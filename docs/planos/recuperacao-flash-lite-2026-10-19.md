# Execução do backlog com Flash-Lite — 19/10/2026

Solicitação explícita: rodar o que ainda não foi analisado, com o modelo econômico já ativado.

- Criadas somente pendências ausentes dos dias 08–18/10, resolvendo a conversa canônica. Resultados existentes não foram reabertos por essa varredura.
- Recuperação de revisões falhadas por HTTP 402 ou ausência de resposta aproveita o resultado e o snapshot da primeira avaliação, sem nova inferência de primeira etapa ou recontagem de seu uso. A nova revisão usa identidade própria, Batch e Flash-Lite, com reserva atômica. Tentativas ativas, incertas, concluídas ou já recuperadas são excluídas.
- Modo explícito reconciliarEnvios no poll: consulta a listagem do Gemini e só retorna uma execução incerta à coleta quando seu ID é confirmado nos dados de entrada/saída do batch. Ausência na listagem não autoriza reenviar.
- Três jobs temporários a cada dois minutos cobrem primeiras avaliações, revisões faltantes e mídia, com limites de até sete dias por chamada, somente até 18/10. Eles se removem ao terminar ou em 21/10/2026 às 00:00 Fortaleza. A rotina normal da madrugada foi mantida e o dia corrente não entra na recuperação.
- A primeira checagem confirmou 51 primeiras avaliações e 50 revisões de recuperação aceitas pelo Gemini, todas gemini-3.5-flash-lite. São submissões, não resultados completos. A coleta e os próximos lotes continuam de forma assíncrona.
- Quatro envios de 14/10 sem confirmação foram procurados até o fim da listagem do provedor. Sem resultado recuperável e sem avaliação concluída na versão atual, foram liberados para nova execução Lite dentro da recuperação solicitada. A operação antiga foi encerrada com diagnóstico explícito de cobrança desconhecida, sem apagar seu histórico ou declarar custo zero. A liberação exigiu consulta completa registrada, quatro candidatos exatos e idade superior a 48 horas. O modo de consulta do poll continua sem reenviar operações por conta própria.

Poll publicado: v26. Migration aplicada: 20261019145706_revisoes_recuperaveis_sem_repetir_analise.sql. A função é SECURITY INVOKER e somente service_role pode executá-la. O arquivo foi criado pelo CLI e alinhado à versão registrada no Supabase.

Validação: doze testes Deno, deno check e teste PostgreSQL das migrations/driver. Verificados reuso do resultado sem alterar consumo da primeira avaliação, identidade determinística, proteção contra recuperação duplicada, limitação do intervalo e encerramento dos jobs. Nenhuma conversa real ou secret foi exportado para os artefatos.
