-- Executar depois de publicar a nova versão de sync-clint.

select cron.unschedule('sync-clint');

select cron.schedule(
  'sync-clint',
  '*/10 * * * *',
  $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/sync-clint',
    headers := jsonb_build_object(
      'Authorization', 'Bearer <NOVO_CRON_SECRET>',
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
