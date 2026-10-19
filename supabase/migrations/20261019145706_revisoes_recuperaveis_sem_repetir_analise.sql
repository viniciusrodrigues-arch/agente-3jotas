-- Leitura estreita: somente primeiras avaliações prontas cuja revisão falhou.
-- Não modifica avaliações nem cria cópia de uma inferência já paga.
create or replace function public.gemini_revisoes_recuperaveis()
returns setof public.gemini_execucoes language sql security invoker set search_path='' as $$
 select e.* from public.gemini_execucoes e
 join public.analises a on a.conversa_id=e.conversa_id and a.dia=e.dia and a.conteudo_versao=e.versao
 join public.conversas c on c.id=e.conversa_id and c.substituida_por_id is null
 where e.etapa='analise' and e.estado='concluida' and a.status='falhou'
 and a.dia<(now() at time zone 'America/Fortaleza')::date
 and exists(select 1 from public.gemini_execucoes r where r.conversa_id=e.conversa_id and r.dia=e.dia and r.input_hash=e.input_hash
  and r.etapa='revisao' and r.estado='falhou' and r.tentativas<3 and r.erro in ('Batch HTTP 402','Batch sem resposta para a execução'))
 and not exists(select 1 from public.gemini_execucoes r where r.conversa_id=e.conversa_id and r.dia=e.dia
  and (r.estado in ('reservada','enviando','submetida','incerta') or (r.etapa='revisao' and r.versao=e.versao and
   (r.estado='concluida' or r.snapshot->'operacao'->>'tipo'='recuperacao_revisao'))))
 order by e.dia,e.id limit 25;
$$;
revoke execute on function public.gemini_revisoes_recuperaveis() from public,anon,authenticated;
grant execute on function public.gemini_revisoes_recuperaveis() to service_role;
