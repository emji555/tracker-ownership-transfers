import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { readConfig } from '../src/config.mjs'
import { Dhis2 } from '../src/dhis2.mjs'
import { Store } from '../src/store.mjs'
import { PatientTransferWorkflow } from '../src/transfer-workflow.mjs'
import { acquireLock } from '../src/lock.mjs'

// This guarded test changes ONLY the generated synthetic programme's ownership.
// It deliberately refuses the real MOHP programme and any non-loopback instance.
const ids=JSON.parse(readFileSync(new URL('../../fixtures/uids.json',import.meta.url)))
const c=readConfig()
if(process.env.TRANSFER_RUN_LIVE_TEST!=='YES_SYNTHETIC_ONLY' ||
    !['127.0.0.1','localhost'].includes(new URL(c.base).hostname) ||
    c.program!==ids.program || c.program==='pMIglSEqPGS' ||
    c.identifier!==ids.nationalId || !process.env.TRANSFER_TEST_A_COOKIE || !process.env.TRANSFER_TEST_B_COOKIE)
    throw new Error('Live test refused: configure the generated isolated programme and local test sessions, then explicitly enable YES_SYNTHETIC_ONLY.')
const release=acquireLock(c.dbPath),store=new Store(c.dbPath)
store.bindProgram(c.program,c.base)
try{
    const d=new Dhis2(c),w=new PatientTransferWorkflow(c,store,d)
    const auth=cookie=>{
        const headers={Cookie:cookie}
        const xsrf=cookie.split(';').map(x=>x.trim()).find(x=>x.startsWith('XSRF-TOKEN='))
        if(xsrf)headers['X-XSRF-TOKEN']=decodeURIComponent(xsrf.slice('XSRF-TOKEN='.length))
        return headers
    }
    const a=await w.context(auth(process.env.TRANSFER_TEST_A_COOKIE))
    const b=await w.context(auth(process.env.TRANSFER_TEST_B_COOKIE))
    assert.notEqual(a.user.id,b.user.id)
    for(const [key,national,action]of [['reject','00000000000002','reject'],['approve','00000000000001','approve']]){
        const patient=ids[`${key}Patient`]
        const before=await d.record(patient,a.auth,true)
        assert.equal(before.owner,ids.centreA)
        assert.ok(before.attributes.some(x=>x.attribute===ids.nationalId&&x.value===national))
        assert.ok(before.attributes.some(x=>x.attribute===ids.name&&x.value.startsWith('SYNTHETIC TRANSFER ')))
        const snapshot=await d.history(a.auth,patient)
        const match=await w.search(b,{identifier:national})
        const request=await w.create(b,{ticket:match.ticket,reason:'Synthetic isolated integration test'})
        await assert.rejects(w.medicalHistory(b,request.id))
        let result=await w.decide(a,request.id,{action,reason:'Verified generated synthetic record only'})
        if(result.status==='TRANSFERRING'&&result.awaitingReceipt)result=await w.confirm(b,request.id)
        assert.equal(result.status,action==='approve'?'COMPLETED':'REJECTED')
        assert.equal((await d.record(patient,action==='approve'?b.auth:a.auth)).owner,action==='approve'?ids.centreB:ids.centreA)
        assert.deepEqual(await d.history(action==='approve'?b.auth:a.auth,patient),snapshot,'Historical visits/enrolments must be unchanged')
        if(action==='approve')assert.equal((await w.medicalHistory(b,request.id)).trackedEntity,patient)
        else await assert.rejects(w.medicalHistory(b,request.id))
        console.log(`PASS synthetic ${action}: patient ${patient}; request ${request.id}`)
    }
}finally{store.close();release()}
