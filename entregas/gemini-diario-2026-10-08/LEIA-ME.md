# Entrega — avaliação diária Gemini no Supabase

Código implementado e validado localmente em 08/10/2026. Não publicado no Supabase. Não foram feitas chamadas reais de inferência nos testes.

## Arquivos das Edge Functions

Copie o conteúdo inteiro do arquivo para a função indicada; cada função tem seu próprio index.ts autocontido.

| Pasta | Nome exato no Supabase |
|---|---|
| edge-1/index.ts | analysis-batch-submit |
| edge-2/index.ts | analysis-batch-poll |
| edge-3/index.ts | sync-clint |
| edge-4/index.ts | processar-midia-pendente |
| edge-5/index.ts | analisar-conversa-unica |

Não há helpers compartilhados/exportados ou dependência entre as pastas. A dependência externa de código é supabase-js do JSR; tabelas e RPCs são instaladas pelo SQL.

## O que mudou

- Avaliação automática apenas de dias encerrados, entre 00:00 e 03:59 em Fortaleza. Cron a cada dez minutos, última submissão às 03:50. Poll continua durante o dia.
- Recorte exato conversa/dia, sem perder ontem quando chegam mensagens de hoje; mensagens tardias e transcrições reabrem o dia correto.
- Reserva atômica e hash do conteúdo evitam inferências repetidas. Alteração durante processamento mantém uma nova pendência; resultado antigo não sobrescreve o novo.
- Revisão usa mensagens, critérios, playbook e modelo congelados na primeira análise.
- Uso de tokens é persistido para análise, revisão, manual e mídia, incluindo respostas inválidas com métricas disponíveis. Ausência de uso é desconhecido.
- 404 do poll: três falhas com backoff levam a quarentena. 401/403: quarentena imediata. Envios incertos precisam de reconciliação antes de reenviar.
- Mídia: MIME correto, transcrição fiel, respostas multipart, rejeição de truncamento, reserva exclusiva, backoff e limite de cinco tentativas. Falhas terminais têm texto de indisponibilidade e diagnóstico, sem inventar transcrição. Worker interrompido após iniciar inferência não reenvia automaticamente.

Modelos preservados: gemini-3.6-flash para análise e revisão; gemini-2.5-flash para mídia. GEMINI_ANALYSIS_MODEL e GEMINI_REVIEW_MODEL permitem configurar modelos separadamente, mas este pacote não ativa Flash-Lite. A comparação de qualidade entre modelos permanece pendente.

## Ordem de publicação no Supabase

1. Use o projeto correto, pvhaqcgoipggrocyxbtj. Guarde versões atuais das funções e horários dos jobs para reversão; não compartilhe comandos de cron, pois podem conter segredos.
2. Pause o job analysis-batch-submit. Deixe o poll antigo concluir os batches legados. Consulte somente `select status,count(*) from public.analise_batches group by status;`. Não marque batches ativos como encerrados sem confirmar o resultado no Gemini. Um 404 persistente exige reconciliação antes da transição.
3. Quando não houver batches legados in_progress, pause temporariamente sync, mídia, poll e chamadas manuais durante a instalação. Termine workers antigos antes de prosseguir. O 01-banco.sql aborta se houver batch legado ativo.
4. Execute 01-banco.sql uma única vez no SQL Editor. Ele preserva o histórico e instala rastreamento, RLS, RPCs e triggers. O arquivo corresponde à migration 20261008171820_gemini_execucoes_diarias.sql. Se aplicar pelo SQL Editor, registre posteriormente essa migration no histórico do CLI antes de usar db push.
5. Publique os cinco index.ts nos nomes da tabela acima. As funções precisam do SQL instalado; não publique só uma parte do pacote.
6. Preserve os secrets existentes: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET, GEMINI_API_KEY e CLINT_API_KEY. Não há secrets dentro dos arquivos. Confirme a chave Gemini no projeto real: a credencial local não estava validada. Preserve a configuração JWT compatível com os jobs atuais; todas as funções verificam o CRON_SECRET internamente. O gateway precisa aceitar o mecanismo de autenticação que o cron já usa.
7. Com todas as funções novas publicadas, execute 02-agendamento.sql. Ele exige pg_cron em UTC/GMT, preserva URL, headers e segredo e ativa o submit em */10 3-6 * * *. Reative sync, mídia e poll nos horários anteriores. Não reaplique ativar-backlog-analises.sql, que é legado e contém agendamento diurno.
8. Confira uma execução real e a primeira janela noturna. Verifique fila por dia, execução/revisão, diagnóstico de mídia, resultados no ranking e consumo com 03-relatorio.sql. O poll deve continuar ativo para concluir batches fora da janela.

03-relatorio.sql é somente leitura e não mostra snapshots. As tarifas do cálculo de USD estão NULL até serem preenchidas com os preços vigentes do modelo e modalidade reais. O consumo só passa a ser medido a partir da publicação: não reconstrói tokens históricos nem comprova o valor da fatura. Mídia fica separada porque áudio/imagem podem ter tarifas distintas de entrada.

## Validação realizada

- deno check nos cinco arquivos: aprovado.
- Sete testes Deno: datas e janela, paginação de 1.001 mensagens, hash, JSON/multipart/truncamento, MIME/base64, backoff/quarentena de 404 e envio Batch incerto.
- Migração real executada em PostgreSQL local via PGlite, com fixture do schema: proteção de batches legados, reservas/deduplicação, versões, revisão/cache, backoff, mensagem tardia, mídia incerta, permissões/RLS e consulta de consumo.
- git diff --check: aprovado.

Esses testes validam código e regras SQL; ainda é necessário validar runtime Supabase, pg_cron e um batch real após publicar. Nenhum banco de produção foi alterado. Não havia credencial de management/SQL apropriada disponível para realizar o deploy nesta sessão.

## Reversão

Pause novas submissões e preserve as pendências/execuções. Retenha o schema aditivo. Para voltar às funções anteriores, primeiro conclua/reconcilie as execuções novas com o poll novo: o poll antigo não entende gemini_execucoes. Voltar ao cron diurno não é necessário para reverter o código.
