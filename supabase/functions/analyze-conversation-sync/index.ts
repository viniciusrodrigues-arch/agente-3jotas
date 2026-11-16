// 1º passe do pipeline de análise: avalia uma conversa contra os critérios do
// playbook de vendas usando a Gemini API (saída estruturada via
// responseSchema, sem texto livre) — chamada síncrona, uma conversa por vez.
// Grava o resultado cru em `analises` (o que o dashboard exibe) e uma cópia
// intocada em `analises_bruta` (auditoria).
//
// O 2º passe — revisão com contexto completo da conversa — NÃO roda aqui.
// Rodar as duas passadas na mesma invocação usava EdgeRuntime.waitUntil()
// pra não travar a resposta, mas isso arrisca o 2º passe ser encerrado
// silenciosamente se o teto de tempo de background task do Supabase estourar.
// Por isso virou a função separada `analyze-conversation-review`, disparada
// por cron, que varre `analises` com `revisado=false` e roda com timeout
// próprio, sem depender de sobreviver ao fim desta requisição.
//
// Os 5 critérios em si são fixos (fluxo, fluidez, cta, clareza, playbook), mas
// nota_maxima, peso_percentual e ativo/inativo vêm de `parametros_analise` —
// mudar isso na aba Configurações do dashboard reflete na próxima análise sem
// precisar alterar código aqui.
//
// Disparo: chamada direta (Database Webhook em `analises` on insert/update de
// status='pendente', ou invocação manual) passando { conversa_id }. Útil para
// análises urgentes/avulsas; para o volume normal (mais barato), ver o par
// analysis-batch-submit / analysis-batch-poll — que AINDA usa a Anthropic
// Batch API e precisa ser migrado pra Gemini Batch separadamente.
//
// Arquivo único e autocontido (sem pasta _shared) para colar direto no editor
// do dashboard do Supabase.

import { createClient } from "jsr:@supabase/supabase-js@2";

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

// Quantas análises concluídas recentes do corretor entram no insight agregado.
const JANELA_INSIGHT = 20;
// Mínimo de análises concluídas pra valer a pena gerar um insight.
const MINIMO_PARA_INSIGHT = 3;

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
  canal: string;
  etapa_playbook: EtapaPlaybook | null;
  iniciada_em: string;
  finalizada_em: string | null;
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

// Edge Functions rodam com a service_role key por padrão (SUPABASE_SERVICE_ROLE_KEY
// é injetada automaticamente pelo runtime), então essas chamadas ignoram RLS.
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

// Clint fecha o chat e reabre com um crm_conversa_id novo quando o lead
// escreve de novo depois de um tempo — sync-clint já agrupa essas conversas
// por (lead_id, corretor_id) marcando `substituida_por_id` (ver
// consolidarPorLead lá). Aqui juntamos as mensagens de TODAS as conversas do
// grupo (a canônica + as que apontam pra ela) num único transcript, em vez
// de avaliar cada pedaço isolado — é a relação inteira com o lead, não um
// recorte arbitrário de um chat que o Clint decidiu reabrir.
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

  // Se um agente de IA qualificou o lead antes do corretor humano entrar,
  // tudo até o handoff (`humano_assumiu_em`) fica de fora — não é atendimento
  // do corretor. Cada conversa do grupo tem seu próprio handoff (um chat
  // reaberto pelo Clint normalmente já começa direto com o corretor, sem
  // fase de IA de novo).
  return (todasMensagens ?? []).filter((m: Mensagem) => {
    if (m.midia_content_type === "TEMPLATE" || /^\[Conteúdo sem texto: .+\]$/.test(m.texto.trim())) return false;
    if (m.remetente === "corretor" && (!m.autor_crm_user_id || /^(?:\*[^*]+:\*|\*?\[(?:CLOSER|SDR)\]\s+[^*\r\n]+\*?)\s*$/i.test(m.texto.trim()) || /sou a (l[ií]via|maria)[,.]?\s*assistente/i.test(m.texto))) return false;
    const handoff = handoffPorConversa.get(m.conversa_id);
    return !handoff || m.enviada_em > handoff;
  });
}

// Não tenta adivinhar em qual etapa a conversa está — o critério "playbook"
// é avaliado de forma fria e agnóstica de etapa: a IA recebe TODOS os
// playbooks ativos configurados e julga se o corretor recorreu a alguma
// dessas técnicas quando precisou, não se seguiu literalmente um script
// específico (ver descrição do critério em parametros_analise).
async function buscarPlaybooksAtivos(
  // deno-lint-ignore no-explicit-any
  supabase: any,
): Promise<string> {
  const { data, error } = await supabase.from("playbooks").select("etapa, conteudo").eq("ativo", true);

  if (error || !data?.length) {
    return "Nenhum playbook configurado — avalie com base nas boas práticas gerais de atendimento descritas no critério.";
  }

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

// Schema no formato aceito pelo Gemini (subconjunto do OpenAPI 3.0 — tipos em
// maiúsculo: OBJECT/STRING/INTEGER, sem minimum/maximum garantidos em todas
// as versões da API, então a faixa 0..notaMaxima vai só na descrição).
function criterioSchema(descricaoCriterio: string, notaMaxima: number) {
  return {
    type: "OBJECT",
    description: descricaoCriterio,
    properties: {
      score: {
        type: "INTEGER",
        description: `Nota de 0 (não atendeu) até ${notaMaxima} (atendeu plenamente).`,
      },
      evidencia: { type: "STRING", description: "Trecho literal da conversa que embasa a nota." },
      justificativa: { type: "STRING", description: "1-2 frases explicando a nota." },
    },
    required: ["score", "evidencia", "justificativa"],
  };
}

// Monta o responseSchema a partir dos parâmetros configurados — critérios
// inativos simplesmente não entram no schema, então o modelo nem os avalia.
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

  properties.justificativa_geral = {
    type: "STRING",
    description: "Resumo de 2-3 frases sobre o atendimento como um todo.",
  };
  required.push("justificativa_geral");

  return { type: "OBJECT", properties, required };
}

function montarRequestBody(
  mensagens: Mensagem[],
  playbook: string,
  // deno-lint-ignore no-explicit-any
  responseSchema: any,
) {
  const transcricao = mensagens
    .map((m) => `[${m.enviada_em}] ${m.remetente === "corretor" ? "Corretor" : "Lead"}: ${m.texto}`)
    .join("\n");

  const systemPrompt = `Você avalia atendimentos de corretores de crédito imobiliário no WhatsApp.

Playbooks configurados (técnicas/scripts de referência da imobiliária — não é
obrigatório que o corretor siga literalmente, mas devem ser usados como apoio
quando a conversa pede, ver critério "playbook" no schema para o julgamento
esperado):
"""
${playbook}
"""

Avalie a conversa abaixo estritamente contra os critérios do schema. Cite trechos
literais da conversa como evidência. Não invente informação que não está na conversa.`;

  return {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: `Conversa a avaliar:\n\n${transcricao}` }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema,
    },
  };
}

// Só grava colunas dos critérios que de fato vieram na resposta (ou seja, que
// estavam ativos no momento da análise) — os demais ficam como estavam.
// deno-lint-ignore no-explicit-any
function montarUpsertAnalise(conversaId: string, resultado: Record<string, any>) {
  // deno-lint-ignore no-explicit-any
  const upsert: Record<string, any> = {
    conversa_id: conversaId,
    status: "concluida" as const,
    justificativa_geral: resultado.justificativa_geral,
    modelo_usado: MODEL,
    erro: null,
    analisado_em: new Date().toISOString(),
    // Reanálise (conversa continuou depois de já ter sido analisada) invalida
    // qualquer revisão anterior — sem isso, o resultado novo herdaria
    // `revisado=true` de uma revisão que julgou uma versão desatualizada da
    // conversa, e o 2º passe nunca rodaria de novo sobre o resultado atual.
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

// Snapshot do 1º passe (cru), pra auditoria — mesma lógica de montarUpsertAnalise
// mas sem status/erro, já que essa tabela não representa o estado atual da análise.
// deno-lint-ignore no-explicit-any
function montarUpsertBruta(conversaId: string, resultado: Record<string, any>) {
  // deno-lint-ignore no-explicit-any
  const upsert: Record<string, any> = {
    conversa_id: conversaId,
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
  const { conversa_id } = await req.json();
  if (!conversa_id) {
    return new Response("conversa_id é obrigatório", { status: 400 });
  }

  const supabase = createServiceClient();

  const { data: conversa, error: conversaError } = await supabase
    .from("conversas")
    .select("*")
    .eq("id", conversa_id)
    .single<Conversa>();

  if (conversaError || !conversa) {
    return new Response(`conversa não encontrada: ${conversaError?.message}`, { status: 404 });
  }

  const mensagens = await buscarMensagensDoGrupo(supabase, conversa);

  // Elegibilidade: basta ter pelo menos 1 mensagem depois do handoff da IA —
  // mesmo só o corretor tendo escrito (abertura/follow-up ainda sem
  // resposta do lead) já é atendimento real e deve ser avaliado.
  if (!mensagens.length) {
    await supabase.from("analises").upsert(
      { conversa_id, status: "nao_elegivel" },
      { onConflict: "conversa_id" },
    );
    return new Response("sem mensagens após o handoff da IA para o corretor humano", { status: 422 });
  }

  await supabase.from("analises").upsert(
    { conversa_id, status: "processando" },
    { onConflict: "conversa_id" },
  );

  try {
    const [playbook, parametros] = await Promise.all([
      buscarPlaybooksAtivos(supabase),
      buscarParametrosAtivos(supabase),
    ]);
    const responseSchema = montarAvaliacaoSchema(parametros);
    const resultado = await avaliarComGemini(mensagens, playbook, responseSchema);

    await supabase.from("analises").upsert(montarUpsertAnalise(conversa_id, resultado), {
      onConflict: "conversa_id",
    });

    // Guarda o resultado cru (1º passe) intocado, pra auditoria — a revisão
    // do 2º passe sobrescreve `analises`, então sem isso perderíamos o "antes".
    await supabase.from("analises_bruta").upsert(montarUpsertBruta(conversa_id, resultado), {
      onConflict: "conversa_id",
    });

    // Em background — não trava a resposta desta análise, e um erro aqui não
    // derruba o resultado do 1º passe que já foi salvo. A revisão com
    // contexto (2º passe) roda separada, ver analyze-conversation-review.
    // deno-lint-ignore no-explicit-any
    (globalThis as any).EdgeRuntime?.waitUntil(
      atualizarInsightCorretor(supabase, conversa.corretor_id).catch((err: unknown) =>
        console.error("falha ao atualizar corretor_insights:", err),
      ),
    );

    return new Response(JSON.stringify({ ok: true, resultado }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const mensagem = err instanceof Error ? err.message : String(err);
    await supabase.from("analises").upsert(
      { conversa_id, status: "falhou", erro: mensagem },
      { onConflict: "conversa_id" },
    );
    return new Response(`falha na análise: ${mensagem}`, { status: 500 });
  }
});

async function avaliarComGemini(
  mensagens: Mensagem[],
  playbook: string,
  // deno-lint-ignore no-explicit-any
  responseSchema: any,
  // deno-lint-ignore no-explicit-any
): Promise<Record<string, any>> {
  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) throw new Error("GEMINI_API_KEY não configurada");

  const resp = await fetch(`${GEMINI_API_URL}/${MODEL}:generateContent?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(montarRequestBody(mensagens, playbook, responseSchema)),
  });

  if (!resp.ok) {
    throw new Error(`Gemini API retornou ${resp.status}: ${await resp.text()}`);
  }

  const data = await resp.json();
  const texto = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!texto) throw new Error(`resposta do Gemini sem conteúdo: ${JSON.stringify(data)}`);

  return JSON.parse(texto);
}

// Junta as análises concluídas mais recentes do corretor e pede pro Gemini um
// parágrafo curto e acionável sobre como ele pode melhorar o atendimento.
// Roda em background (EdgeRuntime.waitUntil) depois de cada análise concluída
// — não bloqueia a resposta e não derruba a análise se falhar.
async function atualizarInsightCorretor(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  corretorId: string,
): Promise<void> {
  const { data: conversasDoCorretor } = await supabase
    .from("conversas")
    .select("id")
    .eq("corretor_id", corretorId);

  const conversaIds = (conversasDoCorretor ?? []).map((c: { id: string }) => c.id);
  if (!conversaIds.length) return;

  const { data: analises } = await supabase
    .from("analises")
    .select("*")
    .eq("status", "concluida")
    .in("conversa_id", conversaIds)
    .order("analisado_em", { ascending: false })
    .limit(JANELA_INSIGHT);

  if (!analises || analises.length < MINIMO_PARA_INSIGHT) return;

  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) return;

  // deno-lint-ignore no-explicit-any
  const linhas = analises.map((a: any, i: number) => {
    // deno-lint-ignore no-explicit-any
    const pontos: string[] = CRITERIOS.map((c) => {
      const score = a[`${c}_score`];
      const justificativa = a[`${c}_justificativa`];
      if (score === null || score === undefined) return null;
      return `  - ${CRITERIO_LABEL[c]}: nota ${score} — ${justificativa ?? "sem justificativa"}`;
    }).filter(Boolean) as string[];
    return `Conversa ${i + 1}:\n${pontos.join("\n")}`;
  });

  const prompt = `Você é um coach de vendas analisando o histórico recente de atendimentos de um corretor de crédito imobiliário no WhatsApp.

Abaixo estão as ${analises.length} análises mais recentes desse corretor, com a nota e justificativa de cada critério avaliado:

${linhas.join("\n\n")}

Escreva um parágrafo curto (3-5 frases), direto e construtivo, em português, apontando o(s) padrão(ões) de melhoria mais recorrente(s) nesse corretor e uma sugestão prática de como melhorar. Não repita números de nota, fale em linguagem natural. Não use markdown.`;

  const resp = await fetch(`${GEMINI_API_URL}/${MODEL}:generateContent?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    }),
  });

  if (!resp.ok) {
    console.error(`Gemini API (insight) retornou ${resp.status}: ${await resp.text()}`);
    return;
  }

  const data = await resp.json();
  const texto = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!texto) return;

  await supabase.from("corretor_insights").upsert(
    {
      corretor_id: corretorId,
      texto,
      baseado_em_conversas: analises.length,
      gerado_em: new Date().toISOString(),
    },
    { onConflict: "corretor_id" },
  );
}
