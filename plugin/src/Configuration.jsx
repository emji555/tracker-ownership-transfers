import React,{useEffect,useState} from 'react'

export default function Configuration({call,onSaved,onProgramLabel}){
    const [draft,setDraft]=useState(null),[lists,setLists]=useState({programs:[],userGroups:[],userRoles:[]})
    const [metadata,setMetadata]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[report,setReport]=useState(null),[status,setStatus]=useState('Loading configuration…')
    const label=x=>x.displayName||x.name||x.id
    function programTitle(id,fallback){
        const found=lists.programs.find(p=>p.id===id)
        return found?label(found):(fallback||id||'')
    }
    async function choices(kind){
        const items=[]
        for(let page=1;page<=1000;page++){
            const result=await call(`/configuration/metadata/${kind}?page=${page}`);items.push(...result.items)
            if(!result.hasMore)return items
        }
        throw new Error('Too many metadata pages. Narrow the metadata available to this administrator.')
    }
    useEffect(()=>{
        let live=true
        Promise.all([call('/configuration'),choices('programs'),choices('userGroups'),choices('userRoles')]).then(([result,programs,userGroups,userRoles])=>{
            if(!live)return
            setLists({programs,userGroups,userRoles});setDraft({...result.settings,expectedRevision:result.settings.revision})
            onProgramLabel?.(result.settings.programLabel||result.settings.program||null)
            setStatus(result.settings.validated?`Saved configuration · revision ${result.settings.revision}`:'First-run defaults are active. Select programme, identifier and staff group, then Validate and Save.')
        }).catch(e=>live&&setError(e.message))
        return()=>{live=false}
    },[call])
    useEffect(()=>{
        if(!draft?.program)return
        let live=true;setMetadata(null)
        call(`/configuration/programs/${draft.program}`).then(result=>live&&setMetadata(result)).catch(e=>live&&setError(e.message))
        return()=>{live=false}
    },[call,draft?.program])
    function change(values){setDraft(d=>({...d,...values}));setReport(null);setError('');setStatus('Unsaved changes — Validate and Save to activate the new programme')}
    async function run(save){
        setBusy(true);setError('')
        try{
            const result=await call(save?'/configuration':'/configuration/validate',draft)
            setReport(result)
            if(save){
                setDraft({...result.settings,expectedRevision:result.settings.revision})
                setStatus(`Saved configuration · revision ${result.settings.revision}`)
                onProgramLabel?.(result.settings.programLabel||result.settings.program||null)
                await onSaved()
            }
            else setStatus('Validation passed. Save to activate these settings.')
        }catch(e){setError(e.message);setReport(null)}finally{setBusy(false)}
    }
    return <section className="panel configuration-panel" aria-label="Administrator configuration">
        <h2>Configuration</h2><p>One active Tracker programme. Existing requests retain their original programme and configuration. The title under Ownership Transfer updates when you change the programme; it becomes active only after Save.</p>
        <p role="status">{status}</p>{error&&<p className="error" role="alert">{error}</p>}
        {draft&&<form onSubmit={e=>{e.preventDefault();run(false)}}>
            <fieldset disabled={busy}><legend>Programme and tracked-entity identity</legend>
                <label htmlFor="cfg-program">Active Tracker programme</label>
                <select id="cfg-program" required value={draft.program} onChange={e=>{
                    const program=e.target.value
                    change({program,identifier:'',nameAttributes:[],identifierValidation:{minLength:1,maxLength:128,pattern:''}})
                    onProgramLabel?.(program?programTitle(program,draft.programLabel):null)
                }}>
                    <option value="">Select programme</option>
                    {!lists.programs.some(p=>p.id===draft.program)&&draft.program&&<option value={draft.program}>{draft.programLabel||draft.program} (current)</option>}
                    {lists.programs.map(p=><option key={p.id} value={p.id}>{label(p)}</option>)}
                </select>
                <label htmlFor="cfg-identifier">Searchable patient identifier</label>
                <select id="cfg-identifier" required value={draft.identifier} disabled={!metadata} onChange={e=>change({identifier:e.target.value})}>
                    <option value="">Select searchable attribute</option>
                    {metadata?.attributes.filter(a=>a.eligible).map(a=><option key={a.id} value={a.id}>{label(a)}</option>)}
                </select>
                {metadata&&!metadata.attributes.some(a=>a.eligible)&&<p className="warning">No eligible searchable attributes. Review programme/type metadata in DHIS2.</p>}
                <fieldset><legend>Patient display-name attributes (optional)</legend>
                    {metadata?.attributes.filter(a=>a.access?.read!==false).map(a=><label className="radio" key={a.id}><input type="checkbox" checked={draft.nameAttributes.includes(a.id)} onChange={e=>change({nameAttributes:e.target.checked?[...draft.nameAttributes,a.id]:draft.nameAttributes.filter(id=>id!==a.id)})}/>{label(a)}</label>)}
                    {metadata&&draft.nameAttributes.filter(id=>!metadata.attributes.some(a=>a.id===id&&a.access?.read!==false)).map(id=><label className="radio" key={id}><input type="checkbox" checked onChange={()=>change({nameAttributes:draft.nameAttributes.filter(value=>value!==id)})}/>{id} (unavailable; clear to remove)</label>)}
                    <small>Only authorised values are shown. No selected attributes means masked identifiers only.</small>
                </fieldset>
                <div className="config-lengths"><label>Minimum length<input id="cfg-min" type="number" min="1" max="128" required value={draft.identifierValidation.minLength} onChange={e=>change({identifierValidation:{...draft.identifierValidation,minLength:Number(e.target.value)}})}/></label>
                    <label>Maximum length<input id="cfg-max" type="number" min="1" max="128" required value={draft.identifierValidation.maxLength} onChange={e=>change({identifierValidation:{...draft.identifierValidation,maxLength:Number(e.target.value)}})}/></label></div>
                <label htmlFor="cfg-pattern">Identifier pattern (optional)</label><input id="cfg-pattern" value={draft.identifierValidation.pattern} maxLength={150} onChange={e=>change({identifierValidation:{...draft.identifierValidation,pattern:e.target.value}})}/>
                <small>Examples: {'^[0-9]{14}$'} or {'^PAT-[A-Z0-9]+$'}. One character class with optional literal prefix/suffix; groups and alternatives are not supported.</small>
            </fieldset>
            <fieldset disabled={busy}><legend>Authorised staff</legend>
                <label htmlFor="cfg-kind">Membership type</label><select id="cfg-kind" required value={draft.membership.kind} onChange={e=>change({membership:{kind:e.target.value,id:''}})}>
                    <option value="legacy" disabled>Initial group/role by name</option><option value="group">User group</option><option value="role">User role</option>
                </select>
                <label htmlFor="cfg-membership">Authorised group or role</label><select id="cfg-membership" required disabled={draft.membership.kind==='legacy'} value={draft.membership.id||''} onChange={e=>change({membership:{...draft.membership,id:e.target.value}})}>
                    <option value="">Select membership</option>{(draft.membership.kind==='group'?lists.userGroups:lists.userRoles).map(m=><option key={m.id} value={m.id}>{label(m)}</option>)}
                </select>
                <p>Membership enables the transfer workflow. Native programme permissions and capture/search scope still apply. This screen never expands organisation-unit scope. Sign out and sign in after authorised DHIS2 permission changes.</p>
            </fieldset>
            {report&&<div className="info"><strong>Configuration validated</strong><ul>{report.warnings.map(w=><li key={w}>{w}</li>)}</ul></div>}
            <div className="form-actions"><button type="submit" disabled={busy||!metadata}>Validate Configuration</button><button className="primary" type="button" disabled={busy||!report?.valid} onClick={()=>run(true)}>Save</button></div>
        </form>}
    </section>
}
