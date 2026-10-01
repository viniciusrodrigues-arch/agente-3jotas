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

// `.in()` com uma lista grande de uuids gera uma URL enorme (~36 chars por
// id) que já causou erro de protocolo HTTP/2 vindo do Supabase quando o
// lote estava grande (ver mesmo comentário em analysis-batch-submit) —
// busca/atualiza em pedaços menores pra não depender do tamanho do lote.
const TAMANHO_LOTE_IN = 100;

// deno-lint-ignore no-explicit-any
async function buscarEmLotes<T>(supabase: any, tabela: string, colunas: string, coluna: string, ids: string[]): Promise<T[]> {
  const resultado: T[] = [];
  for (let i = 0; i < ids.length; i += TAMANHO_LOTE_IN) {
    const lote = ids.slice(i, i + TAMANHO_LOTE_IN);
    const { data } = await supabase.from(tabela).select(colunas).in(coluna, lote);
    resultado.push(...((data ?? []) as T[]));
  }
  return resultado;
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

// Ver consolidarPorLead em sync-clint — junta as mensagens de todas as
// conversas do mesmo grupo (lead_id + corretor_id), não só a canônica.
//
// A avaliação (1º passe e revisão) é só da interação MAIS RECENTE, não do
// histórico inteiro do lead — ver mesmo comentário em analysis-batch-submit.
// Precisa ser a MESMA janela de dia nos dois passes, senão a revisão
// releria mensagens diferentes das que embasaram a nota original.
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
    .order("enviada_em", { ascending: true });

  const elegiveis = ((todasMensagens ?? []) as Mensagem[]).filter((m) => {
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
  const { data } = await supabase.from("parametros_analise").select("criterio, nota_maxima, peso_percentual, descricao, ativo");
  return (data ?? []) as ParametroCriterio[];
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
function montarUpsertAnalise(conversaId: string, dia: string, resultado: Record<string, any>, loteId: string) {
  // deno-lint-ignore no-explicit-any
  const upsert: Record<string, any> = {
    conversa_id: conversaId,
    dia,
    status: "concluida" as const,
    justificativa_geral: resultado.justificativa_geral,
    modelo_usado: MODEL,
    erro: null,
    analisado_em: new Date().toISOString(),
    // Reanálise (chegou msg nova numa conversa já com lote antigo) invalida
    // qualquer revisão anterior — mesmo raciocínio do sync-clint.
    revisado: false,
    revisado_em: null,
    resumo_revisao: null,
    batch_id: loteId,
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

// deno-lint-ignore no-explicit-any
function montarUpsertRevisao(conversaId: string, dia: string, revisao: Record<string, any>, ativos: ParametroCriterio[], loteId: string) {
  // deno-lint-ignore no-explicit-any
  const upsert: Record<string, any> = {
    conversa_id: conversaId,
    dia,
    revisado: true,
    revisado_em: new Date().toISOString(),
    resumo_revisao: revisao.resumo_revisao ?? null,
    batch_id: loteId,
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

interface ItemResultado {
  metadata?: { key?: string; dia?: string };
  response?: { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  error?: unknown;
}

// Confirmado em produção que a Gemini Batch API ecoa o metadata inteiro
// (não só `key`) — usa item.metadata.dia direto, sem query nenhuma. Só cai
// no recálculo (1-2 queries) se por algum motivo vier ausente — isso evita
// o gargalo de fazer uma consulta ao banco por item do lote: com lotes de
// 100-300+ itens, resolver o dia sempre via query sequencial estourava o
// timeout da function e deixava o lote preso em 'in_progress' pra sempre
// (o poll nunca terminava de processar os itens, então nunca marcava o
// batch como 'ended').
async function resolverDiaDaConversa(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  conversaId: string,
): Promise<string | null> {
  const { data: conversa } = await supabase
    .from("conversas")
    .select("id, lead_id, corretor_id, etapa_playbook, humano_assumiu_em, substituida_por_id")
    .eq("id", conversaId)
    .maybeSingle();

  if (!conversa) return null;

  const resultado = await buscarMensagensDoGrupo(supabase, conversa as Conversa);
  return resultado?.dia ?? null;
}

async function resolverDia(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  item: ItemResultado,
  conversaId: string,
): Promise<string | null> {
  if (item.metadata?.dia) return item.metadata.dia;
  return resolverDiaDaConversa(supabase, conversaId);
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

  const { data: lotesEmAndamento, error: lotesError } = await supabase
    .from("analise_batches")
    .select("id, batch_id_externo, tipo")
    .eq("status", "in_progress");

  if (lotesError) {
    return new Response(`erro ao buscar lotes: ${lotesError.message}`, { status: 500 });
  }

  if (!lotesEmAndamento?.length) {
    return new Response(JSON.stringify({ ok: true, verificados: 0, concluidos: 0 }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  let concluidos = 0;
  const detalhes: Record<string, string> = {};

  for (const lote of lotesEmAndamento) {
    const statusResp = await fetch(`${GEMINI_API_URL}/${lote.batch_id_externo}`, {
      headers: { "x-goog-api-key": apiKey },
    });

    if (!statusResp.ok) {
      detalhes[lote.batch_id_externo] = `erro ao consultar status: ${statusResp.status}`;
      continue;
    }

    // deno-lint-ignore no-explicit-any
    const batch: any = await statusResp.json();
    const estado = batch.metadata?.state as string | undefined;

    if (!batch.done || estado === "BATCH_STATE_PENDING" || estado === "BATCH_STATE_RUNNING") {
      detalhes[lote.batch_id_externo] = `ainda em andamento (${estado ?? "desconhecido"})`;
      continue;
    }

    if (estado !== "BATCH_STATE_SUCCEEDED") {
      await supabase.from("analises").update({ status: "falhou", erro: `lote ${estado}` }).eq("batch_id", lote.id);
      await supabase
        .from("analise_batches")
        .update({ status: "falhou", erro: estado, concluido_em: new Date().toISOString() })
        .eq("id", lote.id);
      detalhes[lote.batch_id_externo] = `falhou: ${estado}`;
      continue;
    }

    try {
      const itens = (batch.response?.inlinedResponses?.inlinedResponses ?? []) as ItemResultado[];
      let succeeded = 0;
      let errored = 0;

      if (lote.tipo === "analise") {
        const analisesOk: { conversa_id: string; dia: string }[] = [];

        for (const item of itens) {
          const conversaId = item.metadata?.key;
          if (!conversaId) continue;

          const dia = await resolverDia(supabase, item, conversaId);
          if (!dia) {
            // Sem mensagens elegíveis mais (ex: conversa foi limpa/alterada
            // entre o submit e agora) — usa hoje só como chave de upsert,
            // mesma convenção do submit.
            await supabase.from("analises").upsert(
              { conversa_id: conversaId, dia: diaLocal(new Date().toISOString()), status: "falhou", erro: "conversa sem mensagens elegíveis no momento do poll", batch_id: lote.id },
              { onConflict: "conversa_id,dia" },
            );
            errored++;
            continue;
          }

          const texto = item.response?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!texto) {
            await supabase.from("analises").upsert(
              { conversa_id: conversaId, dia, status: "falhou", erro: `sem resposta no lote: ${JSON.stringify(item.error ?? "desconhecido")}`, batch_id: lote.id },
              { onConflict: "conversa_id,dia" },
            );
            errored++;
            continue;
          }

          try {
            const resultado = JSON.parse(texto);
            await supabase.from("analises").upsert(montarUpsertAnalise(conversaId, dia, resultado, lote.id), { onConflict: "conversa_id,dia" });
            await supabase.from("analises_bruta").upsert(montarUpsertBruta(conversaId, dia, resultado), { onConflict: "conversa_id,dia" });
            analisesOk.push({ conversa_id: conversaId, dia });
            succeeded++;
          } catch (err) {
            await supabase.from("analises").upsert(
              { conversa_id: conversaId, dia, status: "falhou", erro: `parsing: ${err instanceof Error ? err.message : String(err)}`, batch_id: lote.id },
              { onConflict: "conversa_id,dia" },
            );
            errored++;
          }
        }

        // Encadeia o 2º passe automaticamente — sem depender de nenhum cron
        // separado pra revisão acontecer.
        if (analisesOk.length) {
          await submeterLoteRevisao(supabase, apiKey, analisesOk);
        }
      } else {
        // tipo === "revisao"
        const parametros = await buscarParametrosAtivos(supabase);
        const ativos = parametros.filter((p) => p.ativo);

        for (const item of itens) {
          const conversaId = item.metadata?.key;
          if (!conversaId) continue;

          const dia = await resolverDia(supabase, item, conversaId);
          if (!dia) {
            errored++;
            continue;
          }

          const texto = item.response?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!texto) {
            await supabase.from("analises").upsert(
              {
                conversa_id: conversaId,
                dia,
                revisado: true,
                revisado_em: new Date().toISOString(),
                resumo_revisao: "Não revisada: sem resposta no lote de revisão.",
                batch_id: lote.id,
              },
              { onConflict: "conversa_id,dia" },
            );
            errored++;
            continue;
          }

          try {
            const revisao = JSON.parse(texto);
            await supabase.from("analises").upsert(montarUpsertRevisao(conversaId, dia, revisao, ativos, lote.id), { onConflict: "conversa_id,dia" });
            succeeded++;
          } catch (err) {
            await supabase.from("analises").upsert(
              {
                conversa_id: conversaId,
                dia,
                revisado: true,
                revisado_em: new Date().toISOString(),
                resumo_revisao: `Não revisada: parsing falhou (${err instanceof Error ? err.message : String(err)}).`,
                batch_id: lote.id,
              },
              { onConflict: "conversa_id,dia" },
            );
            errored++;
          }
        }
      }

      await supabase
        .from("analise_batches")
        .update({ status: "ended", concluido_em: new Date().toISOString(), succeeded_count: succeeded, errored_count: errored })
        .eq("id", lote.id);

      concluidos++;
      detalhes[lote.batch_id_externo] = `concluído (${lote.tipo}): ${succeeded} ok, ${errored} com erro`;
    } catch (err) {
      const mensagem = err instanceof Error ? err.message : String(err);
      await supabase
        .from("analise_batches")
        .update({ status: "falhou", erro: mensagem, concluido_em: new Date().toISOString() })
        .eq("id", lote.id);
      detalhes[lote.batch_id_externo] = `falhou: ${mensagem}`;
    }
  }

  return new Response(JSON.stringify({ ok: true, verificados: lotesEmAndamento.length, concluidos, detalhes }), {
    headers: { "Content-Type": "application/json" },
  });
});

// Monta e envia um novo lote (tipo 'revisao') pras conversas que acabaram de
// concluir o 1º passe com sucesso — é isso que faz o 2º passe acontecer
// sozinho, sem precisar de um cron dedicado só pra revisão.
async function submeterLoteRevisao(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  apiKey: string,
  concluidos: { conversa_id: string; dia: string }[],
): Promise<void> {
  const conversaIds = concluidos.map((c) => c.conversa_id);
  const diaPorConversa = new Map(concluidos.map((c) => [c.conversa_id, c.dia]));

  const conversas = await buscarEmLotes<Conversa>(
    supabase,
    "conversas",
    "id, lead_id, corretor_id, etapa_playbook, humano_assumiu_em, substituida_por_id",
    "id",
    conversaIds,
  );

  if (!conversas.length) return;

  // Uma conversa pode ter várias linhas em analises_bruta (uma por dia já
  // processado historicamente) — chave composta pra pegar só a do dia que
  // acabou de sair do 1º passe, não uma linha antiga de outro dia.
  // deno-lint-ignore no-explicit-any
  const brutas = await buscarEmLotes<any>(supabase, "analises_bruta", "*", "conversa_id", conversaIds);
  const brutaPorConversaEDia = new Map(
    (brutas ?? []).map((b: { conversa_id: string; dia: string }) => [`${b.conversa_id}|${b.dia}`, b]),
  );

  const parametros = await buscarParametrosAtivos(supabase);
  const ativos = parametros.filter((p) => p.ativo);
  if (!ativos.length) return;

  const playbook = await buscarPlaybooksAtivos(supabase);
  const responseSchema = montarRevisaoSchema(ativos);

  const requests: unknown[] = [];
  const semBruta: string[] = [];

  for (const conversa of conversas) {
    const dia = diaPorConversa.get(conversa.id);
    if (!dia) {
      semBruta.push(conversa.id);
      continue;
    }

    // deno-lint-ignore no-explicit-any
    const bruta = brutaPorConversaEDia.get(`${conversa.id}|${dia}`) as any;
    if (!bruta) {
      semBruta.push(conversa.id);
      continue;
    }

    const resultado = await buscarMensagensDoGrupo(supabase, conversa);
    if (!resultado || resultado.dia !== dia || !resultado.mensagens.length) {
      // Última atividade mudou entre o 1º passe e agora (ex: chegou mensagem
      // nova nesse meio-tempo) — deixa pra próxima rodada tratar o dia novo,
      // não revisa com mensagens que não batem com a avaliação original.
      semBruta.push(conversa.id);
      continue;
    }
    const { mensagens } = resultado;

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
      semBruta.push(conversa.id);
      continue;
    }

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

    requests.push({
      request: {
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: `Interação do dia:\n\n${transcricao}` }] }],
        generationConfig: { responseMimeType: "application/json", responseSchema },
      },
      // Sem o dia, o poll da revisão refazia consultas por item e estourava
      // o timeout em lotes grandes.
      metadata: { key: conversa.id, dia },
    });
  }

  if (semBruta.length) {
    await supabase.from("analises").upsert(
      semBruta
        .map((id) => {
          const dia = diaPorConversa.get(id);
          if (!dia) return null;
          return {
            conversa_id: id,
            dia,
            revisado: true,
            revisado_em: new Date().toISOString(),
            resumo_revisao: "Não revisada: sem análise crua ou mensagens pra revisar.",
          };
        })
        .filter((row): row is NonNullable<typeof row> => row !== null),
      { onConflict: "conversa_id,dia" },
    );
  }

  if (!requests.length) return;

  const resp = await fetch(`${GEMINI_API_URL}/models/${MODEL}:batchGenerateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      batch: {
        display_name: `revisao-${new Date().toISOString().slice(0, 10)}`,
        input_config: { requests: { requests } },
      },
    }),
  });

  if (!resp.ok) {
    console.error(`falha ao submeter lote de revisão: ${resp.status} ${await resp.text()}`);
    return;
  }

  const batch = await resp.json();

  const { data: registroBatch } = await supabase
    .from("analise_batches")
    .insert({ batch_id_externo: batch.name, tipo: "revisao", status: "in_progress", total_requests: requests.length })
    .select("id")
    .single();

  if (registroBatch) {
    // Upsert (não update) por (conversa_id, dia): um update filtrando só por
    // conversa_id atingiria todas as linhas históricas da conversa (uma por
    // dia já analisado antes), não só a linha do dia que está entrando
    // nesse lote de revisão.
    const paresComRequest = conversas
      .filter((c) => !semBruta.includes(c.id))
      .map((c) => ({ conversa_id: c.id, dia: diaPorConversa.get(c.id)!, batch_id: registroBatch.id }));

    for (let i = 0; i < paresComRequest.length; i += TAMANHO_LOTE_IN) {
      const lote = paresComRequest.slice(i, i + TAMANHO_LOTE_IN);
      await supabase.from("analises").upsert(lote, { onConflict: "conversa_id,dia" });
    }
  }
}
