# Plano de execução — redução de custos Gemini

Preparado em 08/10/2026 para execução pelo GPT-6.1 Sol.
Este documento é um plano; não confirma deploy nem alteração do cron em produção.

## Objetivo e decisões

Reduzir reavaliações durante o atendimento sem perder dias de análise, mensagens tardias ou transcrições. Primeiro manter Gemini 3.6 Flash, análise e revisão em Batch. Depois medir e comparar modelos econômicos em amostra, antes de trocar produção.

- Avaliação automática por conversa canônica + dia encerrado, em America/Fortaleza.
- Uma rodada inicial + uma revisão por versão do conteúdo avaliável. Conteúdo novo relevante pode gerar outra versão; polling e repetição de cron não podem gerar novas inferências da mesma versão.
- Janela proposta para submissão: 00:00–03:50 Fortaleza, a cada 10 minutos. Confirmar timezone do pg_cron antes de aplicar `*/10 3-6 * * *` (corresponde a essa janela quando o cron usa UTC).
- Continuar sincronização e processamento de mídia durante o dia; continuar poll fora da janela, pois o Batch pode concluir depois dela.
- Manter análise manual como exceção explícita, identificada e contabilizada, com proteção contra duplo clique/requisições concorrentes.
- Não mudar modelo, critérios, notas ou política de revisão na primeira fase.
- **Sem MCP**, conforme pedido do usuário. Usar REST, CLI ou conexão SQL autorizada. Não criar RPC pública genérica para executar SQL como contorno.
- Edge Functions autocontidas, sem novos helpers compartilhados/exportados ou pasta `_shared`, conforme preferência do usuário.
- Não criar outro chat nem mudar o modelo deste chat automaticamente: o usuário fará a passagem para o 6.1 Sol.

## Evidências e limites

Projeto correto configurado no workspace: `pvhaqcgoipggrocyxbtj`. O projeto inicialmente encontrado pelo MCP era outro; seus números não fazem parte deste diagnóstico.

Consulta REST anterior: 818 IDs de conversa distintos com registro de análise e 1.568 pares conversa/dia no recorte de dias 24/09 a 07/10. Houve 4.733 primeiras avaliações e 4.561 revisões submetidas em lotes no período consultado. São métricas diferentes: datas de interação e datas de submissão não coincidem necessariamente; essas razões sugerem repetição, mas não provam três chamadas idênticas por par. Confirmar com rastreamento por execução.

Os registros mais recentes consultados usavam `gemini-3.6-flash`; mídia está configurada localmente com `gemini-2.5-flash`. Hoje, no instante da consulta, não havia lotes de 08/10, e os 143 áudios/38 imagens de hoje estavam pendentes. Isso não explica sozinho a cobrança informada de R$ 50 nem comprova invasão.

Não há medição persistida suficiente de tokens. Os R$ 1.250/mês e demais valores comunicados são cenários hipotéticos, não custo observado. Não usar como critério de sucesso financeiro sem reconciliar consumo real.

## Estado local a preservar e revisar

`git status` antes da execução deve ser inspecionado novamente. Atualmente:

- `supabase/functions/analysis-batch-submit/index.ts`: edição não publicada filtrando `dia < hoje`, ordenando dias e pulando resultados cujo último dia é hoje.
- `supabase/functions/processar-midia-pendente/index.ts`: correções anteriores de prompt, MIME, resposta multipart, truncamento e propagação de erros; também não confirmadas em produção.
- `supabase/manual/reduzir-reanalises-janela-noturna.sql`: script novo que preserva o comando/segredo do job e altera apenas seu horário.

**Não publicar essas mudanças como estão.** O filtro local do submit não resolve o recorte histórico: `buscarMensagensDoGrupo` continua escolhendo o último dia da conversa. Uma mensagem de hoje pode impedir a análise de ontem. Além disso, o submit deduplica apenas por conversa e apaga pendências de outros dias; isso é incompatível com processar corretamente todo o backlog diário.

## Mapa dos componentes

| Componente | Comportamento atual / alteração necessária |
|---|---|
| `supabase/functions/sync-clint/index.ts` | Novas mensagens reabrem a linha de hoje. Enfileirar cada dia efetivamente afetado, considerando `enviada_em`, canônica e conteúdo relevante; não perder mensagens tardias nem atualizações recebidas durante execução. |
| `supabase/functions/analysis-batch-submit/index.ts` | Lotes de até 50; hoje seleciona conversa, recalcula último dia e apaga pendências de outros dias. Passar a selecionar e processar o par exato conversa/dia, com reserva atômica e identidade da versão. |
| `supabase/functions/analysis-batch-poll/index.ts` | Reconsulta mensagens mutáveis na revisão; usa modelo hardcoded ao gravar; erro HTTP deixa lote ativo para sempre. Congelar contexto/modelo por execução e tornar etapas idempotentes. |
| `supabase/functions/processar-midia-pendente/index.ts` | Reabertura ainda usa `onConflict: conversa_id` e `maybeSingle` sem dia, incompatíveis com a constraint composta. Corrigir para canônica/dia, conferir erros de banco e limitar retentativas. |
| `supabase/functions/analisar-conversa-unica/index.ts` | Duas chamadas síncronas; compartilhar as invariantes de identidade, snapshot, medição e reserva, mantendo arquivo autocontido. |
| `supabase/manual/ativar-backlog-analises.sql` | Submissão a cada dez minutos durante todo o dia. Não reaplicar como operação normal. |
| `supabase/manual/restaurar-cron-noturno.sql` | Uma execução por noite pode processar só 50 pendências; atualizar documentação para evitar fila crescente. |
| Banco: `analises`, `analises_bruta`, `analise_batches`, `mensagens` | Preservar chave `(conversa_id,dia)`, histórico e ranking; acrescentar rastreamento por execução e métricas com migração aditiva. |

## Fase 0 — confirmar produção e estabelecer baseline

1. Conferir instruções do repo e skill Supabase; continuar sem MCP. Ferramentas CLI devem ser descobertas via `--help`.
2. Confirmar conexão com o projeto correto, migrations aplicadas, código realmente publicado, jobs ativos e horários. Inspecionar jobs sem imprimir seu `command`, pois pode conter segredo.
3. Identificar se existe credencial de management/SQL apropriada. A service-role REST não basta para publicar função ou alterar pg_cron. A consulta anterior a um batch Gemini com a chave local devolveu HTTP 401; não tratar essa chave como validada nem inferir que seja a mesma usada em produção.
4. Levantar pendências por dia, mídias por estado/idade, lotes ativos e erros 404/429/5xx; verificar se funções antigas `analyze-conversation-*` ainda têm disparadores ativos.
5. Guardar versões publicadas e horários atuais para rollback em local seguro, sem versionar segredos. Não executar cron de análise durante inventário.
6. Separar chamadas de inferência de GETs de polling. Comparar com painel Google no mesmo fuso (prints estavam em UTC−8) e projeto/chave corretos.

Se o acesso necessário estiver ausente, concluir código, migrações e testes e comunicar o bloqueio exato. Não pedir a chave em texto no chat.

## Fase 1 — corrigir fila e datas antes do cron

1. Fazer `buscarMensagensDoGrupo` receber `diaAlvo` no submit e na revisão. Buscar apenas os limites UTC do dia alvo (início inclusivo, fim exclusivo), preservando filtros de handoff, templates, autoria e agrupamento canônico. Padronizar o fuso; não recalcular o dia na conclusão.
2. Selecionar `conversa_id,dia`, deduplicar pelo par e eliminar a limpeza que apaga pendências válidas de outros dias. Qualquer reparo de linhas órfãs deve exigir evidência de que não há conteúdo para aquele dia.
3. Enfileirar os dias das mensagens novas, incluindo mensagens antigas recém-importadas. Não marcar hoje apenas porque a sincronização ocorreu hoje.
4. Mídia deve reabrir o dia e a canônica corretos. Checar todos os erros de select/upsert/RPC. Mudança durante processamento deve ficar registrada como versão nova pendente, sem ser perdida quando o lote anterior terminar.
5. Aguardar mídias relevantes pendentes antes da avaliação diária. Para mídia permanentemente indisponível, permitir estado explícito de falha terminal após tentativas limitadas; não bloquear o dia para sempre nem chamar placeholder de transcrição bem-sucedida.
6. Evitar starvation: pares aguardando mídia/retry não podem ocupar sempre as primeiras 50 posições. Usar elegibilidade/`proxima_tentativa_em` e seleção paginada/reserva apenas dos itens prontos.

## Fase 2 — identidade, concorrência e retentativas

Implementar rastreamento por execução em migração aditiva. Preferir tabela privada de execuções com restrições de acesso e RPCs estreitas para reserva; se exposta, ativar RLS e privilégios mínimos. Criar migrations pelo CLI segundo as instruções da skill, não inventar número de migration.

Campos mínimos: conversa canônica, dia, hash do input, etapa (análise/revisão), versão do prompt, versão do playbook/parâmetros, modelo solicitado e retornado, estado, lote externo, tentativas, próxima tentativa, lease/expiração, timestamps e uso de tokens. A unicidade deve cobrir a identidade lógica da execução e etapa.

- Calcular hash de mensagens ordenadas deterministicamente (timestamp + ID), texto transcrito, autoria/handoff relevante, prompt, critérios e playbook. Não incluir timestamps voláteis de sincronização.
- Congelar contexto em snapshot protegido ou referência versionada: revisão deve enxergar o mesmo dia, mensagens, playbook e primeira avaliação da execução original.
- Reservar trabalho atomicamente antes da chamada externa. Evitar dois submits ou duas revisões concorrentes da mesma identidade.
- Não prometer exactly-once entre banco e Gemini. Se o envio externo tiver resultado incerto, reconciliar a operação quando possível; não reenviar cegamente por expiração de lease. Persistir identidade e lote assim que conhecidos.
- Repetir o poll não pode reenviar a revisão. Resposta antiga não pode sobrescrever a versão nova do mesmo dia.
- Persistir erros HTTP sem chave/URL secreta/conteúdo sensível. 429/5xx têm backoff com jitter e limite de tentativas. 401/403 exigem diagnóstico de configuração; 404 deve ser distinguido entre recurso expirado/inacessível e modelo indisponível, com quarentena limitada, sem loop eterno.
- No processador de mídia, a edição atual deixou falhas pendentes indefinidamente: acrescentar limite, backoff e estado terminal antes de publicar.

## Fase 3 — medir o custo

- Capturar `usageMetadata` de cada resultado de inferência (análise, revisão, manual e mídia), inclusive tokens de entrada, saída e raciocínio quando disponíveis. Persistir exatamente os campos brutos relevantes para auditoria.
- Não somar raciocínio duas vezes: validar semântica dos campos da API atual e registrar tokens não informados como desconhecidos, nunca zero.
- Modelo e modalidade (Batch ou síncrono) devem ser registrados no envio, não inferidos da constante atual do poll. Isso é necessário para lotes que terminam depois de uma troca de modelo.
- Registrar também falhas pagáveis com usage disponível. Contabilizar GET de polling como solicitação operacional, separado de inferência.
- Relatório diário em Fortaleza: conversas distintas, pares conversa/dia, versões, análises, revisões, mídias, retries, tokens e custo estimado em USD. Conversão BRL deve informar taxa e data; não chamar estimativa de fatura.

## Fase 4 — ativar a janela noturna

1. Validar em ambiente de teste/fixtures, sem enviar conversas reais a modelos durante testes unitários.
2. Aplicar migração aditiva e publicar funções compatíveis sem quebrar lotes já em andamento. Pausar somente submissão durante a transição se necessário; manter sync/mídia/poll conforme compatibilidade verificada.
3. Aplicar o script de janela noturna somente depois do código correto. Preservar comando, headers, autenticação e segredo do job. Verificar timezone e estado `active`.
4. Capacidade nominal: 24 execuções × até 50 pares = 1.200 pares por janela, antes de falhas/itens não prontos. Monitorar fila ao final; não tratar capacidade nominal como garantida nem aumentar frequência diurna automaticamente.
5. Proteger a regra de dia encerrado na função, não só no cron. Chamada automática fora do horário deve ser recusada/no-op ou exigir modo operacional explícito e auditado. Análise manual permanece exceção deliberada.
6. Atualizar scripts de operação para que a rotina de backlog não restaure reanálise diurna inadvertidamente.
7. Verificar uma execução real e o fechamento da primeira janela. Comparar custo/volume em 3–7 dias comparáveis; não criar automação de acompanhamento sem pedido do usuário.

## Fase 5 — avaliar Flash-Lite, sem troca automática

Disponibilidade deve ser confirmada no projeto real. Segundo documentação consultada em 08/10, o 2.5 Flash-Lite não tem data de desligamento anunciada, mas o acesso é restrito a usuários anteriores. 401 da chave local não serve como teste de disponibilidade do modelo.

Preços de referência por milhão de tokens de texto em Batch:

| Modelo | Entrada USD | Saída USD |
|---|---:|---:|
| 3.6 Flash | 0,375 | 1,875 |
| 3.5 Flash-Lite | 0,15 | 1,25 |
| 2.5 Flash-Lite | 0,05 | 0,20 |

Revalidar preços na execução: o preço consultado do 3.6 é promocional até 31/12/2026. Fontes: https://ai.google.dev/gemini-api/docs/pricing e https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-lite.

1. Parametrizar modelo de análise e de revisão separadamente, conservando 3.6 como padrão na fase inicial. Validar parâmetros por família de modelo; não reutilizar `thinkingBudget`/`thinkingLevel` indiscriminadamente.
2. Selecionar cerca de 30 pares já avaliados, com conversas curtas/longas, negações, gírias, contexto ambíguo, handoff e transcrições. Evitar amostra só de casos fáceis.
3. Comparar 3.6, 3.5 Lite e 2.5 Lite se acessível, usando o mesmo snapshot e schema. Avaliações experimentais não alteram ranking nem análises oficiais. Informar custo e teto do experimento antes de executá-lo; a autorização atual é para planejar, não disparar benchmark pago nesta etapa.
4. Medir tokens/custo real, JSON válido, evidências presentes no texto, divergência por critério e estabilidade. Divergência com 3.6 não é automaticamente erro: revisar os casos contra o playbook e julgamento humano.
5. Reportar resultado e recomendar manter 3.6, usar Lite em ambas as etapas ou Lite na primeira + 3.6 na revisão. Troca em produção depende dessa decisão; não assumir que menor custo significa qualidade equivalente.

## Testes e critérios de aceite

- Mensagem de hoje não impede avaliação de ontem; dois dias pendentes da mesma conversa são ambos processados.
- Nenhuma pendência histórica válida é apagada para acomodar o último dia.
- Mensagem tardia e transcrição reabrem apenas o dia/canônica afetados.
- Nova mensagem durante execução não é perdida e resultado antigo não sobrescreve o novo.
- Dois submits simultâneos geram apenas uma reserva por identidade; poll repetido não duplica revisão.
- Mais de 50 pendências drenam em execuções sucessivas; itens bloqueados não paralisam a fila.
- Revisão usa snapshot e modelo registrados, mesmo após mudança de configuração.
- Falha depois do envio e antes de persistir ID não causa reenvio automático sem reconciliação.
- 404 persistente para de ser consultado indefinidamente; 429/5xx respeitam backoff.
- Mídia usa chave composta; erros de banco não são tratados como sucesso.
- Testes de fronteira de meia-noite Fortaleza e ordenação determinística.
- Uso de tokens e custo conciliados com um pequeno lote real; segredos ausentes dos logs/artefatos.
- `deno check` nas funções alteradas, testes comportamentais e `git diff --check`. A checagem anterior foi impedida por acesso ao JSR; resolver acesso por mecanismo autorizado e não declarar tipagem validada apenas pelo diff.

## Reversão e entrega

- Guardar horário anterior de cada job e versões de funções. Se aparecer perda/atraso de dias, pausar novas submissões, preservar pendências/snapshots e corrigir ou voltar para versão compatível com o schema; não restaurar automaticamente um cron diurno que multiplique custo.
- Manter migrations aditivas durante rollout. Não apagar métricas ou histórico para reverter aplicação.
- Entregar diff, migration/script operacional, evidências de testes, situação do deploy, agenda efetiva, métricas da primeira janela e limitações restantes.
- Atualizar estimativa mensal com tokens observados. O objetivo é reduzir inferências redundantes sem perder cobertura de dias; não prometer os valores mensais anteriores como economia garantida.

## Instrução curta para o executor

Leia este plano, revalide o estado local e de produção e execute primeiro as fases 0–4. Preserve funções autocontidas e não use MCP. Não publique o filtro simplificado atual sem corrigir o recorte por dia e a idempotência. Mantenha 3.6 em produção até concluir a medição e uma decisão sobre o experimento Flash-Lite. Quando faltar acesso, conclua o que pode ser validado localmente e explique exatamente o requisito pendente, sem solicitar segredos em texto no chat.
