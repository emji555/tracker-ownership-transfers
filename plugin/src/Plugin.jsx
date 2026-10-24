import React, { useEffect, useMemo, useState } from 'react'
import { useConfig } from '@dhis2/app-runtime'
import { apiBase, client } from './api.mjs'
import './style.css'

// Companion panel: does not patch, replace or calculate anything in the existing patient dashboard.
export default function Plugin({ programId, orgUnitId }) {
    const config = useConfig()
    const [state,setState] = useState(null), [error,setError] = useState('')
    const connection = useMemo(() => {
        try { return {base:apiBase(config.baseUrl)} } catch (e) { return {error:e.message} }
    },[config.baseUrl])
    useEffect(() => {
        setState(null); setError('')
        if (connection.error) { setError(connection.error); return }
        let live = true
        client(connection.base)('/session').then(s => {
            if (live) setState(s)
        }).catch(e => live && setError(e.message))
        return () => {live=false}
    },[connection,programId,orgUnitId])
    const root = connection.base?.replace(/\/transfer-api$/,'') || ''
    return <section className="transfers panel"><h2>Ownership transfer requests</h2>
        {error ? <p role="alert">{error}</p> : !state ? <p>Checking transfer access…</p> :
            !(state.supportedPrograms||[state.program]).includes(programId) ? <p>This programme is not configured for transfers.</p> :
                programId===state.program&&!state.facilities.some(c => c.id === orgUnitId) ? <p>This centre is outside your transfer scope.</p> :
                    <><p>Review incoming requests or follow outgoing requests in the Ownership Transfers app.</p>
                        {programId!==state.program&&<p>Existing requests remain available under their original programme. New requests use the active programme selected by your administrator.</p>}
                        <a href={`${root}/apps/tracker-ownership-transfers/`} target="_blank" rel="noopener noreferrer">Open Ownership Transfers</a></>}
    </section>
}
