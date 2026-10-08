-- Publicar primeiro analysis-batch-submit com o filtro de dias encerrados.
-- Janela de 00:00 a 03:50 em Fortaleza (03:00 a 06:50 UTC).
-- Repete lotes de até 50 para escoar a fila, sem avaliar o dia em andamento.
-- Preserva o comando existente, inclusive URL, headers e segredo.
-- Não imprime o comando para evitar expor credenciais.
do $$
begin
  if coalesce(current_setting('cron.timezone', true),'GMT') not in ('GMT','UTC','Etc/UTC') then
    raise exception 'Este agendamento requer pg_cron em UTC; confira cron.timezone';
  end if;
  if not exists (select 1 from cron.job where jobname = 'analysis-batch-submit') then
    raise exception 'Job analysis-batch-submit não encontrado';
  end if;
  perform cron.alter_job(job_id := jobid, schedule := '*/10 3-6 * * *', active := true)
  from cron.job where jobname = 'analysis-batch-submit';
end $$;

-- Verificação sem exibir credenciais:
select jobname, schedule, active
from cron.job
where jobname in ('analysis-batch-submit', 'analysis-batch-poll');
