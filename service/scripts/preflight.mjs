import { readConfig } from '../src/config.mjs'
import { Dhis2 } from '../src/dhis2.mjs'
import { PatientTransferWorkflow } from '../src/transfer-workflow.mjs'
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
try {
    let config=readConfig()
    if(existsSync(config.dbPath)){
        const db=new DatabaseSync(config.dbPath,{readOnly:true})
        try{
            if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='app_settings'").get()){
                const row=db.prepare("SELECT r.id,r.settings FROM config_revisions r JOIN app_settings a ON a.value=CAST(r.id AS TEXT) WHERE a.key='active'").get()
                if(row)config={...config,...JSON.parse(row.settings),configId:row.id}
            }
        }finally{db.close()}
    }
    const dhis=new Dhis2(config)
    if(!process.env.TRANSFER_TEST_A_COOKIE)throw new Error('Provide a local test-user session through TRANSFER_TEST_A_COOKIE; never share it in chat.')
    const auth={Cookie:process.env.TRANSFER_TEST_A_COOKIE}
    const info=await dhis.call(auth,'system/info',{fields:'version'})
    if(!/^2\.42(?:\.|$)/.test(info.version||''))throw new Error('This pilot targets the DHIS2 2.42 API.')
    const workflow=new PatientTransferWorkflow(config,null,dhis),ctx=await workflow.context(auth)
    await workflow.ensureReady(ctx)
    if(!ctx.request||!ctx.centres.size)throw new Error('Test user needs the configured staff membership and a programme centre in capture scope.')
    workflow.destination(ctx)
    console.log(JSON.stringify({readOnlyPreflight:'PASS',version:info.version,centreCount:ctx.centres.size,
        note:'No patient read or transfer performed. Native user data permissions still require synthetic acceptance testing.'},null,2))
} catch(e){console.error(`Preflight not passed: ${e.message}`);process.exitCode=1}
