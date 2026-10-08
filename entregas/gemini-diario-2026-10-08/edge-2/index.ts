// Verifica o status dos lotes em andamento na Gemini Batch API (não há
// webhook de conclusão — só polling) e, quando um lote termina, grava os
// resultados em `analises`, casando pelo `metadata.key` de cada resposta
// (= conversa_id, confirmado em teste real que a Gemini ecoa esse campo
// mesmo em batch inline).
//
// Quando um lote do tipo 'analise' (1º passe) termina com sucesso, encadeia
// automaticamente a submissão de um lote 'revisao' (2º passe) só com as
// conversas que concluíram — assim o fluxo completo roda sozinho de
// madrugada, sem precisar de um cron dedicado pra revisão (o antigo
// analyze-conversation-review, em tempo real, foi desligado — ver migration
// 0024).
//
// Disparo sugerido: pg_cron a cada 5-10 minutos, mesmo CRON_SECRET dos
// demais crons.

import { createClient } from "jsr:@supabase/supabase-js@2";

// Arquivo único e autocontido (sem pasta _shared) para colar direto no editor
// do dashboard do Supabase.

type EtapaPlaybook = "primeiro_contato" | "envio_simulacao" | "resultado_analise";
type RemetenteTipo = "corretor" | "lead";
type CriterioKey = "fluxo" | "fluidez" | "cta" | "clareza" | "playbook";

const CRITERIOS: CriterioKey[] = ["fluxo", "fluidez", "cta", "clareza", "playbook"];

const CRITERIO_LABEL: Record<CriterioKey, string> = {
  fluxo: "Fluxo Ligação/Mensagem",
  fluidez: "Fluidez",
  cta: "CTA",
  clareza: "Clareza da Informação",
  playbook: "Aderência ao Playbook",
};

interface Mensagem {
  id: string;
  conversa_id: string;
  remetente: RemetenteTipo;
  texto: string;
  enviada_em: string;
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

function createServiceClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!url || !key) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY não configuradas");
  }

  return createClient(url, key);
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

Deno.serve(async (req) => {
  if (!autorizado(req)) return jsonResposta({ erro: "unauthorized" }, 401);
  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) return jsonResposta({ erro: "GEMINI_API_KEY não configurada" }, 500);
  const supabase = createServiceClient();
  const inicio = Date.now();
  let concluidas = 0;
  try {
    // Operações antigas em envio são incertas: não gerar outra cobrança automaticamente.
    const antigas = await db<Execucao[]>(supabase.from("gemini_execucoes").select("*")
      .in("estado", ["enviando", "reservada"]).lt("lease_ate", new Date().toISOString()).limit(50));
    for (const e of antigas ?? []) await falharExecucao(supabase, e, "Operação expirada; envio requer reconciliação", e.estado === "enviando", e.estado === "reservada");
    const submetidas = await db<Execucao[]>(supabase.from("gemini_execucoes").select("*").eq("estado", "submetida")
      .or(`proxima_tentativa_em.is.null,proxima_tentativa_em.lte.${new Date().toISOString()}`).order("atualizada_em").limit(100));
    const grupos = new Map<string, Execucao[]>();
    for (const e of submetidas ?? []) {
      if (!e.batch_externo) { await falharExecucao(supabase, e, "Batch sem identificador", true); continue; }
      grupos.set(e.batch_externo, [...(grupos.get(e.batch_externo) ?? []), e]);
    }
    for (const [batchId, execucoes] of grupos) {
      if (Date.now() - inicio > 65_000) break;
      let resp: Response;
      try { resp = await fetch(`${GEMINI_API_URL}/${batchId}`, { headers: { "x-goog-api-key": apiKey }, signal: AbortSignal.timeout(15_000) }); }
      catch { await registrarFalhaPoll(supabase, execucoes, 0); continue; }
      if (!resp.ok) { await registrarFalhaPoll(supabase, execucoes, resp.status); continue; }
      const batch = await resp.json();
      if (!batch.done) {
        await db(supabase.from("gemini_execucoes").update({ poll_tentativas: 0, atualizada_em: new Date().toISOString() }).in("id", execucoes.map((e) => e.id)));
        continue;
      }
      if (batch.metadata?.state !== "BATCH_STATE_SUCCEEDED") {
        for (const e of execucoes) await falharExecucao(supabase, e, `Batch terminal: ${batch.metadata?.state ?? "desconhecido"}`, false);
        continue;
      }
      const itens: Registro[] = batch.response?.inlinedResponses?.inlinedResponses ?? [];
      const porId = new Map(itens.map((item) => [item.metadata?.key, item]));
      for (const e of execucoes) {
        const item = porId.get(e.id);
        if (!item?.response) { await falharExecucao(supabase, e, "Batch sem resposta para a execução", false); continue; }
        await db(supabase.from("gemini_execucoes").update({ uso: item.response.usageMetadata ?? null, modelo_retornado: item.response.modelVersion ?? null }).eq("id", e.id));
        try { await concluirExecucao(supabase, e, item.response); concluidas++; }
        catch { await falharExecucao(supabase, e, "Resultado inválido ou persistência não confirmada; conferir operação", true); }
      }
    }
    // A revisão é recuperável após interrupção do worker e usa o snapshot do primeiro passe.
    if (Date.now() - inicio < 65_000) {
      const primeiras = await db<Execucao[]>(supabase.rpc("gemini_pendentes_revisao"));
      const gruposRevisao = new Map<string, { execucoes: Execucao[]; requests: Registro[] }>();
      for (const primeira of primeiras ?? []) {
        if (Date.now() - inicio > 65_000) break;
        const revisao = await reservar(supabase, primeira, primeira.snapshot, "revisao", primeira.modalidade, primeira.input_hash);
        if (!revisao) continue;
        const request = requisicaoRevisao(primeira);
        if (revisao.modalidade === "manual") {
          await executarSincrono(supabase, apiKey, revisao, request);
          continue;
        }
        const grupo = gruposRevisao.get(revisao.modelo) ?? { execucoes: [], requests: [] };
        grupo.execucoes.push(revisao); grupo.requests.push(request); gruposRevisao.set(revisao.modelo, grupo);
      }
      for (const grupo of gruposRevisao.values()) {
        if (Date.now() - inicio > 100_000) break;
        await enviarLote(supabase, apiKey, grupo.execucoes, grupo.requests);
      }
    }
    return jsonResposta({ ok: true, concluidas, lotes_consultados: grupos.size });
  } catch { return jsonResposta({ erro: "Falha no poll; operações registradas preservadas para recuperação" }, 502); }
});
async function registrarFalhaPoll(supabase: any, execucoes: Execucao[], status: number): Promise<void> {
  for (const e of execucoes) {
    const n = ((e as any).poll_tentativas ?? 0) + 1;
    if ([401, 403].includes(status) || n >= (status === 404 ? 3 : 6)) {
      await falharExecucao(supabase, e, `Consulta do batch HTTP ${status}; confirmar chave/recurso antes de reenviar`, true);
    } else {
      const espera = Math.min(3600, 120 * 2 ** n) + Math.floor(Math.random() * 30);
      await db(supabase.from("gemini_execucoes").update({ poll_tentativas: n, erro: `Poll HTTP ${status}`,
        proxima_tentativa_em: new Date(Date.now() + espera * 1000).toISOString(), atualizada_em: new Date().toISOString() }).eq("id", e.id));
    }
  }
}
