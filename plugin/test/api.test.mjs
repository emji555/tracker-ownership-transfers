import test from 'node:test'
import assert from 'node:assert/strict'
import { apiBase, client } from '../src/api.mjs'
test('same-origin API paths support DHIS2 context roots',()=>{
    assert.equal(apiBase('https://dhis.example/dhis',{origin:'https://dhis.example',href:'https://dhis.example/dhis/apps/x/'}),'/dhis/transfer-api')
    assert.equal(apiBase('/',{origin:'https://dhis.example',href:'https://dhis.example/'}),'/transfer-api')
    assert.throws(()=>apiBase('http://127.0.0.1:8080',{origin:'http://127.0.0.1:8095',href:'http://127.0.0.1:8095/'}))
    assert.equal(apiBase('../../..',{origin:'https://stage.example',href:'https://stage.example/dhis/api/apps/patient-transfers/index.html'}),'/dhis/transfer-api')
    assert.equal(apiBase('/transfer-api',{origin:'http://127.0.0.1:8080',href:'http://127.0.0.1:8080/apps/tracker-ownership-transfers/'}),'/transfer-api')
    assert.equal(apiBase('../../..',{origin:'http://127.0.0.1:8080',href:'http://127.0.0.1:8080/apps/tracker-ownership-transfers/'}),'/transfer-api')
    // DHIS2 hub iframe: absolute meta base + /api/apps/... page must stay site-root
    assert.equal(apiBase('http://127.0.0.1:8080',{origin:'http://127.0.0.1:8080',href:'http://127.0.0.1:8080/api/apps/tracker-ownership-transfers/index.html?redirect=false'}),'/transfer-api')
})
test('browser client sends only same-origin requests with CSRF token and reports proxy failures',async()=>{
    globalThis.document={cookie:'XSRF-TOKEN=encoded%20token'}
    let sent
    const api=client('/transfer-api',async(url,options)=>{
        sent={url,options};return new Response('{"ok":true}',{headers:{'Content-Type':'application/json'}})
    })
    await api('/search',{identifier:'00000000000001'})
    assert.equal(sent.url,'/transfer-api/search')
    assert.equal(sent.options.credentials,'same-origin')
    assert.equal(sent.options.headers['X-XSRF-TOKEN'],'encoded token')
    assert.equal(sent.options.headers['X-Patient-Transfers'],'1')
    const disconnected=client('/transfer-api',async()=>new Response('<html>DHIS2</html>'))
    await assert.rejects(disconnected('/session'),/not connected/)
    delete globalThis.document
})
