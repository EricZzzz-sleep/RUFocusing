import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
const config=JSON.parse(execFileSync('npx',['--yes','supabase@2.117.0','status','-o','json'],{cwd:new URL('../../../',import.meta.url),encoding:'utf8',stdio:['ignore','pipe','pipe']}))
assert.equal(config.API_URL,'http://127.0.0.1:54321','Integration tests require disposable local Supabase')
const admin=createClient(config.API_URL,config.SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}})
const users=[]
before(async()=>{for(let i=0;i<2;i++){
 const email=`api-${crypto.randomUUID()}@example.test`,password='Integration-only-44!'
 const {data,error}=await admin.auth.admin.createUser({email,password,email_confirm:true});if(error)throw error
 const client=createClient(config.API_URL,config.ANON_KEY,{auth:{persistSession:false,autoRefreshToken:false}})
 const login=await client.auth.signInWithPassword({email,password});if(login.error)throw login.error
 users.push({id:data.user.id,token:login.data.session.access_token,tab:crypto.randomUUID()})
}})
after(async()=>{for(const user of users)await admin.auth.admin.deleteUser(user.id)})
async function api(path, user=users[0],body,headers={}){
 const res=await fetch(`${config.API_URL}/functions/v1/api${path}`,{method:body===undefined?'GET':'POST',headers:{...(user?{Authorization:`Bearer ${user.token}`} :{}),'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)})
 return {status:res.status,data:await res.json()}
}
function command(user,action,session,data={}){return {action,command_id:crypto.randomUUID(),tab_id:user.tab,session_id:session?.id,revision:session?.revision,data}}
test('rejects missing/forged/expired authentication, disallowed origins, and oversized input',async()=>{
 assert.equal((await api('/state',null)).status,401)
 assert.equal((await api('/state',{token:'forged'})).status,401)
 const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url')
 const payload=encode({alg:'HS256',typ:'JWT'})+'.'+encode({sub:users[0].id,role:'authenticated',aud:'authenticated',exp:Math.floor(Date.now()/1000)-3600})
 const expired=payload+'.'+createHmac('sha256',config.JWT_SECRET).update(payload).digest('base64url')
 assert.equal((await api('/state',{token:expired})).status,401)
 assert.equal((await api('/state',users[0],undefined,{Origin:'https://untrusted.example'})).status,403)
 assert.equal((await api('/commands',users[0],{large:'x'.repeat(40000)})).status,413)
})
test('concurrent starts produce exactly one session and cross-account endpoints reveal nothing',async()=>{
 const a=users[0],b=users[1]
 const results=await Promise.all([api('/commands',a,command(a,'start',null,{task:'Race one',mode:'Math'})),api('/commands',a,command(a,'start',null,{task:'Race two',mode:'Reading'}))])
 assert.deepEqual(results.map(r=>r.status).sort(),[200,409],JSON.stringify(results.map(r=>({status:r.status,error:r.data.error}))));let s=results.find(r=>r.status===200).data.session
 assert.equal((await api(`/sessions/${s.id}`,b)).status,404)
 assert.equal((await api(`/sessions/${s.id}/analysis`,b)).status,404)
 assert.equal((await api('/commands',b,command(b,'end',s))).status,404)
 assert.deepEqual((await api(`/export?before=${encodeURIComponent(new Date().toISOString())}`,b)).data,[])
 assert.equal((await api('/history',b)).data.total,0)
 s=(await api('/commands',a,command(a,'end',s))).data.session
 const change=await api('/commands',a,command(a,'reflection',s,{concentration:4,flow:'yes'}));assert.equal(change.status,200)
 assert.equal((await api(`/sessions/${s.id}/analysis`,a)).data.reflection.concentration,4)
})
test('settings and report validation are enforced by the real Edge Function',async()=>{
 assert.equal((await api('/settings',users[0],{timezone:'Mars/Nowhere',default_mode:'Math'})).status,400)
 assert.equal((await api('/settings',users[0],{timezone:'America/Toronto',default_mode:'Coding'})).status,200)
 assert.equal((await api('/overview?days=7')).data.timezone,'America/Toronto')
 assert.equal((await api('/history?page=-1')).status,400)
})
