import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { fixture, ids } from './fixture.mjs'
import { Store } from '../src/store.mjs'
import { readConfig } from '../src/config.mjs'
import { acquireLock } from '../src/lock.mjs'

async function use(t) {const f=await fixture({legacy:true});t.after(()=>f.stop());return f}
const decision=(action='approve')=>({action,reason:'Verified synthetic transfer decision'})

test('audit is append-only, hash linked and has no searched identifier or credential',async t=>{
    const f=await use(t);await f.request()
    const entries=f.store.db.prepare('SELECT * FROM audit ORDER BY seq').all()
    let previous=''
    for(const a of entries){
        assert.equal(a.previous,previous)
        assert.equal(a.hash,createHash('sha256').update(JSON.stringify([previous,a.time,a.actor,a.action,a.request,a.detail])).digest('hex'))
        previous=a.hash
    }
    assert.ok(!JSON.stringify(entries).includes('00000000000001'))
    assert.ok(!JSON.stringify(entries).includes('directory-test-only'))
    assert.throws(()=>f.store.db.exec('DELETE FROM audit'),/Append-only/)
    assert.throws(()=>f.store.db.exec("UPDATE audit SET actor='bad'"),/Append-only/)
})
test('persistent SQLite survives reopening and marks interrupted transfers for review',async t=>{
    const f=await use(t),r=await f.request(),row=f.store.get(r.body.id)
    f.store.transaction(()=>f.store.change(row,'TRANSFERRING',ids.userA))
    const reopened=new Store(f.config.dbPath)
    reopened.recover()
    assert.equal(reopened.get(row.id).status,'NEEDS_REVIEW')
    assert.ok(reopened.db.prepare("SELECT * FROM audit WHERE action='NEEDS_REVIEW'").get())
    reopened.close()
})
test('configuration rejects unsafe URLs, invalid IDs and ports',()=>{
    assert.throws(()=>readConfig({DHIS2_BASE_URL:'http://public.example'}))
    assert.throws(()=>readConfig({DHIS2_BASE_URL:'https://user:secret@dhis2.example'}))
    assert.throws(()=>readConfig({TRANSFER_IDENTIFIER_ATTRIBUTE:'bad'}))
    assert.throws(()=>readConfig({TRANSFER_PORT:'NaN'}))
})
test('database cannot be reused for another programme or upstream',async t=>{
    const f=await use(t)
    assert.throws(()=>f.store.bindProgram('OtherProgAA',f.config.base),/different DHIS2/)
    assert.throws(()=>f.store.bindProgram(f.config.program,'https://different.example'),/different DHIS2/)
})
test('second service process cannot recover or share an active service database',async t=>{
    const f=await use(t),release=acquireLock(f.config.dbPath)
    try {assert.throws(()=>acquireLock(f.config.dbPath),/already owns/)}
    finally {release()}
})
