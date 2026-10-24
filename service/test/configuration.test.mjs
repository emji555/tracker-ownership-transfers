import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture,ids } from './fixture.mjs'
import { Store } from '../src/store.mjs'
import { Settings } from '../src/settings.mjs'
import { Dhis2 } from '../src/dhis2.mjs'
import { validationRules,maskIdentifier,filterValue } from '../src/identifier.mjs'
async function use(t){const f=await fixture();t.after(()=>f.stop());return f}
const draft=(revision=1,program=ids.program2)=>({expectedRevision:revision,program,
    identifier:program===ids.program?ids.identifier:ids.identifier2,
    nameAttributes:[program===ids.program?'sB1IHYu2xQT':ids.name2],
    identifierValidation:program===ids.program?{minLength:14,maxLength:14,pattern:'^[0-9]{14}$'}:{minLength:6,maxLength:12,pattern:'^PT-[A-Z0-9]+$'},
    membership:{kind:'role',id:ids.request}})
async function save(f,value=draft()){const r=await f.call('admin','/configuration',value);assert.equal(r.status,200,JSON.stringify(r.body));return r.body.settings}
async function request(f,identifier,revision){
    const match=await f.call('b','/search',{identifier,configurationRevision:revision});assert.equal(match.status,200,JSON.stringify(match.body))
    const r=await f.call('b','/requests',{ticket:match.body.ticket,reason:'Synthetic transfer request'});assert.equal(r.status,201,JSON.stringify(r.body));return r.body
}

test('configuration and all metadata/validation/save routes require native ALL authority',async t=>{
    const f=await use(t)
    for(const who of ['a','b','none'])for(const [path,data] of [['/configuration'],['/configuration/metadata/programs'],[`/configuration/programs/${ids.program}`],['/configuration/validate',draft()],['/configuration',draft()]])
        assert.equal((await f.call(who,path,data)).status,403)
    assert.equal((await f.call('admin','/session')).body.canConfigure,true)
    assert.equal((await f.call('b','/session')).body.canConfigure,false)
    assert.equal((await f.call('admin','/configuration/metadata/programs')).body.items.length,2)
    assert.ok((await f.call('admin',`/configuration/programs/${ids.program2}`)).body.attributes.some(a=>a.id===ids.identifier2&&a.eligible))
})

test('ALL from a package role cannot grant configuration; verified Superuser role is required',async t=>{
    const f=await use(t);f.state.superRequester=true
    assert.equal((await f.call('b','/session')).body.canConfigure,false)
    for(const [path,data] of [['/configuration'],['/configuration/metadata/programs'],[`/configuration/programs/${ids.program}`],['/configuration/validate',draft()],['/configuration',draft()]])
        assert.equal((await f.call('b',path,data)).status,403)
    assert.equal((await f.call('admin','/session')).body.canConfigure,true)
    for(const flag of ['removeSuperRole','superRoleDenied','superRoleNoAll','superRoleMismatch']){
        f.state[flag]=true
        assert.equal((await f.call('admin','/session')).body.canConfigure,false,flag)
        assert.equal((await f.call('admin','/configuration',draft())).status,403,flag)
        f.state[flag]=false
    }
    assert.equal((await f.call('admin','/configuration')).status,200)
    assert.equal((await f.call('admin','/configuration')).body.settings.revision,1)
})
test('save validates metadata, membership, identifier, display fields, native access and bounded patterns',async t=>{
    const f=await use(t)
    for(const change of [{identifier:ids.A},{nameAttributes:[ids.A]},{membership:{kind:'role',id:ids.A}},
        {identifierValidation:{minLength:1,maxLength:500,pattern:''}},
        {identifierValidation:{minLength:1,maxLength:128,pattern:'(a+)+$'}}])
        assert.ok((await f.call('admin','/configuration',{...draft(),...change})).status>=400)
    f.state.searchable=false;assert.equal((await f.call('admin','/configuration',draft())).status,400)
    f.state.searchable=true;f.state.metadataRead=false;assert.equal((await f.call('admin','/configuration',draft())).status,403)
    f.state.metadataRead=true;f.state.programType='WITHOUT_REGISTRATION';assert.equal((await f.call('admin','/configuration',draft())).status,400)
    f.state.programType='WITH_REGISTRATION'
    const validated=await f.call('admin','/configuration/validate',draft())
    assert.equal(validated.status,200);assert.ok(validated.body.warnings.length>=2)
    assert.equal((await f.call('admin','/configuration')).body.settings.revision,1,'Validate does not save')
    assert.ok(f.state.calls.every(c=>c.method==='GET'),'Configuration never writes DHIS2 permissions/metadata')
})
test('configuration persists across reopen, ignores later env defaults and audits immutable revisions',async t=>{
    const f=await use(t);await save(f)
    const reopened=new Store(f.config.dbPath)
    try{
        const settings=new Settings({...f.config,program:ids.A},reopened,new Dhis2(f.config))
        assert.equal(settings.active().program,ids.program2);assert.equal(settings.active().revision,2)
        assert.equal(reopened.db.prepare("SELECT count(*) AS n FROM audit WHERE action='CONFIGURATION_SAVED'").get().n,1)
        assert.throws(()=>reopened.db.exec("UPDATE config_revisions SET settings='{}'"),/Immutable/)
        assert.throws(()=>reopened.db.exec('DELETE FROM config_revisions'),/Immutable/)
    }finally{reopened.close()}
    assert.equal((await f.call('admin','/configuration',draft())).body.code,'CONFIG_CHANGED')
})
test('programme switch keeps pending approval, refused/completed history and notifications on original programme',async t=>{
    const f=await use(t),old=(await f.request()).body
    await save(f)
    const session=await f.call('b','/session')
    assert.equal(session.body.program,ids.program2);assert.equal(session.body.identifierLabel,'Patient Code')
    const current=await request(f,'PT-ABC123',2)
    const rows=(await f.call('a','/requests?view=incoming')).body.items
    assert.equal(rows.length,2);assert.deepEqual(new Set(rows.map(r=>r.programId)),new Set([ids.program,ids.program2]))
    assert.equal((await f.call('a',`/requests/${old.id}/decision`,{action:'approve'})).body.status,'COMPLETED')
    assert.equal(f.state.putCalls[0].params.program,ids.program)
    assert.equal(f.state.owner,ids.B);assert.equal(f.state.owner2,ids.A)
    assert.equal((await f.call('a',`/requests/${current.id}/decision`,{action:'reject',reason:'Synthetic refusal'})).body.status,'REJECTED')
    const history=await f.call('b',`/requests/${old.id}/medical-history`)
    assert.equal(history.status,200);assert.equal(history.body.enrollments[0].program,ids.program)
    assert.ok(history.body.captureUrl.includes(`programId=${ids.program}`))
    assert.equal((await f.call('b',`/requests/${current.id}/medical-history`)).status,403)
    const notifications=(await f.call('b','/notifications')).body.items
    assert.ok(notifications.some(n=>n.request===old.id));assert.ok(notifications.some(n=>n.request===current.id))
    const note=notifications.find(n=>n.request===old.id)
    assert.equal((await f.call('b',`/notifications/${note.id}/read`,{})).status,200)
    assert.equal((await f.call('b',`/requests/${old.id}/audit`)).status,200)
})
test('same-programme revision preserves original role and blocks stale searches/tickets',async t=>{
    const f=await use(t),old=(await f.request()).body,search=await f.search()
    const input={...draft(1,ids.program),membership:{kind:'group',id:'qSSuhs65xMP'}}
    await save(f,input)
    assert.equal((await f.call('b','/session')).body.requestEnabled,false)
    assert.equal((await f.call('b','/search',{identifier:'00000000000001',configurationRevision:1})).body.code,'CONFIG_CHANGED')
    assert.equal((await f.call('b','/requests',{ticket:search.body.ticket,reason:'Synthetic move'})).body.code,'SEARCH_EXPIRED')
    // Original role still governs this request, not the newly selected group.
    assert.equal((await f.call('a',`/requests/${old.id}/decision`,{action:'approve'})).body.status,'COMPLETED')
    f.state.groupOnly=true
    assert.equal((await f.call('b','/session')).body.requestEnabled,true)
})
test('new identifier rules apply without restart and neither regex nor filter inputs can expand a query',async t=>{
    const f=await use(t);await save(f)
    assert.equal((await f.call('b','/search',{identifier:'00000000000001',configurationRevision:2})).status,400)
    const r=await request(f,'PT-ABC123',2)
    assert.equal(f.store.get(r.id).program,ids.program2)
    assert.ok(f.state.calls.some(c=>c.params.filter===`${ids.identifier2}:eq:PT-ABC123`))
    assert.equal((await f.call('a',`/requests/${r.id}/decision`,{action:'approve',reason:'Approved'})).body.status,'COMPLETED')
    assert.equal(f.state.putCalls[0].params.program,ids.program2)
    assert.equal(f.state.owner,ids.A);assert.equal(f.state.owner2,ids.B)
    assert.ok(!maskIdentifier('A').includes('A'))
    assert.equal(filterValue('A:B,C/D'),'A/:B/,C//D')
    assert.throws(()=>validationRules({minLength:1,maxLength:128,pattern:'(a|aa)+$'}))
})
test('administrator can repair configuration when active metadata is unavailable',async t=>{
    const f=await use(t);f.state.removedFacility=true
    const session=await f.call('admin','/session')
    assert.equal(session.status,200);assert.equal(session.body.canConfigure,true);assert.equal(session.body.ready,false)
    assert.equal((await f.call('admin','/configuration')).status,200)
})

test('migration preserves legacy requests, notifications and the complete original audit chain',async t=>{
    const f=await fixture({legacy:true});t.after(()=>f.stop())
    const r=(await f.request()).body
    const before=f.store.get(r.id),audit=f.store.db.prepare('SELECT * FROM audit ORDER BY seq').all(),notes=f.store.db.prepare('SELECT * FROM notifications ORDER BY id').all()
    // Recreate the pre-0.5 schema before exercising the additive column migration.
    f.store.db.exec('DROP TRIGGER request_program_immutable; ALTER TABLE requests DROP COLUMN configId; ALTER TABLE tickets DROP COLUMN configId')
    const migrated=new Store(f.config.dbPath)
    migrated.close()
    const settings=new Settings(f.config,f.store,new Dhis2(f.config))
    const after=f.store.get(r.id)
    assert.deepEqual({...after,configId:null},{...before})
    assert.equal(after.configId,settings.active().revision)
    assert.deepEqual(f.store.db.prepare('SELECT * FROM audit ORDER BY seq LIMIT ?').all(audit.length),audit)
    assert.deepEqual(f.store.db.prepare('SELECT * FROM notifications ORDER BY id').all(),notes)
    assert.throws(()=>f.store.db.prepare('UPDATE requests SET program=? WHERE id=?').run(ids.program2,r.id),/Immutable/)
    assert.throws(()=>f.store.db.prepare('UPDATE requests SET configId=NULL WHERE id=?').run(r.id),/Immutable/)
    new Settings(f.config,f.store,new Dhis2(f.config))
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM audit WHERE action='CONFIGURATION_INITIALISED'").get().n,1)
})

test('configuration change during an in-flight approval never redirects its ownership call',async t=>{
    const f=await use(t),old=(await f.request()).body
    f.state.mode='delay'
    const approval=f.call('a',`/requests/${old.id}/decision`,{action:'approve'})
    const deadline=Date.now()+3000
    while(!f.state.putCalls.length){assert.ok(Date.now()<deadline);await new Promise(r=>setTimeout(r,2))}
    await save(f)
    assert.equal((await approval).body.status,'COMPLETED')
    assert.equal(f.store.get(old.id).program,ids.program)
    assert.equal(f.state.putCalls.length,1);assert.equal(f.state.putCalls[0].params.program,ids.program)
    assert.equal(f.state.owner2,ids.A)
})
