-- Executar ANTES de publicar as Edge Functions do pacote.
-- Migração aditiva: nenhuma tabela de histórico é apagada.
begin;
-- O poll novo usa o registro de execuções; não abandone lotes do formato anterior.
do $$
begin
 if to_regclass('public.analise_batches') is not null then
  if exists(select 1 from public.analise_batches where status='in_progress') then
   raise exception 'Há batches legados ativos. Pause o submit e conclua/reconcilie esses batches com o poll anterior antes da migração';
  end if;
 end if;
end $$;
alter table public.analises add column if not exists conteudo_versao bigint not null default 0;
alter table public.analises add column if not exists proxima_tentativa_em timestamptz;
alter table public.mensagens add column if not exists midia_tentativas integer not null default 0;
alter table public.mensagens add column if not exists midia_proxima_tentativa_em timestamptz;
alter table public.mensagens add column if not exists midia_lease uuid;
alter table public.mensagens add column if not exists midia_lease_ate timestamptz;
alter table public.mensagens add column if not exists midia_erro text;
alter table public.mensagens add column if not exists midia_envio_iniciado boolean not null default false;
create table public.gemini_execucoes (
 id uuid primary key default gen_random_uuid(),
 conversa_id uuid not null references public.conversas(id) on delete cascade,
 dia date not null,
 input_hash text not null,
 etapa text not null check(etapa in ('analise','revisao')),
 modalidade text not null check(modalidade in ('batch','manual')),
 modelo text not null,
 modelo_retornado text,
 versao bigint not null,
 snapshot jsonb not null,
 resultado jsonb,
 uso jsonb,
 estado text not null default 'reservada' check(estado in ('reservada','enviando','submetida','concluida','falhou','incerta')),
 batch_externo text,
 reutilizacoes integer not null default 0,
 tentativas integer not null default 1,
 poll_tentativas integer not null default 0,
 erro text,
 proxima_tentativa_em timestamptz,
 criada_em timestamptz not null default now(),
 atualizada_em timestamptz not null default now(),
 lease_ate timestamptz not null default now()+interval '5 minutes',
 unique(conversa_id,dia,input_hash,etapa)
);
create index gemini_execucoes_ativas on public.gemini_execucoes(estado,atualizada_em);
create table public.gemini_uso_midia (
 mensagem_id uuid not null references public.mensagens(id) on delete cascade,
 tentativa integer not null,
 modelo text not null,
 modelo_retornado text,
 uso jsonb,
 sucesso boolean not null,
 criada_em timestamptz not null default now(),
 primary key(mensagem_id,tentativa)
);
alter table public.gemini_execucoes enable row level security;
alter table public.gemini_uso_midia enable row level security;
revoke all on public.gemini_execucoes, public.gemini_uso_midia from public,anon,authenticated;
grant all on public.gemini_execucoes, public.gemini_uso_midia to service_role;
-- Todas as RPCs operam com permissões do chamador e só service_role recebe EXECUTE.
create or replace function public.gemini_canonica(p_id uuid)
returns uuid language plpgsql security invoker set search_path='' as $$
declare atual uuid:=p_id; proxima uuid; vistos uuid[]:='{}';
begin
 loop
  if atual=any(vistos) or cardinality(vistos)>=16 then raise exception 'Ciclo ou profundidade inválida na consolidação'; end if;
  vistos=array_append(vistos,atual);
  select substituida_por_id into proxima from public.conversas where id=atual;
  if not found then raise exception 'Conversa ausente'; end if;
  if proxima is null then return atual; end if;
  atual=proxima;
 end loop;
end $$;
create or replace function public.gemini_grupo(p_id uuid)
returns table(id uuid,humano_assumiu_em timestamptz,canonica_id uuid)
language sql security invoker set search_path='' as $$
 with recursive raiz as(select public.gemini_canonica(p_id) as id),
 grupo as(select c.id,c.humano_assumiu_em,array[c.id] as caminho from public.conversas c join raiz r on r.id=c.id
  union all select c.id,c.humano_assumiu_em,g.caminho||c.id from public.conversas c join grupo g on c.substituida_por_id=g.id
  where not c.id=any(g.caminho) and cardinality(g.caminho)<16)
 select g.id,g.humano_assumiu_em,r.id from grupo g cross join raiz r;
$$;
revoke execute on function public.gemini_canonica(uuid),public.gemini_grupo(uuid) from public,anon,authenticated;
grant execute on function public.gemini_canonica(uuid),public.gemini_grupo(uuid) to service_role;

create or replace function public.enfileirar_analise_diaria(p_conversa_id uuid,p_dia date)
returns void language plpgsql security invoker set search_path='' as $$
declare v_id uuid;
begin
 v_id=public.gemini_canonica(p_conversa_id);
 if v_id is null then raise exception 'Conversa não encontrada'; end if;
 perform pg_advisory_xact_lock(hashtextextended(v_id::text||p_dia::text,0));
 insert into public.analises(conversa_id,dia,status,conteudo_versao)
 values(v_id,p_dia,'pendente',1)
 on conflict(conversa_id,dia) do update set
  conteudo_versao=public.analises.conteudo_versao+1,
  status=case when public.analises.status='processando' then 'processando'::public.analise_status else 'pendente'::public.analise_status end,
  proxima_tentativa_em=null;
end $$;

create or replace function public.gemini_reservar(p_conversa_id uuid,p_dia date,p_hash text,p_etapa text,p_modelo text,p_modalidade text,p_snapshot jsonb,p_versao bigint)
returns setof public.gemini_execucoes language plpgsql security invoker set search_path='' as $$
declare e public.gemini_execucoes; v bigint;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_conversa_id::text||p_dia::text,0));
 select conteudo_versao into v from public.analises where conversa_id=p_conversa_id and dia=p_dia for update;
 if v is distinct from p_versao or public.gemini_canonica(p_conversa_id)<>p_conversa_id then return; end if;
 -- Uma resposta incerta não autoriza reenviar uma inferência potencialmente paga.
 if exists(select 1 from public.gemini_execucoes where conversa_id=p_conversa_id and dia=p_dia and
  (estado in ('enviando','submetida','incerta') or (estado='reservada' and lease_ate>now()))) then return; end if;
 select * into e from public.gemini_execucoes where conversa_id=p_conversa_id and dia=p_dia and input_hash=p_hash and etapa=p_etapa for update;
 if found then
  if e.estado='concluida' then
   -- Mesmo input: reaplica o cache, sem nova inferência ou nova métrica de consumo.
   update public.gemini_execucoes set versao=p_versao,reutilizacoes=reutilizacoes+1
    where conversa_id=p_conversa_id and dia=p_dia and input_hash=p_hash and estado='concluida';
   perform public.gemini_concluir(e.id,e.resultado,e.uso,e.modelo_retornado,true);
   if p_etapa='analise' then
    select * into e from public.gemini_execucoes where conversa_id=p_conversa_id and dia=p_dia and input_hash=p_hash and etapa='revisao' and estado='concluida';
    if found then perform public.gemini_concluir(e.id,e.resultado,e.uso,e.modelo_retornado,true); end if;
   end if;
   return;
  end if;
  if e.estado='falhou' and (e.tentativas>=3 or e.proxima_tentativa_em is null or e.proxima_tentativa_em>now()) then return; end if;
  update public.gemini_execucoes set estado='reservada',tentativas=tentativas+1,versao=p_versao,
   snapshot=p_snapshot,modelo=p_modelo,modalidade=p_modalidade,lease_ate=now()+interval '5 minutes',atualizada_em=now(),erro=null
  where id=e.id returning * into e;
 else
  insert into public.gemini_execucoes(conversa_id,dia,input_hash,etapa,modelo,modalidade,snapshot,versao)
  values(p_conversa_id,p_dia,p_hash,p_etapa,p_modelo,p_modalidade,p_snapshot,p_versao) returning * into e;
 end if;
 update public.analises set status='processando',proxima_tentativa_em=null where conversa_id=p_conversa_id and dia=p_dia;
 return next e;
end $$;

create or replace function public.gemini_marcar_envio(p_ids uuid[])
returns integer language plpgsql security invoker set search_path='' as $$
declare n integer;
begin
 update public.gemini_execucoes set estado='enviando',atualizada_em=now() where id=any(p_ids) and estado='reservada' and lease_ate>now();
 get diagnostics n=row_count;
 if n<>cardinality(p_ids) then raise exception 'Reserva expirada ou já utilizada'; end if;
 return n;
end $$;

create or replace function public.gemini_falhar(p_id uuid,p_erro text,p_incerta boolean,p_repetir boolean)
returns void language plpgsql security invoker set search_path='' as $$
declare e public.gemini_execucoes; t timestamptz;
begin
 select * into e from public.gemini_execucoes where id=p_id;
 if not found then raise exception 'Execução ausente'; end if;
 perform pg_advisory_xact_lock(hashtextextended(e.conversa_id::text||e.dia::text,0));
 select * into e from public.gemini_execucoes where id=p_id for update;
 if e.estado='concluida' then return; end if;
 t=case when p_repetir and not p_incerta and e.tentativas<3 then now()+make_interval(secs=> (300*power(2,e.tentativas))::integer) else null end;
 update public.gemini_execucoes set estado=case when p_incerta then 'incerta' else 'falhou' end,
 erro=left(p_erro,500),proxima_tentativa_em=t,atualizada_em=now() where id=p_id;
 update public.analises set
 status=case when conteudo_versao<>e.versao or t is not null then 'pendente'::public.analise_status else 'falhou'::public.analise_status end,
 erro=case when conteudo_versao=e.versao then left(p_erro,500) else null end,
 proxima_tentativa_em=case when conteudo_versao=e.versao then t else null end
 where conversa_id=e.conversa_id and dia=e.dia;
end $$;

create or replace function public.gemini_concluir(p_id uuid,p_resultado jsonb,p_uso jsonb,p_modelo_retornado text,p_reaplicar boolean default false)
returns boolean language plpgsql security invoker set search_path='' as $$
declare e public.gemini_execucoes; a public.analises; b public.analises_bruta; patch jsonb;
begin
 select * into e from public.gemini_execucoes where id=p_id;
 if not found then raise exception 'Execução ausente'; end if;
 perform pg_advisory_xact_lock(hashtextextended(e.conversa_id::text||e.dia::text,0));
 select * into e from public.gemini_execucoes where id=p_id for update;
 if e.estado='concluida' and not p_reaplicar then return false; end if;
 if e.estado<>'concluida' and e.estado not in ('enviando','submetida','incerta') then raise exception 'Estado não permite conclusão'; end if;
 if e.estado<>'concluida' then
  update public.gemini_execucoes set resultado=p_resultado,uso=p_uso,modelo_retornado=p_modelo_retornado,
  estado='concluida',atualizada_em=now(),erro=null where id=p_id;
 end if;
 select * into a from public.analises where conversa_id=e.conversa_id and dia=e.dia for update;
 if exists(select 1 from public.conversas where id=e.conversa_id and substituida_por_id is not null) then
  update public.analises set status='consolidada' where id=a.id;
  return false;
 end if;
 if a.conteudo_versao<>e.versao then
  update public.analises set status='pendente',proxima_tentativa_em=null where id=a.id;
  return false;
 end if;
 patch=jsonb_build_object('modelo_usado',coalesce(p_modelo_retornado,e.modelo),'erro',null);
 if e.etapa='analise' then
  patch=patch||jsonb_build_object('status','processando','justificativa_geral',p_resultado->>'justificativa_geral',
   'analisado_em',now(),'revisado',false,'revisado_em',null,'resumo_revisao',null);
 else
  patch=patch||jsonb_build_object('status','concluida','revisado',true,'revisado_em',now(),'resumo_revisao',p_resultado->>'resumo_revisao');
 end if;
 if p_resultado ? 'fluxo' then patch=patch||jsonb_build_object('fluxo_score',p_resultado->'fluxo'->'score','fluxo_evidencia',p_resultado->'fluxo'->>'evidencia','fluxo_justificativa',p_resultado->'fluxo'->>'justificativa'); end if;
 if p_resultado ? 'fluidez' then patch=patch||jsonb_build_object('fluidez_score',p_resultado->'fluidez'->'score','fluidez_evidencia',p_resultado->'fluidez'->>'evidencia','fluidez_justificativa',p_resultado->'fluidez'->>'justificativa'); end if;
 if p_resultado ? 'cta' then patch=patch||jsonb_build_object('cta_score',p_resultado->'cta'->'score','cta_evidencia',p_resultado->'cta'->>'evidencia','cta_justificativa',p_resultado->'cta'->>'justificativa'); end if;
 if p_resultado ? 'clareza' then patch=patch||jsonb_build_object('clareza_score',p_resultado->'clareza'->'score','clareza_evidencia',p_resultado->'clareza'->>'evidencia','clareza_justificativa',p_resultado->'clareza'->>'justificativa'); end if;
 if p_resultado ? 'playbook' then patch=patch||jsonb_build_object('playbook_score',p_resultado->'playbook'->'score','playbook_evidencia',p_resultado->'playbook'->>'evidencia','playbook_justificativa',p_resultado->'playbook'->>'justificativa'); end if;
 a=jsonb_populate_record(a,patch);
 update public.analises set
 status=a.status,
 modelo_usado=a.modelo_usado,
 erro=a.erro,
 justificativa_geral=a.justificativa_geral,
 analisado_em=a.analisado_em,
 revisado=a.revisado,
 revisado_em=a.revisado_em,
 resumo_revisao=a.resumo_revisao,
 fluxo_score=a.fluxo_score,
 fluxo_evidencia=a.fluxo_evidencia,
 fluxo_justificativa=a.fluxo_justificativa,
 fluidez_score=a.fluidez_score,
 fluidez_evidencia=a.fluidez_evidencia,
 fluidez_justificativa=a.fluidez_justificativa,
 cta_score=a.cta_score,
 cta_evidencia=a.cta_evidencia,
 cta_justificativa=a.cta_justificativa,
 clareza_score=a.clareza_score,
 clareza_evidencia=a.clareza_evidencia,
 clareza_justificativa=a.clareza_justificativa,
 playbook_score=a.playbook_score,
 playbook_evidencia=a.playbook_evidencia,
 playbook_justificativa=a.playbook_justificativa where id=a.id;
 if e.etapa='analise' then
  b=jsonb_populate_record(null::public.analises_bruta,to_jsonb(a)||jsonb_build_object('criado_em',now()));
  insert into public.analises_bruta select (b).* on conflict(conversa_id,dia) do update set
 modelo_usado=excluded.modelo_usado,
 justificativa_geral=excluded.justificativa_geral,
 fluxo_score=excluded.fluxo_score,
 fluxo_evidencia=excluded.fluxo_evidencia,
 fluxo_justificativa=excluded.fluxo_justificativa,
 fluidez_score=excluded.fluidez_score,
 fluidez_evidencia=excluded.fluidez_evidencia,
 fluidez_justificativa=excluded.fluidez_justificativa,
 cta_score=excluded.cta_score,
 cta_evidencia=excluded.cta_evidencia,
 cta_justificativa=excluded.cta_justificativa,
 clareza_score=excluded.clareza_score,
 clareza_evidencia=excluded.clareza_evidencia,
 clareza_justificativa=excluded.clareza_justificativa,
 playbook_score=excluded.playbook_score,
 playbook_evidencia=excluded.playbook_evidencia,
 playbook_justificativa=excluded.playbook_justificativa;
 end if;
 return true;
end $$;

create or replace function public.gemini_reservar_midia(p_limite integer default 15)
returns setof public.mensagens language plpgsql security invoker set search_path='' as $$
begin
 -- Expiração após envio não prova que o provedor não cobrou a inferência.
 insert into public.gemini_uso_midia(mensagem_id,tentativa,modelo,sucesso)
 select id,midia_tentativas,'gemini-2.5-flash',false from public.mensagens
 where not midia_descrita and midia_envio_iniciado and midia_lease_ate<=now()
 on conflict do nothing;
 update public.mensagens set midia_descrita=true,midia_erro='Envio expirado sem confirmação; reconciliar antes de repetir',
 texto='[Mídia indisponível — envio sem confirmação; conferir diagnóstico]',midia_lease=null,midia_lease_ate=null
 where not midia_descrita and midia_envio_iniciado and midia_lease_ate<=now();
 return query update public.mensagens m set midia_envio_iniciado=false,midia_lease=gen_random_uuid(),midia_lease_ate=now()+interval '3 minutes',midia_tentativas=m.midia_tentativas+1
 where m.id in (select id from public.mensagens where not midia_descrita and midia_tentativas<5
  and (midia_proxima_tentativa_em is null or midia_proxima_tentativa_em<=now())
  and (midia_lease_ate is null or midia_lease_ate<=now()) order by enviada_em for update skip locked limit least(greatest(p_limite,1),15)) returning m.*;
end $$;

create or replace function public.gemini_marcar_envio_midia(p_id uuid,p_lease uuid)
returns boolean language plpgsql security invoker set search_path='' as $$
begin
 update public.mensagens set midia_envio_iniciado=true
 where id=p_id and midia_lease=p_lease and midia_lease_ate>now() and not midia_envio_iniciado and not midia_descrita;
 return found;
end $$;
revoke execute on function public.gemini_marcar_envio_midia(uuid,uuid) from public,anon,authenticated;
grant execute on function public.gemini_marcar_envio_midia(uuid,uuid) to service_role;

create or replace function public.gemini_finalizar_midia(p_id uuid,p_lease uuid,p_texto text,p_erro text,p_uso jsonb,p_modelo text,p_modelo_retornado text,p_repetir boolean default true)
returns boolean language plpgsql security invoker set search_path='' as $$
declare m public.mensagens; terminal boolean;
begin
 select * into m from public.mensagens where id=p_id and midia_lease=p_lease for update;
 if not found then return false; end if;
 terminal=p_texto is not null or m.midia_tentativas>=5 or not p_repetir;
 if p_uso is not null or m.midia_envio_iniciado then
  insert into public.gemini_uso_midia(mensagem_id,tentativa,modelo,modelo_retornado,uso,sucesso)
  values(m.id,m.midia_tentativas,p_modelo,p_modelo_retornado,p_uso,p_texto is not null) on conflict do nothing;
 end if;
 update public.mensagens set
  texto=coalesce(p_texto,case when terminal then '[Mídia indisponível — processamento falhou; conferir diagnóstico]' else texto end),
  midia_descrita=terminal,midia_erro=left(p_erro,500),midia_lease=null,midia_lease_ate=null,
  midia_proxima_tentativa_em=case when terminal then null else now()+make_interval(secs=>(300*power(2,m.midia_tentativas))::integer) end
 where id=m.id;
 return true;
end $$;

-- A alteração real de conteúdo (inclusive transcrição) marca a versão afetada.
create or replace function public.gemini_mensagem_alterada()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if TG_OP='INSERT' or (new.texto,new.autor_crm_user_id,new.enviada_em,new.conversa_id) is distinct from
 (old.texto,old.autor_crm_user_id,old.enviada_em,old.conversa_id) then
  perform public.enfileirar_analise_diaria(new.conversa_id,(new.enviada_em at time zone 'America/Fortaleza')::date);
  if TG_OP='UPDATE' and (new.enviada_em,new.conversa_id) is distinct from (old.enviada_em,old.conversa_id) then
   perform public.enfileirar_analise_diaria(old.conversa_id,(old.enviada_em at time zone 'America/Fortaleza')::date);
  end if;
 end if;
 return new;
end $$;
create trigger gemini_mensagem_alterada after insert or update of texto,autor_crm_user_id,enviada_em,conversa_id on public.mensagens
 for each row execute function public.gemini_mensagem_alterada();

-- Mudanças do grupo/handoff invalidam os dias que tiveram conteúdo, inclusive os antigos.
create or replace function public.gemini_conversa_alterada()
returns trigger language plpgsql security invoker set search_path='' as $$
declare d date;
begin
 if (new.humano_assumiu_em,new.substituida_por_id) is distinct from (old.humano_assumiu_em,old.substituida_por_id) then
  for d in select distinct (m.enviada_em at time zone 'America/Fortaleza')::date from public.mensagens m
   join public.gemini_grupo(new.id) g on g.id=m.conversa_id loop
   perform public.enfileirar_analise_diaria(new.id,d);
  end loop;
 end if;
 return new;
end $$;
create trigger gemini_conversa_alterada after update of humano_assumiu_em,substituida_por_id on public.conversas
 for each row execute function public.gemini_conversa_alterada();
revoke execute on function public.gemini_conversa_alterada() from public,anon,authenticated;

-- Uso bruto permanece disponível; ausência de métricas não é zero tokens.
create view public.gemini_consumo_diario with (security_invoker=true) as
select (atualizada_em at time zone 'America/Fortaleza')::date as dia_consumo,modelo,modalidade,etapa,
 count(*) as execucoes,count(distinct conversa_id) as conversas,
 count(distinct (conversa_id,dia)) as pares_conversa_dia,
 count(*) filter(where estado='concluida') as concluidas,
 count(*) filter(where estado<>'concluida') as falhas_com_uso,
 sum(greatest(tentativas-1,0)) as retentativas,
 sum((uso->>'promptTokenCount')::bigint) as entrada,
 sum((uso->>'candidatesTokenCount')::bigint) as saida,
 sum((uso->>'thoughtsTokenCount')::bigint) as raciocinio,
 count(*) filter(where uso is null) as sem_metricas
from public.gemini_execucoes where estado='concluida' or uso is not null group by 1,2,3,4;
revoke all on public.gemini_consumo_diario from public,anon,authenticated;
grant select on public.gemini_consumo_diario to service_role;
revoke execute on function public.enfileirar_analise_diaria(uuid,date) from public,anon,authenticated;
grant execute on function public.enfileirar_analise_diaria(uuid,date) to service_role;
revoke execute on function public.gemini_reservar(uuid,date,text,text,text,text,jsonb,bigint) from public,anon,authenticated;
grant execute on function public.gemini_reservar(uuid,date,text,text,text,text,jsonb,bigint) to service_role;
revoke execute on function public.gemini_marcar_envio(uuid[]) from public,anon,authenticated;
grant execute on function public.gemini_marcar_envio(uuid[]) to service_role;
revoke execute on function public.gemini_falhar(uuid,text,boolean,boolean) from public,anon,authenticated;
grant execute on function public.gemini_falhar(uuid,text,boolean,boolean) to service_role;
revoke execute on function public.gemini_concluir(uuid,jsonb,jsonb,text,boolean) from public,anon,authenticated;
grant execute on function public.gemini_concluir(uuid,jsonb,jsonb,text,boolean) to service_role;
revoke execute on function public.gemini_reservar_midia(integer) from public,anon,authenticated;
grant execute on function public.gemini_reservar_midia(integer) to service_role;
revoke execute on function public.gemini_finalizar_midia(uuid,uuid,text,text,jsonb,text,text,boolean) from public,anon,authenticated;
grant execute on function public.gemini_finalizar_midia(uuid,uuid,text,text,jsonb,text,text,boolean) to service_role;
revoke execute on function public.gemini_mensagem_alterada() from public,anon,authenticated;
create or replace function public.gemini_pendentes_revisao()
returns setof public.gemini_execucoes language sql security invoker set search_path='' as $$
 select e.* from public.gemini_execucoes e join public.analises a on a.conversa_id=e.conversa_id and a.dia=e.dia and a.conteudo_versao=e.versao
 where e.etapa='analise' and e.estado='concluida' and not exists(
  select 1 from public.gemini_execucoes r where r.conversa_id=e.conversa_id and r.dia=e.dia and r.input_hash=e.input_hash and r.etapa='revisao'
  and (r.estado<>'falhou' or r.tentativas>=3 or r.proxima_tentativa_em is null or r.proxima_tentativa_em>now()))
 order by e.atualizada_em limit 25;
$$;
revoke execute on function public.gemini_pendentes_revisao() from public,anon,authenticated;
grant execute on function public.gemini_pendentes_revisao() to service_role;
commit;
