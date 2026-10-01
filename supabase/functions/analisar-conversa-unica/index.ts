// Analisa e pontua UMA conversa específica, na hora (chamada síncrona ao
// Gemini, sem passar pela Batch API) — botão "Analisar conversa" no
// dashboard, pra quando o corretor/gestor não quer esperar o lote noturno,
// ou como fallback manual se o pipeline em lote (analysis-batch-submit/poll)
// não rodar por algum motivo.
//
// Mesma lógica de contexto/critérios/playbooks do pipeline em lote
// (analysis-batch-submit) — só troca batchGenerateContent por
// generateContent (resposta na hora, sem polling). Faz os mesmos 2 passes do
// lote noturno (análise + revisão, ver analysis-batch-poll/submeterLoteRevisao),
// só que em sequência síncrona em vez de 2 lotes encadeados.
//
// Disparo: POST { conversaId } com o mesmo CRON_SECRET das demais functions
// (a rota /api/conversas/[id]/analisar do dashboard repassa a chamada).

import { createClient } from "jsr:@supabase/supabase-js@2";

type EtapaPlaybook = "primeiro_contato" | "envio_simulacao" | "resultado_analise";
type RemetenteTipo = "corretor" | "lead";
type CriterioKey = "fluxo" | "fluidez" | "cta" | "clareza" | "playbook";

interface Mensagem {
  id: string;
  conversa_id: string;
  remetente: RemetenteTipo;
  texto: string;
  enviada_em: string;
  // null = IA de qualificação (Lívia/Maria), não um corretor humano — ver
  // checagem "100% IA" no handler principal.
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
const CRITERIOS: CriterioKey[] = ["fluxo", "fluidez", "cta", "clareza", "playbook"];

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
// (ver mesmo comentário em analysis-batch-submit) — cobre TEMPLATE e também
// mensagens vazias (só prefixo de autoria, sem conteúdo).
const EH_CONTEUDO_VAZIO = /^\[Conteúdo sem texto: .+\]$/;

// Script fixo da IA de qualificação (Playbook 1) — ver mesmo comentário em
// analysis-batch-submit. Exige a frase de auto-apresentação completa (não
// bare match de nome) porque "Maria"/"Lívia" também são nomes reais de lead.
const EH_APRESENTACAO_IA = /sou a (l[ií]via|maria)[,.]?\s*assistente/i;

const CRITERIO_LABEL: Record<CriterioKey, string> = {
  fluxo: "Fluxo Ligação/Mensagem",
  fluidez: "Fluidez",
  cta: "CTA",
  clareza: "Clareza da Informação",
  playbook: "Aderência ao Playbook",
};

// Ver mesmo comentário em analysis-batch-submit — a avaliação é só da
// interação MAIS RECENTE (último dia local com atividade), não do histórico
// inteiro do lead.
const FUSO_ANALISE = "America/Sao_Paulo";
function diaLocal(isoTimestamp: string): string {
  return new Date(isoTimestamp).toLocaleDateString("en-CA", { timeZone: FUSO_ANALISE });
}

interface MensagensDoDia {
  dia: string;
  mensagens: Mensagem[];
}

// Idêntico ao buscarMensagensDoGrupo de analysis-batch-submit — junta as
// mensagens de todas as conversas do mesmo grupo consolidado (lead_id +
// corretor_id), não só a canônica, corta tudo antes do handoff IA→humano, e
// filtra só o último dia local com atividade.
async function buscarMensagensDoGrupo(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  conversa: Conversa,
): Promise<MensagensDoDia | null> {
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
    .returns<Mensagem[]>();

  const elegiveis = (todasMensagens ?? []).filter((m: Mensagem) => {
    if (EH_CONTEUDO_VAZIO.test(m.texto)) return false;
    if (m.remetente === "corretor" && EH_APRESENTACAO_IA.test(m.texto)) return false;
    const handoff = handoffPorConversa.get(m.conversa_id);
    return !handoff || m.enviada_em > handoff;
  });

  if (!elegiveis.length) return null;

  const dia = diaLocal(elegiveis[elegiveis.length - 1].enviada_em);
  return { dia, mensagens: elegiveis.filter((m: Mensagem) => diaLocal(m.enviada_em) === dia) };
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

function criterioRevisaoSchema(descricaoCriterio: string, notaMaxima: number) {
  return {
    type: "OBJECT",
    description: descricaoCriterio,
    properties: {
      score: { type: "INTEGER", description: `Nota revisada de 0 (não atendeu) até ${notaMaxima} (atendeu plenamente).` },
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
    description: "2-3 frases resumindo o que mudou nesta revisão e por quê, ou explicando que a avaliação original já estava correta e nada mudou.",
  };
  required.push("resumo_revisao");

  return { type: "OBJECT", properties, required };
}

// deno-lint-ignore no-explicit-any
function montarPromptRevisao(mensagens: Mensagem[], playbook: string, resultadoOriginal: Record<string, any>, ativos: ParametroCriterio[]) {
  const avaliacaoOriginal = ativos
    .map((p) => {
      const c = resultadoOriginal[p.criterio];
      if (!c) return null;
      return `- ${CRITERIO_LABEL[p.criterio]} (instrução: "${p.descricao}"): nota ${c.score}/${p.nota_maxima} — evidência citada: "${c.evidencia}" — justificativa: "${c.justificativa}"`;
    })
    .filter(Boolean)
    .join("\n");

  const transcricao = mensagens
    .map((m) => `[${m.enviada_em}] ${m.remetente === "corretor" ? "Corretor" : "Lead"}: ${m.texto}`)
    .join("\n");

  const systemPrompt = `Você é um revisor sênior de QA, mais experiente que o avaliador que fez a primeira passada desta conversa.

Playbooks configurados (técnicas/scripts de referência da imobiliária — ver
critério "playbook" no schema para o julgamento esperado, que é frio e
agnóstico de etapa):
"""
${playbook}
"""

A primeira avaliação (feita critério a critério, isoladamente) resultou em:
${avaliacaoOriginal}

Releia abaixo a interação deste dia específico prestando atenção a nuances que
uma avaliação isolada por critério pode perder: ironia ou sarcasmo, o corretor
recuperando uma falha mais tarde na mesma interação, gírias e expressões
regionais, mudança de tom do lead ao longo do atendimento, contexto que só faz
sentido lendo tudo junto. Ajuste a nota, evidência e justificativa de cada
critério apenas onde a avaliação original estiver de fato equivocada — mantenha
a nota original quando ela já estiver correta, mesmo que a evidência citada não
seja o único trecho relevante. Não mude uma nota só para ser diferente da
original.`;

  return { systemPrompt, transcricao };
}

// deno-lint-ignore no-explicit-any
function montarUpsertRevisao(conversaId: string, dia: string, revisao: Record<string, any>, ativos: ParametroCriterio[]) {
  // deno-lint-ignore no-explicit-any
  const upsert: Record<string, any> = {
    conversa_id: conversaId,
    dia,
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

  return upsert;
}

function montarPrompt(mensagens: Mensagem[], playbook: string) {
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

  return { systemPrompt, transcricao };
}

// deno-lint-ignore no-explicit-any
function montarUpsertAnalise(conversaId: string, dia: string, resultado: Record<string, any>) {
  // deno-lint-ignore no-explicit-any
  const upsert: Record<string, any> = {
    conversa_id: conversaId,
    dia,
    status: "concluida" as const,
    justificativa_geral: resultado.justificativa_geral,
    modelo_usado: MODEL,
    erro: null,
    analisado_em: new Date().toISOString(),
    revisado: false,
    revisado_em: null,
    resumo_revisao: null,
  };

  for (const criterio of CRITERIOS) {
    const c = resultado[criterio];
    if (!c) continue;
    upsert[`${criterio}_score`] = c.score;
    upsert[`${criterio}_evidencia`] = c.evidencia;
    upsert[`${criterio}_justificativa`] = c.justificativa;
  }

  return upsert;
}

// deno-lint-ignore no-explicit-any
function montarUpsertBruta(conversaId: string, dia: string, resultado: Record<string, any>) {
  // deno-lint-ignore no-explicit-any
  const upsert: Record<string, any> = {
    conversa_id: conversaId,
    dia,
    justificativa_geral: resultado.justificativa_geral,
    modelo_usado: MODEL,
  };

  for (const criterio of CRITERIOS) {
    const c = resultado[criterio];
    if (!c) continue;
    upsert[`${criterio}_score`] = c.score;
    upsert[`${criterio}_evidencia`] = c.evidencia;
    upsert[`${criterio}_justificativa`] = c.justificativa;
  }

  return upsert;
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

  let conversaId: string | undefined;
  try {
    const body = await req.json();
    conversaId = body.conversaId;
  } catch {
    // segue com conversaId undefined, cai no 400 abaixo
  }

  if (!conversaId) {
    return new Response("body precisa de { conversaId }", { status: 400 });
  }

  const supabase = createServiceClient();

  const { data: conversa, error: conversaError } = await supabase
    .from("conversas")
    .select("id, lead_id, corretor_id, etapa_playbook, humano_assumiu_em, substituida_por_id")
    .eq("id", conversaId)
    .maybeSingle<Conversa>();

  if (conversaError || !conversa) {
    return new Response(`conversa não encontrada: ${conversaError?.message ?? conversaId}`, { status: 404 });
  }

  // Sem "dia" calculável ainda (não sabemos o que buscarMensagensDoGrupo vai
  // achar) — usa hoje só como sinalizador transitório de "processando", igual
  // à convenção do sync-clint/analysis-batch-submit. É sobrescrito abaixo
  // assim que o dia real é conhecido.
  const hojeLocal = diaLocal(new Date().toISOString());
  await supabase.from("analises").upsert({ conversa_id: conversaId, dia: hojeLocal, status: "processando" }, { onConflict: "conversa_id,dia" });

  try {
    const resultadoMensagens = await buscarMensagensDoGrupo(supabase, conversa);
    if (!resultadoMensagens || resultadoMensagens.mensagens.length === 0) {
      // Sem mensagens elegíveis: mesma categoria de "não teve atendimento
      // humano real ainda" que a checagem 100% IA abaixo cobre (ex: só
      // template/blast automático) — não é erro técnico, não deve ficar em
      // "falhou" (ver mesmo ajuste em analysis-batch-submit).
      await supabase.from("analises").upsert(
        { conversa_id: conversaId, dia: hojeLocal, status: "nao_elegivel", erro: "sem mensagens reais no período (só template/apresentação automática, sem interação humana)" },
        { onConflict: "conversa_id,dia" },
      );
      return new Response(JSON.stringify({ ok: false, erro: "conversa sem mensagens" }), {
        status: 422,
        headers: { "Content-Type": "application/json" },
      });
    }
    const { dia, mensagens } = resultadoMensagens;

    // Mesma checagem "100% IA" do analysis-batch-submit — sem isso, o botão
    // manual "Analisar conversa" pontuaria a IA de qualificação (Lívia/Maria)
    // no lugar do corretor.
    const temCorretorHumano = mensagens.some((m) => m.remetente === "corretor" && m.autor_crm_user_id);
    if (!temCorretorHumano) {
      const erro = "100% IA de qualificação (Lívia/Maria) — corretor ainda não engajou, nada pra analisar";
      await supabase.from("analises").upsert({ conversa_id: conversaId, dia, status: "nao_elegivel", erro }, { onConflict: "conversa_id,dia" });
      return new Response(JSON.stringify({ ok: false, erro }), { status: 422, headers: { "Content-Type": "application/json" } });
    }

    const parametros = await buscarParametrosAtivos(supabase);
    const responseSchema = montarAvaliacaoSchema(parametros);
    const playbook = await buscarPlaybooksAtivos(supabase);
    const { systemPrompt, transcricao } = montarPrompt(mensagens, playbook);

    const resp = await fetch(`${GEMINI_API_URL}/models/${MODEL}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: `Interação do dia a avaliar:\n\n${transcricao}` }] }],
        generationConfig: { responseMimeType: "application/json", responseSchema },
      }),
    });

    if (!resp.ok) {
      const erro = `Gemini API retornou ${resp.status}: ${await resp.text()}`;
      await supabase.from("analises").upsert({ conversa_id: conversaId, dia, status: "falhou", erro }, { onConflict: "conversa_id,dia" });
      return new Response(JSON.stringify({ ok: false, erro }), { status: 502, headers: { "Content-Type": "application/json" } });
    }

    const data = await resp.json();
    const texto = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!texto) {
      const erro = "resposta do Gemini sem texto (bloqueada ou vazia)";
      await supabase.from("analises").upsert({ conversa_id: conversaId, dia, status: "falhou", erro }, { onConflict: "conversa_id,dia" });
      return new Response(JSON.stringify({ ok: false, erro }), { status: 502, headers: { "Content-Type": "application/json" } });
    }

    const resultado = JSON.parse(texto);

    await supabase.from("analises").upsert(montarUpsertAnalise(conversaId, dia, resultado), { onConflict: "conversa_id,dia" });
    await supabase.from("analises_bruta").upsert(montarUpsertBruta(conversaId, dia, resultado), { onConflict: "conversa_id,dia" });

    // 2º passe (revisão) — mesma ideia do analysis-batch-poll/submeterLoteRevisao,
    // só que síncrono. Falha aqui não desfaz a análise (já concluída e válida);
    // só fica sem o selo "revisado por IA", igual ao caso "sem resposta no
    // lote de revisão" do pipeline em lote.
    const ativos = parametros.filter((p) => p.ativo);
    try {
      const revisaoSchema = montarRevisaoSchema(ativos);
      const { systemPrompt: systemPromptRevisao, transcricao: transcricaoRevisao } = montarPromptRevisao(
        mensagens,
        playbook,
        resultado,
        ativos,
      );

      const respRevisao = await fetch(`${GEMINI_API_URL}/models/${MODEL}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPromptRevisao }] },
          contents: [{ role: "user", parts: [{ text: `Interação do dia:\n\n${transcricaoRevisao}` }] }],
          generationConfig: { responseMimeType: "application/json", responseSchema: revisaoSchema },
        }),
      });

      if (!respRevisao.ok) throw new Error(`Gemini API (revisão) retornou ${respRevisao.status}: ${await respRevisao.text()}`);

      const dataRevisao = await respRevisao.json();
      const textoRevisao = dataRevisao.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!textoRevisao) throw new Error("resposta do Gemini (revisão) sem texto (bloqueada ou vazia)");

      const revisao = JSON.parse(textoRevisao);
      await supabase.from("analises").upsert(montarUpsertRevisao(conversaId, dia, revisao, ativos), { onConflict: "conversa_id,dia" });
    } catch (errRevisao) {
      await supabase.from("analises").upsert(
        {
          conversa_id: conversaId,
          dia,
          revisado: true,
          revisado_em: new Date().toISOString(),
          resumo_revisao: `Não revisada: ${errRevisao instanceof Error ? errRevisao.message : String(errRevisao)}`,
        },
        { onConflict: "conversa_id,dia" },
      );
    }

    return new Response(JSON.stringify({ ok: true, conversaId }), { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    const erro = err instanceof Error ? err.message : String(err);
    await supabase.from("analises").upsert({ conversa_id: conversaId, dia: hojeLocal, status: "falhou", erro }, { onConflict: "conversa_id,dia" });
    return new Response(JSON.stringify({ ok: false, erro }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
