// 2º passe do pipeline de análise: relê a conversa inteira (não critério a
// critério, isolado, como no 1º passe) já sabendo qual foi a nota e a
// justificativa originais, e ajusta onde uma leitura mais atenta ao contexto
// da conversa (ironia, recuperação tardia do corretor, gíria, mudança de tom)
// discordar do julgamento isolado do 1º passe. Sobrescreve as colunas de
// `analises` in-place — o dashboard não precisa saber que existe um 2º passe.
//
// Roda em lote, disparado por cron: varre `analises` com status='concluida'
// e revisado=false, processa até MAX_POR_EXECUCAO por chamada. Cada execução
// é uma invocação HTTP própria com timeout cheio — não depende de
// EdgeRuntime.waitUntil() sobreviver ao fim de outra requisição (era assim
// que rodava antes, dentro de analyze-conversation-sync, e arriscava ser
// encerrado silenciosamente se o teto de background task do Supabase
// estourasse).
//
// O resultado cru do 1º passe (necessário aqui pra saber "o que mudou" em
// relação à avaliação original) vem de `analises_bruta`, gravada por
// analyze-conversation-sync antes de qualquer revisão acontecer.
//
// Arquivo único e autocontido (sem pasta _shared) para colar direto no editor
// do dashboard do Supabase. Lembre de desativar "Enforce JWT Verification"
// pra essa função, igual às outras disparadas por cron (Bearer CRON_SECRET).

import { createClient } from "jsr:@supabase/supabase-js@2";

type EtapaPlaybook = "primeiro_contato" | "envio_simulacao" | "resultado_analise";
type RemetenteTipo = "corretor" | "lead";
type CriterioKey = "fluxo" | "fluidez" | "cta" | "clareza" | "playbook";

const CRITERIO_LABEL: Record<CriterioKey, string> = {
  fluxo: "Fluxo Ligação/Mensagem",
  fluidez: "Fluidez",
  cta: "CTA",
  clareza: "Clareza da Informação",
  playbook: "Aderência ao Playbook",
};

// Quantas conversas revisar por execução — cada uma é uma chamada Gemini com
// a conversa inteira, então mantém baixo pra não estourar o timeout da função.
const MAX_POR_EXECUCAO = 15;

interface Mensagem {
  autor_crm_user_id?: string | null;
  midia_content_type?: string | null;
  id: string;
  conversa_id: string;
  remetente: RemetenteTipo;
  texto: string;
  enviada_em: string;
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

const MODEL = "gemini-2.5-flash";
const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models";

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

// Mesmo critério do 1º passe (analyze-conversation-sync): o critério
// "playbook" é avaliado de forma fria e agnóstica de etapa — todos os
// playbooks ativos entram como referência, sem tentar adivinhar em qual
// etapa a conversa está.
// Ver consolidarPorLead em sync-clint — junta as mensagens de todas as
// conversas do mesmo grupo (lead_id + corretor_id), não só a canônica, pra
// revisar com o contexto completo da relação com o lead.
async function buscarMensagensDoGrupo(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  conversa: Conversa,
): Promise<Mensagem[]> {
  const canonicaId = conversa.substituida_por_id ?? conversa.id;

  const { data: grupo } = await supabase
    .from("conversas")
    .select("id, humano_assumiu_em")
    .or(`id.eq.${canonicaId},substituida_por_id.eq.${canonicaId}`);

  const conversaIds = (grupo ?? []).map((c: { id: string }) => c.id);
  const handoffPorConversa = new Map((grupo ?? []).map((c: { id: string; humano_assumiu_em: string | null }) => [c.id, c.humano_assumiu_em]));

  const { data: todasMensagens } = await supabase
    .from("mensagens")
    .select("*")
    .in("conversa_id", conversaIds)
    .order("enviada_em", { ascending: true })
    .returns();

  return (todasMensagens ?? []).filter((m: Mensagem) => {
    if (m.midia_content_type === "TEMPLATE" || /^\[Conteúdo sem texto: .+\]$/.test(m.texto.trim())) return false;
    if (m.remetente === "corretor" && (!m.autor_crm_user_id || /^(?:\*[^*]+:\*|\*?\[(?:CLOSER|SDR)\]\s+[^*\r\n]+\*?)\s*$/i.test(m.texto.trim()) || /sou a (l[ií]via|maria)[,.]?\s*assistente/i.test(m.texto))) return false;
    const handoff = handoffPorConversa.get(m.conversa_id);
    return !handoff || m.enviada_em > handoff;
  });
}

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
  const { data } = await supabase.from("parametros_analise").select("criterio, nota_maxima, peso_percentual, descricao, ativo");
  return (data ?? []) as ParametroCriterio[];
}

function criterioRevisaoSchema(descricaoCriterio: string, notaMaxima: number) {
  return {
    type: "OBJECT",
    description: descricaoCriterio,
    properties: {
      score: {
        type: "INTEGER",
        description: `Nota revisada de 0 (não atendeu) até ${notaMaxima} (atendeu plenamente).`,
      },
      evidencia: { type: "STRING", description: "Trecho literal da conversa que embasa a nota revisada." },
      justificativa: { type: "STRING", description: "1-2 frases explicando a nota revisada." },
      mudou: { type: "BOOLEAN", description: "true se essa nota mudou em relação à avaliação original." },
    },
    required: ["score", "evidencia", "justificativa", "mudou"],
  };
}

function montarRevisaoSchema(parametrosAtivos: ParametroCriterio[]) {
  // deno-lint-ignore no-explicit-any
  const properties: Record<string, any> = {};
  const required: string[] = [];

  for (const p of parametrosAtivos) {
    properties[p.criterio] = criterioRevisaoSchema(p.descricao, p.nota_maxima);
    required.push(p.criterio);
  }

  properties.resumo_revisao = {
    type: "STRING",
    description:
      "2-3 frases resumindo o que mudou nesta revisão e por quê, ou explicando que a avaliação original já estava correta e nada mudou.",
  };
  required.push("resumo_revisao");

  return { type: "OBJECT", properties, required };
}

// Retorna "revisada" (2º passe rodou e atualizou `analises`), "pulada"
// (marcada como revisado=true sem chamar o Gemini — caso permanente, não
// adianta tentar de novo no próximo cron, ex: conversa sem `analises_bruta`
// porque foi analisada antes desse recurso existir) ou lança erro (caso
// transiente — falha de rede/Gemini — fica revisado=false pra tentar de
// novo na próxima execução).
// deno-lint-ignore no-explicit-any
async function revisarUmaConversa(supabase: any, conversaId: string, parametros: ParametroCriterio[]): Promise<"revisada" | "pulada"> {
  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) throw new Error("GEMINI_API_KEY não configurada");

  const ativos = parametros.filter((p) => p.ativo);

  const [{ data: conversa, error: conversaError }, { data: bruta }] = await Promise.all([
    supabase
      .from("conversas")
      .select("id, lead_id, corretor_id, etapa_playbook, humano_assumiu_em, substituida_por_id")
      .eq("id", conversaId)
      .single(),
    supabase.from("analises_bruta").select("*").eq("conversa_id", conversaId).maybeSingle(),
  ]);

  // Erro real de banco/schema (ex: coluna renomeada) é caso transiente — não
  // pode se disfarçar de "sem análise crua", senão fica revisado=true pra
  // sempre e ninguém percebe que o 2º passe parou de rodar de verdade.
  if (conversaError) throw new Error(`buscar conversa falhou: ${conversaError.message}`);

  const mensagens = conversa ? await buscarMensagensDoGrupo(supabase, conversa) : [];

  if (!ativos.length || !conversa || !bruta || !mensagens.length) {
    await marcarComoPulada(supabase, conversaId, "sem análise crua (analises_bruta) pra revisar — provavelmente analisada antes desse recurso existir.");
    return "pulada";
  }
  if (!mensagens.length) {
    await marcarComoPulada(supabase, conversaId, "sem mensagens após o handoff da IA de qualificação.");
    return "pulada";
  }

  const playbook = await buscarPlaybooksAtivos(supabase);

  const transcricao = mensagens
    .map((m) => `[${m.enviada_em}] ${m.remetente === "corretor" ? "Corretor" : "Lead"}: ${m.texto}`)
    .join("\n");

  const avaliacaoOriginal = ativos
    .map((p) => {
      const score = bruta[`${p.criterio}_score`];
      const evidencia = bruta[`${p.criterio}_evidencia`];
      const justificativa = bruta[`${p.criterio}_justificativa`];
      if (score === null || score === undefined) return null;
      return `- ${CRITERIO_LABEL[p.criterio]} (instrução: "${p.descricao}"): nota ${score}/${p.nota_maxima} — evidência citada: "${evidencia}" — justificativa: "${justificativa}"`;
    })
    .filter(Boolean)
    .join("\n");

  if (!avaliacaoOriginal) {
    await marcarComoPulada(supabase, conversaId, "análise crua sem nota em nenhum critério ativo.");
    return "pulada";
  }

  const systemPrompt = `Você é um revisor sênior de QA, mais experiente que o avaliador que fez a primeira passada desta conversa.

Playbooks configurados (técnicas/scripts de referência da imobiliária — ver
critério "playbook" no schema para o julgamento esperado, que é frio e
agnóstico de etapa):
"""
${playbook}
"""

A primeira avaliação (feita critério a critério, isoladamente) resultou em:
${avaliacaoOriginal}

Releia a conversa completa abaixo prestando atenção a nuances que uma avaliação
isolada por critério pode perder: ironia ou sarcasmo, o corretor recuperando
uma falha mais tarde na conversa, gírias e expressões regionais, mudança de
tom do lead ao longo do atendimento, contexto que só faz sentido lendo tudo
junto. Ajuste a nota, evidência e justificativa de cada critério apenas onde a
avaliação original estiver de fato equivocada — mantenha a nota original
quando ela já estiver correta, mesmo que a evidência citada não seja o único
trecho relevante. Não mude uma nota só para ser diferente da original.`;

  const resp = await fetch(`${GEMINI_API_URL}/${MODEL}:generateContent?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: "user", parts: [{ text: `Conversa completa:\n\n${transcricao}` }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: montarRevisaoSchema(ativos),
      },
    }),
  });

  if (!resp.ok) {
    throw new Error(`Gemini API retornou ${resp.status}: ${await resp.text()}`);
  }

  const data = await resp.json();
  const texto = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!texto) throw new Error(`resposta do Gemini sem conteúdo: ${JSON.stringify(data)}`);

  // deno-lint-ignore no-explicit-any
  const revisao: Record<string, any> = JSON.parse(texto);

  // deno-lint-ignore no-explicit-any
  const upsert: Record<string, any> = {
    conversa_id: conversaId,
    revisado: true,
    revisado_em: new Date().toISOString(),
    resumo_revisao: revisao.resumo_revisao ?? null,
  };

  for (const p of ativos) {
    const c = revisao[p.criterio];
    if (!c) continue;
    upsert[`${p.criterio}_score`] = c.score;
    upsert[`${p.criterio}_evidencia`] = c.evidencia;
    upsert[`${p.criterio}_justificativa`] = c.justificativa;
  }

  const { error } = await supabase.from("analises").upsert(upsert, { onConflict: "conversa_id" });
  if (error) throw new Error(error.message);

  return "revisada";
}

// deno-lint-ignore no-explicit-any
async function marcarComoPulada(supabase: any, conversaId: string, motivo: string): Promise<void> {
  await supabase.from("analises").upsert(
    { conversa_id: conversaId, revisado: true, revisado_em: new Date().toISOString(), resumo_revisao: `Não revisada: ${motivo}` },
    { onConflict: "conversa_id" },
  );
}

Deno.serve(async (req) => {
  const authHeader = req.headers.get("Authorization");
  const cronSecret = Deno.env.get("CRON_SECRET");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return new Response("unauthorized", { status: 401 });
  }

  const supabase = createServiceClient();

  const { data: pendentes, error: pendentesError } = await supabase
    .from("analises")
    .select("conversa_id")
    .eq("status", "concluida")
    .eq("revisado", false)
    .order("analisado_em", { ascending: true })
    .limit(MAX_POR_EXECUCAO);

  if (pendentesError) {
    return new Response(`erro ao buscar pendentes: ${pendentesError.message}`, { status: 500 });
  }

  if (!pendentes?.length) {
    return new Response(JSON.stringify({ ok: true, revisadas: 0, motivo: "nada pendente" }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const parametros = await buscarParametrosAtivos(supabase);

  let revisadas = 0;
  let puladas = 0;
  const falhas: { conversa_id: string; erro: string }[] = [];

  for (const p of pendentes) {
    try {
      const resultado = await revisarUmaConversa(supabase, p.conversa_id, parametros);
      if (resultado === "revisada") revisadas++;
      else puladas++;
    } catch (err) {
      falhas.push({ conversa_id: p.conversa_id, erro: err instanceof Error ? err.message : String(err) });
    }
  }

  return new Response(JSON.stringify({ ok: true, revisadas, puladas, falhas, total: pendentes.length }), {
    headers: { "Content-Type": "application/json" },
  });
});
