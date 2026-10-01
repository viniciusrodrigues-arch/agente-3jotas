// 1º passe do pipeline de análise, em lote — processa todas as conversas
// pendentes de uma vez via Gemini Batch API (50% mais barato que a chamada
// síncrona; prazo de até 24h, mas normalmente bem mais rápido — um teste
// com 2 requests levou ~2min30s). Substitui o caminho antigo em tempo real
// (analyze-conversation-sweep, desligado — ver migration 0024): a ideia
// agora é rodar 1x de madrugada e ter o resumo do dia anterior pronto de
// manhã, não análise instantânea.
//
// Resultados não saem na hora daqui — ver analysis-batch-poll, que consulta
// o status do lote e, quando terminar, já encadeia a submissão do lote de
// revisão (2º passe) automaticamente, sem precisar de outro cron.
//
// Cada rodada avalia só a interação do dia (mensagens do último dia com
// atividade, ver buscarMensagensDoGrupo) — não o histórico completo do lead.
// A cada noite a nota da conversa é recalculada do zero com base só no
// atendimento daquele dia, sem carregar nem penalizar por dias anteriores.
//
// Disparo sugerido: pg_cron 1x por noite/madrugada, mesmo CRON_SECRET dos
// demais crons.

import { createClient } from "jsr:@supabase/supabase-js@2";

// Arquivo único e autocontido (sem pasta _shared) para colar direto no editor
// do dashboard do Supabase.

type EtapaPlaybook = "primeiro_contato" | "envio_simulacao" | "resultado_analise";
type RemetenteTipo = "corretor" | "lead";
type CriterioKey = "fluxo" | "fluidez" | "cta" | "clareza" | "playbook";

interface Mensagem {
  id: string;
  conversa_id: string;
  remetente: RemetenteTipo;
  texto: string;
  enviada_em: string;
  // null = IA de qualificação (Lívia/Maria) escreveu essa mensagem, não um
  // corretor humano — ver checagem "100% IA" mais abaixo.
  autor_crm_user_id: string | null;
}

interface Conversa {
  id: string;
  lead_id: string;
  corretor_id: string;
  etapa_playbook: EtapaPlaybook | null;
  humano_assumiu_em: string | null;
  substituida_por_id: string | null;
}

interface ParametroCriterio {
  criterio: CriterioKey;
  nota_maxima: number;
  peso_percentual: number;
  descricao: string;
  ativo: boolean;
}

const MODEL = "gemini-3.6-flash";
const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta";

function createServiceClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!url || !key) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY não configuradas");
  }

  return createClient(url, key);
}

const ETAPA_LABEL: Record<EtapaPlaybook, string> = {
  primeiro_contato: "1º Contato",
  envio_simulacao: "Envio de Simulação",
  resultado_analise: "Resultado de Análise",
};

// Placeholder que sync-clint grava pra qualquer content_type sem texto real
// (TEMPLATE = blast automático do WhatsApp Business, STICKER, LOCATION,
// CONTACT etc — não digitado pelo corretor) — ver textoMensagem/switch
// default em sync-clint/index.ts. Cobre qualquer content_type, não só
// TEMPLATE: mensagens vazias (ex: só prefixo de autoria "*Nome:*" sem
// conteúdo, ~600+ casos observados em produção) também caem nesse mesmo
// placeholder genérico depois da checagem PREFIXO_AUTOR_SEM_CONTEUDO no sync.
const EH_CONTEUDO_VAZIO = /^\[Conteúdo sem texto: .+\]$/;

// Script fixo da IA de qualificação (Playbook 1: "Sou a Lívia, assistente da
// Três Jotas Imobiliária ✨" / variante "Maria") — mensagem canned, sempre
// idêntica, usada só pra pegar esse caso específico. Não é um match solto de
// nome: "Maria"/"Lívia" sozinhos são nomes comuns de lead (confirmado em
// produção — corretor de verdade cumprimentando lead chamada Maria/"Ana
// Livia"/"Clivia" tem autor_crm_user_id preenchido normalmente), então um
// bare match nesses nomes geraria falso positivo e descartaria mensagem real
// de corretor. Exige a frase de auto-apresentação completa.
const EH_APRESENTACAO_IA = /sou a (l[ií]via|maria)[,.]?\s*assistente/i;

// Ver consolidarPorLead em sync-clint — junta as mensagens de todas as
// conversas do mesmo grupo (lead_id + corretor_id), não só a canônica.
//
// A avaliação é só da interação MAIS RECENTE, não do histórico inteiro do
// lead: depois de filtrar template/apresentação-IA/handoff, fica só o dia
// (fuso America/Sao_Paulo) da última mensagem — cada rodada noturna analisa
// o atendimento daquele dia isoladamente (pedido: cliente perguntou algo e o
// corretor respondeu bem naquele dia = nota alta daquele dia, sem carregar
// nem penalizar por conversas de dias anteriores).
const FUSO_ANALISE = "America/Sao_Paulo";
function diaLocal(isoTimestamp: string): string {
  return new Date(isoTimestamp).toLocaleDateString("en-CA", { timeZone: FUSO_ANALISE });
}

interface MensagensDoDia {
  // Dia (fuso America/Sao_Paulo, formato YYYY-MM-DD) da interação mais
  // recente — vira parte da chave de upsert em `analises` (conversa_id, dia).
  dia: string;
  mensagens: Mensagem[];
}

async function buscarMensagensDoGrupo(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  conversa: Conversa,
): Promise<MensagensDoDia | null> {
  const canonicaId = conversa.substituida_por_id ?? conversa.id;

  const { data: grupo, error: grupoError } = await supabase
    .from("conversas")
    .select("id, humano_assumiu_em")
    .or(`id.eq.${canonicaId},substituida_por_id.eq.${canonicaId}`);

  if (grupoError) throw new Error(`buscar grupo ${canonicaId}: ${grupoError.message}`);

  const conversaIds = (grupo ?? []).map((c: { id: string }) => c.id);
  const handoffPorConversa = new Map((grupo ?? []).map((c: { id: string; humano_assumiu_em: string | null }) => [c.id, c.humano_assumiu_em]));

  const { data: todasMensagens, error: mensagensError } = await supabase
    .from("mensagens")
    .select("*")
    .in("conversa_id", conversaIds)
    .order("enviada_em", { ascending: true });

  if (mensagensError) throw new Error(`buscar mensagens ${canonicaId}: ${mensagensError.message}`);

  const elegiveis = ((todasMensagens ?? []) as Mensagem[]).filter((m) => {
    // Mensagem de template do WhatsApp Business (blast automático, não
    // digitado pelo corretor) — sync-clint grava esse placeholder fixo
    // quando o content_type do Clint é TEMPLATE (ver textoMensagem/switch
    // default). Não reflete comunicação real, não deve entrar na
    // transcrição nem contar como "corretor humano engajou".
    if (EH_CONTEUDO_VAZIO.test(m.texto)) return false;

    // Auto-apresentação da IA de qualificação — desconsidera mesmo se por
    // algum motivo vier com autor_crm_user_id preenchido (pedido explícito:
    // esse conteúdo nunca deve contar como atendimento humano).
    if (m.remetente === "corretor" && EH_APRESENTACAO_IA.test(m.texto)) return false;

    const handoff = handoffPorConversa.get(m.conversa_id);
    return !handoff || m.enviada_em > handoff;
  });

  if (!elegiveis.length) return null;

  const dia = diaLocal(elegiveis[elegiveis.length - 1].enviada_em);
  return { dia, mensagens: elegiveis.filter((m: Mensagem) => diaLocal(m.enviada_em) === dia) };
}

// Mesmo critério das outras functions do pipeline: o critério "playbook" é
// avaliado de forma fria e agnóstica de etapa — todos os playbooks ativos
// entram como referência, sem tentar adivinhar em qual etapa a conversa está.
async function buscarPlaybooksAtivos(
  // deno-lint-ignore no-explicit-any
  supabase: any,
): Promise<string> {
  const { data } = await supabase.from("playbooks").select("etapa, conteudo").eq("ativo", true);
  if (!data?.length) return "Nenhum playbook configurado — avalie com base nas boas práticas gerais de atendimento descritas no critério.";

  return data
    .map((p: { etapa: EtapaPlaybook; conteudo: string }) => `[${ETAPA_LABEL[p.etapa] ?? p.etapa}]\n${p.conteudo}`)
    .join("\n\n");
}

async function buscarParametrosAtivos(
  // deno-lint-ignore no-explicit-any
  supabase: any,
): Promise<ParametroCriterio[]> {
  const { data, error } = await supabase
    .from("parametros_analise")
    .select("criterio, nota_maxima, peso_percentual, descricao, ativo");

  if (error || !data?.length) {
    throw new Error(`parametros_analise vazio ou inacessível: ${error?.message ?? "sem registros"}`);
  }

  return data as ParametroCriterio[];
}

function criterioSchema(descricaoCriterio: string, notaMaxima: number) {
  return {
    type: "OBJECT",
    description: descricaoCriterio,
    properties: {
      score: { type: "INTEGER", description: `Nota de 0 (não atendeu) até ${notaMaxima} (atendeu plenamente).` },
      evidencia: { type: "STRING", description: "Trecho literal da conversa que embasa a nota." },
      justificativa: { type: "STRING", description: "1-2 frases explicando a nota." },
    },
    required: ["score", "evidencia", "justificativa"],
  };
}

// Monta o responseSchema a partir dos parâmetros configurados — critérios
// inativos simplesmente não entram no schema.
function montarAvaliacaoSchema(parametros: ParametroCriterio[]) {
  const ativos = parametros.filter((p) => p.ativo);
  if (!ativos.length) throw new Error("nenhum critério ativo em parametros_analise");

  // deno-lint-ignore no-explicit-any
  const properties: Record<string, any> = {};
  const required: string[] = [];

  for (const p of ativos) {
    properties[p.criterio] = criterioSchema(p.descricao, p.nota_maxima);
    required.push(p.criterio);
  }

  properties.justificativa_geral = { type: "STRING", description: "Resumo de 2-3 frases sobre o atendimento como um todo." };
  required.push("justificativa_geral");

  return { type: "OBJECT", properties, required };
}

// Formato "inline request" da Gemini Batch API — um item por conversa, com
// `metadata.key` = conversa_id pra casar o resultado de volta depois (o
// Gemini ecoa esse key em cada resposta, confirmado em teste real). `dia`
// também vai no metadata por conveniência/observabilidade, mas
// analysis-batch-poll NÃO confia nele pra gravar — recalcula chamando
// buscarMensagensDoGrupo de novo (não é garantido que o Gemini ecoe campos
// além de key).
function montarRequestInline(
  conversaId: string,
  dia: string,
  mensagens: Mensagem[],
  playbook: string,
  // deno-lint-ignore no-explicit-any
  responseSchema: any,
) {
  const transcricao = mensagens
    .map((m) => `[${m.enviada_em}] ${m.remetente === "corretor" ? "Corretor" : "Lead"}: ${m.texto}`)
    .join("\n");

  const systemPrompt = `Você avalia atendimentos de corretores de crédito imobiliário no WhatsApp.

Você recebe apenas a interação de UM dia específico (não o histórico completo
do lead). Avalie esse dia isoladamente: se o cliente trouxe uma dúvida ou
pedido nessa interação e o corretor respondeu bem, isso já é motivo de nota
alta para este dia, independente de como foram os atendimentos em dias
anteriores.

Playbooks configurados (técnicas/scripts de referência da imobiliária — não é
obrigatório que o corretor siga literalmente, mas devem ser usados como apoio
quando a conversa pede, ver critério "playbook" no schema para o julgamento
esperado):
"""
${playbook}
"""

Avalie a interação abaixo estritamente contra os critérios do schema. Cite trechos
literais da conversa como evidência. Não invente informação que não está na conversa.`;

  return {
    request: {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: "user", parts: [{ text: `Interação do dia a avaliar:\n\n${transcricao}` }] }],
      generationConfig: { responseMimeType: "application/json", responseSchema },
    },
    metadata: { key: conversaId, dia },
  };
}

interface ConversaDia {
  conversa_id: string;
  dia: string;
}

// `.in()` com uma lista grande de uuids gera uma URL enorme (~36 chars por
// id) que já causou erro de protocolo HTTP/2 vindo do Supabase quando o
// backlog estava grande — atualiza em lotes menores pra não depender do
// tamanho da lista.
//
// Upsert (não update) por (conversa_id, dia): agora pode haver mais de uma
// linha por conversa (uma por dia de atividade já analisado), então um
// update filtrando só por conversa_id atingiria todas as linhas históricas
// da conversa por engano — upsert com a chave composta atinge só a linha do
// dia certo, criando-a se ainda não existir (ex: primeira vez que essa
// conversa entra na fila).
const TAMANHO_LOTE_UPDATE = 100;
// deno-lint-ignore no-explicit-any
async function atualizarStatusEmLotesPorDia(supabase: any, pares: ConversaDia[], update: Record<string, unknown>): Promise<void> {
  for (let i = 0; i < pares.length; i += TAMANHO_LOTE_UPDATE) {
    const lote = pares.slice(i, i + TAMANHO_LOTE_UPDATE);
    await supabase
      .from("analises")
      .upsert(
        lote.map((p) => ({ conversa_id: p.conversa_id, dia: p.dia, ...update })),
        { onConflict: "conversa_id,dia" },
      );
  }
}

// Limite de segurança — a Gemini Batch API aceita requests inline até 20MB
// no corpo total; conversas normais (poucas dezenas de mensagens) ficam bem
// abaixo disso mesmo em lotes de várias centenas. Se o volume diário crescer
// muito, pode ser necessário migrar pra upload de arquivo JSONL.
// O cron chama esta função repetidamente e drena o backlog em lotes pequenos.
// Isso mantém a preparação abaixo do timeout do pg_net/Edge Function.
const MAX_CONVERSAS_POR_LOTE = 50;
const CONCORRENCIA_PREPARACAO = 5;

async function paraCadaComConcorrencia<T>(itens: T[], concorrencia: number, tarefa: (item: T) => Promise<void>): Promise<void> {
  let proximo = 0;
  const workers = Array.from({ length: Math.min(concorrencia, itens.length) }, async () => {
    while (true) {
      const indice = proximo++;
      if (indice >= itens.length) return;
      await tarefa(itens[indice]);
    }
  });
  await Promise.all(workers);
}

Deno.serve(async (req) => {
  const authHeader = req.headers.get("Authorization");
  const cronSecret = Deno.env.get("CRON_SECRET");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return new Response("unauthorized", { status: 401 });
  }

  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) {
    return new Response("GEMINI_API_KEY não configurada", { status: 500 });
  }

  const supabase = createServiceClient();

  const { data: pendentes, error: pendentesError } = await supabase
    .from("analises")
    .select("conversa_id")
    .eq("status", "pendente")
    .limit(MAX_CONVERSAS_POR_LOTE);

  if (pendentesError) {
    return new Response(`erro ao buscar pendentes: ${pendentesError.message}`, { status: 500 });
  }

  if (!pendentes?.length) {
    return new Response(JSON.stringify({ ok: true, enviados: 0, motivo: "nada pendente" }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // Dedupe: pode haver mais de uma linha 'pendente' pra mesma conversa (dias
  // diferentes, ex: sync-clint gravou a fila em noites seguidas antes desta
  // function rodar) — processamos a conversa uma vez só, recalculando o dia
  // real via buscarMensagensDoGrupo (que resolve tudo do zero de qualquer
  // forma, ver limpeza de linhas 'pendente' órfãs mais abaixo).
  const conversaIds = [...new Set(pendentes.map((p: { conversa_id: string }) => p.conversa_id))];

  // Buscar muitas conversas de uma vez só com `.in()` gera uma URL
  // gigante (cada uuid ~36 chars) que já derrubou essa function com erro de
  // protocolo HTTP/2 ("stream error") quando o backlog estava grande —
  // silenciosamente, sem nunca marcar nada como 'processando', então o
  // backlog só crescia noite após noite. Busca em lotes menores evita isso
  // independente do tamanho do backlog.
  const TAMANHO_LOTE_BUSCA = 100;
  const conversas: Conversa[] = [];
  for (let i = 0; i < conversaIds.length; i += TAMANHO_LOTE_BUSCA) {
    const idsDoLote = conversaIds.slice(i, i + TAMANHO_LOTE_BUSCA);
    const { data: parte, error: parteError } = await supabase
      .from("conversas")
      .select("id, lead_id, corretor_id, etapa_playbook, humano_assumiu_em, substituida_por_id")
      .in("id", idsDoLote);

    if (parteError) {
      return new Response(`erro ao buscar conversas: ${parteError.message}`, { status: 500 });
    }
    conversas.push(...((parte ?? []) as Conversa[]));
  }

  if (!conversas.length) {
    return new Response("erro ao buscar conversas: nenhuma encontrada", { status: 500 });
  }

  let responseSchema;
  try {
    const parametros = await buscarParametrosAtivos(supabase);
    responseSchema = montarAvaliacaoSchema(parametros);
  } catch (err) {
    return new Response(err instanceof Error ? err.message : String(err), { status: 500 });
  }

  // Mesmos playbooks pra todas as conversas do lote — busca uma vez só, fora do loop.
  const playbook = await buscarPlaybooksAtivos(supabase);

  const requests: unknown[] = [];
  const semMensagens: string[] = [];
  const semCorretorHumano: ConversaDia[] = [];
  const comRequest: ConversaDia[] = [];

  try {
    await paraCadaComConcorrencia(conversas, CONCORRENCIA_PREPARACAO, async (conversa) => {
      const resultado = await buscarMensagensDoGrupo(supabase, conversa);
      if (!resultado || resultado.mensagens.length === 0) {
        semMensagens.push(conversa.id);
        return;
      }
      const { dia, mensagens } = resultado;

      // "100% IA": nenhuma mensagem de corretor tem autor_crm_user_id
      // preenchido — quem atendeu até agora foi só a IA de qualificação
      // (Lívia/Maria), o corretor dono do chat ainda não escreveu nada.
      // Avaliar essa conversa seria pontuar a IA no lugar do corretor. Não
      // fica preso pra sempre: essa checagem roda de novo a cada noite, então
      // assim que um humano responder de verdade ela entra no lote seguinte
      // normalmente — diferente da trava antiga (0032), que ficava guardada
      // num status já calculado e não se corrigia sozinha quando a regra ou
      // os dados mudavam.
      const temCorretorHumano = mensagens.some((m) => m.remetente === "corretor" && m.autor_crm_user_id);
      if (!temCorretorHumano) {
        semCorretorHumano.push({ conversa_id: conversa.id, dia });
        return;
      }

      comRequest.push({ conversa_id: conversa.id, dia });
      requests.push(montarRequestInline(conversa.id, dia, mensagens, playbook, responseSchema));
    });
  } catch (err) {
    return new Response(`erro ao preparar lote: ${err instanceof Error ? err.message : String(err)}`, { status: 500 });
  }

  // "Sem mensagens" aqui é só o que sobra DEPOIS do filtro de template/vazio/
  // apresentação-IA/handoff — ou seja, não é erro técnico, é a mesma
  // categoria de "não teve atendimento humano real ainda" que semCorretorHumano
  // já cobre (ex: dia em que só rodou blast automático do WhatsApp Business,
  // sem nenhuma mensagem real de corretor ou lead). 'falhou' é reservado pra
  // problema técnico de verdade (erro de parsing, resposta ausente do
  // Gemini) — misturar os dois dificultava enxergar o que precisa de atenção
  // de fato. Não tem "dia" calculável (não sobrou mensagem nenhuma pra achar
  // o dia mais recente) — usa hoje só como chave de upsert, mesma convenção
  // do sync-clint pra linhas sem interação real ainda.
  const hoje = diaLocal(new Date().toISOString());
  const semMensagensHoje: ConversaDia[] = semMensagens.map((id) => ({ conversa_id: id, dia: hoje }));

  if (semMensagensHoje.length) {
    await atualizarStatusEmLotesPorDia(
      supabase,
      semMensagensHoje,
      { status: "nao_elegivel", erro: "sem mensagens reais no período (só template/apresentação automática, sem interação humana)" },
    );
  }

  if (semCorretorHumano.length) {
    await atualizarStatusEmLotesPorDia(supabase, semCorretorHumano, {
      status: "nao_elegivel",
      erro: "100% IA de qualificação (Lívia/Maria) — corretor ainda não engajou",
    });
  }

  // Limpa possíveis linhas 'pendente' órfãs da mesma conversa com um `dia`
  // diferente do calculado agora (ex: sync-clint gravou a fila com "hoje",
  // mas a última atividade real é de ontem) — evita acumular lixo de fila
  // que nunca seria retomado (nada mais aponta pra essas linhas). Precisa
  // incluir semMensagens também: o upsert de nao_elegivel acima usa
  // dia=hoje como chave, então a linha 'pendente' original (com o dia real
  // da última mensagem, quase sempre diferente de hoje) nunca seria
  // atingida pelo upsert — sem essa limpeza ela ficava presa em 'pendente'
  // pra sempre, sendo repescada em toda chamada seguinte sem nunca sair da
  // fila (bug observado: milhares de conversas só-template travadas).
  const todosOsPares = [...comRequest, ...semCorretorHumano, ...semMensagensHoje];
  await paraCadaComConcorrencia(todosOsPares, CONCORRENCIA_PREPARACAO, async (par) => {
    const { error } = await supabase
      .from("analises")
      .delete()
      .eq("conversa_id", par.conversa_id)
      .eq("status", "pendente")
      .neq("dia", par.dia);
    if (error) throw new Error(`limpar pendência órfã ${par.conversa_id}: ${error.message}`);
  });

  if (!requests.length) {
    return new Response(JSON.stringify({ ok: true, enviados: 0, motivo: "sem conversas com mensagens" }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const resp = await fetch(`${GEMINI_API_URL}/models/${MODEL}:batchGenerateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      batch: {
        display_name: `analise-${new Date().toISOString().slice(0, 10)}`,
        input_config: { requests: { requests } },
      },
    }),
  });

  if (!resp.ok) {
    return new Response(`Gemini Batch API retornou ${resp.status}: ${await resp.text()}`, { status: 502 });
  }

  const batch = await resp.json();
  const batchName = batch.name as string; // ex: "batches/xxxxx"

  const { data: registroBatch, error: registroError } = await supabase
    .from("analise_batches")
    .insert({
      batch_id_externo: batchName,
      tipo: "analise",
      status: "in_progress",
      total_requests: requests.length,
    })
    .select("id")
    .single();

  if (registroError || !registroBatch) {
    return new Response(`batch enviado (${batchName}) mas falhou ao registrar: ${registroError?.message}`, {
      status: 500,
    });
  }

  // comRequest já é exatamente quem tem request real no lote (bug corrigido
  // aqui antes: um filtro esquecia de excluir semCorretorHumano e sobrescrevia
  // 'nao_elegivel' pra 'processando' mesmo sem request nenhum enviado —
  // deixava a análise presa em 'processando' pra sempre, já que o poll nunca
  // via aquele conversa_id na resposta do Gemini e sync-clint não mexe em
  // conversas 'processando' — evita brigar com análise em andamento).
  await atualizarStatusEmLotesPorDia(supabase, comRequest, { status: "processando", batch_id: registroBatch.id });

  return new Response(
    JSON.stringify({
      ok: true,
      batch: batchName,
      enviados: requests.length,
      sem_mensagens: semMensagens.length,
    }),
    { headers: { "Content-Type": "application/json" } },
  );
});
