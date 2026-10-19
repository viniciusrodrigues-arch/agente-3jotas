# Flash-Lite — publicado em 19/10/2026

Este pacote atualiza a base de 13/10. Já está instalado em produção; não é necessário republicar para ativar Lite.

| Arquivo | Função | Versão |
|---|---|---:|
| edge-1/index.ts | analysis-batch-submit | 27 |
| edge-2/index.ts | analysis-batch-poll | 21 |
| edge-3/index.ts | sync-clint | 31 |
| edge-4/index.ts | processar-midia-pendente | 9 |
| edge-5/index.ts | analisar-conversa-unica | 11 |

Padrão para novas análises, revisões e mídia: gemini-3.5-flash-lite com pensamento mínimo. Análise e revisão automáticas continuam em Batch. Não existe fallback automático para modelo mais caro. Batches antigos conservam modelos e configurações congelados. Variáveis de modelo seguem configuráveis; o modelo efetivo foi confirmado em chamadas reais de análise, revisão e áudio.

Quatro funções foram alteradas; sync-clint está incluída para completar o mapa dos cinco arquivos autocontidos. Não há helpers compartilhados ou secrets no pacote.

01-atualizar-banco.sql instala a RPC de adiamento de mídia para recusas HTTP 401/402/403/404. Deve preceder a publicação da função de mídia em outro ambiente que já tenha a base. A RPC opera somente como service_role, preserva o texto e não transforma falta de saldo em falha definitiva do arquivo.

02-relatorio.sql contém preços consultados em 19/10/2026. A comparação para o volume de tokens conhecido do período foi USD 18,21 no 3.6 contra USD 9,96 no Lite (45,3% menos só na tarifa). Não é fatura ou mensalidade; exclui uso desconhecido e mistura backlog com rotina. Não presumir quantidade igual de tokens entre modelos. Referência: https://ai.google.dev/gemini-api/docs/pricing.

Dez testes Deno, checagem das funções e testes PostgreSQL passaram. Uma avaliação real completa em duas etapas e uma transcrição real retornaram gemini-3.5-flash-lite com sucesso. A validação funcional não comprova equivalência das notas em todas as conversas.
