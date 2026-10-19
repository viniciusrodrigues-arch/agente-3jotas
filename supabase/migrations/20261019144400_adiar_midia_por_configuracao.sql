-- Recusa explícita de autenticação/cobrança/modelo não é falha do arquivo.
-- Preserva texto e estado pendente, devolve a reserva e adia uma hora.
create or replace function public.gemini_adiar_midia_configuracao(p_id uuid,p_lease uuid,p_erro text)
returns boolean language plpgsql security invoker set search_path='' as $$
begin
 if p_erro not in ('Gemini HTTP 401','Gemini HTTP 402','Gemini HTTP 403','Gemini HTTP 404') then raise exception 'Erro não elegível'; end if;
 update public.mensagens set midia_descrita=false,midia_erro=p_erro,
 midia_lease=null,midia_lease_ate=null,midia_envio_iniciado=false,
 midia_tentativas=greatest(midia_tentativas-1,0),midia_proxima_tentativa_em=now()+interval '1 hour'
 where id=p_id and midia_lease=p_lease;
 return found;
end $$;
revoke execute on function public.gemini_adiar_midia_configuracao(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.gemini_adiar_midia_configuracao(uuid,uuid,text) to service_role;
