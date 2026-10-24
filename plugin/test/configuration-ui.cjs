const {createRequire}=require('node:module')
const {resolve}=require('node:path')
const assert=require('node:assert/strict')
const local=createRequire(resolve(__dirname,'../package.json'))
const {JSDOM,VirtualConsole}=local('jsdom')
async function main(){
    const {fixture,ids}=await import('../../service/test/fixture.mjs')
    const bundle=await local('esbuild').build({
        stdin:{contents:`import React from 'react'; import {createRoot} from 'react-dom/client'; import {Transfers} from './App.jsx';
            const root=createRoot(document.getElementById('root'));window.renderRole=role=>root.render(React.createElement(Transfers,{key:role,call:window.calls[role]}));
            window.stopRender=()=>root.unmount();window.renderRole('admin');`,resolveDir:resolve(__dirname,'../src'),loader:'jsx'},
        bundle:true,write:false,format:'iife',platform:'browser',loader:{'.css':'empty'},
        plugins:[{name:'runtime',setup(build){build.onResolve({filter:/^@dhis2\/app-runtime$/},()=>({path:'config',namespace:'test'}));
            build.onLoad({filter:/.*/,namespace:'test'},()=>({contents:'export const useConfig=()=>({baseUrl:window.location.origin});'}))}}],
    })
    const f=await fixture(),failures=[],vc=new VirtualConsole()
    vc.on('jsdomError',e=>failures.push(e.message))
    const dom=new JSDOM('<div id="root"></div>',{url:'http://127.0.0.1:8095/apps/tracker-patient-transfers/',runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:vc,
        beforeParse(w){w.calls=Object.fromEntries(['admin','a','b'].map(role=>[role,async(path,data)=>{
            const response=await f.call(role,path,data);if(response.status>=400)throw new Error(response.body.error);return response.body
        }]))}})
    try{
        const old=(await f.request()).body
        dom.window.eval(bundle.outputFiles[0].text)
        const d=dom.window.document
        const wait=async predicate=>{const until=Date.now()+6000;while(!predicate()){if(Date.now()>until)throw new Error('UI timeout: '+d.body.textContent);await new Promise(r=>setTimeout(r,15))}}
        const button=text=>[...d.querySelectorAll('button')].find(b=>b.textContent===text)
        const click=async text=>{await wait(()=>button(text)&&!button(text).disabled);button(text).click()}
        const input=(id,value)=>{const el=d.getElementById(id);const proto=el.tagName==='SELECT'?dom.window.HTMLSelectElement.prototype:dom.window.HTMLInputElement.prototype;
            Object.getOwnPropertyDescriptor(proto,'value').set.call(el,value);el.dispatchEvent(new dom.window.Event(el.tagName==='SELECT'?'change':'input',{bubbles:true}))}
        await click('Configuration')
        await wait(()=>d.getElementById('cfg-identifier')?.options.length===2)
        assert.equal(d.querySelectorAll('nav button').length,3)
        assert.ok(button('Save').disabled)
        assert.ok(d.body.textContent.includes('Initial HTN/DM settings preserved'))
        input('cfg-program',ids.program2)
        await wait(()=>[...d.getElementById('cfg-identifier').options].some(o=>o.value===ids.identifier2))
        input('cfg-identifier',ids.identifier2)
        input('cfg-kind','role');await wait(()=>!d.getElementById('cfg-membership').disabled)
        input('cfg-membership',ids.request)
        input('cfg-min','6');input('cfg-max','12');input('cfg-pattern','^PT-[A-Z0-9]+$')
        const name=[...d.querySelectorAll('input[type=checkbox]')].find(el=>el.parentElement.textContent==='Patient full name');name.click()
        await click('Validate Configuration')
        await wait(()=>!button('Save').disabled)
        assert.ok(d.body.textContent.includes('Validation passed'))
        assert.ok(d.body.textContent.includes('No organisation-unit scope is expanded'))
        await click('Save')
        await wait(()=>d.body.textContent.includes('Saved configuration')&&d.body.textContent.includes('revision 2'))
        await wait(()=>d.querySelector('header').textContent.includes('Synthetic second programme'))
        await click('Request Transfer')
        await wait(()=>d.querySelector('label[for=nid]')?.textContent==='Patient Code')
        await click('Configuration')
        await wait(()=>d.getElementById('cfg-identifier')?.value===ids.identifier2)
        assert.equal(d.getElementById('cfg-membership').value,ids.request)
        assert.equal(d.getElementById('cfg-pattern').value,'^PT-[A-Z0-9]+$')
        f.state.superApprover=true // ALL from a non-Superuser role must not expose Configuration.
        dom.window.renderRole('a')
        await wait(()=>d.querySelector('.account strong')?.textContent==='Test user a')
        assert.ok(!button('Configuration'))
        await click('Transfer Requests')
        await wait(()=>button('Approve'))
        assert.ok(d.querySelector('tbody').textContent.includes('Hypertension & Diabetes'))
        await click('Approve');await click('Confirm approval')
        await wait(()=>f.store.get(old.id).status==='COMPLETED')
        assert.equal(f.state.putCalls[0].params.program,ids.program)
        dom.window.renderRole('b')
        await wait(()=>d.getElementById('nid')&&!d.getElementById('nid').disabled)
        input('nid','PT-ABC123');await click('Search')
        await wait(()=>button('Request Transfer to My Centre'))
        assert.ok(d.body.textContent.includes('SYNTHETIC PATIENT'))
        assert.deepEqual(failures,[])
        process.stdout.write('PASS administrator UI: metadata, validation, save, live labels, persisted settings, restricted screen, original-programme approval and new identifier search\n')
    }finally{dom.window.stopRender?.();dom.window.close();await f.stop()}
}
main().catch(error=>{console.error(error);process.exitCode=1})
