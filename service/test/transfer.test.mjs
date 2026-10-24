import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture, ids } from './fixture.mjs'
async function use(t){const f=await fixture();t.after(()=>f.stop());return f}
const reason='Synthetic patient has moved'

for(const flag of ['globalSearch','superRequester'])test(`NID search honours existing ${flag} without widening ordinary users`,async t=>{
    const f=await use(t);f.state.requesterSearch=false
    assert.equal((await f.search()).body.code,'NO_UNIQUE_MATCH')
    f.state[flag]=true
    const found=await f.search()
    assert.equal(found.status,200)
    assert.equal(found.body.masked,'**********0001')
    assert.ok(f.state.calls.some(c=>c.who==='b'&&c.params.orgUnitMode==='ALL'))
    assert.equal(f.state.putCalls.length,0)
    const created=await f.call('b','/requests',{ticket:found.body.ticket,reason})
    assert.equal(created.status,201)
    // Create re-checks with the NID attribute filter (never collection trackedEntity=UID alone —
    // that 409s on DHIS2 2.42 with "At least 1 attributes should be mentioned").
    assert.ok(f.state.calls.some(c=>c.who==='b'&&c.path==='/api/tracker/trackedEntities'&&
        c.params.filter===`${ids.identifier}:eq:00000000000001`&&c.params.fields?.includes('programOwners')))
    assert.equal((await f.call('b',`/requests/${created.body.id}/medical-history`)).status,403)
    f.state[flag]=false
    assert.equal((await f.search()).body.code,'NO_UNIQUE_MATCH')
})

test('NID search detects source owner and one authenticated destination without clinical history',async t=>{
    const f=await use(t)
    const session=await f.call('b','/session')
    assert.equal(session.body.userCentre.id,ids.B)
    assert.equal(session.body.requestEnabled,true)
    assert.equal(session.body.requestMode,'nid-search')
    assert.equal(session.body.sourceFacilities,undefined)
    const search=await f.search()
    assert.equal(search.status,200)
    assert.equal(search.body.sourceName,`Test ${ids.A}`)
    assert.equal(search.body.destinationName,`Test ${ids.B}`)
    assert.equal(search.body.patientName,'SYNTHETIC PATIENT')
    assert.equal(search.body.masked,'**********0001')
    assert.equal(search.body.patient,undefined)
    const text=JSON.stringify(search.body)
    assert.ok(!text.includes(ids.patient)&&!text.includes('00000000000001')&&!text.includes('128'))
    assert.ok(!f.state.calls.some(c=>c.params.fields?.includes('enrollments')))
    assert.ok(f.state.calls.every(c=>!c.directory))
    assert.ok(f.state.calls.some(c=>c.who==='b'&&c.params.filter===`${ids.identifier}:eq:00000000000001`&&c.params.orgUnitMode==='ACCESSIBLE'))
})
test('automatic ownership request, optional approval comment and permitted history',async t=>{
    const f=await use(t),r=await f.request()
    assert.equal(r.status,201)
    const row=f.store.get(r.body.id)
    assert.equal(row.patient,ids.patient);assert.equal(row.source,ids.A);assert.equal(row.target,ids.B)
    assert.equal(row.identifier,null,'Do not retain raw NID for new matched requests')
    assert.equal((await f.call('b',`/requests/${row.id}/medical-history`)).status,403)
    assert.equal((await f.call('b','/requests?view=outgoing')).body.items[0].patientName,'')
    assert.equal((await f.call('a','/requests?view=incoming')).body.items[0].patientName,'SYNTHETIC PATIENT')
    const decision=await f.call('a',`/requests/${row.id}/decision`,{action:'approve'})
    assert.equal(decision.body.status,'COMPLETED')
    assert.equal(f.state.putCalls.length,1);assert.equal(f.state.putCalls[0].who,'a')
    assert.equal(f.state.owner,ids.B)
    const h=await f.call('b',`/requests/${row.id}/medical-history`)
    assert.equal(h.status,200);assert.equal(h.body.trackedEntity,ids.patient)
    assert.equal(JSON.stringify(f.clinical),f.original)
})
test('refusal requires comment and makes it visible to receiving centre',async t=>{
    const f=await use(t),r=await f.request(),id=r.body.id
    const absent=await f.call('a',`/requests/${id}/decision`,{action:'reject',reason:' '})
    assert.equal(absent.status,400);assert.equal(f.store.get(id).status,'PENDING')
    const refused=await f.call('a',`/requests/${id}/decision`,{action:'reject',reason:'Patient will remain at our centre'})
    assert.equal(refused.body.status,'REJECTED')
    const out=await f.call('b','/requests?view=outgoing')
    assert.equal(out.body.items[0].decision,'Patient will remain at our centre')
    assert.equal(f.state.owner,ids.A);assert.equal(f.state.putCalls.length,0)
})
test('no name is returned when native identity access is denied',async t=>{
    const f=await use(t);f.state.hideNames=true
    const r=await f.search()
    assert.equal(r.status,200);assert.equal(r.body.patientName,'')
    assert.equal(r.body.sourceName,`Test ${ids.A}`)
})
test('no access, no match and ambiguous NID searches never issue a usable ticket',async t=>{
    const f=await use(t)
    f.state.requesterSearch=false
    let r=await f.search();assert.equal(r.body.code,'NO_UNIQUE_MATCH');assert.equal(r.body.ticket,undefined)
    f.state.requesterSearch=true
    for(const matches of [0,2]){
        f.state.matches=matches;r=await f.search()
        assert.equal(r.body.code,'NO_UNIQUE_MATCH');assert.equal(r.body.ticket,undefined)
    }
    f.state.matches=1;f.state.accessDenied=true
    assert.equal((await f.search()).status,403)
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM tickets').get().n,0)
})
test('no arbitrary centre choice for ambiguous capture scope or spoofed input',async t=>{
    const f=await use(t)
    f.state.extraRoot=true
    const s=await f.call('b','/session')
    assert.equal(s.body.requestEnabled,false);assert.equal(s.body.userCentre,null)
    assert.equal((await f.search()).body.code,'CENTRE_NOT_UNIQUE')
    f.state.extraRoot=false
    assert.equal((await f.call('b','/search',{identifier:'00000000000001',centre:ids.C})).body.code,'AUTOMATIC_CENTRES')
    const match=await f.search()
    assert.equal((await f.call('b','/requests',{ticket:match.body.ticket,reason,source:ids.C})).body.code,'AUTOMATIC_CENTRES')
    assert.equal((await f.call('a','/search',{identifier:'00000000000001'})).body.code,'ALREADY_AT_CENTRE')
})
test('ticket is user-bound, expires and cannot be reused',async t=>{
    const f=await use(t),s=await f.search()
    assert.equal((await f.call('c','/requests',{ticket:s.body.ticket,reason})).body.code,'SEARCH_EXPIRED')
    f.store.db.prepare('UPDATE tickets SET expires=0 WHERE token=?').run(s.body.ticket)
    assert.equal((await f.call('b','/requests',{ticket:s.body.ticket,reason})).body.code,'SEARCH_EXPIRED')
    const fresh=await f.search(),body={ticket:fresh.body.ticket,reason}
    assert.equal((await f.call('b','/requests',body)).status,201)
    assert.equal((await f.call('b','/requests',body)).body.code,'SEARCH_EXPIRED')
})
test('ownership rechecked after search; duplicate concurrent matched requests blocked',async t=>{
    const f=await use(t),s=await f.search()
    f.state.owner=ids.B
    assert.equal((await f.call('b','/requests',{ticket:s.body.ticket,reason})).body.code,'OWNER_CHANGED')
    f.state.owner=ids.A
    const results=await Promise.all([f.request(),f.request()])
    assert.deepEqual(results.map(r=>r.status).sort(),[201,409])
    const row=results.find(r=>r.status===201).body
    f.state.mode='delay'
    const decisions=await Promise.all([
        f.call('a',`/requests/${row.id}/decision`,{action:'approve',reason:'Approved after checking'}),
        f.call('a',`/requests/${row.id}/decision`,{action:'approve'}),
    ])
    assert.equal(decisions.filter(r=>r.status===200).length,1);assert.equal(f.state.putCalls.length,1)
    assert.equal((await f.call('b','/requests?view=outgoing')).body.items[0].decision,'Approved after checking')
})
test('destination scope still enforced; no permission bypass in the simplified flow',async t=>{
    const f=await use(t),r=await f.request();f.state.targetScopeMissing=true
    const response=await f.call('a',`/requests/${r.body.id}/decision`,{action:'approve'})
    assert.equal(response.body.code,'TARGET_OUTSIDE_SEARCH_SCOPE')
    assert.equal(f.store.get(r.body.id).status,'PENDING');assert.equal(f.state.putCalls.length,0)
})
test('receiving centre can verify acknowledged transfer after source access is removed',async t=>{
    const f=await use(t),r=await f.request();f.state.closeAfterTransfer=true
    const d=await f.call('a',`/requests/${r.body.id}/decision`,{action:'approve'})
    assert.equal(d.body.status,'TRANSFERRING')
    assert.equal((await f.call('b',`/requests/${r.body.id}/medical-history`)).status,403)
    assert.equal((await f.call('b',`/requests/${r.body.id}/confirm`,{})).body.status,'COMPLETED')
    assert.equal((await f.call('b',`/requests/${r.body.id}/medical-history`)).status,200)
})
test('lost acknowledgement remains uncertain and audit contains neither NID nor tickets',async t=>{
    const f=await use(t),s=await f.search()
    const r=await f.call('b','/requests',{ticket:s.body.ticket,reason})
    f.state.mode='lost-ack'
    const d=await f.call('a',`/requests/${r.body.id}/decision`,{action:'approve'})
    assert.equal(d.body.status,'NEEDS_REVIEW')
    assert.equal((await f.call('b',`/requests/${r.body.id}/medical-history`)).status,403)
    assert.equal((await f.call('b',`/requests/${r.body.id}/confirm`,{})).status,409)
    const audit=JSON.stringify(f.store.db.prepare('SELECT * FROM audit').all())
    assert.ok(!audit.includes('00000000000001')&&!audit.includes(s.body.ticket))
})
test('existing pending manual requests remain decidable and duplicate-protected',async t=>{
    const f=await use(t)
    const {CaptureWorkflow}=await import('../src/capture-workflow.mjs')
    const {Dhis2}=await import('../src/dhis2.mjs')
    const legacy=new CaptureWorkflow(f.config,f.store,new Dhis2(f.config))
    const ctx=await legacy.context({Cookie:'SESSION=b'})
    const old=await legacy.create(ctx,{source:ids.A,centre:ids.B,identifier:'00000000000001',reason})
    // Simulate service upgrade after the old process wrote its pending request.
    const {Settings}=await import('../src/settings.mjs')
    new Settings(f.config,f.store,new Dhis2(f.config))
    assert.equal((await f.request()).body.code,'DUPLICATE')
    assert.equal((await f.call('a','/requests?view=incoming')).body.items[0].patientName,'SYNTHETIC PATIENT')
    assert.equal((await f.call('a',`/requests/${old.id}/decision`,{action:'approve'})).body.status,'COMPLETED')
})
