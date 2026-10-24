import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { portableCaptureLinks } from '../src/capture-links.mjs'
import { createGateway } from '../src/gateway.mjs'
import { listen } from './fixture.mjs'

test('portable plugin links preserve layout, external plugins and settings across ports and context paths',()=>{
    const old={pMIglSEqPGS:{leftColumn:[{type:'plugin',source:'http://127.0.0.1:8080/api/apps/cvd-patient-dashboard/plugin.html'}],rightColumn:[{type:'component',name:'ProfileWidget'}]},
        fields:[{type:'plugin',pluginSource:'http://127.0.0.1:8080/api/apps/cvd-risk-plugin/plugin.html',fieldMap:[{IdFromApp:'existing'}]},
            {type:'plugin',source:'https://external.example/api/apps/cvd-patient-dashboard/plugin.html'},
            {type:'plugin',source:'http://127.0.0.1:8080/api/apps/unrelated/plugin.html'}]}
    const before=JSON.stringify(old)
    const result=portableCaptureLinks(old,{trustedOrigins:['http://127.0.0.1:8080']})
    assert.equal(result.changes.length,2);assert.equal(JSON.stringify(old),before)
    assert.deepEqual(result.value.fields[0].fieldMap,old.fields[0].fieldMap)
    assert.deepEqual(result.value.fields.slice(1),old.fields.slice(1))
    const path=result.value.pMIglSEqPGS.leftColumn[0].source
    for(const origin of ['http://127.0.0.1:8080','http://127.0.0.1:8090','http://127.0.0.1:8095','https://staging.example','https://production.example:8443']){
        assert.equal(new URL(path,origin+'/apps/capture').origin,origin)
    }
    const context=portableCaptureLinks(old,{trustedOrigins:['http://127.0.0.1:8080'],contextPath:'/dhis'})
    assert.equal(context.value.pMIglSEqPGS.leftColumn[0].source,'/dhis/api/apps/cvd-patient-dashboard/plugin.html')
    assert.equal(portableCaptureLinks(result.value).changes.length,0)
})

for(const route of ['/api/dataStore/capture/enrollmentOverviewLayout','/api/42/dataStore/capture?fields=.'])
test(`gateway corrects authenticated Capture layout at ${route} without weakening security`,async t=>{
    const requests=[]
    let upstreamPort
    const upstream=createServer((req,res)=>{
        requests.push({method:req.method,cookie:req.headers.cookie,encoding:req.headers['accept-encoding']})
        if(req.headers.cookie!=='SESSION=synthetic'){res.writeHead(401);return res.end()}
        res.writeHead(200,{'Content-Type':'application/json','X-Frame-Options':'SAMEORIGIN','ETag':'old-tag'})
        const value={layout:[{type:'plugin',source:`http://127.0.0.1:${upstreamPort}/api/apps/cvd-patient-dashboard/plugin.html`}]}
        res.end(JSON.stringify(route.includes('?')?{entries:[{key:'enrollmentOverviewLayout',value}]}:value))
    })
    await listen(upstream);upstreamPort=upstream.address().port
    const gateway=createGateway({port:8095,dhisPort:upstreamPort})
    const base=await listen(gateway)
    t.after(async()=>{for(const server of [gateway,upstream])await new Promise(r=>{server.close(r);server.closeAllConnections()})})
    // Explicit Host for the configured gateway: the listener uses an ephemeral test port.
    const {request}=await import('node:http')
    async function get(cookie){return new Promise((resolve,reject)=>{
        request(base+route,{headers:{Host:'127.0.0.1:8095',...(cookie?{Cookie:cookie}:{})}},res=>{
            let body='';res.on('data',b=>body+=b);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body}))
        }).on('error',reject).end()
    })}
    assert.equal((await get()).status,401)
    const response=await get('SESSION=synthetic')
    assert.equal(response.status,200)
    const body=JSON.parse(response.body)
    assert.equal((body.entries?.[0]?.value||body).layout[0].source,'/api/apps/cvd-patient-dashboard/plugin.html')
    assert.equal(response.headers['x-frame-options'],'SAMEORIGIN')
    assert.equal(response.headers.etag,undefined)
    assert.equal(response.headers['cache-control'],'no-store')
    assert.ok(requests.every(r=>r.method==='GET'&&r.encoding==='identity'))
})
