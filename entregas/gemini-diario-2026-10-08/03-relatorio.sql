-- Executar no SQL Editor do Supabase após a migração.
-- Só leitura. Não mostra mensagens, snapshots, segredos ou comandos do cron.
select * from public.gemini_consumo_diario order by dia_consumo desc,modelo,modalidade,etapa;

-- Inclui operações incertas e falhas sem métricas, que não significam custo zero.
select estado,modelo,modalidade,etapa,count(*) as execucoes,
 count(*) filter(where uso is null) as sem_metricas,
 sum(reutilizacoes) as reutilizacoes,sum(greatest(tentativas-1,0)) as retentativas
from public.gemini_execucoes group by 1,2,3,4 order by 1,2,3,4;

select (criada_em at time zone 'America/Fortaleza')::date as dia_consumo,modelo,
 count(*) as tentativas,count(*) filter(where sucesso) as sucessos,
 count(*) filter(where uso is null) as sem_metricas,
 sum((uso->>'promptTokenCount')::bigint) as entrada,
 sum((uso->>'candidatesTokenCount')::bigint) as saida,
 sum((uso->>'thoughtsTokenCount')::bigint) as raciocinio
from public.gemini_uso_midia group by 1,2 order by 1 desc,2;

-- Estimativa de análise/revisão: preencher tarifas vigentes por milhão de tokens.
-- NULL é desconhecido, nunca zero. Cada modalidade tem sua própria tarifa.
-- Mídia fica separada porque áudio/imagem podem ter outras tarifas de entrada.
-- Saída é totalTokenCount - promptTokenCount; não soma thoughtsTokenCount outra vez.
-- A estimativa precisa ser conciliada com a fatura, não é custo observado.
with tarifas(modelo,modalidade,entrada_usd,cache_usd,saida_usd) as (
 values
 ('gemini-3.6-flash','batch',null::numeric,null::numeric,null::numeric),
 ('gemini-3.6-flash','manual',null::numeric,null::numeric,null::numeric)
), calculo as (
 select e.*,t.entrada_usd,t.cache_usd,t.saida_usd,
 case when t.entrada_usd is not null and t.saida_usd is not null
  and uso ? 'promptTokenCount' and uso ? 'totalTokenCount'
  and (coalesce((uso->>'cachedContentTokenCount')::numeric,0)=0 or t.cache_usd is not null)
 then (
 ((uso->>'promptTokenCount')::numeric-coalesce((uso->>'cachedContentTokenCount')::numeric,0))*t.entrada_usd
 +coalesce((uso->>'cachedContentTokenCount')::numeric,0)*coalesce(t.cache_usd,0)
 +((uso->>'totalTokenCount')::numeric-(uso->>'promptTokenCount')::numeric)*t.saida_usd
 )/1000000 end as custo_usd
 from public.gemini_execucoes e left join tarifas t using(modelo,modalidade)
 where e.estado='concluida' or e.uso is not null
)
select (atualizada_em at time zone 'America/Fortaleza')::date as dia_consumo,modelo,modalidade,
 count(*) as execucoes,count(distinct(conversa_id,dia)) as pares_conversa_dia,
 count(*) filter(where custo_usd is null) as custo_desconhecido,
 case when count(*) filter(where custo_usd is null)=0 then sum(custo_usd) end as custo_estimado_usd
from calculo group by 1,2,3 order by 1 desc,2,3;
