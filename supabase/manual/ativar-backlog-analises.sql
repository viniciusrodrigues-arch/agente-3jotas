-- EXECUTAR SOMENTE DEPOIS de publicar as versões novas de:
--   1. analysis-batch-submit
--   2. analysis-batch-poll
--
-- Substitua os dois placeholders. Use um CRON_SECRET novo, pois o anterior
-- foi exposto durante o diagnóstico.

select cron.unschedule('analysis-batch-submit');
select cron.unschedule('analysis-batch-poll');

-- Drena todas as pendências em lotes de até 50. Cada chamada pega somente o
-- próximo lote; o cron repete até a fila chegar a zero.
select cron.schedule(
  'analysis-batch-submit',
  '*/10 * * * *',
  $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/analysis-batch-submit',
    headers := jsonb_build_object(
      'Authorization', 'Bearer <NOVO_CRON_SECRET>',
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);

select cron.schedule(
  'analysis-batch-poll',
  '*/10 * * * *',
  $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/analysis-batch-poll',
    headers := jsonb_build_object(
      'Authorization', 'Bearer <NOVO_CRON_SECRET>',
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);

-- Acompanhe a drenagem com:
-- select status, count(*) from analises group by status order by status;
-- select tipo, status, count(*) from analise_batches group by tipo, status;
