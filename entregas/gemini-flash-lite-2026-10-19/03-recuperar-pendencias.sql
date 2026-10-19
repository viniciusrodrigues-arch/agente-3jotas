-- Acionamento pontual autorizado em 19/10. Somente dias encerrados até 18/10.
-- Preserva os comandos/autenticação dos jobs existentes e não imprime secrets.
-- Cada job se remove ao terminar ou em 21/10 00:00 Fortaleza.
do $$
declare base text; comando text; tarefa text;
begin
 select command into base from cron.job where jobname='analysis-batch-submit';
 if base is null or base !~ $p$body\s*:=\s*'\{\}'::jsonb$p$ then raise exception 'Submit não reconhecido'; end if;
 tarefa=format($t$do $r$ declare d date; f date; c text; begin
 if now()>='2026-10-21T03:00:00Z'::timestamptz or not exists(select 1 from public.analises a where a.dia<'2026-10-19' and a.status='pendente' and not exists(select 1 from public.gemini_execucoes e where e.conversa_id=a.conversa_id and e.dia=a.dia and e.estado='incerta')) then perform cron.unschedule('gemini-pendentes-20261019'); return; end if;
 select min(a.dia) into d from public.analises a where a.dia<'2026-10-19' and a.status='pendente' and (a.proxima_tentativa_em is null or a.proxima_tentativa_em<=now()) and not exists(select 1 from public.gemini_execucoes e where e.conversa_id=a.conversa_id and e.dia=a.dia and e.estado in ('reservada','enviando','submetida','incerta'));
 if d is null then return; end if; f=least(d+6,'2026-10-18'::date);
 c=regexp_replace(%L,$p$body\s*:=\s*'\{\}'::jsonb$p$,format('body := %%L::jsonb',jsonb_build_object('recuperacao',true,'diaInicio',d,'diaFim',f)::text)); execute c;
 end $r$;$t$,base);
 perform cron.schedule('gemini-pendentes-20261019','*/2 * * * *',tarefa);
 perform cron.alter_job(job_id:=jobid,active:=true) from cron.job where jobname='gemini-pendentes-20261019';
 -- Primeira chamada concentra os dias recentes, enquanto o driver cobre o histórico.
 comando=regexp_replace(base,$p$body\s*:=\s*'\{\}'::jsonb$p$,$p$body := '{"recuperacao":true,"diaInicio":"2026-10-12","diaFim":"2026-10-18"}'::jsonb$p$);
 execute comando;
 select command into base from cron.job where jobname='analysis-batch-poll';
 if base is null or base !~ $p$body\s*:=\s*'\{\}'::jsonb$p$ then raise exception 'Poll não reconhecido'; end if;
 comando=regexp_replace(base,$p$body\s*:=\s*'\{\}'::jsonb$p$,$p$body := '{"recuperarRevisoes":true}'::jsonb$p$);
 tarefa=format($t$do $r$ begin
 if now()>='2026-10-21T03:00:00Z'::timestamptz or (not exists(select 1 from public.gemini_revisoes_recuperaveis()) and not exists(select 1 from public.gemini_execucoes where etapa='revisao' and estado in ('reservada','enviando','submetida') and snapshot->'operacao'->>'tipo'='recuperacao_revisao')) then perform cron.unschedule('gemini-revisoes-20261019'); return; end if;
 execute %L; end $r$;$t$,comando);
 perform cron.schedule('gemini-revisoes-20261019','*/2 * * * *',tarefa);
 perform cron.alter_job(job_id:=jobid,active:=true) from cron.job where jobname='gemini-revisoes-20261019';
 execute comando;
 select command into base from cron.job where jobname='processar-midia-pendente';
 if base is null or base !~ $p$body\s*:=\s*'\{\}'::jsonb$p$ then raise exception 'Mídia não reconhecida'; end if;
 tarefa=format($t$do $r$ declare d date; f date; c text; begin
 if now()>='2026-10-21T03:00:00Z'::timestamptz or not exists(select 1 from public.mensagens where not midia_descrita and enviada_em<'2026-10-19T03:00:00Z') then perform cron.unschedule('gemini-midias-20261019'); return; end if;
 select min((enviada_em at time zone 'America/Fortaleza')::date) into d from public.mensagens where not midia_descrita and enviada_em<'2026-10-19T03:00:00Z' and midia_tentativas<5 and (midia_proxima_tentativa_em is null or midia_proxima_tentativa_em<=now()) and (midia_lease_ate is null or midia_lease_ate<=now()) and (not midia_envio_iniciado or midia_lease is null);
 if d is null then return; end if; f=least(d+6,'2026-10-18'::date);
 c=regexp_replace(%L,$p$body\s*:=\s*'\{\}'::jsonb$p$,format('body := %%L::jsonb',jsonb_build_object('recuperacao',true,'diaInicio',d,'diaFim',f)::text)); execute c;
 end $r$;$t$,base);
 perform cron.schedule('gemini-midias-20261019','*/2 * * * *',tarefa);
 perform cron.alter_job(job_id:=jobid,active:=true) from cron.job where jobname='gemini-midias-20261019';
 execute tarefa;
end $$;
