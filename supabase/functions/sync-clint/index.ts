// Sincroniza conversas e mensagens do Clint (CRM/WhatsApp) para o Supabase.
//
// Cadeia de descoberta (a API do Clint não tem "listar tudo" sem filtro):
//   GET /v2/channel-accounts                            → contas conectadas
//   GET /v2/chats/channel-account/{channelAccountId}     → chats de cada conta
//   GET /v2/messages/chat/{chatId}                       → mensagens de cada chat
//
// Escopo: desde o início de ONTEM (00:00 UTC) até agora — não faz backfill
// de histórico anterior a isso. A janela inclui o dia anterior de propósito
// (ver comentário perto do cálculo do cursor): garante que nada se perde se
// uma execução truncar perto da virada do dia. Roda de novo a cada execução
// sobre a mesma janela; os upserts são idempotentes
// (crm_conversa_id/crm_mensagem_id), então reprocessar não duplica nada. Ao
// final de cada conversa com mensagem nova, marca `analises.status =
// pendente` para entrar na fila do motor de análise (analysis-batch-submit).
//
// Mídia (áudio/imagem/documento) NÃO é descrita aqui — só grava um
// placeholder e marca `midia_descrita = false` (ver montarCamposMensagem);
// quem descreve de fato é a function processar-midia-pendente, em lotes
// pequenos e separados, pra não competir pelo orçamento de tempo deste sync.
//
// Disparo sugerido: pg_cron a cada N minutos, mesmo CRON_SECRET dos demais crons.

import { createClient } from "jsr:@supabase/supabase-js@2";

// Arquivo único e autocontido (sem pasta _shared) para colar direto no editor
// do dashboard do Supabase.

function createServiceClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!url || !key) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY não configuradas");
  }

  return createClient(url, key);
}

// --- Client mínimo para a API do Clint (CRM/WhatsApp) -----------------------
// Só o necessário para listar canais, chats e mensagens (paginação
// PaginatedV2: page/limit/has_next).

interface ClintChannelAccount {
  id: string;
  name: string;
  type: "WHATSAPP_OFFICIAL" | "WHATSAPP" | "INSTAGRAM";
  status: "CONNECTED" | "DISCONNECTED" | "CANCELLED";
  identifier: string | null;
}

interface ClintChat {
  id: string;
  created_at: string;
  contact_id: string;
  user_id: string;
  status: string;
  closed_at: string | null;
  channel_account_id: string;
}

interface ClintMessage {
  id: string;
  created_at: string;
  chat_id: string | null;
  content: string | null;
  type: "USER" | "CUSTOMER" | "EVENT" | "NOTE";
  content_type: string;
  content_url: string | null;
  // Só vem preenchido pra content_type=DOCUMENT (mimeType real do arquivo —
  // pode ser um PDF de verdade ou uma imagem mandada "como documento").
  content_object: { name?: string; mimeType?: string } | null;
  // Vem `null` quando quem escreveu foi a IA de qualificação (ela não usa
  // uma conta própria no Clint) e com o crm_id do corretor quando foi um
  // humano — é o sinal estruturado que usamos pra achar o handoff, em vez
  // de adivinhar pelo texto da mensagem.
  user_id: string | null;
}

interface PaginatedResponse<T> {
  data: T[];
  has_next: boolean;
}

// /v2/deals é o único endpoint com nome/telefone reais do lead e nome real
// do corretor (nas outras rotas só vem contact_id/user_id, sem nome). Não
// tem endpoint de busca por id único (contact/{id}, user/{id} — testado,
// 404), só filtro de listagem. E o formato de paginação é diferente do
// resto da API (totalCount/hasNext em vez de has_next), então usa fetch
// próprio em vez de `listarTudo`.
interface ClintDeal {
  id: string;
  user: { id: string; full_name: string } | null;
  contact: { id: string; name: string | null; phone: string | null } | null;
}

function createClintClient() {
  const apiKey = Deno.env.get("CLINT_API_KEY");
  const baseUrl = Deno.env.get("CLINT_BASE_URL") ?? "https://api.clint.digital";
  if (!apiKey) throw new Error("CLINT_API_KEY não configurada");

  async function listarTudo<T>(path: string, params: Record<string, string | undefined> = {}): Promise<T[]> {
    const itens: T[] = [];
    let page = 1;
    const limit = 200;

    while (true) {
      const url = new URL(`${baseUrl}${path}`);
      url.searchParams.set("page", String(page));
      url.searchParams.set("limit", String(limit));
      for (const [chave, valor] of Object.entries(params)) {
        if (valor) url.searchParams.set(chave, valor);
      }

      const resp = await fetch(url, { headers: { "api-token": apiKey! } });
      if (!resp.ok) {
        throw new Error(`Clint API ${path} retornou ${resp.status}: ${await resp.text()}`);
      }

      const body = (await resp.json()) as PaginatedResponse<T>;
      itens.push(...body.data);

      if (!body.has_next || body.data.length === 0) break;
      page++;
    }

    return itens;
  }

  async function buscarDeals(params: Record<string, string | undefined>): Promise<ClintDeal[]> {
    const url = new URL(`${baseUrl}/v2/deals`);
    url.searchParams.set("limit", "200");
    for (const [chave, valor] of Object.entries(params)) {
      if (valor) url.searchParams.set(chave, valor);
    }

    const resp = await fetch(url, { headers: { "api-token": apiKey! } });
    if (!resp.ok) throw new Error(`Clint API /v2/deals retornou ${resp.status}: ${await resp.text()}`);

    const body = await resp.json();
    return (body.data ?? []) as ClintDeal[];
  }

  return {
    listarContas: (params: Record<string, string | undefined> = {}) =>
      listarTudo<ClintChannelAccount>("/v2/channel-accounts", params),
    listarChatsDaConta: (channelAccountId: string, params: Record<string, string | undefined> = {}) =>
      listarTudo<ClintChat>(`/v2/chats/channel-account/${channelAccountId}`, params),
    listarMensagensDoChat: (chatId: string, params: Record<string, string | undefined> = {}) =>
      listarTudo<ClintMessage>(`/v2/messages/chat/${chatId}`, params),
    // Primeira página (200 mais recentes), sem filtro — na prática já cobre
    // os corretores ativos, porque eles aparecem como dono em vários
    // negócios recentes. Usado só pra montar o mapa de nomes, não precisa
    // de todas as 20mil+ linhas.
    buscarPrimeiraPaginaDeals: () => buscarDeals({}),
    buscarContatoPorId: async (contactId: string) => {
      const deals = await buscarDeals({ contact_id: contactId, limit: "1" });
      return deals[0]?.contact ?? null;
    },
    // Fallback quando o corretor não apareceu na amostra de
    // buscarPrimeiraPaginaDeals (corretor novo, poucos deals ainda, nenhum
    // deles entre os 200 mais recentes globais) — busca só os deals DESSE
    // user_id específico. Confirmado em teste real que a Clint filtra de
    // verdade por user_id (não ignora o parâmetro).
    //
    // limit=1 não é confiável sozinho: o deal mais recente pode ter
    // `user: null` (ex: deal fechado por esse user_id via `won_by`, mas sem
    // o objeto `user` populado no retorno) mesmo havendo outros deals do
    // mesmo user_id com `user` preenchido — confirmado em teste real com 3
    // corretores que ficaram presos no placeholder por causa disso. Busca
    // uma amostra maior e usa o primeiro deal com `user` de fato presente.
    buscarNomePorUserId: async (userId: string): Promise<string | null> => {
      const deals = await buscarDeals({ user_id: userId, limit: "50" });
      const comUser = deals.find((d) => d.user?.full_name);
      return comUser?.user?.full_name ?? null;
    },
  };
}

// Limite de segurança por execução — mesmo escopo sendo só ontem+hoje, um dia
// de pico pode ter muitos chats; corta aqui para não estourar o limite de
// recursos da Edge Function (WORKER_RESOURCE_LIMIT). Se truncar, a próxima
// execução (cron ou botão) reprocessa o dia inteiro de novo — inofensivo,
// os upserts são idempotentes por crm_conversa_id/crm_mensagem_id.
// Baixado de 100 pra 20 quando a descrição de mídia (download + base64 +
// chamada Gemini por áudio/imagem/documento) ainda rodava dentro deste loop
// e estourava esse limite com frequência. Essa parte foi movida pra
// processar-midia-pendente (function separada) — o sync voltou a ser leve,
// então esse valor provavelmente pode subir de novo; não subimos ainda por
// falta de validação em produção.
const MAX_CHATS_POR_EXECUCAO = 20;

// Teto de quantos chats a função examina no total (incluindo os já
// sincronizados, que são baratos de pular) — segurança pra não rodar sobre
// um dia inteiro de chats antigos numa única invocação mesmo quando nenhum
// deles conta pro teto acima.
// Com 300, a função podia recomeçar sempre nos mesmos chats e nunca alcançar
// o restante da janela de ontem+hoje (especialmente nas últimas contas).
const MAX_CHATS_EXAMINADOS_POR_EXECUCAO = 2000;

Deno.serve(async (req) => {
  const authHeader = req.headers.get("Authorization");
  const cronSecret = Deno.env.get("CRON_SECRET");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return new Response("unauthorized", { status: 401 });
  }

  const supabase = createServiceClient();
  let clint;
  try {
    clint = createClintClient();
  } catch (err) {
    return new Response(err instanceof Error ? err.message : String(err), { status: 500 });
  }

  // Janela = desde o início de ONTEM (não hoje) — se o cursor fosse sempre
  // "hoje 00:00", uma execução que rodasse logo depois da virada do dia (ou
  // que ainda estivesse truncando por WORKER_RESOURCE_LIMIT quando o dia
  // virou) perderia pra sempre o que sobrou de ontem: o cursor pularia
  // direto pro novo dia e ninguém nunca mais pediria esses chats de novo à
  // Clint. Cobrindo ontem+hoje toda vez, qualquer trabalho que ficou pra
  // trás é sempre retomado na próxima execução — o "skip já sincronizado"
  // (ver dentro de sincronizarChat) garante que isso não sai caro.
  const inicioOntem = new Date();
  inicioOntem.setUTCDate(inicioOntem.getUTCDate() - 1);
  inicioOntem.setUTCHours(0, 0, 0, 0);
  const cursor = inicioOntem.toISOString();

  // Nome real do corretor (best-effort) — se a chamada falhar ou o corretor
  // não aparecer na primeira página, cai no placeholder de sempre em
  // upsertCorretor. Buscado uma vez por execução, não por chat.
  const nomesCorretor = new Map<string, string>();
  try {
    const deals = await clint.buscarPrimeiraPaginaDeals();
    for (const d of deals) {
      if (d.user?.id && d.user.full_name) nomesCorretor.set(d.user.id, d.user.full_name);
    }
  } catch {
    // segue sem nomes reais — não é crítico pra sincronização em si
  }

  let chatsProcessados = 0;
  let chatsExaminados = 0;
  let mensagensGravadas = 0;
  let truncado = false;
  const erros: string[] = [];

  try {
    const contas = await clint.listarContas();

    contasLoop: for (const conta of contas) {
      if (conta.status !== "CONNECTED") continue;

      const chats = await clint.listarChatsDaConta(conta.id, { last_message_at_start: cursor });

      for (const chat of chats) {
        // Duas contagens separadas: `chatsProcessados` só sobe quando o chat
        // trouxe mensagem nova de verdade (é isso que estoura o orçamento —
        // transcrição de áudio, chamadas de handoff/elegibilidade). Chats já
        // sincronizados em execuções anteriores hoje são baratos de pular
        // (só a listagem na Clint), então não contam pra esse teto — senão
        // o sync nunca avançava pros chats seguintes quando truncava.
        // `chatsExaminados` é só uma trava de segurança pra não examinar um
        // dia inteiro de chats já sincronizados numa única invocação.
        if (chatsProcessados >= MAX_CHATS_POR_EXECUCAO || chatsExaminados >= MAX_CHATS_EXAMINADOS_POR_EXECUCAO) {
          truncado = true;
          break contasLoop;
        }
        chatsExaminados++;

        try {
          const resultado = await sincronizarChat(supabase, clint, chat, conta.type, cursor, nomesCorretor);
          if (resultado.mensagensGravadas > 0) chatsProcessados++;
          mensagensGravadas += resultado.mensagensGravadas;
        } catch (err) {
          erros.push(`chat ${chat.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  } catch (err) {
    return new Response(`falha na sincronização: ${err instanceof Error ? err.message : String(err)}`, {
      status: 502,
    });
  }

  return new Response(
    JSON.stringify({
      ok: true,
      chats_processados: chatsProcessados,
      chats_examinados: chatsExaminados,
      mensagens_gravadas: mensagensGravadas,
      truncado,
      erros,
    }),
    { headers: { "Content-Type": "application/json" } },
  );
});

async function sincronizarChat(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  clint: ReturnType<typeof createClintClient>,
  chat: ClintChat,
  tipoCanal: string,
  cursor: string,
  nomesCorretor: Map<string, string>,
): Promise<{ mensagensGravadas: number }> {
  const corretorId = await upsertCorretor(supabase, clint, chat.user_id, nomesCorretor);
  const leadId = await upsertLead(supabase, clint, chat.contact_id);
  if (!corretorId || !leadId) return { mensagensGravadas: 0 };

  const { data: conversa, error: conversaError } = await supabase
    .from("conversas")
    .upsert(
      {
        crm_conversa_id: chat.id,
        lead_id: leadId,
        corretor_id: corretorId,
        canal: tipoCanal.toLowerCase(),
        iniciada_em: chat.created_at,
        finalizada_em: chat.closed_at,
      },
      { onConflict: "crm_conversa_id" },
    )
    .select("id")
    .single();

  if (conversaError || !conversa) {
    throw new Error(`upsert conversa falhou: ${conversaError?.message}`);
  }

  const mensagens = await clint.listarMensagensDoChat(chat.id, { updated_at_start: cursor });
  let mensagensGravadas = 0;

  // Sem isso, toda execução re-baixava e re-transcrevia áudios já gravados
  // em execuções anteriores no mesmo dia — caro (chamada Gemini por áudio) e
  // também o motivo do sync nunca avançar pros próximos chats quando
  // truncava: o "trabalho" reaparecia idêntico a cada chamada.
  const { data: existentes } = await supabase
    .from("mensagens")
    .select("crm_mensagem_id")
    .eq("conversa_id", conversa.id);
  const idsExistentes = new Set((existentes ?? []).map((m: { crm_mensagem_id: string }) => m.crm_mensagem_id));

  for (const msg of mensagens) {
    if (idsExistentes.has(msg.id)) continue;

    const remetente = mapearRemetente(msg.type);
    if (!remetente) continue; // EVENT/NOTE não são mensagens de conversa

    const campos = montarCamposMensagem(msg, remetente);
    const { error } = await supabase.from("mensagens").upsert(
      {
        crm_mensagem_id: msg.id,
        conversa_id: conversa.id,
        remetente,
        texto: campos.texto,
        enviada_em: msg.created_at,
        autor_crm_user_id: remetente === "corretor" ? msg.user_id : null,
        midia_content_type: campos.midiaContentType,
        midia_content_url: campos.midiaContentUrl,
        midia_mime_type: campos.midiaMimeType,
        midia_nome: campos.midiaNome,
        midia_descrita: campos.midiaDescrita,
      },
      { onConflict: "crm_mensagem_id" },
    );

    if (!error) mensagensGravadas++;
  }

  if (mensagensGravadas > 0) {
    const aindaCanonica = await consolidarPorLead(supabase, conversa.id, leadId, corretorId, chat.created_at);
    // Se essa conversa acabou de ser consolidada em outra (deixou de ser a
    // canônica do grupo), não mexe no status dela — senão sobrescreveria o
    // 'consolidada' que consolidarPorLead acabou de gravar, reabrindo pra
    // análise uma conversa que não deveria mais ser analisada isoladamente.
    if (aindaCanonica) {
      await atualizarHandoffIA(supabase, conversa.id);
      await atualizarStatusAnalise(supabase, conversa.id);
    }
  }

  return { mensagensGravadas };
}

// Clint fecha o chat e reabre com um crm_conversa_id novo quando o lead
// manda mensagem depois de um tempo — sem isso, cada pedaço vira uma
// análise isolada, perdendo o contexto da relação inteira com o lead.
// Agrupa por (lead_id, corretor_id) dentro de uma janela de dias: a
// conversa mais recente do grupo fica "canônica" (é a que segue sendo
// analisada e contando no ranking); as demais apontam `substituida_por_id`
// pra ela e ganham status 'consolidada' em `analises`.
const JANELA_CONSOLIDACAO_DIAS = 120;

// Retorna `false` quando a conversa passada acaba de ser consolidada em
// outra (deixou de ser canônica) — quem chama usa isso pra não reabrir a
// análise dela depois.
async function consolidarPorLead(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  conversaId: string,
  leadId: string,
  corretorId: string,
  iniciadaEm: string,
): Promise<boolean> {
  const { data: atual } = await supabase
    .from("conversas")
    .select("substituida_por_id")
    .eq("id", conversaId)
    .single();
  if (atual?.substituida_por_id) return false; // já resolvida numa execução anterior

  const inicioMs = new Date(iniciadaEm).getTime();
  const janelaMs = JANELA_CONSOLIDACAO_DIAS * 24 * 60 * 60 * 1000;
  const janelaInicio = new Date(inicioMs - janelaMs).toISOString();
  const janelaFim = new Date(inicioMs + janelaMs).toISOString();

  const { data: candidatas } = await supabase
    .from("conversas")
    .select("id, iniciada_em")
    .eq("lead_id", leadId)
    .eq("corretor_id", corretorId)
    .is("substituida_por_id", null)
    .neq("id", conversaId)
    .gte("iniciada_em", janelaInicio)
    .lte("iniciada_em", janelaFim);

  if (!candidatas?.length) return true;

  // Canônica = quem tem a mensagem mais recente de verdade, não quem foi
  // "criada" por último — o Clint às vezes continua postando no chat_id
  // antigo em vez de abrir um novo, então "iniciada_em" mais recente pode
  // estar sem nenhuma mensagem enquanto a atividade real continua na mais
  // antiga. Pega a última `enviada_em` de cada conversa do grupo (ordenado
  // desc, primeira ocorrência por conversa já é a mais recente dela).
  const grupoIds = [...candidatas.map((c: { id: string }) => c.id), conversaId];
  const { data: ultimasMensagens } = await supabase
    .from("mensagens")
    .select("conversa_id, enviada_em")
    .in("conversa_id", grupoIds)
    .order("enviada_em", { ascending: false });

  const ultimaAtividade = new Map<string, string>();
  for (const m of ultimasMensagens ?? []) {
    if (!ultimaAtividade.has(m.conversa_id)) ultimaAtividade.set(m.conversa_id, m.enviada_em);
  }

  const grupo = [...candidatas, { id: conversaId, iniciada_em: iniciadaEm }].sort((a, b) => {
    const atividadeA = ultimaAtividade.get(a.id) ?? a.iniciada_em;
    const atividadeB = ultimaAtividade.get(b.id) ?? b.iniciada_em;
    return new Date(atividadeB).getTime() - new Date(atividadeA).getTime();
  });
  const canonicaId = grupo[0].id;

  for (const antiga of grupo.slice(1)) {
    await supabase.from("conversas").update({ substituida_por_id: canonicaId }).eq("id", antiga.id);
    // update (não upsert): marca 'consolidada' em TODAS as linhas existentes
    // dessa conversa (uma por dia já analisado) — um upsert com chave
    // composta criaria uma linha nova com dia arbitrário em vez de marcar as
    // que já existem. Se a conversa antiga não tiver nenhuma linha em
    // analises ainda, não há o que consolidar (nada a fazer).
    await supabase.from("analises").update({ status: "consolidada" }).eq("conversa_id", antiga.id);
  }

  return canonicaId === conversaId;
}

// `humano_assumiu_em` marca o fim da fase da IA — quem lê usa
// `enviada_em > humano_assumiu_em` pra pegar só o que veio depois (ver
// analyze-conversation-sync/review, analysis-batch-submit). Por isso o
// valor gravado é o timestamp da ÚLTIMA mensagem antes do corretor humano
// assumir, não da primeira mensagem dele — senão o corte estrito (`>`)
// excluiria por engano a primeira mensagem humana.
//
// Detecção 100% pelo sinal estruturado do Clint: primeira mensagem de
// corretor com `autor_crm_user_id` preenchido (null = IA de qualificação,
// preenchido = humano de verdade). Se essa mensagem for a primeira da
// conversa inteira, não há fase de IA a excluir (o corretor já começou o
// atendimento) e `humano_assumiu_em` fica null. Se NENHUMA mensagem tiver
// `autor_crm_user_id`, a IA ainda está com a conversa — fica null também
// (não é "dado antigo faltando o campo": esse campo existe desde
// 2026-07-14, e o sync só cobre ontem+hoje, então toda conversa
// sincronizada por aqui necessariamente já tem o campo).
//
// Havia um fallback por heurística de texto aqui (procurava frases tipo
// "um dos nossos corretores vai assumir o atendimento") pra cobrir dados
// pré-2026-07-14 — removido depois de achar 3 conversas (de 124 com
// humano_assumiu_em setado) marcadas como "handoff" só porque a própria IA
// mencionou "corretor" + "atendimento" na fala normal dela, sem nenhum
// humano ter respondido (zero mensagens com autor_crm_user_id na conversa
// inteira). Falso positivo puro — atribuía a conversa inteira ao corretor
// responsável pelo chat mesmo sem ele ter escrito uma palavra.
async function atualizarHandoffIA(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  conversaId: string,
): Promise<void> {
  const { data: conversa } = await supabase
    .from("conversas")
    .select("humano_assumiu_em")
    .eq("id", conversaId)
    .single();

  if (conversa?.humano_assumiu_em) return;

  const { data: mensagens } = await supabase
    .from("mensagens")
    .select("remetente, enviada_em, autor_crm_user_id")
    .eq("conversa_id", conversaId)
    .order("enviada_em", { ascending: true });

  const lista = mensagens ?? [];

  const indiceHumana = lista.findIndex(
    (m: { remetente: string; autor_crm_user_id: string | null }) =>
      m.remetente === "corretor" && m.autor_crm_user_id,
  );

  // indiceHumana === -1: nenhuma mensagem de corretor tem autor_crm_user_id
  // — a IA ainda está com a conversa, cutoff fica null (nada a excluir
  // ainda). indiceHumana === 0: corretor humano já respondeu desde a
  // primeira mensagem, também não tem fase de IA a excluir.
  const cutoff: string | null = indiceHumana > 0 ? lista[indiceHumana - 1].enviada_em : null;

  if (!cutoff) return;

  const { error } = await supabase.from("conversas").update({ humano_assumiu_em: cutoff }).eq("id", conversaId);

  if (error) throw new Error(`marcar humano_assumiu_em falhou: ${error.message}`);
}

// Dia (fuso America/Sao_Paulo) usado como chave de fila em `analises` — só
// um sinalizador de "tem conversa esperando processamento", não o dia real
// da análise: analysis-batch-submit recalcula o dia de atividade mais
// recente do zero (buscarMensagensDoGrupo) e é ele quem decide a chave
// definitiva de upsert. Usar sempre "hoje" aqui evita ter que reimplementar
// aquela lógica de "último dia com atividade" também no sync.
const FUSO_ANALISE = "America/Sao_Paulo";
function diaLocal(isoTimestamp: string): string {
  return new Date(isoTimestamp).toLocaleDateString("en-CA", { timeZone: FUSO_ANALISE });
}

// Só entra na fila de análise quando a conversa atinge o mínimo de interação
// (regra definida em `elegivel_para_analise`, hoje: 3+ mensagens, 2+ do lead).
// Chamada só quando chegaram mensagens novas nesta sincronização (ver
// `sincronizarChat`) — por isso reabre pra 'pendente' mesmo se já estava
// 'concluida'/'falhou': uma conversa que continua depois de já analisada
// precisa ser relida (a interação do dia mais recente) pra IA considerar as
// mensagens novas, senão elas nunca entram em análise nenhuma. Só não mexe
// se a linha de HOJE já está 'processando' agora mesmo, pra não brigar com
// uma análise em andamento (uma conversa pode ter várias linhas históricas,
// uma por dia já analisado — só a de hoje importa aqui).
async function atualizarStatusAnalise(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  conversaId: string,
): Promise<void> {
  const hoje = diaLocal(new Date().toISOString());

  const { data: existente } = await supabase
    .from("analises")
    .select("status")
    .eq("conversa_id", conversaId)
    .eq("dia", hoje)
    .maybeSingle();

  if (existente?.status === "processando") return;

  const { data: elegivel } = await supabase.rpc("elegivel_para_analise", { p_conversa_id: conversaId });

  await supabase
    .from("analises")
    .upsert({ conversa_id: conversaId, dia: hoje, status: elegivel ? "pendente" : "nao_elegivel" }, { onConflict: "conversa_id,dia" });
}

function mapearRemetente(tipo: ClintMessage["type"]): "corretor" | "lead" | null {
  if (tipo === "USER") return "corretor";
  if (tipo === "CUSTOMER") return "lead";
  return null;
}

// Imagem sempre vem como jpeg/png na prática (WhatsApp comprime pra isso);
// tenta inferir pela extensão do content_url, mas cai em jpeg por padrão.
// Usado tanto aqui (pra gravar midia_mime_type) quanto em
// processar-midia-pendente (pra montar a chamada Gemini).
function inferirMimeImagem(contentUrl: string): string {
  if (contentUrl.toLowerCase().endsWith(".png")) return "image/png";
  if (contentUrl.toLowerCase().endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}

// Só os formatos que o Gemini processa bem via inline_data — outros tipos
// de documento (docx, xlsx etc.) caem no placeholder genérico sem entrar na
// fila de processamento de mídia.
const MIME_DOCUMENTO_SUPORTADO = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp", "text/plain"]);

interface CamposMidia {
  texto: string;
  midiaContentType: string | null;
  midiaContentUrl: string | null;
  midiaMimeType: string | null;
  midiaNome: string | null;
  midiaDescrita: boolean;
}

// `mensagens.texto` é NOT NULL, mas nem toda mensagem do Clint tem `content`
// preenchido (chamadas, mídia sem legenda, figurinhas, etc. vêm com
// `content: null`) — sem isso, o upsert falhava em silêncio (erro ignorado
// no loop de sincronização) e a mensagem simplesmente nunca era gravada.
// CALL_MISSED_VOICE em especial vira uma evidência real e estruturada pro
// critério "fluxo" (tentativa de contato por ligação), em vez de precisar
// adivinhar pelo tom da mensagem seguinte.
//
// Áudio/imagem/documento NÃO são descritos aqui — isso exigiria uma chamada
// Gemini síncrona por mensagem dentro do loop de sincronização, e cada uma
// soma ao tempo de execução até estourar o WORKER_RESOURCE_LIMIT da Edge
// Function (era o caso já só com áudio). Em vez disso, grava um placeholder
// na hora e marca `midia_descrita = false`: a function
// processar-midia-pendente (cron próprio, mais frequente e em lotes
// pequenos) descreve depois, sem competir pelo orçamento de tempo do sync.
// Algumas mensagens do WhatsApp Business chegam do Clint com `content`
// preenchido só com o prefixo de autoria do grupo/atendimento compartilhado
// (ex: "*Victor Castro:* \n ") e nada de texto real depois — sem essa
// checagem, isso passava como se fosse conteúdo genuíno e a IA analisava uma
// mensagem vazia como se o corretor tivesse escrito algo. Ocorre aos
// milhares em produção (ex: 652 casos só pro Victor Castro).
const PREFIXO_AUTOR_SEM_CONTEUDO = /^\*[^*]+:\*\s*$/;

function montarCamposMensagem(msg: ClintMessage, remetente: "corretor" | "lead"): CamposMidia {
  if (msg.content && !PREFIXO_AUTOR_SEM_CONTEUDO.test(msg.content)) {
    return { texto: msg.content, midiaContentType: null, midiaContentUrl: null, midiaMimeType: null, midiaNome: null, midiaDescrita: true };
  }

  if (msg.content_type === "AUDIO" && msg.content_url) {
    return {
      texto: "[Áudio recebido — transcrição pendente]",
      midiaContentType: "AUDIO",
      midiaContentUrl: msg.content_url,
      midiaMimeType: "audio/ogg",
      midiaNome: null,
      midiaDescrita: false,
    };
  }

  if (msg.content_type === "IMAGE" && msg.content_url) {
    return {
      texto: "[Imagem recebida — descrição pendente]",
      midiaContentType: "IMAGE",
      midiaContentUrl: msg.content_url,
      midiaMimeType: inferirMimeImagem(msg.content_url),
      midiaNome: null,
      midiaDescrita: false,
    };
  }

  if (msg.content_type === "DOCUMENT" && msg.content_url) {
    const mimeType = msg.content_object?.mimeType;
    if (mimeType && MIME_DOCUMENTO_SUPORTADO.has(mimeType)) {
      const nome = msg.content_object?.name ?? null;
      return {
        texto: `[Documento${nome ? ` "${nome}"` : ""} recebido — resumo pendente]`,
        midiaContentType: "DOCUMENT",
        midiaContentUrl: msg.content_url,
        midiaMimeType: mimeType,
        midiaNome: nome,
        midiaDescrita: false,
      };
    }
  }

  const texto = (() => {
    switch (msg.content_type) {
      case "CALL_MISSED_VOICE":
        return remetente === "lead"
          ? "[Ligação de voz do lead não atendida pelo corretor]"
          : "[Ligação de voz do corretor não atendida pelo lead]";
      case "IMAGE":
        return "[Imagem enviada — formato não suportado]";
      case "AUDIO":
        return "[Áudio enviado — sem URL de conteúdo]";
      case "VIDEO":
        return "[Vídeo enviado, sem legenda]";
      case "DOCUMENT":
        return "[Documento enviado — formato não suportado]";
      case "STICKER":
        return "[Figurinha enviada]";
      case "LOCATION":
        return "[Localização compartilhada]";
      case "CONTACT":
      case "CONTACT_ARRAY":
        return "[Contato compartilhado]";
      case "REACTION":
        return "[Reação a uma mensagem]";
      default:
        return `[Conteúdo sem texto: ${msg.content_type}]`;
    }
  })();

  return { texto, midiaContentType: null, midiaContentUrl: null, midiaMimeType: null, midiaNome: null, midiaDescrita: true };
}

// `ignoreDuplicates: true` faz o nome real só ser gravado na CRIAÇÃO do
// registro — se o corretor já existe (inclusive com nome editado manualmente
// no dashboard via CorretoresManager), o upsert é no-op e não sobrescreve.
async function upsertCorretor(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  clint: ReturnType<typeof createClintClient>,
  userId: string | null,
  nomesCorretor: Map<string, string>,
): Promise<string | null> {
  if (!userId) return null;

  let nomeReal = nomesCorretor.get(userId);

  // Corretor novo (nunca visto) e o mapa geral (200 deals mais recentes,
  // sem filtro) não tinha esse user_id — acontece com corretor recém
  // cadastrado na Clint, ainda sem deal recente o bastante pra entrar
  // nessa amostra. Busca dedicada só pra esse user_id antes de recorrer ao
  // placeholder, pra evitar que o nome_crm fique "Corretor <id>" à toa
  // quando o nome real já existe na Clint. Só roda quando o corretor ainda
  // não existe em `corretores` — pra quem já foi criado antes (inclusive
  // com nome editado manualmente), não vale a chamada extra, já que o
  // upsert abaixo é no-op de qualquer forma.
  if (!nomeReal) {
    const { data: existente } = await supabase.from("corretores").select("id").eq("crm_id", userId).maybeSingle();
    if (!existente) {
      nomeReal = (await clint.buscarNomePorUserId(userId)) ?? undefined;
    }
  }

  await supabase
    .from("corretores")
    .upsert(
      { crm_id: userId, nome_crm: nomeReal ?? `Corretor ${userId.slice(0, 8)}` },
      { onConflict: "crm_id", ignoreDuplicates: true },
    );

  const { data } = await supabase.from("corretores").select("id").eq("crm_id", userId).single();
  return data?.id ?? null;
}

// Só busca o contato na Clint (telefone/nome real) se o lead ainda não
// existe — poupa uma chamada extra por chat pra leads já conhecidos, que é a
// maioria depois do primeiro sync.
async function upsertLead(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  clint: ReturnType<typeof createClintClient>,
  contactId: string | null,
): Promise<string | null> {
  if (!contactId) return null;

  const { data: existente } = await supabase.from("leads").select("id").eq("crm_id", contactId).maybeSingle();
  if (existente) return existente.id;

  let contato: { name: string | null; phone: string | null } | null = null;
  try {
    contato = await clint.buscarContatoPorId(contactId);
  } catch {
    // enriquecimento é best-effort — segue só com o crm_id se falhar
  }

  await supabase.from("leads").upsert(
    { crm_id: contactId, telefone: contato?.phone ?? null, nome_crm: contato?.name || null },
    { onConflict: "crm_id", ignoreDuplicates: true },
  );

  const { data } = await supabase.from("leads").select("id").eq("crm_id", contactId).single();
  return data?.id ?? null;
}
