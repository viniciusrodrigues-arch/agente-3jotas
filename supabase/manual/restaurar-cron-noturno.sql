-- Executar quando `select count(*) from analises where status = 'pendente'`
-- chegar a zero. 03:05 UTC = 00:05 em Fortaleza.

select cron.unschedule('analysis-batch-submit');

select cron.schedule(
  'analysis-batch-submit',
  '5 3 * * *',
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
