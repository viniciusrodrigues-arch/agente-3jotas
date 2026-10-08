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
  midia_descrita?: boolean;
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

const MODEL = Deno.env.get("GEMINI_ANALYSIS_MODEL") ?? "gemini-3.6-flash";
const REVIEW_MODEL = Deno.env.get("GEMINI_REVIEW_MODEL") ?? "gemini-3.6-flash";
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
const FUSO_ANALISE = "America/Fortaleza";
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
// recorta o dia solicitado; sem dia explícito, usa o último dia com atividade.
async function buscarMensagensDoGrupo(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  conversa: Conversa,
  diaAlvo?: string,
): Promise<MensagensDoDia | null> {
  const canonicaId = conversa.substituida_por_id ?? conversa.id;

  const grupo = await db<{ id: string; humano_assumiu_em: string | null; canonica_id: string }[]>(
    supabase.rpc("gemini_grupo", { p_id: conversa.id }),
  );

  const conversaIds = (grupo ?? []).map((c: { id: string }) => c.id);
  const handoffPorConversa = new Map((grupo ?? []).map((c: { id: string; humano_assumiu_em: string | null }) => [c.id, c.humano_assumiu_em]));

  const todasMensagens: Mensagem[] = [];
  for (let offset = 0;; offset += 500) {
    let consulta = supabase.from("mensagens").select("*").in("conversa_id", conversaIds)
      .order("enviada_em", { ascending: true }).order("id", { ascending: true }).range(offset, offset + 499);
    if (diaAlvo) {
      const { inicio, fim } = limitesDia(diaAlvo);
      consulta = consulta.gte("enviada_em", inicio).lt("enviada_em", fim);
    }
    const pagina = await db<Mensagem[]>(consulta);
    todasMensagens.push(...(pagina ?? []));
    if (!pagina || pagina.length < 500) break;
  }

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

  const dia = diaAlvo ?? diaLocal(elegiveis[elegiveis.length - 1].enviada_em);
  return { dia, mensagens: elegiveis.filter((m: Mensagem) => diaLocal(m.enviada_em) === dia) };
}


async function buscarPlaybooksAtivos(
  // deno-lint-ignore no-explicit-any
  supabase: any,
): Promise<string> {
  const data = await db<{ etapa: EtapaPlaybook; conteudo: string }[]>(supabase.from("playbooks").select("etapa, conteudo").eq("ativo", true).order("etapa").order("conteudo"));
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


// Implementação local duplicada intencionalmente: cada Edge é um único index.ts.
type Registro = Record<string, any>;
interface Execucao {
  id: string; conversa_id: string; dia: string; input_hash: string; etapa: string;
  modelo: string; modalidade: string; versao: number; snapshot: Registro; resultado: Registro;
  estado: string; batch_externo: string | null; tentativas: number;
}
async function db<T = any>(consulta: PromiseLike<{ data: T | null; error: any }>): Promise<T> {
  const { data, error } = await consulta;
  if (error) throw new Error(`Banco: ${error.message}`);
  return data as T;
}
function jsonResposta(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
function autorizado(req: Request): boolean {
  const segredo = Deno.env.get("CRON_SECRET");
  return !!segredo && req.headers.get("Authorization") === `Bearer ${segredo}`;
}
function ordenarJSON(v: any): any {
  if (Array.isArray(v)) return v.map(ordenarJSON);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, ordenarJSON(v[k])]));
  return v;
}
async function hashInput(snapshot: Registro): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(ordenarJSON(snapshot)));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}
function janelaNoturna(agora = new Date()): boolean {
  const hora = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Fortaleza", hour: "2-digit", hourCycle: "h23" }).format(agora));
  return hora < 4;
}
function limitesDia(dia: string): { inicio: string; fim: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) throw new Error("Dia inválido");
  const inicio = new Date(`${dia}T00:00:00-03:00`);
  if (Number.isNaN(inicio.getTime()) || inicio.toISOString().slice(0, 10) !== dia) throw new Error("Dia inválido");
  return { inicio: inicio.toISOString(), fim: new Date(inicio.getTime() + 86400000).toISOString() };
}
function extrairJSONResposta(data: Registro, parametros: ParametroCriterio[], etapa: string): Registro {
  const c = data.candidates?.[0];
  if (data.promptFeedback?.blockReason || c?.finishReason !== "STOP") throw new Error("Resposta bloqueada, vazia ou truncada");
  const texto = c.content?.parts?.filter((p: Registro) => !p.thought && typeof p.text === "string").map((p: Registro) => p.text).join("");
  const resultado = JSON.parse(texto || "");
  for (const p of parametros.filter((p) => p.ativo)) {
    const r = resultado[p.criterio];
    if (!r || !Number.isInteger(r.score) || r.score < 0 || r.score > p.nota_maxima ||
      typeof r.evidencia !== "string" || typeof r.justificativa !== "string" ||
      (etapa === "revisao" && typeof r.mudou !== "boolean")) throw new Error(`Resultado inválido: ${p.criterio}`);
  }
  if (typeof resultado[etapa === "analise" ? "justificativa_geral" : "resumo_revisao"] !== "string") throw new Error("Resumo ausente");
  return resultado;
}
async function reservar(supabase: any, par: Registro, snapshot: Registro, etapa: string, modalidade: string, hash: string): Promise<Execucao | null> {
  const rows = await db<Execucao[]>(supabase.rpc("gemini_reservar", {
    p_conversa_id: par.conversa_id, p_dia: par.dia, p_hash: hash, p_etapa: etapa,
    p_modelo: etapa === "analise" ? snapshot.modeloAnalise : snapshot.modeloRevisao,
    p_modalidade: modalidade, p_snapshot: snapshot, p_versao: par.conteudo_versao ?? par.versao,
  }));
  return rows?.[0] ?? null;
}
async function falharExecucao(supabase: any, e: Execucao, erro: string, incerta: boolean, repetir = false): Promise<void> {
  await db(supabase.rpc("gemini_falhar", { p_id: e.id, p_erro: erro, p_incerta: incerta, p_repetir: repetir }));
}
async function concluirExecucao(supabase: any, e: Execucao, data: Registro): Promise<boolean> {
  const resultado = extrairJSONResposta(data, e.snapshot.parametros, e.etapa);
  return await db<boolean>(supabase.rpc("gemini_concluir", {
    p_id: e.id, p_resultado: resultado, p_uso: data.usageMetadata ?? null, p_modelo_retornado: data.modelVersion ?? null,
  }));
}
function requisicaoRevisao(e: Execucao): Registro {
  const { systemPrompt, transcricao } = montarPromptRevisao(e.snapshot.mensagens, e.snapshot.playbook, e.resultado, e.snapshot.parametros);
  return {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: `Interação do dia:\n\n${transcricao}` }] }],
    generationConfig: { responseMimeType: "application/json", responseSchema: e.snapshot.schemaRevisao },
  };
}
async function enviarLote(supabase: any, apiKey: string, execucoes: Execucao[], requests: Registro[]): Promise<void> {
  if (!execucoes.length) return;
  const modelo = execucoes[0].modelo;
  if (execucoes.some((e) => e.modelo !== modelo)) throw new Error("Um lote deve conter apenas um modelo");
  const body = JSON.stringify({ batch: {
    display_name: `diario-${execucoes[0].etapa}-${execucoes[0].id}`,
    input_config: { requests: { requests: requests.map((request, i) => ({ request, metadata: { key: execucoes[i].id } })) } },
  } });
  if (new TextEncoder().encode(body).byteLength >= 20_000_000) {
    for (const e of execucoes) await falharExecucao(supabase, e, "Lote excedeu 20 MB", false);
    return;
  }
  await db(supabase.rpc("gemini_marcar_envio", { p_ids: execucoes.map((e) => e.id) }));
  let resp: Response;
  try {
    resp = await fetch(`${GEMINI_API_URL}/models/${modelo}:batchGenerateContent`, {
      method: "POST", headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(40_000),
    });
  } catch {
    for (const e of execucoes) await falharExecucao(supabase, e, "Envio sem confirmação; reconciliar antes de reenviar", true);
    return;
  }
  if (!resp.ok) {
    // Resposta 5xx também pode ocorrer após o provedor aceitar a operação.
    for (const e of execucoes) await falharExecucao(supabase, e, `Batch HTTP ${resp.status}`, resp.status >= 500, resp.status === 429);
    return;
  }
  try {
    const data = await resp.json();
    if (typeof data.name !== "string") throw new Error("Batch sem identificador");
    await db(supabase.from("gemini_execucoes").update({ estado: "submetida", batch_externo: data.name, atualizada_em: new Date().toISOString() }).in("id", execucoes.map((e) => e.id)));
  } catch {
    // Preserva 'enviando': o próximo poll coloca em quarentena, sem repetir inferência.
    throw new Error("Batch aceito, mas identificação não confirmada no banco; reconciliar");
  }
}
async function executarSincrono(supabase: any, apiKey: string, e: Execucao, request: Registro): Promise<boolean> {
  await db(supabase.rpc("gemini_marcar_envio", { p_ids: [e.id] }));
  let resp: Response;
  try {
    resp = await fetch(`${GEMINI_API_URL}/models/${e.modelo}:generateContent`, {
      method: "POST", headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(request), signal: AbortSignal.timeout(40_000),
    });
  } catch {
    await falharExecucao(supabase, e, "Inferência síncrona sem confirmação", true);
    return false;
  }
  if (!resp.ok) {
    await falharExecucao(supabase, e, `Gemini HTTP ${resp.status}`, resp.status >= 500, resp.status === 429);
    return false;
  }
  const data = await resp.json();
  // Persiste uso antes de validar, inclusive respostas pagas com JSON inválido.
  await db(supabase.from("gemini_execucoes").update({ uso: data.usageMetadata ?? null, modelo_retornado: data.modelVersion ?? null }).eq("id", e.id));
  try { return await concluirExecucao(supabase, e, data); }
  catch {
    await falharExecucao(supabase, e, "Resposta inválida ou conclusão não confirmada; conferir resultado", true);
    return false;
  }
}
function criarSnapshot(conversaId: string, dia: string, mensagens: Mensagem[], parametros: ParametroCriterio[], playbook: string): Registro {
  const ordenadas = [...mensagens].sort((a, b) => a.enviada_em.localeCompare(b.enviada_em) || a.id.localeCompare(b.id))
    .map((m) => ({ id: m.id, conversa_id: m.conversa_id, remetente: m.remetente, texto: m.texto,
      enviada_em: m.enviada_em, autor_crm_user_id: m.autor_crm_user_id }));
  const ativos = [...parametros].filter((p) => p.ativo).sort((a, b) => a.criterio.localeCompare(b.criterio));
  return {
    promptVersao: "diario-v2", modeloAnalise: MODEL, modeloRevisao: REVIEW_MODEL,
    mensagens: ordenadas, parametros: ativos, playbook,
    requestAnalise: montarRequestInline(conversaId, dia, ordenadas, playbook, montarAvaliacaoSchema(ativos)).request,
    schemaRevisao: montarRevisaoSchema(ativos),
  };
}

Deno.serve(async (req) => {
  if (!autorizado(req)) return jsonResposta({ erro: "unauthorized" }, 401);
  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) return jsonResposta({ erro: "GEMINI_API_KEY não configurada" }, 500);
  const supabase = createServiceClient();
  try {
    const { conversaId, dia: diaPedido } = await req.json();
    if (typeof conversaId !== "string" || !/^[0-9a-f-]{36}$/i.test(conversaId)) return jsonResposta({ erro: "conversaId inválido" }, 400);
    if (diaPedido != null) limitesDia(diaPedido);
    const conversa = await db<Conversa | null>(supabase.from("conversas").select("*").eq("id", conversaId).maybeSingle());
    if (!conversa) return jsonResposta({ erro: "conversa não encontrada" }, 404);
    const canonica = await db<string>(supabase.rpc("gemini_canonica", { p_id: conversa.id }));
    const resultado = await buscarMensagensDoGrupo(supabase, conversa, diaPedido);
    if (!resultado || !resultado.mensagens.some((m) => m.remetente === "corretor" && m.autor_crm_user_id)) return jsonResposta({ erro: "sem atendimento humano avaliável" }, 422);
    const { dia } = resultado;
    // A inserção não modifica a versão de uma avaliação já existente.
    await db(supabase.from("analises").upsert({ conversa_id: canonica, dia }, { onConflict: "conversa_id,dia", ignoreDuplicates: true }));
    const par = await db<Registro>(supabase.from("analises").select("conversa_id,dia,conteudo_versao").eq("conversa_id", canonica).eq("dia", dia).single());
    // Ler a versão antes do conteúdo: qualquer alteração concorrente invalida a reserva.
    const atualizado = await buscarMensagensDoGrupo(supabase, conversa, dia);
    if (!atualizado || !atualizado.mensagens.some((m) => m.remetente === "corretor" && m.autor_crm_user_id)) return jsonResposta({ erro: "sem atendimento humano avaliável" }, 422);
    const mensagens = atualizado.mensagens;
    if (mensagens.some((m) => m.midia_descrita === false)) return jsonResposta({ erro: "mídia ainda pendente neste dia" }, 409);
    const parametros = await buscarParametrosAtivos(supabase);
    const playbook = await buscarPlaybooksAtivos(supabase);
    const snapshot = criarSnapshot(canonica, dia, mensagens, parametros, playbook);
    const hash = await hashInput(snapshot);
    const e = await reservar(supabase, par, snapshot, "analise", "manual", hash);
    if (!e) {
      const concluida = await db<Execucao | null>(supabase.from("gemini_execucoes").select("*").eq("conversa_id", canonica).eq("dia", dia)
        .eq("input_hash", hash).eq("etapa", "revisao").eq("estado", "concluida").maybeSingle());
      if (concluida) return jsonResposta({ ok: true, conversaId: canonica, dia, reutilizada: true });
      return jsonResposta({ erro: "avaliação em andamento, aguardando revisão ou bloqueada; nenhuma chamada duplicada foi enviada" }, 409);
    }
    const publicada = await executarSincrono(supabase, apiKey, e, snapshot.requestAnalise);
    if (!publicada) return jsonResposta({ erro: "análise não concluída ou conteúdo mudou; confira o estado da execução" }, 502);
    const primeira = await db<Execucao>(supabase.from("gemini_execucoes").select("*").eq("id", e.id).single());
    const revisao = await reservar(supabase, { conversa_id: canonica, dia, versao: e.versao }, snapshot, "revisao", "manual", hash);
    if (!revisao) return jsonResposta({ ok: true, conversaId: canonica, dia, revisao_pendente: true });
    const revisada = await executarSincrono(supabase, apiKey, revisao, requisicaoRevisao(primeira));
    return jsonResposta({ ok: true, conversaId: canonica, dia, revisado: revisada });
  } catch {
    return jsonResposta({ erro: "Falha na análise manual; confira entrada, configuração e execução registrada" }, 502);
  }
});
