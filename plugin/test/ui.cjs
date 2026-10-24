const { createRequire } = require('node:module')
const { resolve } = require('node:path')
const assert = require('node:assert/strict')
const local = createRequire(resolve(__dirname,'../package.json'))
const esbuild = local('esbuild')
const { JSDOM, VirtualConsole } = local('jsdom')

async function main() {
    const { fixture } = await import('../../service/test/fixture.mjs')
    const bundle = await esbuild.build({
        stdin: { contents: `
            import React from 'react';
            import {createRoot} from 'react-dom/client';
            import {Transfers} from './App.jsx';
            const root=createRoot(document.getElementById('root'));
            window.renderRole = role => root.render(React.createElement(Transfers,{key:role,call:window.calls[role]}));
            window.stopRender=()=>root.unmount();
            window.renderRole(window.firstRole);
        `, resolveDir:resolve(__dirname,'../src'),loader:'jsx' },
        bundle:true,write:false,format:'iife',platform:'browser',loader:{'.css':'empty'},
        plugins:[{name:'unused-config',setup(build){
            build.onResolve({filter:/^@dhis2\/app-runtime$/},()=>({path:'config',namespace:'test'}))
            build.onLoad({filter:/.*/,namespace:'test'},()=>({contents:'export const useConfig = () => ({baseUrl:window.location.origin});'}))
        }}],
    })
    for(const scenario of ['ok','refuse','lost-ack','capture-group','target-scope','ambiguous-centre','name-hidden','receipt']){
        const f=await fixture()
        if(scenario==='capture-group')f.state.groupOnly=true
        if(scenario==='ambiguous-centre')f.state.extraRoot=true
        if(scenario==='name-hidden')f.state.hideNames=true
        const failures=[]
        const virtualConsole=new VirtualConsole()
        virtualConsole.on('jsdomError',e=>failures.push(e.message))
        const dom=new JSDOM('<div id="root"></div>',{
            url:'http://127.0.0.1:8095/apps/tracker-patient-transfers/',runScripts:'dangerously',pretendToBeVisual:true,virtualConsole,
            beforeParse(w){
                w.fetch=()=>{throw new Error('Unexpected external network request')}
                w.firstRole='b'
                w.calls=Object.fromEntries(['a','b','admin'].map(role=>[role,async(path,data)=>{
                    const r=await f.call(role,path,data)
                    if(r.status>=400)throw new Error(r.body.error)
                    return r.body
                }]))
            },
        })
        try{
            dom.window.eval(bundle.outputFiles[0].text)
            const d=dom.window.document
            const wait=async predicate=>{
                const until=Date.now()+6000
                while(!predicate()){if(Date.now()>until)throw new Error('UI wait failed: '+d.body.textContent);await new Promise(r=>setTimeout(r,15))}
            }
            const button=text=>[...d.querySelectorAll('button')].find(b=>b.textContent===text)
            const click=async text=>{await wait(()=>button(text)&&!button(text).disabled);button(text).click()}
            const input=(id,value)=>{
                const el=d.getElementById(id),prototype=el.tagName==='TEXTAREA'?dom.window.HTMLTextAreaElement.prototype:dom.window.HTMLInputElement.prototype
                Object.getOwnPropertyDescriptor(prototype,'value').set.call(el,value)
                el.dispatchEvent(new dom.window.Event('input',{bubbles:true}))
            }
            await wait(()=>d.getElementById('nid'))
            assert.equal(d.querySelectorAll('nav button').length,2)
            assert.equal(d.querySelectorAll('select').length,0,'No centre dropdowns')
            if(scenario==='ambiguous-centre'){
                assert.ok(d.getElementById('nid').disabled)
                assert.ok(d.body.textContent.includes('more than one programme centre'))
                assert.equal(f.state.putCalls.length,0)
                process.stdout.write('PASS two-screen UI: ambiguous centre fails safely without dropdown\n')
                continue
            }
            assert.ok(d.body.textContent.includes('Your centre: Test CentreBBBBB'))
            input('nid','00000000000001')
            await click('Search')
            await wait(()=>button('Request Transfer to My Centre'))
            assert.ok(d.body.textContent.includes('Test CentreAAAAA'))
            assert.ok(d.body.textContent.includes('**********0001'))
            assert.ok(!d.body.textContent.includes('00000000000001'))
            assert.equal(d.getElementById('nid').value,'')
            assert.ok(!button('Open permitted history'))
            if(scenario==='name-hidden')assert.ok(!d.body.textContent.includes('SYNTHETIC PATIENT'))
            else assert.ok(d.body.textContent.includes('SYNTHETIC PATIENT'))
            input('reason','Synthetic patient moving centre')
            await click('Request Transfer to My Centre')
            await wait(()=>d.querySelector('tbody')&&d.body.textContent.includes('Pending'))
            assert.ok(!button('Open permitted history'))
            dom.window.renderRole('a')
            await wait(()=>d.body.textContent.includes('Test user a'))
            await click('Transfer Requests')
            await wait(()=>button('Approve'))
            assert.ok(!button('Verify patient'),'No extra manual verification action')
            await click(scenario==='refuse'?'Refuse':'Approve')
            await wait(()=>d.querySelector('[role=dialog]'))
            if(scenario==='refuse'){
                assert.ok(d.getElementById('comment').required)
                d.querySelector('[role=dialog] form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}))
                await wait(()=>d.body.textContent.includes('refusal comment is required'))
                input('comment','Synthetic request refused by original centre')
            }else assert.equal(d.getElementById('comment').required,false,'Approval comment is optional')
            if(scenario==='lost-ack')f.state.mode='lost-ack'
            if(scenario==='target-scope')f.state.targetScopeMissing=true
            if(scenario==='receipt')f.state.closeAfterTransfer=true
            await click(scenario==='refuse'?'Confirm refusal':'Confirm approval')
            if(scenario==='target-scope'){
                await wait(()=>d.body.textContent.includes('effective search scope'))
                assert.ok(d.body.textContent.includes('Pending'));assert.equal(f.state.putCalls.length,0)
                process.stdout.write('PASS two-screen UI: missing destination scope remains pending\n')
                continue
            }
            await wait(()=>!d.querySelector('[role=dialog]'))
            dom.window.renderRole('b')
            await wait(()=>d.body.textContent.includes('Test user b')&&d.querySelector('tbody'))
            if(scenario==='refuse'){
                assert.ok(d.body.textContent.includes('Refused'))
                assert.ok(d.body.textContent.includes('Synthetic request refused by original centre'))
                assert.ok(!button('Open permitted history'));assert.equal(f.state.putCalls.length,0)
            }else if(scenario==='lost-ack'){
                assert.ok(d.body.textContent.includes('Needs review'));assert.ok(!button('Open permitted history'))
                dom.window.renderRole('admin')
                await wait(()=>d.body.textContent.includes('Test user admin'))
                await click('Review uncertain outcome')
                await wait(()=>d.querySelector('[role=dialog]'))
                assert.equal(d.querySelectorAll('input[type=radio]:checked').length,0)
                assert.ok(button('Confirm decision').disabled)
                d.querySelector('input[value=confirmNotTransferred]').click()
                input('comment','Synthetic confirmed outcome review')
                await click('Confirm decision')
                await wait(()=>d.body.textContent.includes('DHIS2 currently records Test CentreBBBBB'))
                d.querySelector('input[value=confirmTransferred]').click()
                await click('Confirm decision')
                await wait(()=>!d.querySelector('[role=dialog]')&&d.body.textContent.includes('Transferred'))
                assert.equal(f.state.putCalls.length,1)
            }else{
                await wait(()=>button('Open permitted history'))
                await click('Open permitted history')
                await wait(()=>d.body.textContent.includes('Systolic blood pressure'))
                assert.ok(d.querySelector('a[href*="dhis-web-capture"]'))
                assert.ok(d.body.textContent.includes('CentreAAAAA'))
                assert.equal(f.state.putCalls.length,1)
                f.state.accessDenied=true
                await click('Close history');await click('Open permitted history')
                await wait(()=>d.querySelector('[role=alert]'))
                assert.ok(!d.body.textContent.includes('Systolic blood pressure'))
            }
            assert.equal(JSON.stringify(f.clinical),f.original)
            assert.deepEqual(failures,[])
            process.stdout.write(`PASS two-screen UI ? HTTP service ? simulated DHIS2: ${scenario}\n`)
        }finally{dom.window.stopRender?.();dom.window.close();await f.stop()}
    }
}
main().catch(error=>{console.error(error);process.exitCode=1})
