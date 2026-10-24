import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture, ids } from './fixture.mjs'
import { Store } from '../src/store.mjs'
const why={reason:'Verified synthetic transfer decision'}
const approve={...why,action:'approve'}
async function use(t){const f=await fixture({legacy:true});t.after(()=>f.stop());return f}
async function pending(f){const r=await f.request();assert.equal(r.status,201);return r.body.id}

test('configured staff membership alone enables both actions; no directory token or setup',async t=>{
    const f=await use(t)
    assert.equal(f.config.directoryToken,undefined)
    for(const who of ['a','b']){
        const r=await f.call(who,'/session')
        assert.equal(r.status,200);assert.equal(r.body.ready,true)
        assert.equal(r.body.roles.request,true);assert.equal(r.body.roles.approve,true)
        assert.deepEqual(r.body.facilities.map(x=>x.id),[who==='a'?ids.A:ids.B])
    }
    assert.equal((await f.call('b','/setup',{})).status,404)
    assert.equal((await f.call('none','/session')).status,403)
    const admin=await f.call('admin','/session')
    assert.equal(admin.body.roles.request,false);assert.equal(admin.body.roles.audit,true)
    assert.ok(f.state.calls.every(c=>!c.directory))
})
test('staff user group grants scoped requests and approvals without a named role',async t=>{
    const f=await use(t);f.state.groupOnly=true
    const session=await f.call('b','/session')
    assert.equal(session.status,200)
    assert.equal(session.body.roles.request,true)
    assert.equal(session.body.roles.approve,true)
    assert.deepEqual(session.body.facilities.map(x=>x.id),[ids.B])
    assert.ok(f.state.calls.some(c=>c.path==='/api/me'&&c.params.fields.includes('userGroups[id,name]')))
    const id=await pending(f)
    assert.equal((await f.request('b',ids.C)).status,403)
    assert.equal((await f.call('b',`/requests/${id}/decision`,approve)).status,403)
    assert.equal((await f.call('c',`/requests/${id}/review`,{})).status,403)
    assert.equal((await f.call('a',`/requests/${id}/review`,{})).status,200)
    assert.equal((await f.call('a',`/requests/${id}/decision`,approve)).body.status,'TRANSFERRING')
    assert.equal((await f.call('b',`/requests/${id}/confirm`,{})).body.status,'COMPLETED')
    assert.equal(JSON.stringify(f.clinical),f.original)
})
test('unrelated group and client-supplied capture membership cannot grant access',async t=>{
    const f=await use(t);f.state.groupOnly=true;f.state.groupName='HTN Access'
    assert.equal((await f.call('b','/session')).status,403)
    const forged=await f.call('b','/requests',{
        source:ids.A,centre:ids.B,identifier:'00000000000001',...why,
        userRoles:[{id:ids.request,name:'Tracker Ownership Transfers'}],
        userGroups:[{id:'qSSuhs65xMP',name:'Tracker Ownership Transfers'}],
    })
    assert.equal(forged.status,403)
    assert.equal(f.state.putCalls.length,0)
})
test('UID-only memberships resolve through same-session metadata and reject mismatched UID',async t=>{
    const f=await use(t);f.state.membershipNames=false
    assert.equal((await f.call('b','/session')).body.roles.request,true)
    f.state.groupOnly=true
    assert.equal((await f.call('b','/session')).body.roles.request,true)
    assert.ok(f.state.calls.some(c=>c.path==='/api/userGroups/qSSuhs65xMP'&&c.who==='b'&&!c.directory))
    f.state.wrongGroupMetadata=true
    assert.equal((await f.call('b','/session')).body.code,'MEMBERSHIP_RESPONSE')
})
for(const superApprover of [false,true])test(`destination outside effective search scope stays pending without PUT (superuser=${superApprover})`,async t=>{
    const f=await use(t),id=await pending(f)
    f.state.targetScopeMissing=true;f.state.superApprover=superApprover
    const r=await f.call('a',`/requests/${id}/decision`,approve)
    assert.equal(r.status,403);assert.equal(r.body.code,'TARGET_OUTSIDE_SEARCH_SCOPE')
    assert.match(r.body.error,/CentreBBBBB/)
    assert.equal(f.store.get(id).status,'PENDING');assert.equal(f.state.putCalls.length,0)
    assert.equal(f.state.owner,ids.A)
    f.state.targetScopeMissing=false
    assert.equal((await f.call('a',`/requests/${id}/decision`,approve)).body.status,'TRANSFERRING')
})
test('effective search scope includes capture centres even with no explicit search centres',async t=>{
    const f=await use(t),id=await pending(f);f.state.targetScopeMissing=true
    assert.equal((await f.call('both',`/requests/${id}/decision`,approve)).body.status,'COMPLETED')
    assert.equal(f.state.putCalls.length,1)
})
test('failed outcome review explains actual owner and never transfers when reconciling',async t=>{
    const f=await use(t),id=await pending(f);f.state.mode='reject'
    await f.call('a',`/requests/${id}/decision`,approve)
    const wrong=await f.call('admin',`/requests/${id}/reconcile`,{...why,action:'confirmTransferred'})
    assert.equal(wrong.status,409)
    assert.match(wrong.body.error,/Test CentreAAAAA/)
    assert.match(wrong.body.error,/Not transferred; still at the original centre/)
    assert.equal(f.store.get(id).status,'NEEDS_REVIEW')
    const correct=await f.call('admin',`/requests/${id}/reconcile`,{...why,action:'confirmNotTransferred'})
    assert.equal(correct.body.status,'FAILED')
    assert.equal(f.state.owner,ids.A)
    assert.equal(f.state.putCalls.length,1,'Reconciliation must not send another PUT')
})
test('request, source match, approval, receiving verification, history and notifications',async t=>{
    const f=await use(t),id=await pending(f)
    assert.ok(!f.state.calls.some(c=>c.path.includes('/tracker/')),'Request never searches clinical data')
    const out=await f.call('b','/requests?view=outgoing')
    assert.equal(out.body.items.length,1)
    assert.ok(!JSON.stringify(out.body).includes('00000000000001'))
    assert.ok(!JSON.stringify(out.body).includes(ids.patient))
    assert.equal((await f.call('b',`/requests/${id}/medical-history`)).status,403)
    const review=await f.call('a',`/requests/${id}/review`,{})
    assert.equal(review.body.patientName,'SYNTHETIC PATIENT')
    const result=await f.call('a',`/requests/${id}/decision`,approve)
    assert.equal(result.body.status,'TRANSFERRING');assert.equal(result.body.awaitingReceipt,true)
    assert.equal(f.state.owner,ids.B)
    assert.equal(f.state.putCalls.length,1)
    assert.deepEqual(f.state.putCalls[0].params,{trackedEntity:ids.patient,program:ids.program,orgUnit:ids.B})
    assert.equal(f.state.putCalls[0].who,'a')
    assert.equal((await f.call('b',`/requests/${id}/medical-history`)).status,403)
    const receipt=await f.call('b',`/requests/${id}/confirm`,{})
    assert.equal(receipt.body.status,'COMPLETED')
    const history=await f.call('b',`/requests/${id}/medical-history`)
    assert.equal(history.status,200);assert.equal(history.body.trackedEntity,ids.patient)
    assert.equal(JSON.stringify(history.body.enrollments),JSON.stringify(f.clinical.enrollments))
    assert.equal(JSON.stringify(f.clinical),f.original)
    assert.ok((await f.call('b','/notifications')).body.items.some(n=>n.kind==='COMPLETED'))
    assert.ok(f.state.calls.every(c=>!c.directory))
    f.state.accessDenied=true
    assert.equal((await f.call('b',`/requests/${id}/medical-history`)).status,409)
})
test('wrong or ambiguous ID cannot approve; source can reject without reading a patient',async t=>{
    const f=await use(t),id=await pending(f)
    for(const matches of [0,2]){
        f.state.matches=matches
        assert.equal((await f.call('a',`/requests/${id}/decision`,approve)).body.code,'NO_UNIQUE_MATCH')
    }
    const r=await f.call('a',`/requests/${id}/decision`,{...why,action:'reject'})
    assert.equal(r.body.status,'REJECTED');assert.equal(f.state.owner,ids.A)
    assert.equal(f.state.putCalls.length,0)
    assert.ok((await f.call('b','/notifications')).body.items.some(n=>n.kind==='REJECTED'))
})
test('scope, self approval and malformed identifier are rejected',async t=>{
    const f=await use(t),id=await pending(f)
    for(const who of ['b','c','none','admin']){
        assert.equal((await f.call(who,`/requests/${id}/decision`,approve)).status,403)
        assert.equal((await f.call(who,`/requests/${id}/review`,{})).status,403)
    }
    assert.equal((await f.call('c',`/requests/${id}/audit`)).status,403)
    assert.equal((await f.call('c','/requests?view=history')).body.items.length,0)
    assert.equal((await f.request('b',ids.C)).status,403)
    assert.equal((await f.call('b','/requests',{source:ids.A,centre:ids.B,identifier:'123',...why})).status,400)
    await f.call('b',`/requests/${id}/cancel`,why)
    const own=await f.request('both')
    assert.equal((await f.call('both',`/requests/${own.body.id}/decision`,approve)).status,403)
})
test('concurrent duplicate requests and approvals send at most one ownership PUT',async t=>{
    const f=await use(t)
    const requests=await Promise.all([f.request(),f.request()])
    assert.deepEqual(requests.map(r=>r.status).sort(),[201,409])
    const id=requests.find(r=>r.status===201).body.id
    f.state.mode='delay'
    const decisions=await Promise.all([f.call('a',`/requests/${id}/decision`,approve),f.call('a',`/requests/${id}/decision`,approve)])
    assert.equal(decisions.filter(r=>r.status===200).length,1)
    assert.equal(f.state.putCalls.length,1)
    assert.equal((await f.request()).status,409)
})
for(const mode of ['reject','unchanged','lost-ack'])test(`uncertain ${mode} never completes or opens history`,async t=>{
    const f=await use(t),id=await pending(f);f.state.mode=mode
    const r=await f.call('a',`/requests/${id}/decision`,approve)
    assert.equal(r.body.status,'NEEDS_REVIEW')
    assert.equal((await f.call('b',`/requests/${id}/confirm`,{})).status,409)
    assert.equal((await f.call('b',`/requests/${id}/medical-history`)).status,403)
    assert.equal((await f.request()).status,409)
    assert.equal((await f.call('b',`/requests/${id}/reconcile`,{...why,action:'confirmTransferred'})).status,403)
    const action=mode==='lost-ack'?'confirmTransferred':'confirmNotTransferred'
    const reconciled=await f.call('admin',`/requests/${id}/reconcile`,{...why,action})
    assert.equal(reconciled.body.status,mode==='lost-ack'?'COMPLETED':'FAILED')
    assert.equal(f.state.putCalls.length,1)
})
test('receipt rechecks owner and rejects unrelated centre',async t=>{
    const f=await use(t),id=await pending(f)
    await f.call('a',`/requests/${id}/decision`,approve)
    assert.equal((await f.call('c',`/requests/${id}/confirm`,{})).status,403)
    f.state.owner=ids.A
    // Owner no longer at the receiving centre → OWNER_MISMATCH from collection ACCESSIBLE read.
    assert.equal((await f.call('b',`/requests/${id}/confirm`,{})).status,409)
    assert.equal(f.store.get(id).status,'TRANSFERRING')
})
test('receipt-wait survives restart; migration preserves legacy requests and audit',async t=>{
    const f=await use(t),id=await pending(f)
    await f.call('a',`/requests/${id}/decision`,approve)
    const db=new Store(f.config.dbPath);db.recover()
    assert.equal(db.get(id).error,'AWAITING_RECEIPT');db.close()
    // Exercise additive migration against the previous schema, without identifier columns.
    f.store.db.exec('DROP INDEX one_open_identifier; ALTER TABLE requests DROP COLUMN identifierKey; ALTER TABLE requests DROP COLUMN identifier')
    const migrated=new Store(f.config.dbPath)
    assert.equal(migrated.get(id).status,'TRANSFERRING')
    assert.equal(migrated.get(id).identifier,null)
    assert.ok(migrated.db.prepare('SELECT 1 FROM audit WHERE request=?').get(id))
    migrated.close()
})
test('OPEN programme remains usable without modifying native access',async t=>{
    const f=await use(t);f.state.access='OPEN'
    const r=await f.call('b','/session')
    assert.equal(r.body.ready,true);assert.match(r.body.accessNote,/Existing DHIS2/)
    await pending(f)
    assert.equal(f.state.access,'OPEN');assert.equal(f.state.putCalls.length,0)
    f.state.removedFacility=true
    assert.equal((await f.call('a','/session')).body.ready,false)
})
test('missing identity, origin, cookie and expired session fail closed',async t=>{
    const f=await use(t)
    assert.equal((await f.call('b','/requests',{}, {Origin:'https://wrong.example'})).status,403)
    assert.equal((await f.call('b','/session',undefined,{Cookie:''})).status,401)
    assert.equal((await f.call('expired','/session')).status,401)
    f.state.identityRoles=false
    assert.equal((await f.call('b','/session')).status,401)
    assert.equal(f.state.putCalls.length,0)
})
test('request rate limiting, cancellation and no identifier in audit or notification',async t=>{
    const f=await use(t),id=await pending(f)
    await f.call('b',`/requests/${id}/cancel`,why)
    assert.equal((await f.request()).status,201)
    for(let i=0;i<8;i++)await f.request()
    assert.equal((await f.request()).status,429)
    const rows=f.store.db.prepare('SELECT * FROM audit').all()
    assert.ok(!JSON.stringify(rows).includes('00000000000001'))
    assert.ok(!JSON.stringify((await f.call('a','/notifications')).body).includes('00000000000001'))
})
