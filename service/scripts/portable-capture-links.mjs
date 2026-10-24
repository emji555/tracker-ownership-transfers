// One-time administrator utility. Preview by default; --apply saves reviewed metadata.
// No patient, ownership, sharing or user-scope endpoints are written.
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { readConfig } from '../src/config.mjs'
import { portableCaptureLinks } from '../src/capture-links.mjs'
const config=readConfig()
const cookie=process.env.TRANSFER_LAYOUT_ADMIN_COOKIE
if(!cookie)throw new Error('Set TRANSFER_LAYOUT_ADMIN_COOKIE privately in your local environment. Never send it in chat.')
const headers={Cookie:cookie,Accept:'application/json','Content-Type':'application/json'}
const xsrf=cookie.split(';').map(s=>s.trim()).find(s=>s.startsWith('XSRF-TOKEN='))
if(xsrf)headers['X-XSRF-TOKEN']=decodeURIComponent(xsrf.slice(11))
async function api(path,method='GET',value){
    const response=await fetch(`${config.base}/api/${path}`,{method,headers,body:value===undefined?undefined:JSON.stringify(value),redirect:'manual',signal:AbortSignal.timeout(15000)})
    if(!response.ok)throw new Error(`DHIS2 returned HTTP ${response.status}; no automatic retry. Check permissions and current configuration.`)
    if(method==='GET')return response.json()
}
if(await api('me/authorization/ALL')!==true)throw new Error('Use an authorised DHIS2 administrator for this metadata maintenance task.')
const contextPath=new URL(config.base).pathname.replace(/\/$/,'')
const trustedOrigins=[new URL(config.base).origin,config.origin,
    'http://127.0.0.1:8080','http://localhost:8080','http://127.0.0.1:8081','http://localhost:8081',
    'http://127.0.0.1:8095','http://localhost:8095',
    ...(process.env.TRANSFER_OLD_PLUGIN_ORIGINS||'').split(',').map(s=>s.trim()).filter(Boolean).map(s=>new URL(s).origin)]
const plans=[]
for(const key of ['enrollmentOverviewLayout','dataEntryForms']){
    const path=`dataStore/capture/${key}`
    const old=await api(path)
    const result=portableCaptureLinks(old,{trustedOrigins,contextPath})
    console.log(JSON.stringify({key,changes:result.changes},null,2))
    if(result.changes.length)plans.push({key,path,old,...result})
}
if(!process.argv.includes('--apply'))console.log('Preview only. Run again with --apply to save these plugin-link changes.')
else if(plans.length){
    const dir=resolve('data',`capture-layout-backup-${Date.now()}`);mkdirSync(dir,{recursive:true,mode:0o700})
    for(const plan of plans){
        writeFileSync(resolve(dir,`${plan.key}.json`),JSON.stringify(plan.old,null,2),{mode:0o600})
        if(JSON.stringify(await api(plan.path))!==JSON.stringify(plan.old))throw new Error('Layout changed during review. Stopped; rerun preview.')
        await api(plan.path,'PUT',plan.value)
        if(JSON.stringify(await api(plan.path))!==JSON.stringify(plan.value))throw new Error('Saved layout could not be verified. Inspect backup and current DHIS2 configuration.')
        console.log(`Saved and verified ${plan.key}. Backup: ${dir}`)
    }
}
