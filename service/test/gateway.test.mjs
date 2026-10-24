import test from 'node:test'
import assert from 'node:assert/strict'
import { blockedOwnershipPath, createGateway } from '../src/gateway.mjs'
import { listen } from './fixture.mjs'
test('gateway rejects direct, versioned, encoded and legacy ownership routes',()=>{
    for(const path of ['/api/tracker/ownership/transfer','/api/42/tracker/ownership/transfer.json',
        '/api/tracker/ownership/override','/api/trackerOwnership','/api//tracker/ownership/transfer',
        '/api/%74racker/ownership/transfer','/api/tracker%2fownership/transfer',
        '/api/tracker/ownership;test/transfer','/api/%2574racker/ownership/transfer']){
        assert.equal(blockedOwnershipPath(path),true,path)
    }
    for(const path of ['/api/tracker/events','/api/tracker/trackedEntities','/api/programs','/transfer-api/requests']){
        assert.equal(blockedOwnershipPath(path),false,path)
    }
})
test('gateway does not accept arbitrary Host headers',async t=>{
    const gateway=createGateway({port:8095})
    const url=await listen(gateway)
    t.after(()=>new Promise(resolve=>{gateway.close(resolve);gateway.closeAllConnections()}))
    const response=await fetch(url+'/api/tracker/events')
    assert.equal(response.status,403)
})
