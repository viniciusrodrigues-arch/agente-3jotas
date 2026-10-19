# Flash-Lite em produção — 19/10/2026

A escolha explícita do usuário foi Flash-Lite na análise, revisão e mídia, com cobrança Gemini já regularizada. Projeto: Três Jotas (pvhaqcgoipggrocyxbtj). A conexão MCP correspondente é Climb.

## Implantação

- analysis-batch-submit v27, analysis-batch-poll v21 e analisar-conversa-unica v11: padrão gemini-3.5-flash-lite em análise e revisão. Mídia v9: padrão gemini-3.5-flash-lite.
- Variáveis GEMINI_ANALYSIS_MODEL, GEMINI_REVIEW_MODEL e GEMINI_MEDIA_MODEL continuam configuráveis; chamadas reais confirmaram o modelo efetivo Lite nas três etapas.
- Mantidos prompts, critérios, schema e duas etapas. Raciocínio mínimo configurado por família. Novos snapshots congelam também a configuração da revisão; os antigos preservam seus parâmetros/modelos.
- Crons de submit/mídia pausados apenas durante a implantação e reativados; análise automática continua em Batch na madrugada. Nenhum job temporário de recuperação foi recriado.
- HTTP 401/402/403/404 na mídia agora encerra a invocação e devolve o arquivo para a fila com uma hora de adiamento, preservando texto e tentativas. Só respostas explícitas de recusa usam esse caminho; timeouts/envios incertos não são reenviados cegamente.
- Reabertas mídias com erro exato HTTP 402 e primeira análise recusada por Batch HTTP 402, sem repetir sucessos, operações ativas ou incertas. O processamento segue a rotina normal.

## Medição e limites

Registros desde 13/10 até a consulta em 19/10: 1.195 análises e 1.102 revisões completas, 4.538 mídias com sucesso. Houve 549 recusas de Batch por HTTP 402 e 1.361 de mídia; ausência de métricas não significa custo zero. A recuperação histórica está misturada a esse período: ele não representa uma mensalidade estável.

Tarifas vigentes consultadas: 3.6 Flash Batch entrada 0,375/cache 0,0375/saída 1,875 USD por milhão; Lite Batch 0,15/0,02/1,25. Standard 3.6 0,75/0,075/3,75; Lite 0,30/0,03/2,50. Fonte: https://ai.google.dev/gemini-api/docs/pricing. Tarifas promocionais do 3.6 terminam em 31/12/2026.

Aplicando essas tarifas ao uso conhecido das execuções completas e mídias bem-sucedidas, o cenário passa de aproximadamente USD 18,21 para USD 9,96 (45,3% menos), mantendo a mesma quantidade de tokens. Não é fatura nem previsão mensal: exclui consumo desconhecido, não estima câmbio/impostos e não pressupõe estabilidade do backlog. Pensamento mínimo pode reduzir tokens além da tarifa; medir uso real antes de projetar economia maior.

## Validação

Dez testes Deno, checagem das quatro funções e teste PostgreSQL das migrations. Foi concluída uma avaliação manual real em duas etapas e uma transcrição real; a API retornou gemini-3.5-flash-lite em todas, com JSON válido e métricas. Isso confirma funcionamento, não equivalência de qualidade em todas as conversas. Comparação sistemática de notas e fidelidade continua sendo trabalho separado.

Migração aplicada: 20261019144400_adiar_midia_por_configuracao.sql; arquivo criado pelo CLI e alinhado ao timestamp efetivamente registrado pelo Supabase.
