import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { createClient } from '@supabase/supabase-js'
const config=JSON.parse(execFileSync('npx',['--yes','supabase@2.117.0','status','-o','json'],{cwd:new URL('../../../../',import.meta.url),encoding:'utf8',stdio:['ignore','pipe','pipe']}))
if(config.API_URL!=='http://127.0.0.1:54321') throw new Error('E2E tests may only use local Supabase.')
const admin=createClient(config.API_URL,config.SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}})
let userId='',email=''; const password='Local-test-only-39!'
test.beforeEach(async()=>{
 email=`study-${crypto.randomUUID()}@example.test`
 const result=await admin.auth.admin.createUser({email,password,email_confirm:true}); if(result.error) throw result.error;userId=result.data.user.id
})
test.afterEach(async()=>{if(userId) await admin.auth.admin.deleteUser(userId)})
test('sign in, record, save, reflect, edit, export and delete on desktop/mobile',async({page},testInfo)=>{
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message))
 await page.goto('/')
 await page.getByLabel('Email',{exact:true}).fill(email); await page.getByLabel('Password',{exact:true}).fill(password)
 await page.getByRole('button',{name:'Sign in',exact:true}).click()
 await expect(page.getByRole('heading',{name:'Your study overview.'})).toBeVisible()
 await page.getByRole('link',{name:'Record',exact:true}).click()
 await page.getByLabel('What are you working on?').fill('Linear algebra practice')
 await page.getByRole('button',{name:'Start session'}).click()
 await expect(page.getByRole('button',{name:'Take a break'})).toBeEnabled()
 await expect(page.getByText('No tracking data',{exact:true})).toBeVisible()
 await page.getByRole('button',{name:'Take a break'}).click();await expect(page.getByRole('button',{name:'Resume session',exact:true})).toBeEnabled()
 await page.getByRole('button',{name:'Resume session',exact:true}).click();await expect(page.getByRole('button',{name:'End & save session'})).toBeEnabled()
 await page.getByRole('button',{name:'End & save session'}).click()
 await expect(page.getByRole('heading',{name:'Session summary.'})).toBeVisible()
 await page.getByLabel('Concentration',{exact:true}).selectOption('4');await page.getByRole('button',{name:'Save reflection',exact:true}).click();await expect(page.getByText('Reflection saved.',{exact:true})).toBeVisible()
 await page.getByLabel('Task name').fill('Algebra revision');await page.getByRole('button',{name:'Save session details',exact:true}).click();await expect(page.getByText('Session details saved.',{exact:true})).toBeVisible()
 await page.getByRole('link',{name:'Analysis',exact:true}).click();await expect(page.getByRole('link',{name:/Algebra revision/})).toBeVisible()
 await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
 await page.screenshot({path:`test-results/${testInfo.project.name}-analysis.png`,fullPage:true})
 await page.getByRole('link',{name:'Settings',exact:true}).click()
 await page.getByRole('combobox',{name:'Timezone',exact:true}).selectOption('America/Toronto');await page.getByRole('button',{name:'Save preferences'}).click();await expect(page.getByText('Preferences saved.',{exact:true})).toBeVisible()
 const downloading=page.waitForEvent('download');await page.getByRole('button',{name:'Download JSON'}).click();const file=await downloading;expect(file.suggestedFilename()).toBe('rufocusing-sessions.json')
 const stream=await file.createReadStream();let text='';for await(const chunk of stream!) text+=chunk.toString();const saved=JSON.parse(text);expect(saved.version).toBe(1);expect(saved.sessions[0].task).toBe('Algebra revision');expect(saved.sessions[0].reflection.concentration).toBe(4)
 await page.getByRole('link',{name:'Analysis',exact:true}).click();await page.getByRole('link',{name:/Algebra revision/}).click()
 await page.getByRole('button',{name:'Delete session',exact:true}).click();await expect(page.getByRole('dialog')).toBeVisible()
 await page.getByRole('button',{name:'Keep session',exact:true}).focus();await page.keyboard.press('Tab');await expect(page.getByRole('button',{name:'Delete permanently',exact:true})).toBeFocused();await page.keyboard.press('Enter')
 await expect(page.getByRole('heading',{name:'Room for your next session'})).toBeVisible()
 await page.getByRole('button',{name:'Sign out',exact:true}).click();await expect(page.getByRole('heading',{name:'Welcome to your study space'})).toBeVisible()
 expect(errors).toEqual([])
})
test('a lost final response can be retried without duplicate sessions',async({page})=>{
 await page.goto('/');await page.getByLabel('Email',{exact:true}).fill(email);await page.getByLabel('Password',{exact:true}).fill(password);await page.getByRole('button',{name:'Sign in',exact:true}).click()
 await page.getByRole('link',{name:'Record',exact:true}).click();await page.getByLabel('What are you working on?').fill('Retry test');await page.getByRole('button',{name:'Start session'}).click();await expect(page.getByRole('button',{name:'End & save session'})).toBeEnabled()
 let failed=false
 await page.route('**/functions/v1/api/commands',async route=>{
   const body=route.request().postDataJSON()
   if(body.action==='end'&&!failed){failed=true;await route.fetch();await route.abort('failed')}else await route.continue()
 })
 await page.getByRole('button',{name:'End & save session'}).click();await expect(page.getByRole('button',{name:'Retry pending save'})).toBeVisible()
 await page.getByRole('button',{name:'Retry pending save'}).click();await expect(page.getByRole('button',{name:'Retry pending save'})).toHaveCount(0)
 await page.getByRole('link',{name:'Analysis',exact:true}).click();await expect(page.getByRole('link',{name:/Retry test/})).toHaveCount(1)
})

test('email verification and password recovery use the local mail service',async({page,request})=>{
 await admin.auth.admin.deleteUser(userId); userId=''; email=`signup-${crypto.randomUUID()}@example.test`
 await page.goto('/');await page.getByRole('button',{name:'Create an account',exact:true}).click()
 await page.getByLabel('Email',{exact:true}).fill(email);await page.getByLabel('Password',{exact:true}).fill(password);await page.getByRole('button',{name:'Create account',exact:true}).click()
 await expect(page.getByText('Check your email to verify your account, then sign in.')).toBeVisible()
 const users=await admin.auth.admin.listUsers();userId=users.data.users.find(user=>user.email===email)!.id
 async function emailLink(subject:string){
   let id=''
   await expect.poll(async()=>{const data=await(await request.get('http://127.0.0.1:54324/api/v1/messages')).json();const match=data.messages.find((message:any)=>message.To.some((to:any)=>to.Address===email)&&message.Subject.toLowerCase().includes(subject));id=match?.ID;return Boolean(id)}).toBe(true)
   const mail=await(await request.get(`http://127.0.0.1:54324/api/v1/message/${id}`)).json()
   const href=mail.HTML.match(/href="([^"]+)"/)[1].replaceAll('&amp;','&');expect(new URL(href).hostname).toBe('127.0.0.1');return href
 }
 await page.goto(await emailLink('confirm'));await expect(page.getByRole('heading',{name:'Your study overview.'})).toBeVisible()
 await page.getByRole('button',{name:'Sign out',exact:true}).click();await page.getByRole('button',{name:'Forgot password?',exact:true}).click()
 await page.getByLabel('Email',{exact:true}).fill(email);await page.getByRole('button',{name:'Send reset link',exact:true}).click()
 await expect(page.getByText('If this email has an account, you’ll receive a password reset link.')).toBeVisible()
 await page.goto(await emailLink('reset'));await expect(page.getByRole('heading',{name:'Choose a new password'})).toBeVisible()
 await page.getByLabel('New password',{exact:true}).fill('Changed-local-test-99!');await page.getByRole('button',{name:'Save new password'}).click()
 await expect(page.getByRole('heading',{name:'Your study overview.'})).toBeVisible()
 await page.getByRole('button',{name:'Sign out',exact:true}).click();await page.getByLabel('Email',{exact:true}).fill(email);await page.getByLabel('Password',{exact:true}).fill('Changed-local-test-99!');await page.getByRole('button',{name:'Sign in',exact:true}).click();await expect(page.getByRole('heading',{name:'Your study overview.'})).toBeVisible()
})

test('a second tab cannot record until the first lease expires; resume is explicit',async({page,context})=>{
 await page.goto('/');await page.getByLabel('Email',{exact:true}).fill(email);await page.getByLabel('Password',{exact:true}).fill(password);await page.getByRole('button',{name:'Sign in',exact:true}).click()
 await page.getByRole('link',{name:'Record',exact:true}).click();await page.getByLabel('What are you working on?').fill('Tab ownership');await page.getByRole('button',{name:'Start session'}).click();await expect(page.getByRole('button',{name:'Take a break'})).toBeEnabled()
 const second=await context.newPage();await second.goto('/record');await expect(second.getByText(/This session is recording in another tab/)).toBeVisible();await expect(second.getByRole('button',{name:'Take a break'})).toBeDisabled()
 await page.close()
 const expired=await admin.from('ru_sessions').update({lease_until:new Date(Date.now()-1000).toISOString()}).eq('user_id',userId);if(expired.error) throw expired.error
 await second.reload();await expect(second.getByText(/Your session paused at its last saved checkpoint/)).toBeVisible();await expect(second.getByRole('button',{name:'Resume session',exact:true})).toBeEnabled()
 await second.getByRole('button',{name:'Resume session',exact:true}).click();await expect(second.getByRole('button',{name:'Take a break'})).toBeEnabled()
 await second.getByRole('button',{name:'End & save session'}).click();await expect(second.getByRole('heading',{name:'Session summary.'})).toBeVisible()
})

test('account deletion removes the real local authentication account and cloud records',async({page})=>{
 await page.goto('/');await page.getByLabel('Email',{exact:true}).fill(email);await page.getByLabel('Password',{exact:true}).fill(password);await page.getByRole('button',{name:'Sign in',exact:true}).click()
 await page.getByRole('link',{name:'Record',exact:true}).click();await page.getByLabel('What are you working on?').fill('Delete my data');await page.getByRole('button',{name:'Start session'}).click();await expect(page.getByRole('button',{name:'End & save session'})).toBeEnabled();await page.getByRole('button',{name:'End & save session'}).click();await expect(page.getByRole('heading',{name:'Session summary.'})).toBeVisible()
 await page.getByRole('link',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'Delete account',exact:true}).click();await page.getByLabel('Type DELETE to confirm').fill('DELETE');await page.getByRole('button',{name:'Delete permanently',exact:true}).click()
 await expect(page.getByRole('heading',{name:'Welcome to your study space'})).toBeVisible()
 expect((await admin.auth.admin.getUserById(userId)).error).toBeTruthy()
 expect((await admin.from('ru_sessions').select('id').eq('user_id',userId)).data).toEqual([]);userId=''
})

test('browser camera worker handles synthetic video and releases capture on breaks',async({browser},testInfo)=>{
 test.skip(testInfo.project.name==='mobile','Desktop camera support is the public v1 target.')
 const {chromium}=await import('@playwright/test')
 const cameraBrowser=await chromium.launch({args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']})
 const context=await cameraBrowser.newContext({permissions:['camera']}),page=await context.newPage()
 const uploads:string[]=[];page.on('request',request=>{if(request.method()==='POST'&&request.url().includes('/functions/v1/')) uploads.push(request.postData()??'')})
 try{
   await page.goto('http://127.0.0.1:5174/');await page.getByLabel('Email',{exact:true}).fill(email);await page.getByLabel('Password',{exact:true}).fill(password);await page.getByRole('button',{name:'Sign in',exact:true}).click()
   await page.getByRole('link',{name:'Record',exact:true}).click();await page.getByLabel('What are you working on?').fill('Synthetic camera');await page.getByRole('checkbox',{name:'Use camera for presence estimates'}).check();await page.getByRole('button',{name:'Start session'}).click()
   await expect(page.getByText('Tracking presence. No video is saved or uploaded.',{exact:true})).toBeVisible({timeout:20000})
   await expect.poll(()=>page.locator('video').evaluate((video:HTMLVideoElement)=>video.srcObject instanceof MediaStream&&video.srcObject.getVideoTracks()[0]?.readyState)).toBe('live')
   // Wait for an actual server checkpoint carrying compact browser evidence.
   await expect.poll(()=>uploads.some(body=>{const data=JSON.parse(body);return data.action==='checkpoint'&&data.data.intervals.length>0})).toBe(true)
   expect(uploads.every(body=>!body.includes('faceLandmarks')&&!body.includes('data:image'))).toBe(true)
   await page.getByRole('button',{name:'Take a break'}).click();await expect.poll(()=>page.locator('video').evaluate((video:HTMLVideoElement)=>video.srcObject)).toBeNull()
   await page.getByRole('button',{name:'Resume session',exact:true}).click();await expect(page.getByText('Tracking presence. No video is saved or uploaded.',{exact:true})).toBeVisible({timeout:20000})
   await page.getByRole('checkbox',{name:'Use camera',exact:true}).click();await expect(page.getByRole('checkbox',{name:'Use camera',exact:true})).not.toBeChecked();await expect.poll(()=>page.locator('video').evaluate((video:HTMLVideoElement)=>video.srcObject)).toBeNull()
   await page.getByRole('button',{name:'End & save session'}).click();await expect(page.getByRole('heading',{name:'Session summary.'})).toBeVisible()
 }finally{await context.close();await cameraBrowser.close()}
})

test('camera permission denial preserves recording and offers retry',async({page})=>{
 await page.addInitScript(()=>{
   Object.defineProperty(navigator.mediaDevices,'getUserMedia',{configurable:true,value:()=>Promise.reject(new DOMException('Denied for test','NotAllowedError'))})
 })
 await page.goto('/');await page.getByLabel('Email',{exact:true}).fill(email);await page.getByLabel('Password',{exact:true}).fill(password);await page.getByRole('button',{name:'Sign in',exact:true}).click()
 await page.getByRole('link',{name:'Record',exact:true}).click();await page.getByLabel('What are you working on?').fill('Denied camera');await page.getByRole('checkbox',{name:'Use camera for presence estimates'}).check();await page.getByRole('button',{name:'Start session'}).click()
 await expect(page.getByText('Camera permission was denied. Allow camera access in your browser, then retry.').first()).toBeVisible()
 await expect(page.getByRole('button',{name:'Retry camera',exact:true})).toBeEnabled();await expect(page.getByRole('button',{name:'End & save session'})).toBeEnabled()
 await page.getByRole('button',{name:'End & save session'}).click();await expect(page.getByRole('heading',{name:'Session summary.'})).toBeVisible();await expect(page.getByText('No tracking data',{exact:true})).toBeVisible()
})
