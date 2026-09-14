create function public.ru_settings_get() returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null then raise exception 'Sign in required.' using errcode='28000'; end if;
 return coalesce((select to_jsonb(s)-'user_id' from public.ru_settings s where user_id=auth.uid()),'{"timezone":null,"default_mode":"Math"}'::jsonb);
end $$;
revoke all on function public.ru_settings_get() from public,anon;
grant execute on function public.ru_settings_get() to authenticated;
