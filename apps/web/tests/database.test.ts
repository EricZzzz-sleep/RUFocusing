import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { withReport, type CloudSession } from '../../../packages/study'
const db = new PGlite()
const alice = '00000000-0000-4000-8000-000000000001', bob = '00000000-0000-4000-8000-000000000002'
const tab = '00000000-0000-4000-8000-000000000011', secondTab = '00000000-0000-4000-8000-000000000012'
let user = alice
async function identity(id: string | null, role = 'authenticated') {
  await db.exec('reset role')
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id ?? ''])
  await db.exec(`set role ${role}`)
  user = id ?? ''
}
async function rpc<T>(name: string, args: unknown[] = []): Promise<T> {
  const placeholders = args.map((_, i) => `$${i+1}`).join(',')
  const { rows } = await db.query<{value:T}>(`select public.${name}(${placeholders}) as value`, args)
  return rows[0].value
}
async function command(action: string, session?: CloudSession | null, data: object = {}, id = crypto.randomUUID(), owner = tab) {
  return rpc<{session:CloudSession|null;deleted:boolean;replayed:boolean}>('ru_command',[action,id,owner,session?.id ?? null,session?.revision ?? null,JSON.stringify(data)])
}
async function start(task = 'Calculus', camera = false) { return (await command('start',null,{task,mode:'Math',camera})).session! }
async function age(session: CloudSession, seconds: number, expire = false) {
  const current = user; await db.exec('reset role')
  await db.query(`update public.ru_sessions set checkpoint_at=clock_timestamp()-($1::double precision*interval '1 second'),lease_until=clock_timestamp()+($2::double precision*interval '1 second') where id=$3`,[seconds,expire?-1:30,session.id])
  await identity(current)
}
beforeAll(async () => {
  await db.exec(`create role anon; create role authenticated; create schema auth; create table auth.users(id uuid primary key); create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; grant usage on schema auth to authenticated,anon; grant execute on function auth.uid() to authenticated,anon;`)
  await db.query('insert into auth.users values($1),($2)',[alice,bob])
  await db.exec(readFileSync(new URL('../../../supabase/migrations/202609130001_public_study.sql',import.meta.url),'utf8'))
  await identity(alice)
},30000)
afterAll(async () => db.close())
describe('PostgreSQL migration, ownership, and lifecycle', () => {
  it('denies anonymous reads and commands',async () => {
    await identity(null,'anon')
    await expect(db.query('select * from public.ru_sessions')).rejects.toThrow(/permission denied/)
    await expect(rpc('ru_state')).rejects.toThrow(/permission denied/)
    await identity(alice)
  })
  it('supports idempotent start and prevents a second active session',async () => {
    const id=crypto.randomUUID(), s=(await command('start',null,{task:'Idempotent',mode:'Math'},id)).session!
    const again=await command('start',null,{task:'Idempotent',mode:'Math'},id)
    expect(again.session?.id).toBe(s.id); expect(again.replayed).toBe(true)
    await expect(start()).rejects.toThrow(/active session/)
    await command('end',s)
  })
  it('denies cross-account reads, commands, and direct writes',async () => {
    const s=await start('Private task')
    await identity(bob)
    expect(await rpc('ru_session_json',[s.id])).toBeNull()
    expect((await db.query('select * from public.ru_sessions')).rows).toEqual([])
    await expect(command('end',s)).rejects.toThrow(/not found/)
    await expect(db.query("update public.ru_sessions set task='stolen' where id=$1",[s.id])).rejects.toThrow(/permission denied/)
    await expect(rpc('ru_append',[s.id,alice,0,10,'present'])).rejects.toThrow(/permission denied/)
    await identity(alice); await command('end',s)
  })
  it('rejects competing tabs and stale revisions',async () => {
    const s=await start()
    await expect(command('checkpoint',s,{},crypto.randomUUID(),secondTab)).rejects.toThrow(/another tab/)
    const next=(await command('checkpoint',s)).session!
    await expect(command('pause',s)).rejects.toThrow(/Session changed/)
    await command('end',next)
  })
  it('checkpoints exactly once and pauses at the last acknowledgement on lost contact',async () => {
    let s=await start(); await age(s,5)
    const id=crypto.randomUUID(); const saved=await command('checkpoint',s,{},id); s=saved.session!
    expect(s.elapsed).toBeGreaterThanOrEqual(5)
    const duplicate=await command('checkpoint',s,{},id); expect(duplicate.session!.elapsed).toBe(s.elapsed)
    const elapsed=s.elapsed; await age(s,60,true)
    s=(await rpc<{active:CloudSession}>('ru_state')).active
    expect(s.status).toBe('break'); expect(s.owner_tab).toBeNull(); expect(s.elapsed).toBe(elapsed); expect(s.pause_reason).toBe('connection_lost')
    await expect(command('checkpoint',s)).rejects.toThrow(/Resume/)
    s=(await command('resume',s,{},crypto.randomUUID(),secondTab)).session!
    expect(s.owner_tab).toBe(secondTab); expect(s.timeline.at(-1)?.state).toBe('break')
    await command('end',s,{},crypto.randomUUID(),secondTab)
  })
  it('keeps continuous presence across checkpoints and matches server aggregates',async () => {
    let s=await start('Deep',true)
    // Age below the lease limit is simulated independently of elapsed for threshold fixtures.
    await age(s,300)
    s=(await command('checkpoint',s,{intervals:[{start:0,end:301,state:'present'}]})).session!
    await age(s,301)
    s=(await command('end',s,{intervals:[{start:s.elapsed,end:s.elapsed+302,state:'present'}]})).session!
    const report=withReport(s)
    expect(report.study_periods.totals.deep).toBeGreaterThanOrEqual(600)
    expect(s.timeline).toHaveLength(1)
    const overview=await rpc<{totals:{deep:number}}>('ru_overview',[7])
    expect(overview.totals.deep).toBeCloseTo(report.study_periods.totals.deep,4)
    const total=s.timeline.reduce((n,row)=>n+row.end-row.start,0); expect(total).toBeCloseTo(s.elapsed,5)
  })
  it('does not trust tracking when the camera is disabled and rejects malformed batches',async () => {
    let s=await start(); await age(s,5)
    s=(await command('checkpoint',s,{intervals:[{start:0,end:10,state:'present'}]})).session!
    expect(s.timeline.every(row=>row.state==='unknown')).toBe(true)
    s=(await command('camera',s,{enabled:true})).session!
    await expect(command('checkpoint',s,{intervals:[{start:0,end:10,state:'break'}]})).rejects.toThrow(/Invalid tracking/)
    await command('end',s)
  })
  it('validates reflections and tags without rewriting recorded timing',async () => {
    let s=await start(); await age(s,5); s=(await command('pause',s)).session!
    await age(s,3); s=(await command('resume',s)).session!; await age(s,5); s=(await command('end',s)).session!
    const timeline=JSON.stringify(s.timeline)
    await expect(command('reflection',s,{concentration:1.5})).rejects.toThrow(/rating/)
    await expect(command('reflection',s,{concentration:6})).rejects.toThrow(/check constraint/)
    s=(await command('reflection',s,{concentration:4,flow:'yes'})).session!
    expect(s.reflection.concentration).toBe(4)
    await expect(command('annotations',s,{annotations:[{start:0,end:10,kind:'focused'}]})).rejects.toThrow(/breaks/)
    await expect(command('annotations',s,{annotations:[{start:0,end:3,kind:'focused'},{start:2,end:4,kind:'flow'}]})).rejects.toThrow(/overlapping/)
    s=(await command('annotations',s,{annotations:[{start:0,end:3,kind:'focused'}]})).session!
    expect(s.annotations).toHaveLength(1)
    s=(await command('edit',s,{task:'Updated task',mode:'Coding'})).session!
    expect(s.task).toBe('Updated task'); expect(JSON.stringify(s.timeline)).toBe(timeline)
    const deletion=crypto.randomUUID(); await command('delete',s,{},deletion)
    expect(await rpc('ru_session_json',[s.id])).toBeNull()
    expect((await command('delete',s,{},deletion)).deleted).toBe(true)
    expect((await db.query('select * from public.ru_annotations where session_id=$1',[s.id])).rows).toHaveLength(0)
  })
  it('supports literal search, paginated history, timezone and DST dates',async () => {
    await rpc('ru_settings_save',['America/Toronto','Reading'])
    await expect(rpc('ru_settings_save',['Mars/Olympus','Math'])).rejects.toThrow(/valid timezone/)
    let s=await start('100%_task'); s=(await command('end',s)).session!
    const matches=await rpc<{sessions:CloudSession[]}>('ru_history',[0,'%_','Math','completed',0]); expect(matches.sessions).toHaveLength(1)
    await db.exec('reset role'); await db.query("update public.ru_sessions set started_at='2026-03-08T04:30:00Z' where id=$1",[s.id]); await identity(alice)
    const overview=await rpc<{days:{date:string;sessions:number}[]}>('ru_overview',[0])
    expect(overview.days.find(day=>day.date==='2026-03-07')?.sessions).toBeGreaterThan(0)
    expect(new Set(overview.days.map(day=>day.date)).size).toBe(overview.days.length)
    const page=await rpc<{sessions:unknown[];total:number}>('ru_history',[0,'','','',1]); expect(page.sessions.length).toBeLessThanOrEqual(20)
  })
  it('cascades account deletion across every owned table',async () => {
    await identity(bob); let s=await start('Bob'); s=(await command('end',s)).session!; await command('reflection',s,{concentration:5})
    await db.exec('reset role'); await db.query('delete from auth.users where id=$1',[bob])
    for (const table of ['ru_sessions','ru_intervals','ru_reflections','ru_annotations','ru_settings','ru_commands']) expect((await db.query(`select * from public.${table} where user_id=$1`,[bob])).rows).toHaveLength(0)
    await identity(alice)
  })
})
