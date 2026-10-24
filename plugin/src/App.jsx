import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useConfig } from '@dhis2/app-runtime'
import { apiBase, client } from './api.mjs'
import './style.css'
import Configuration from './Configuration'

const statusText={PENDING:'Pending',TRANSFERRING:'Verifying transfer',COMPLETED:'Transferred',REJECTED:'Refused',CANCELLED:'Cancelled',FAILED:'Failed',NEEDS_REVIEW:'Needs review'}
const noticeText={
    REQUESTED:'New transfer request waiting for approval at your centre.',
    PENDING:'A transfer request is pending at your centre.',
    TRANSFERRING:'A transfer is being verified.',
    COMPLETED:'An ownership transfer to your centre was approved.',
    REJECTED:'A transfer request from your centre was refused.',
    CANCELLED:'A transfer request was cancelled.',
    FAILED:'A transfer attempt failed. Check request details.',
    NEEDS_REVIEW:'A transfer needs administrator review.',
}
const when=value=>value?new Date(value).toLocaleString():'—'
function TransferIcon(){return <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M5 10h22m-6-6 6 6-6 6M27 22H5m6-6-6 6 6 6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>}

export function Transfers({call}){
    const [session,setSession]=useState(null),[page,setPage]=useState('request'),[list,setList]=useState({items:[],hasMore:false})
    const [number,setNumber]=useState(1),[identifier,setIdentifier]=useState(''),[match,setMatch]=useState(null),[reason,setReason]=useState('')
    const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('')
    const [decision,setDecision]=useState(null),[comment,setComment]=useState(''),[history,setHistory]=useState(null),[audit,setAudit]=useState(null)
    const [alerts,setAlerts]=useState([])
    const [draftProgramLabel,setDraftProgramLabel]=useState(null)
    const locked=useRef(false),generation=useRef(0)
    useEffect(()=>{
        let live=true
        call('/session').then(s=>{if(live){setSession(s);setPage(s.roles.request?'request':'incoming')}}).catch(e=>live&&setError(e.message))
        return()=>{live=false}
    },[call])
    useEffect(()=>{
        if(!session)return
        let live=true
        const update=async()=>{if(locked.current)return;try{const next=await call('/session');if(live&&(next.configurationRevision!==session.configurationRevision||next.canConfigure!==session.canConfigure)){setSession(next);setMatch(null);setIdentifier('');setHistory(null);setNotice('Configuration changed. Review the current programme before searching.')}}catch{}}
        const timer=setInterval(update,15000);window.addEventListener('focus',update)
        return()=>{live=false;clearInterval(timer);window.removeEventListener('focus',update)}
    },[session?.configurationRevision,session?.canConfigure,call])
    async function loadAlerts(){
        try{
            const result=await call('/notifications')
            setAlerts(Array.isArray(result.items)?result.items:[])
        }catch{/* Keep the last alerts if the feed briefly fails. */}
    }
    async function refresh(){
        const own=++generation.current
        try{
            const view=page==='request'?'outgoing':'incoming'
            let rows=await call(`/requests?view=${view}&page=${number}`)
            // Receipt verification never retries an ownership transfer. It only
            // checks the receiving user's access after an acknowledged PUT.
            if(view==='outgoing'&&rows.items.some(r=>r.canConfirm)){
                await Promise.allSettled(rows.items.filter(r=>r.canConfirm).map(r=>call(`/requests/${r.id}/confirm`,{})))
                rows=await call(`/requests?view=${view}&page=${number}`)
            }
            if(own===generation.current)setList(rows)
            await loadAlerts()
        }catch(e){if(own===generation.current){setList({items:[]});setHistory(null);setError(e.message)}}
    }
    useEffect(()=>{
        if(!session||page==='configuration')return
        setList({items:[]});setDecision(null);setHistory(null);setAudit(null)
        refresh()
        const timer=setInterval(()=>{if(!document.hidden&&!locked.current)refresh()},15000)
        const focus=()=>{setMatch(null);setHistory(null);if(!locked.current)refresh()}
        window.addEventListener('focus',focus)
        return()=>{generation.current++;clearInterval(timer);window.removeEventListener('focus',focus)}
    },[session,page,number])
    async function act(fn){
        if(locked.current)return
        locked.current=true;setBusy(true);setError('');setNotice('')
        try{await fn()}catch(e){setError(e.message);setHistory(null)}finally{locked.current=false;setBusy(false)}
    }
    function navigate(next){
        setPage(next);setNumber(1);setMatch(null);setError('');setNotice('')
        if(next!=='configuration')setDraftProgramLabel(null)
    }
    function choose(row,action,endpoint='decision'){setDecision({row,action,endpoint});setComment('');setError('')}
    async function decide(){
        const result=await call(`/requests/${decision.row.id}/${decision.endpoint}`,{action:decision.action,reason:comment})
        setDecision(null);setComment('');await refresh()
        setNotice(result.status==='NEEDS_REVIEW'?'DHIS2 did not confirm the transfer. The request needs administrator review.':statusText[result.status])
    }
    async function dismissAlert(id){
        await call(`/notifications/${id}/read`,{})
        setAlerts(items=>items.filter(item=>item.id!==id))
    }
    function openAlert(item){
        // New requests belong on the approval screen; outcomes belong on the requester screen.
        navigate(item.kind==='REQUESTED'||item.kind==='PENDING'?'incoming':'request')
    }
    if(!session)return <main className="transfers"><h1>Ownership Transfer</h1><p role={error?'alert':'status'}>{error||'Checking your DHIS2 access…'}</p>{error&&<button onClick={()=>window.location.reload()}>Retry connection</button>}</main>
    const pending=list.items.filter(r=>r.status==='PENDING').length
    const unreadIncoming=alerts.filter(item=>item.kind==='REQUESTED'||item.kind==='PENDING').length
    return <main className="transfers">
        <header><div className="heading"><span className="transfer-icon"><TransferIcon/></span><div><h1>Ownership Transfer</h1><p>{draftProgramLabel||session.programLabel||session.program}</p>
            {page==='configuration'&&draftProgramLabel&&draftProgramLabel!==(session.programLabel||session.program)&&
                <small className="muted">Draft selection — Validate and Save to activate</small>}</div></div>
            <div className="account"><strong>{session.user.name}</strong><span>{session.userCentre?`Your centre: ${session.userCentre.name}`:'Centre not uniquely assigned'}</span></div></header>
        <nav aria-label="Ownership transfer screens">
            <button disabled={busy} aria-current={page==='request'?'page':undefined} onClick={()=>navigate('request')}>Request Transfer</button>
            <button disabled={busy} aria-current={page==='incoming'?'page':undefined} onClick={()=>navigate('incoming')}>Transfer Requests{(page==='incoming'?pending:unreadIncoming)>0&&<span className="count">{page==='incoming'?pending:unreadIncoming}</span>}</button>
            {session.canConfigure===true&&<button disabled={busy} aria-current={page==='configuration'?'page':undefined} onClick={()=>navigate('configuration')}>Configuration</button>}
        </nav>
        {page==='configuration'&&session.canConfigure===true?<Configuration call={call}
            onProgramLabel={setDraftProgramLabel}
            onSaved={async()=>{setDraftProgramLabel(null);setMatch(null);setIdentifier('');setHistory(null);setSession(await call('/session'))}}/>:<>

        {error&&<p className="error" role="alert">{error}</p>}
        {notice&&<p className="notice" role="status">{notice}</p>}
        <section className="panel alerts-panel" aria-label="Transfer notifications">
            <div className="section-title"><div><h2>Notifications</h2><p className="muted">New requests alert the owning centre. Decisions alert the requesting centre. Check Messages (envelope) in the DHIS2 top bar as well.</p></div>
                <button disabled={busy} onClick={()=>act(loadAlerts)}>Refresh alerts</button></div>
            {!alerts.length?<p className="muted empty-alerts">No unread notifications for your centre.</p>:
                <ul className="alert-list">{alerts.map(item=><li key={item.id} className={`alert-item ${(item.kind||'').toLowerCase()}`}>
                    <div><strong>{noticeText[item.kind]||statusText[item.kind]||item.kind}</strong>
                        <small>Request {String(item.request||'').slice(0,8)} · {when(item.created)}</small></div>
                    <div className="alert-actions">
                        <button type="button" disabled={busy} onClick={()=>openAlert(item)}>Open</button>
                        <button type="button" disabled={busy} onClick={()=>act(()=>dismissAlert(item.id))}>Dismiss</button>
                    </div>
                </li>)}</ul>}
        </section>
        {page==='request'&&<section className="panel search-panel">
            <h2>Search by {session.identifierLabel||'identifier'}</h2><p className="muted">Find the current programme owner using your authorised DHIS2 access.</p>
            {!session.requestEnabled&&<p className="warning" role="alert">{session.requestMessage||session.message}</p>}
            <form onSubmit={e=>{e.preventDefault();act(async()=>{setMatch(null);setReason('');const result=await call('/search',{identifier,configurationRevision:session.configurationRevision});setIdentifier('');setMatch(result)})}}>
                <label htmlFor="nid">{session.identifierLabel||'Identifier'}</label><div className="search-input"><input id="nid" required autoComplete="off" minLength={session.identifierValidation?.minLength||1} maxLength={session.identifierValidation?.maxLength||128} value={identifier} disabled={!session.requestEnabled||busy} onChange={e=>{setIdentifier(e.target.value);setMatch(null)}} placeholder={`Enter ${session.identifierLabel||'identifier'}`}/>
                    <button className="primary" type="submit" disabled={busy||!session.requestEnabled}>Search</button></div>
            </form>
            {match&&<div className="match-result">
                <div className="patient-card"><span className="patient-avatar" aria-hidden="true"><svg width="32" height="32" viewBox="0 0 32 32" fill="currentColor"><circle cx="16" cy="10" r="6"/><path d="M5 29v-4a11 11 0 0 1 22 0v4z"/></svg></span><div><h3>{match.patientName||'Record found'}</h3><p>{session.identifierLabel||'Identifier'}: <strong>{match.masked}</strong></p>{!match.patientName&&<small>Display name is not available under your current access.</small>}</div></div>
                <div className="current-centre"><span>Current programme centre</span><strong>{match.sourceName}</strong></div>
                <form onSubmit={e=>{e.preventDefault();act(async()=>{await call('/requests',{ticket:match.ticket,reason});setMatch(null);setReason('');setNumber(1);await refresh();setNotice('Request sent to the current centre for approval.')})}}>
                    <h3>Request transfer to your centre</h3><p>Destination: <strong>{match.destinationName}</strong></p>
                    <label htmlFor="reason">Reason for transfer</label><textarea id="reason" required minLength={1} maxLength={1000} value={reason} onChange={e=>setReason(e.target.value)} placeholder="Explain why ownership should move. Do not include clinical details."/>
                    <p className="info">The current centre will approve or refuse this request. Clinical history stays closed in this app until a successful transfer is verified.</p>
                    <div className="form-actions"><button type="button" disabled={busy} onClick={()=>setMatch(null)}>Cancel</button><button type="submit" className="primary" disabled={busy}>Request Transfer to My Centre</button></div>
                </form>
            </div>}
        </section>}
        <section className="panel requests-panel">
            <div className="section-title"><div><h2>{page==='request'?'My Centre’s Requests':'Incoming Transfer Requests'}</h2><p className="muted">Requests and decisions update automatically while this page is open.</p></div><button disabled={busy} onClick={()=>act(refresh)}>Refresh</button></div>
            {list.unavailableConfigurations>0&&<p className="warning">Some programme lists could not be loaded with your current access. Contact an administrator if a historical request is missing.</p>}
            {!list.items.length?<div className="empty"><TransferIcon/><p>No transfer requests to show.</p></div>:<div className="table-scroll"><table>
                <thead><tr><th>Record</th><th>{page==='request'?'From / To':'Requesting centre'}</th><th>Request date</th><th>Status</th><th>Comments</th><th>Actions</th></tr></thead>
                <tbody>{list.items.map(row=><tr key={row.id}>
                    <td><strong>{row.patientName||'Record'}</strong><span className="masked">{row.masked}</span><small>{row.programLabel||row.programId}</small><small>Request {row.id.slice(0,8)}</small></td>
                    <td>{page==='request'?<>{row.sourceName}<span className="muted"> → {row.targetName}</span></>:row.targetName}</td>
                    <td>{when(row.created)}</td><td><span className={`badge ${row.status.toLowerCase()}`}>{statusText[row.status]}</span>{row.status==='NEEDS_REVIEW'&&<small>Outcome unconfirmed. Contact your administrator.</small>}</td>
                    <td><span>{row.reason}</span>{row.decision&&<small><strong>Decision:</strong> {row.decision}</small>}</td>
                    <td className="actions">
                        {page==='incoming'&&row.canDecide&&<><button className="approve" disabled={busy} onClick={()=>choose(row,'approve')}>Approve</button><button className="refuse" disabled={busy} onClick={()=>choose(row,'reject')}>Refuse</button></>}
                        {page==='request'&&row.canOpen&&<button disabled={busy} onClick={()=>act(async()=>{setHistory(await call(`/requests/${row.id}/medical-history`))})}>Open permitted history</button>}
                        {page==='request'&&row.canConfirm&&<button disabled={busy} onClick={()=>act(async()=>{await call(`/requests/${row.id}/confirm`,{});await refresh()})}>Check transfer</button>}
                        {row.canCancel&&<button disabled={busy} onClick={()=>choose(row,'cancel','cancel')}>Cancel request</button>}
                        <details><summary>Request details</summary>
                            <button disabled={busy} onClick={()=>act(async()=>{setAudit({id:row.id,...await call(`/requests/${row.id}/audit`)})})}>Audit trail</button>
                            {row.canReconcile&&<button disabled={busy} onClick={()=>choose(row,'','reconcile')}>Review uncertain outcome</button>}
                        </details>
                    </td>
                </tr>)}</tbody>
            </table></div>}
            <div className="pagination"><button disabled={busy||number===1} onClick={()=>setNumber(number-1)}>Previous</button><span>Page {number}</span><button disabled={busy||!list.hasMore} onClick={()=>setNumber(number+1)}>Next</button></div>
        </section>
        {decision&&<section className="panel decision" role="dialog" aria-modal="false" aria-labelledby="decision-title">
            <h2 id="decision-title">{decision.endpoint==='reconcile'?'Review uncertain outcome':decision.action==='approve'?'Approve transfer':decision.action==='reject'?'Refuse transfer':'Cancel request'}</h2>
            <p><strong>{decision.row.patientName||decision.row.masked}</strong> · {decision.row.sourceName} → {decision.row.targetName}</p>
            <form onSubmit={e=>{e.preventDefault();act(decide)}}>
                {decision.endpoint==='reconcile'&&<fieldset><legend>Outcome verified in DHIS2</legend><p>Check current ownership and ensure the earlier operation has stopped. This records the result; it does not resend a transfer.</p>
                    {[['confirmTransferred','Transferred to the receiving centre'],['confirmNotTransferred','Not transferred; still at the original centre']].map(([value,label])=><label className="radio" key={value}><input type="radio" name="outcome" value={value} checked={decision.action===value} onChange={()=>setDecision({...decision,action:value})} required/>{label}</label>)}
                </fieldset>}
                <label htmlFor="comment">{decision.action==='approve'?'Approval comment (optional)':'Comment (required)'}</label><textarea id="comment" required={decision.action!=='approve'} minLength={decision.endpoint==='decision'?1:5} maxLength={1000} value={comment} onChange={e=>setComment(e.target.value)}/>
                <div className="form-actions"><button type="button" disabled={busy} onClick={()=>setDecision(null)}>Close</button><button className={decision.action==='reject'?'refuse':'primary'} type="submit" disabled={busy||!decision.action}>{decision.action==='approve'?'Confirm approval':decision.action==='reject'?'Confirm refusal':'Confirm decision'}</button></div>
            </form>
        </section>}
        {history&&<section className="panel"><div className="section-title"><h2>Permitted medical history</h2><button onClick={()=>setHistory(null)}>Close history</button></div><p className="muted">Visits retain their original facility, date and recorded values.</p>
            <a href={history.captureUrl}>Open record in Capture / dashboard</a>
            {history.enrollments.map(e=><article key={e.enrollment}><h3>Enrolment {when(e.enrolledAt)} · {e.status}</h3>{(e.events||[]).map(v=><details key={v.event}><summary>{when(v.occurredAt)} · {v.orgUnit} · {v.status}</summary><dl>{(v.dataValues||[]).map(d=><React.Fragment key={d.dataElement}><dt>{history.labels[d.dataElement]||d.dataElement}</dt><dd>{String(d.value)}</dd></React.Fragment>)}</dl></details>)}</article>)}
        </section>}
        {audit&&<section className="panel"><div className="section-title"><h2>Audit trail</h2><button onClick={()=>setAudit(null)}>Close audit trail</button></div><ol>{audit.items.map(a=><li key={a.seq}>{when(a.time)} · {a.action} · User {a.actor}</li>)}</ol>{audit.items.length>0&&audit.items.length%100===0&&<button disabled={busy} onClick={()=>act(async()=>{const result=await call(`/requests/${audit.id}/audit?after=${audit.items.at(-1).seq}`);setAudit({...audit,items:[...audit.items,...result.items]})})}>Load more audit entries</button>}</section>}
        </>}
        <footer>Identity and access follow your DHIS2 permissions. Programme ownership changes only after approval and verification.</footer>
    </main>
}
export default function App(){
    const config=useConfig()
    const connection=useMemo(()=>{try{return {call:client(apiBase(config.baseUrl))}}catch(e){return {error:e.message}}},[config.baseUrl])
    if(connection.error)return <main className="transfers"><h1>Ownership Transfer</h1><p role="alert">{connection.error}</p></main>
    return <Transfers call={connection.call}/>
}
