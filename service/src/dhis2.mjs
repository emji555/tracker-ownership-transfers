import { Problem, uid } from './config.mjs'

function safeDhisMessage(value) {
    if (typeof value !== 'string') return ''
    return value.replace(/[^\x20-\x7E]/g, '').slice(0, 240)
}

function trackerUrl(base, path, params = {}) {
    const url = new URL(`${base}/api/${path}`)
    const parts = []
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null) continue
        const raw = String(value)
        // DHIS2 splits filter/query on literal ':'. URLSearchParams encodes ':' as %3A,
        // which some tracker parsers treat as "no attribute filter" → HTTP 409
        // "At least 1 attributes should be mentioned in the search criteria".
        if (key === 'filter' || key === 'filterAttributes' || key === 'query') {
            parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(raw).replace(/%3A/gi, ':')}`)
        } else {
            parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(raw)}`)
        }
    }
    if (parts.length) url.search = parts.join('&')
    return url
}

export class Dhis2 {
    constructor(config, transport = fetch) { this.config = config; this.transport = transport }
    async call(auth, path, params = {}, method = 'GET', body) {
        const url = trackerUrl(this.config.base, path, params)
        const headers = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', ...auth }
        if (body !== undefined) headers['Content-Type'] = 'application/json'
        let response
        try {
            response = await this.transport(url, {
                method, headers, redirect: 'manual', signal: AbortSignal.timeout(15000),
                body: body === undefined ? undefined : JSON.stringify(body),
            })
        } catch { throw new Problem(502, 'DHIS2_UNAVAILABLE', 'DHIS2 did not confirm the operation.') }
        if (response.status === 401 || (response.status >= 300 && response.status < 400))
            throw new Problem(401, 'SESSION_EXPIRED', 'Sign in to DHIS2 again.')
        const contentType = response.headers.get('content-type') || ''
        // Expired sessions are often returned as 200 HTML login pages through the gateway.
        if (contentType.includes('text/html'))
            throw new Problem(401, 'SESSION_EXPIRED', 'Sign in to DHIS2 again.')
        if (!response.ok) {
            let detail = ''
            try {
                const payload = await response.json()
                detail = safeDhisMessage(payload?.message || payload?.devMessage || '')
            } catch { /* keep generic message */ }
            // 403/404 on tracker reads usually means "no access" (DHIS2 hides existence).
            if ([403, 404].includes(response.status))
                throw new Problem(403, 'DHIS2_DENIED', detail || 'DHIS2 did not grant access.')
            throw new Problem(502, 'DHIS2_ERROR', detail
                ? `DHIS2 rejected the request (${response.status}): ${detail}`
                : 'DHIS2 did not confirm the operation.')
        }
        if (response.status === 204 || method === 'PUT') return null
        if (contentType.includes('json')) {
            try { return await response.json() } catch { throw new Problem(502, 'DHIS2_RESPONSE', 'Invalid DHIS2 response.') }
        }
        // /me/authorization/{auth} may return a bare boolean as text/plain.
        if (path.startsWith('me/authorization')) {
            const text = (await response.text()).trim()
            if (text === 'true') return true
            if (text === 'false') return false
        }
        throw new Problem(502, 'DHIS2_RESPONSE', 'Unexpected DHIS2 response.')
    }
    async usersAt(auth, centreId) {
        if (!uid(centreId)) return []
        try {
            const result = await this.call(auth, 'users', {
                filter: `organisationUnits.id:eq:${centreId}`,
                fields: 'id', paging: false,
            })
            return (result.users || []).map(u => u.id).filter(uid)
        } catch { return [] }
    }
    async message(auth, subject, text, { users = [], organisationUnits = [], userGroups = [] } = {}) {
        const payload = {
            subject: String(subject).slice(0, 100),
            text: String(text).slice(0, 1000),
            users: [...new Set(users)].filter(uid).map(id => ({ id })),
            organisationUnits: [...new Set(organisationUnits)].filter(uid).map(id => ({ id })),
            userGroups: [...new Set(userGroups)].filter(uid).map(id => ({ id })),
        }
        if (!payload.users.length && !payload.organisationUnits.length && !payload.userGroups.length) return null
        return this.call(auth, 'messageConversations', {}, 'POST', payload)
    }
    async isConfigurationAdmin(auth, user, hasAll) {
        if(hasAll!==true)return false
        for(const role of user.userRoles){
            if(typeof role.name!=='string'||role.name.trim().toLowerCase()!=='superuser')continue
            // Verify the assigned role itself; ALL from a package role is insufficient.
            const verified=await this.call(auth,`userRoles/${role.id}`,{fields:'id,name,authorities'})
            if(verified.id===role.id&&typeof verified.name==='string'&&
                verified.name.trim().toLowerCase()==='superuser'&&
                Array.isArray(verified.authorities)&&verified.authorities.includes('ALL'))return true
        }
        return false
    }
    async identify(auth) {
        const me = await this.call(auth, 'me', {
            fields: 'id,displayName,userRoles[id,name],userGroups[id,name],organisationUnits[id],teiSearchOrganisationUnits[id]',
        })
        if (!uid(me.id) || !Array.isArray(me.userRoles) || !Array.isArray(me.organisationUnits) ||
            (me.userGroups !== undefined && !Array.isArray(me.userGroups)) ||
            (me.teiSearchOrganisationUnits !== undefined && !Array.isArray(me.teiSearchOrganisationUnits)))
            throw new Problem(401, 'IDENTITY', 'Unable to verify DHIS2 roles and organisation units.')
        // Some responses expose assigned objects as UID references. Resolve only
        // objects in the authenticated user's membership, using that same session.
        for (const collection of ['userRoles','userGroups']) {
            const entries = me[collection] || []
            me[collection] = await Promise.all(entries.map(async entry => {
                if (!uid(entry?.id)) throw new Problem(401, 'IDENTITY', 'Unable to verify DHIS2 membership.')
                if (typeof entry.name === 'string') return entry
                const metadata = await this.call(auth, `${collection}/${entry.id}`, { fields: 'id,name' })
                if (metadata.id !== entry.id || typeof metadata.name !== 'string')
                    throw new Problem(502, 'MEMBERSHIP_RESPONSE', 'Could not verify the assigned DHIS2 role or group.')
                return { id: entry.id, name: metadata.name }
            }))
        }
        return me
    }
    async record(patient, auth, identity = false, _globalSearch = false) {
        // No enrolments, events, relationships, clinical attributes or values are requested here.
        // GET by UID only. On DHIS2 2.42, collection queries with trackedEntity=UID and no
        // attribute filter return 409 "At least 1 attributes should be mentioned…" — never use that fallback.
        const fields=`trackedEntity,deleted,programOwners[program,orgUnit]${identity ? ',attributes[attribute,value]' : ''}`
        let te
        try {
            te=await this.call(auth,`tracker/trackedEntities/${patient}`,{program:this.config.program,fields})
        } catch (e) {
            if (e.code === 'DHIS2_DENIED')
                throw new Problem(409, 'PATIENT_UNAVAILABLE', 'The patient is no longer uniquely available within your DHIS2 access.')
            throw e
        }
        if (!te || te.trackedEntity !== patient || te.deleted)
            throw new Problem(409, 'PATIENT_UNAVAILABLE', 'Patient is no longer available.')
        const owners = te.programOwners?.filter(x => x.program === this.config.program) || []
        if (owners.length !== 1 || !uid(owners[0].orgUnit))
            throw new Problem(409, 'OWNER_UNAVAILABLE', 'Unable to determine the programme owner.')
        return { patient, owner: owners[0].orgUnit, attributes: te.attributes || [] }
    }
    transfer(auth, patient, target) {
        // Only the authenticated approver's credentials can perform this PUT.
        return this.call(auth, 'tracker/ownership/transfer', {
            trackedEntity: patient, program: this.config.program, orgUnit: target,
        }, 'PUT')
    }
    async history(auth, patient) {
        return this.call(auth, `tracker/trackedEntities/${patient}`, {
            program: this.config.program,
            fields: 'trackedEntity,enrollments[enrollment,program,status,orgUnit,enrolledAt,events[event,programStage,orgUnit,status,occurredAt,dataValues[dataElement,value]]]',
        })
    }
}
