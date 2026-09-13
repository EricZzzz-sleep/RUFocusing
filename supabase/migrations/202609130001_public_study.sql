-- Public v1. Cloud data is independent of the local SQLite database.
create table public.ru_settings (
 user_id uuid primary key references auth.users(id) on delete cascade,
 timezone text not null default 'UTC', default_mode text not null default 'Math'
 check (default_mode in ('Math','Coding','Reading','Lecture'))
);
create table public.ru_sessions (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
 task text not null check (length(btrim(task)) between 1 and 200), mode text not null check (mode in ('Math','Coding','Reading','Lecture')),
 started_at timestamptz not null default now(), ended_at timestamptz,
 status text not null check (status in ('running','break','completed','interrupted')),
 elapsed double precision not null default 0 check (elapsed >= 0), camera_enabled boolean not null default false,
 revision integer not null default 0, checkpoint_at timestamptz not null default now(),
 lease_until timestamptz, owner_tab uuid, pause_reason text,
 unique(id,user_id)
);
create unique index ru_one_active on public.ru_sessions(user_id) where status in ('running','break');
create index ru_history on public.ru_sessions(user_id,started_at desc,id desc);
create table public.ru_intervals (
 session_id uuid not null, user_id uuid not null, start double precision not null, "end" double precision not null,
 state text not null check (state in ('present','away','unknown','break')),
 primary key(session_id,start), foreign key(session_id,user_id) references public.ru_sessions(id,user_id) on delete cascade,
 check (start >= 0 and "end" > start)
);
create table public.ru_reflections (
 session_id uuid primary key, user_id uuid not null,
 concentration integer check (concentration between 1 and 5), distraction integer check (distraction between 1 and 5),
 flow text check (flow in ('yes','no','unsure')),
 foreign key(session_id,user_id) references public.ru_sessions(id,user_id) on delete cascade
);
create table public.ru_annotations (
 session_id uuid not null, user_id uuid not null, start double precision not null, "end" double precision not null,
 kind text not null check (kind in ('focused','distracted','flow')), primary key(session_id,start),
 foreign key(session_id,user_id) references public.ru_sessions(id,user_id) on delete cascade,
 check(start >= 0 and "end" > start)
);
-- Tombstones contain no study content and retain idempotency after session deletion.
create table public.ru_commands (
 user_id uuid not null references auth.users(id) on delete cascade, command_id uuid not null,
 session_id uuid, action text not null, created_at timestamptz not null default now(), primary key(user_id,command_id)
);
alter table public.ru_settings enable row level security;
alter table public.ru_sessions enable row level security;
alter table public.ru_intervals enable row level security;
alter table public.ru_reflections enable row level security;
alter table public.ru_annotations enable row level security;
alter table public.ru_commands enable row level security;
create policy own_settings on public.ru_settings for select to authenticated using(user_id=(select auth.uid()));
create policy own_sessions on public.ru_sessions for select to authenticated using(user_id=(select auth.uid()));
create policy own_intervals on public.ru_intervals for select to authenticated using(user_id=(select auth.uid()));
create policy own_reflections on public.ru_reflections for select to authenticated using(user_id=(select auth.uid()));
create policy own_annotations on public.ru_annotations for select to authenticated using(user_id=(select auth.uid()));
revoke all on public.ru_settings,public.ru_sessions,public.ru_intervals,public.ru_reflections,public.ru_annotations,public.ru_commands from anon,authenticated;
grant select on public.ru_settings,public.ru_sessions,public.ru_intervals,public.ru_reflections,public.ru_annotations to authenticated;

create function public.ru_session_json(p_id uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select to_jsonb(s)-'user_id' || jsonb_build_object(
 'timeline',coalesce((select jsonb_agg(jsonb_build_object('start',i.start,'end',i."end",'state',i.state) order by i.start) from public.ru_intervals i where i.session_id=s.id),'[]'::jsonb),
 'reflection',coalesce((select to_jsonb(r)-'user_id'-'session_id' from public.ru_reflections r where r.session_id=s.id),'{"concentration":null,"distraction":null,"flow":null}'::jsonb),
 'annotations',coalesce((select jsonb_agg(jsonb_build_object('start',a.start,'end',a."end",'kind',a.kind) order by a.start) from public.ru_annotations a where a.session_id=s.id),'[]'::jsonb))
 from public.ru_sessions s where s.id=p_id and s.user_id=auth.uid()
$$;
-- Internal helper: caller holds the account transaction lock.
create function public.ru_append(p_id uuid,p_user uuid,p_start double precision,p_end double precision,p_state text) returns void language plpgsql security definer set search_path='' as $$
declare last_row public.ru_intervals;
begin
 if p_end <= p_start then return; end if;
 select * into last_row from public.ru_intervals where session_id=p_id order by start desc limit 1;
 if last_row.state=p_state and abs(last_row."end"-p_start)<0.000001 then
   update public.ru_intervals set "end"=p_end where session_id=p_id and start=last_row.start;
 else insert into public.ru_intervals values(p_id,p_user,p_start,p_end,p_state); end if;
end $$;
create function public.ru_expire(p_user uuid) returns void language plpgsql security definer set search_path='' as $$
begin
 update public.ru_sessions set status='break',pause_reason='connection_lost',owner_tab=null,lease_until=null,revision=revision+1
 where user_id=p_user and status='running' and lease_until<clock_timestamp();
end $$;
create function public.ru_state() returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=auth.uid(); identifier uuid;
begin
 if u is null then raise exception 'Sign in required.' using errcode='28000'; end if;
 perform pg_advisory_xact_lock(hashtextextended(u::text,0));
 perform public.ru_expire(u);
 select id into identifier from public.ru_sessions where user_id=u and status in ('running','break');
 return jsonb_build_object('active',public.ru_session_json(identifier),'server_now',clock_timestamp());
end $$;

create function public.ru_command(p_action text,p_command uuid,p_tab uuid,p_id uuid default null,p_revision integer default null,p_data jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 u uuid:=auth.uid(); s public.ru_sessions; prior public.ru_commands; stamp timestamptz;
 next_elapsed double precision; cursor_time double precision; a double precision; b double precision;
 row jsonb; previous_end double precision:=-1; label text; last_label text:='unknown';
 task_value text; mode_value text;
begin
 if u is null then raise exception 'Sign in required.' using errcode='28000'; end if;
 if p_command is null or p_tab is null or jsonb_typeof(p_data)<>'object' then raise exception 'Invalid command.'; end if;
 perform pg_advisory_xact_lock(hashtextextended(u::text,0));
 perform public.ru_expire(u);
 select * into prior from public.ru_commands where user_id=u and command_id=p_command;
 if found then
   if prior.action<>p_action or (p_id is not null and prior.session_id is distinct from p_id) then raise exception 'Command ID already used.'; end if;
   return jsonb_build_object('session',public.ru_session_json(prior.session_id),'replayed',true,'deleted',prior.action='delete');
 end if;
 stamp:=clock_timestamp();
 if p_action='start' then
   if exists(select 1 from public.ru_sessions where user_id=u and status in ('running','break')) then raise exception 'An active session already exists.' using errcode='40001'; end if;
   task_value:=btrim(p_data->>'task'); mode_value:=p_data->>'mode';
   if task_value is null or length(task_value) not between 1 and 200 or mode_value is null or mode_value not in ('Math','Coding','Reading','Lecture') then raise exception 'Enter a task and valid study mode.'; end if;
   insert into public.ru_sessions(user_id,task,mode,status,started_at,checkpoint_at,lease_until,owner_tab,camera_enabled)
   values(u,task_value,mode_value,'running',stamp,stamp,stamp+interval '30 seconds',p_tab,coalesce((p_data->>'camera')::boolean,false)) returning * into s;
 else
   select * into s from public.ru_sessions where id=p_id and user_id=u for update;
   if not found then raise exception 'Session not found.' using errcode='P0002'; end if;
   if p_revision is distinct from s.revision then raise exception 'Session changed. Refresh and try again.' using errcode='40001'; end if;
   if p_action in ('edit','delete','reflection','annotations') then
     if s.status not in ('completed','interrupted') then raise exception 'End the session before changing its report.'; end if;
     if p_action='delete' then delete from public.ru_sessions where id=s.id;
     elsif p_action='edit' then
       task_value:=btrim(p_data->>'task'); mode_value:=p_data->>'mode';
       if task_value is null or length(task_value) not between 1 and 200 or mode_value is null or mode_value not in ('Math','Coding','Reading','Lecture') then raise exception 'Enter a task and valid study mode.'; end if;
       update public.ru_sessions set task=task_value,mode=mode_value,revision=revision+1 where id=s.id;
     elsif p_action='reflection' then
       if exists(select 1 from jsonb_object_keys(p_data) k where k not in ('concentration','distraction','flow')) then raise exception 'Invalid reflection field.'; end if;
       if (p_data->>'concentration') is not null and (jsonb_typeof(p_data->'concentration')<>'number' or (p_data->>'concentration')::numeric<>trunc((p_data->>'concentration')::numeric)) then raise exception 'Invalid concentration rating.'; end if;
       if (p_data->>'distraction') is not null and (jsonb_typeof(p_data->'distraction')<>'number' or (p_data->>'distraction')::numeric<>trunc((p_data->>'distraction')::numeric)) then raise exception 'Invalid distraction rating.'; end if;
       insert into public.ru_reflections values(s.id,u,(p_data->>'concentration')::integer,(p_data->>'distraction')::integer,p_data->>'flow')
       on conflict(session_id) do update set concentration=excluded.concentration,distraction=excluded.distraction,flow=excluded.flow;
       update public.ru_sessions set revision=revision+1 where id=s.id;
     else
       if jsonb_typeof(p_data->'annotations') is distinct from 'array' or jsonb_array_length(p_data->'annotations')>30 then raise exception 'Use up to 30 timeline tags.'; end if;
       delete from public.ru_annotations where session_id=s.id;
       for row in select value from jsonb_array_elements(p_data->'annotations') order by (value->>'start')::double precision loop
         a:=(row->>'start')::double precision; b:=(row->>'end')::double precision;
         if jsonb_typeof(row->'start') is distinct from 'number' or jsonb_typeof(row->'end') is distinct from 'number' or a<0 or b<=a or b>s.elapsed or a<previous_end or (row->>'kind') is null or (row->>'kind') not in ('focused','distracted','flow') then raise exception 'Invalid or overlapping timeline tags.'; end if;
         if exists(select 1 from public.ru_intervals i where i.session_id=s.id and i.state='break' and a<i."end" and b>i.start) then raise exception 'Tags cannot overlap breaks.'; end if;
         insert into public.ru_annotations values(s.id,u,a,b,row->>'kind'); previous_end:=b;
       end loop;
       update public.ru_sessions set revision=revision+1 where id=s.id;
     end if;
   else
     if s.status not in ('running','break') then raise exception 'Session already ended.' using errcode='40001'; end if;
     if s.status='running' and s.owner_tab is distinct from p_tab then raise exception 'This session is recording in another tab.' using errcode='40001'; end if;
     if p_action not in ('checkpoint','pause','resume','end','camera') then raise exception 'Unknown session command.'; end if;
     if p_action='resume' and s.status<>'break' then raise exception 'Session is already running.'; end if;
     if p_action in ('checkpoint','pause') and s.status<>'running' then raise exception 'Resume the session first.' using errcode='40001'; end if;
     next_elapsed:=s.elapsed+greatest(0,extract(epoch from stamp-s.checkpoint_at)); cursor_time:=s.elapsed;
     if s.status='break' then perform public.ru_append(s.id,u,s.elapsed,next_elapsed,'break');
     elsif not s.camera_enabled then perform public.ru_append(s.id,u,s.elapsed,next_elapsed,'unknown');
     else
       if jsonb_typeof(coalesce(p_data->'intervals','[]'))<>'array' or jsonb_array_length(coalesce(p_data->'intervals','[]'))>200 then raise exception 'Invalid tracking batch.'; end if;
       for row in select value from jsonb_array_elements(coalesce(p_data->'intervals','[]')) loop
         a:=(row->>'start')::double precision; b:=(row->>'end')::double precision; label:=row->>'state';
         if a is null or b is null or jsonb_typeof(row->'start')<>'number' or jsonb_typeof(row->'end')<>'number' or a<0 or b<=a or a<previous_end or label is null or label not in ('present','away','unknown') then raise exception 'Invalid tracking interval.'; end if;
         previous_end:=b;
         a:=greatest(cursor_time,least(next_elapsed,a)); b:=greatest(a,least(next_elapsed,b));
         if a>cursor_time then perform public.ru_append(s.id,u,cursor_time,a,'unknown'); end if;
         perform public.ru_append(s.id,u,a,b,label); cursor_time:=b; last_label:=label;
       end loop;
       -- Recent evidence remains usable for two seconds, matching the detector.
       perform public.ru_append(s.id,u,cursor_time,next_elapsed,case when next_elapsed-cursor_time<=2 then last_label else 'unknown' end);
     end if;
     update public.ru_sessions set elapsed=next_elapsed,checkpoint_at=stamp,revision=revision+1,
       status=case when p_action='pause' then 'break' when p_action='end' then 'completed' when p_action='resume' then 'running' else status end,
       ended_at=case when p_action='end' then stamp else null end,
       pause_reason=case when p_action='pause' then 'user' when p_action='resume' then null else pause_reason end,
       owner_tab=case when p_action in ('pause','end') then null when p_action='resume' then p_tab else owner_tab end,
       lease_until=case when p_action in ('pause','end') or (s.status='break' and p_action<>'resume') then null else stamp+interval '30 seconds' end,
       camera_enabled=case when p_action='camera' then (p_data->>'enabled')::boolean else camera_enabled end
       where id=s.id;
   end if;
 end if;
 insert into public.ru_commands(user_id,command_id,session_id,action) values(u,p_command,s.id,p_action);
 return jsonb_build_object('session',public.ru_session_json(s.id),'deleted',p_action='delete','replayed',false);
end $$;

create function public.ru_settings_save(p_timezone text,p_mode text) returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=auth.uid(); result jsonb;
begin
 if u is null then raise exception 'Sign in required.' using errcode='28000'; end if;
 if not exists(select 1 from pg_timezone_names where name=p_timezone) or p_mode is null or p_mode not in ('Math','Coding','Reading','Lecture') then raise exception 'Choose a valid timezone and study mode.'; end if;
 insert into public.ru_settings values(u,p_timezone,p_mode) on conflict(user_id) do update set timezone=excluded.timezone,default_mode=excluded.default_mode;
 select to_jsonb(s)-'user_id' into result from public.ru_settings s where user_id=u; return result;
end $$;
create function public.ru_history(p_days integer default 7,p_search text default '',p_mode text default '',p_status text default '',p_page integer default 0)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare u uuid:=auth.uid(); zone text; today date; first_day date; count_rows integer; result jsonb;
begin
 if u is null then raise exception 'Sign in required.' using errcode='28000'; end if;
 if p_days not in (0,7,30) or p_page<0 or p_page>100000 or length(p_search)>200 or p_mode not in ('','Math','Coding','Reading','Lecture') or p_status not in ('','completed','interrupted') then raise exception 'Invalid history filters.'; end if;
 select coalesce((select timezone from public.ru_settings where user_id=u),'UTC') into zone;
 today:=(now() at time zone zone)::date; first_day:=case when p_days=0 then '-infinity'::date else today-p_days+1 end;
 select count(*) into count_rows from public.ru_sessions s where user_id=u and status in ('completed','interrupted')
 and (started_at at time zone zone)::date between first_day and today
 and position(lower(p_search) in lower(task))>0 and (p_mode='' or mode=p_mode) and (p_status='' or status=p_status);
 select coalesce(jsonb_agg(public.ru_session_json(s.id) order by s.started_at desc,s.id desc),'[]') into result
 from (select id,started_at from public.ru_sessions where user_id=u and status in ('completed','interrupted')
 and (started_at at time zone zone)::date between first_day and today
 and position(lower(p_search) in lower(task))>0 and (p_mode='' or mode=p_mode) and (p_status='' or status=p_status)
 order by started_at desc,id desc limit 20 offset p_page*20) s;
 return jsonb_build_object('sessions',result,'total',count_rows,'page',p_page,'page_size',20);
end $$;
create function public.ru_overview(p_days integer default 7) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare u uuid:=auth.uid(); zone text; today date; first_day date; result jsonb;
begin
 if u is null then raise exception 'Sign in required.' using errcode='28000'; end if;
 if p_days not in (0,7,30) then raise exception 'Invalid date range.'; end if;
 zone:=coalesce((select timezone from public.ru_settings where user_id=u),'UTC'); today:=(now() at time zone zone)::date;
 first_day:=case when p_days=0 then coalesce((select min((started_at at time zone zone)::date) from public.ru_sessions where user_id=u and status in ('completed','interrupted')),today) else today-p_days+1 end;
 with selected as (
 select s.id,s.elapsed,(s.started_at at time zone zone)::date as day from public.ru_sessions s where user_id=u and status in ('completed','interrupted') and (started_at at time zone zone)::date between first_day and today
 ), session_totals as (
 select s.id,s.day,s.elapsed,
 coalesce(sum(i."end"-i.start) filter(where i.state='break'),0) as breaks,
 coalesce(sum(i."end"-i.start) filter(where i.state='unknown'),0) as unknown,
 coalesce(sum(i."end"-i.start) filter(where i.state='present' and i."end"-i.start>=600),0) as deep,
 coalesce(sum(i."end"-i.start) filter(where i.state='present' and i."end"-i.start<600),0) as normal,
 coalesce(sum(i."end"-i.start) filter(where i.state='away'),0) as distracted
 from selected s left join public.ru_intervals i on i.session_id=s.id group by s.id,s.day,s.elapsed
 ), daily as (
 select d::date as date,count(t.id) as sessions,coalesce(sum(t.elapsed-t.breaks),0) as study,
 coalesce(sum(t.deep),0) as deep,coalesce(sum(t.normal),0) as normal,coalesce(sum(t.distracted),0) as distracted,
 coalesce(sum(t.unknown),0) as unknown,coalesce(sum(t.breaks),0) as breaks
 from generate_series(first_day::timestamp,today::timestamp,interval '1 day') d left join session_totals t on t.day=d::date group by d
 ) select jsonb_build_object('timezone',zone,'days',coalesce(jsonb_agg(to_jsonb(daily) order by date),'[]'),
 'totals',jsonb_build_object('sessions',coalesce(sum(sessions),0),'study',coalesce(sum(study),0),'deep',coalesce(sum(deep),0),'normal',coalesce(sum(normal),0),'distracted',coalesce(sum(distracted),0),'unknown',coalesce(sum(unknown),0),'breaks',coalesce(sum(breaks),0))) into result from daily;
 return result;
end $$;
create function public.ru_export_page(p_before timestamptz,p_after uuid default null) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 if auth.uid() is null then raise exception 'Sign in required.' using errcode='28000'; end if;
 select coalesce(jsonb_agg(public.ru_session_json(s.id) order by s.id),'[]') into result
 from (select id from public.ru_sessions where user_id=auth.uid() and started_at<=p_before and (p_after is null or id>p_after) order by id limit 100) s;
 return result;
end $$;
-- Only the supported RPC surface is executable. Internal helpers cannot be invoked by clients.
revoke all on function public.ru_session_json(uuid),public.ru_append(uuid,uuid,double precision,double precision,text),public.ru_expire(uuid),public.ru_state(),public.ru_command(text,uuid,uuid,uuid,integer,jsonb),public.ru_settings_save(text,text),public.ru_history(integer,text,text,text,integer),public.ru_overview(integer),public.ru_export_page(timestamptz,uuid) from public,anon,authenticated;
grant execute on function public.ru_session_json(uuid),public.ru_state(),public.ru_command(text,uuid,uuid,uuid,integer,jsonb),public.ru_settings_save(text,text),public.ru_history(integer,text,text,text,integer),public.ru_overview(integer),public.ru_export_page(timestamptz,uuid) to authenticated;
