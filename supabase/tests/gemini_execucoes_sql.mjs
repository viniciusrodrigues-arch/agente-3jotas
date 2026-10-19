// Executar com PGlite 0.3.14 instalado em /tmp/3jotas-sql-tests.
const { PGlite } = await import(process.env.PGLITE_MODULE || '/tmp/3jotas-sql-tests/node_modules/@electric-sql/pglite/dist/index.js');
import fs from 'node:fs/promises';
const pg = new PGlite();
const criterios = ['fluxo','fluidez','cta','clareza','playbook'];
const campos = criterios.flatMap(c => [`${c}_score smallint`, `${c}_evidencia text`, `${c}_justificativa text`]).join(',');
await pg.exec(`
create role anon; create role authenticated; create role service_role bypassrls;
create type public.analise_status as enum ('pendente','processando','concluida','falhou','nao_elegivel','consolidada');
create table public.conversas(id uuid primary key,substituida_por_id uuid,humano_assumiu_em timestamptz);
create table public.mensagens(id uuid primary key default gen_random_uuid(),conversa_id uuid references conversas(id),texto text not null,enviada_em timestamptz not null,autor_crm_user_id text,midia_descrita boolean not null default true);
create table public.analises(id uuid primary key default gen_random_uuid(),conversa_id uuid references conversas(id),dia date not null,status public.analise_status not null default 'pendente',${campos},modelo_usado text,erro text,justificativa_geral text,analisado_em timestamptz,revisado boolean default false,revisado_em timestamptz,resumo_revisao text,created_at timestamptz default now(),updated_at timestamptz default now(),unique(conversa_id,dia));
create table public.analises_bruta(conversa_id uuid,dia date,${campos},modelo_usado text,justificativa_geral text,criado_em timestamptz default now(),primary key(conversa_id,dia));
`);
const migration = process.argv[2];
const arquivos=['20261013142056_gemini_execucoes_diarias_estrutura.sql','20261013142109_gemini_execucoes_diarias_operacoes.sql','20261013142303_gemini_execucoes_diarias_midia_e_fila.sql','20261013142758_gemini_recuperacao_midia_periodo.sql'];
await pg.exec("create table public.analise_batches(status text);insert into public.analise_batches values('in_progress');");
arquivos.push(...(await fs.readdir('supabase/migrations')).filter(n=>n.endsWith('_adiar_midia_por_configuracao.sql')));
const sqlMigration=migration ? await fs.readFile(migration,'utf8') : (await Promise.all(arquivos.map(nome=>fs.readFile('supabase/migrations/'+nome,'utf8')))).join('\n');
let bloqueouLegado=false;
try{await pg.exec(sqlMigration);}catch(err){bloqueouLegado=String(err).includes('batches legados ativos');await pg.exec('rollback');}
if(!bloqueouLegado) throw new Error('Migração não protege batches legados');
await pg.exec("update public.analise_batches set status='ended'");
await pg.exec(sqlMigration);
const id = '00000000-0000-0000-0000-000000000001';
await pg.query('insert into conversas(id) values($1)',[id]);
const assert = (cond,msg) => { if(!cond) throw new Error(msg); };
const q = async (sql,params=[]) => (await pg.query(sql,params)).rows;
const enfileirar = async dia => q('select enfileirar_analise_diaria($1,$2)',[id,dia]);
const reservar = async (dia,hash,etapa='analise',versao=1) => q('select * from gemini_reservar($1,$2,$3,$4,$5,$6,$7,$8)',[id,dia,hash,etapa,'gemini-3.6-flash','batch',{parametros:[]},versao]);
const enviar = async e => q('select gemini_marcar_envio($1)',[[e.id]]);
const concluir = async e => q('select gemini_concluir($1,$2,$3,$4)',[e.id,{justificativa_geral:'teste',resumo_revisao:'teste',fluxo:{score:1,evidencia:'oi',justificativa:'teste'}},{promptTokenCount:100,candidatesTokenCount:20,thoughtsTokenCount:5},'modelo-retornado']);
await enfileirar('2026-10-06');await enfileirar('2026-10-07');
let e=(await reservar('2026-10-06','a'))[0];assert(e,'reserva não criada');
assert((await reservar('2026-10-06','a')).length===0,'reserva duplicada');
assert((await reservar('2026-10-06','b')).length===0,'versão concorrente reservada');
let outra=(await reservar('2026-10-07','b'))[0];assert(outra,'dia diferente bloqueado');
await enviar(e);await enfileirar('2026-10-06');
assert(!(await concluir(e))[0].gemini_concluir,'resultado antigo publicado');
assert((await q('select status from analises where dia=$1',['2026-10-06']))[0].status==='pendente','mudança durante execução perdida');
let nova=(await reservar('2026-10-06','nova','analise',2))[0];await enviar(nova);assert((await concluir(nova))[0].gemini_concluir,'resultado atual não publicado');
assert(!(await concluir(nova))[0].gemini_concluir,'conclusão repetida publicada');
let parents=await q('select * from gemini_pendentes_revisao()');assert(parents.some(p=>p.id===nova.id),'revisão não recuperável');assert(!parents.some(p=>p.id===e.id),'revisão de versão obsoleta');
let rev=(await reservar('2026-10-06','nova','revisao',2))[0];assert(rev,'revisão não reservada');assert((await reservar('2026-10-06','nova','revisao',2)).length===0,'revisão duplicada');
await enviar(rev);await concluir(rev);assert((await q('select status,revisado from analises where dia=$1',['2026-10-06']))[0].revisado,'revisão não publicada');
await q('select gemini_falhar($1,$2,$3,$4)',[outra.id,'incerto',true,false]);
assert((await reservar('2026-10-07','b')).length===0,'envio incerto repetido');
// Voltar ao mesmo conteúdo após outra versão reaproveita análise e revisão.
const antes=(await q('select uso,atualizada_em from gemini_execucoes where id=$1',[nova.id]))[0];
await enfileirar('2026-10-06');
assert((await reservar('2026-10-06','nova','analise',3)).length===0,'cache cobrado novamente');
assert((await q("select status,revisado from analises where dia='2026-10-06'"))[0].revisado,'cache não restaurou revisão');
const depois=(await q('select uso,atualizada_em from gemini_execucoes where id=$1',[nova.id]))[0];
assert(JSON.stringify(antes)===JSON.stringify(depois),'reuso modificou consumo original');
// Reservas expiradas antes do envio podem tentar novamente com backoff.
await enfileirar('2026-09-01');
let expirou=(await reservar('2026-09-01','expirada'))[0];
await q("update gemini_execucoes set lease_ate=now()-interval '1 minute' where id=$1",[expirou.id]);
await q('select gemini_falhar($1,$2,false,true)',[expirou.id,'pré-envio']);
assert((await reservar('2026-09-01','expirada')).length===0,'retry ignorou backoff');
await q("update gemini_execucoes set proxima_tentativa_em=now()-interval '1 minute' where id=$1",[expirou.id]);
assert((await reservar('2026-09-01','expirada'))[0].tentativas===2,'reserva segura não recuperada');
// Falha de uma execução anterior preserva a fila de conteúdo mais recente.
await enfileirar('2026-09-01');
await q('select gemini_falhar($1,$2,false,false)',[expirou.id,'falha antiga']);
assert((await q("select status from analises where dia='2026-09-01'"))[0].status==='pendente','falha apagou versão nova');
// Insert e transcrição enfileiram o dia original; não o dia corrente.
const m=(await q("insert into mensagens(conversa_id,texto,enviada_em,midia_descrita) values($1,'pendente','2026-10-05T02:30:00Z',false) returning id",[id]))[0];
assert((await q("select dia::text from analises where dia='2026-10-04'")).length===1,'fronteira Fortaleza incorreta');
const media=(await q('select * from gemini_reservar_midia(1)'))[0];assert(media.id===m.id,'mídia não reservada');assert((await q('select * from gemini_reservar_midia(1)')).length===0,'mídia reservada duas vezes');
await q('select gemini_finalizar_midia($1,$2,$3,$4,$5,$6,$7,$8)',[m.id,media.midia_lease,'transcrição',null,{promptTokenCount:10},'modelo','modelo',false]);
assert((await q("select conteudo_versao from analises where dia='2026-10-04'"))[0].conteudo_versao===2,'transcrição não reabriu o dia');
// Worker interrompido depois de iniciar o envio não cobra a mesma mídia novamente.
const interrompida=(await q("insert into mensagens(conversa_id,texto,enviada_em,midia_descrita) values($1,'pendente','2026-10-05T15:00:00Z',false) returning id",[id]))[0];
const lease=(await q('select * from gemini_reservar_midia(1)'))[0];
assert((await q('select gemini_marcar_envio_midia($1,$2)',[lease.id,lease.midia_lease]))[0].gemini_marcar_envio_midia,'envio de mídia não marcado');
await q("update mensagens set midia_lease_ate=now()-interval '1 minute' where id=$1",[lease.id]);
assert((await q('select * from gemini_reservar_midia(1)')).length===0,'mídia incerta reservada novamente');
assert((await q('select midia_descrita,midia_erro from mensagens where id=$1',[interrompida.id]))[0].midia_erro.includes('sem confirmação'),'mídia incerta sem diagnóstico');
assert((await q('select * from gemini_uso_midia where mensagem_id=$1',[interrompida.id]))[0].uso===null,'uso desconhecido virou zero');
// Grupos seguem cadeias de consolidação e invalidam o dia de mensagens do grupo.
const raiz='00000000-0000-0000-0000-000000000002';
const filha='00000000-0000-0000-0000-000000000003';
await q('insert into conversas(id) values($1),($2)',[raiz,filha]);
await q('update conversas set substituida_por_id=$1 where id=$2',[id,raiz]);
await q('update conversas set substituida_por_id=$1 where id=$2',[raiz,filha]);
assert((await q('select gemini_canonica($1)',[filha]))[0].gemini_canonica===id,'cadeia canônica truncada');
assert((await q('select * from gemini_grupo($1)',[filha])).length===3,'grupo incompleto');
await q("insert into mensagens(conversa_id,texto,enviada_em) values($1,'oi','2026-10-03T15:00:00Z')",[filha]);
const vGrupo=(await q("select conteudo_versao from analises where conversa_id=$1 and dia='2026-10-03'",[id]))[0].conteudo_versao;
await q("update conversas set humano_assumiu_em='2026-10-03T14:00:00Z' where id=$1",[filha]);
assert((await q("select conteudo_versao from analises where conversa_id=$1 and dia='2026-10-03'",[id]))[0].conteudo_versao>vGrupo,'handoff não reabriu dia da cadeia');
// A fila de 61 dias é drenada em duas seleções de 50 sem apagar o restante.
await q("select enfileirar_analise_diaria($1,d::date) from generate_series('2026-06-01'::date,'2026-07-31'::date,interval '1 day') as d",[id]);
let total=0;
for(let ciclo=0;ciclo<2;ciclo++){
 const fila=await q("select dia::text,conteudo_versao from analises where conversa_id=$1 and dia between '2026-06-01' and '2026-07-31' and status='pendente' order by dia limit 50",[id]);
 for(const par of fila){assert((await reservar(par.dia,'fila-'+par.dia,'analise',par.conteudo_versao)).length===1,'item da fila não reservado');total++;}
}
assert(total===61,'mais de 50 pendências não drenaram');
assert((await q("select count(*)::integer as n from analises where conversa_id=$1 and dia between '2026-06-01' and '2026-07-31'",[id]))[0].n===61,'pendências históricas apagadas');
// Recuperação de mídia reserva apenas o período e preserva texto fora dele.
const dentro=(await q("insert into mensagens(conversa_id,texto,enviada_em,midia_descrita) values($1,'pendente no período','2026-10-09T15:00:00Z',false) returning id",[id]))[0];
const fora=(await q("insert into mensagens(conversa_id,texto,enviada_em,midia_descrita) values($1,'texto fora do período','2026-10-07T15:00:00Z',false) returning id",[id]))[0];
const periodo=await q("select * from gemini_reservar_midia_periodo(1,'2026-10-09','2026-10-10')");
assert(periodo.length===1 && periodo[0].id===dentro.id,'mídia fora do período reservada');
const preservada=(await q('select texto,midia_tentativas from mensagens where id=$1',[fora.id]))[0];
assert(preservada.texto==='texto fora do período' && preservada.midia_tentativas===0,'recuperação alterou mídia fora do período');
// HTTP 402 mantém o texto e não consome as cinco tentativas do arquivo.
const original=(await q('select texto,midia_tentativas from mensagens where id=$1',[dentro.id]))[0];
assert((await q('select gemini_adiar_midia_configuracao($1,$2,$3)',[dentro.id,periodo[0].midia_lease,'Gemini HTTP 402']))[0].gemini_adiar_midia_configuracao,'recusa não adiada');
const adiada=(await q('select texto,midia_descrita,midia_lease,midia_tentativas,midia_proxima_tentativa_em>now() as adiada from mensagens where id=$1',[dentro.id]))[0];
assert(adiada.texto===original.texto && !adiada.midia_descrita && adiada.midia_lease===null && adiada.adiada,'402 descartou conteúdo ou não adiou');
assert(adiada.midia_tentativas===original.midia_tentativas-1,'402 consumiu tentativa de mídia');
// RPCs estreitas não são públicas; tabelas com snapshots possuem RLS.
assert(!(await q("select has_function_privilege('anon','public.gemini_reservar(uuid,date,text,text,text,text,jsonb,bigint)','execute') as permitido"))[0].permitido,'RPC exposta anon');
assert((await q("select relrowsecurity from pg_class where relname='gemini_execucoes'"))[0].relrowsecurity,'snapshots sem RLS');
assert((await q('select entrada,saida,raciocinio from gemini_consumo_diario')).length>0,'métricas ausentes');
await pg.exec(await fs.readFile('supabase/manual/relatorio-consumo-gemini.sql','utf8'));
// O script operacional preserva autenticação, ativa ambos os jobs e se remove ao terminar.
await pg.exec(`create schema cron; create schema net;
create table cron.job(jobid bigint generated always as identity primary key,jobname text unique,schedule text,command text,active boolean default true);
create table net.chamadas(id bigint generated always as identity,body jsonb,timeout_ms integer);
create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer default 1000) returns bigint language sql as 'insert into net.chamadas(body,timeout_ms) values(body,timeout_milliseconds) returning id';
create function cron.schedule(nome text,agenda text,comando text) returns bigint language sql as 'insert into cron.job(jobname,schedule,command) values(nome,agenda,comando) on conflict(jobname) do update set schedule=excluded.schedule,command=excluded.command returning jobid';
create function cron.alter_job(job_id bigint,schedule text default null,command text default null,active boolean default null) returns void language sql as 'update cron.job j set schedule=coalesce(alter_job.schedule,j.schedule),command=coalesce(alter_job.command,j.command),active=coalesce(alter_job.active,j.active) where j.jobid=job_id';
create function cron.unschedule(nome text) returns boolean language plpgsql as 'begin delete from cron.job where jobname=nome; return found; end';`);
const comandoTeste="select net.http_post(url := 'https://teste/functions/v1/analysis-batch-submit',headers := '{\"Authorization\":\"Bearer teste\"}'::jsonb,body := '{}'::jsonb);";
await q('select cron.schedule($1,$2,$3)',['analysis-batch-submit','*/10 * * * *',comandoTeste]);
await q('select cron.schedule($1,$2,$3)',['processar-midia-pendente','*/5 * * * *',comandoTeste]);
await pg.exec(await fs.readFile('supabase/manual/recuperar-analises-outubro-2026.sql','utf8'));
assert((await q("select count(*)::integer as n from cron.job where jobname like 'gemini-recuperacao-%' and active"))[0].n===2,'job de recuperação não ativado');
assert((await q("select timeout_ms from net.chamadas where body->>'diaInicio'='2026-10-09'"))[0].timeout_ms===120000,'timeout de mídia não corrigido');
assert((await q("select command from cron.job where jobname='processar-midia-pendente'"))[0].command.includes('Bearer teste'),'autenticação não preservada');
await q("update analises set status='consolidada' where dia between '2026-10-08' and '2026-10-12'");
await q("update mensagens set midia_descrita=true where enviada_em>='2026-10-09T03:00:00Z' and enviada_em<'2026-10-11T03:00:00Z'");
for(const j of await q("select command from cron.job where jobname like 'gemini-recuperacao-%'")){await pg.exec(j.command);}
assert((await q("select count(*)::integer as n from cron.job where jobname like 'gemini-recuperacao-%'"))[0].n===0,'recuperação não encerrou os jobs');
console.log('OK: migração real + reservas, dias, versões, revisão, incerteza, mídia, permissões e métricas.');
await pg.close();
