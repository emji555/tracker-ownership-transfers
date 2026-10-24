import { Problem, requireUid, uid } from './config.mjs'

const deny = () => { throw new Problem(403, 'FORBIDDEN', 'You do not have permission for this action.') }
const reason = value => {
    if (typeof value !== 'string' || value.trim().length < 5 || value.trim().length > 1000 ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))
        throw new Problem(400, 'REASON_REQUIRED', 'Enter a reason between 5 and 1,000 characters.')
    return value.trim()
}
const inboxText = {
    REQUESTED: 'New ownership transfer request waiting for approval at your centre.',
    PENDING: 'An ownership transfer request is pending at your centre.',
    TRANSFERRING: 'An ownership transfer is being verified.',
    COMPLETED: 'An ownership transfer was approved and completed.',
    REJECTED: 'An ownership transfer request was refused.',
    CANCELLED: 'An ownership transfer request was cancelled.',
    FAILED: 'An ownership transfer attempt failed. Open Tracker Ownership Transfers for details.',
    NEEDS_REVIEW: 'An ownership transfer needs administrator review.',
}
export class Workflow {
    constructor(config, store, dhis) { this.c = config; this.s = store; this.d = dhis }
    visible(ctx, row) {
        return row && (!row.program||row.program===this.c.program)&&(!this.c.configId||row.configId===this.c.configId)&&((ctx.centres.has(row.source) && (ctx.approve || ctx.audit)) ||
            (ctx.centres.has(row.target) && (ctx.request || ctx.audit)))
    }
    row(ctx, id) {
        const row = this.s.get(id)
        if (!this.visible(ctx, row)) deny()
        return row
    }
    publicRow(ctx, row) {
        const { patient, program, configId, ...rest } = row
        return { ...rest,programId:program,programLabel:ctx.program?.displayName||this.c.programLabel||program,
            canDecide: ctx.approve && ctx.centres.has(row.source) && ctx.user.id !== row.requester && row.status === 'PENDING',
            canCancel: ctx.request && ctx.centres.has(row.target) && ctx.user.id === row.requester && row.status === 'PENDING',
            canOpen: ctx.request && ctx.centres.has(row.target) && row.status === 'COMPLETED',
            canReconcile: ctx.audit && row.status === 'NEEDS_REVIEW',
        }
    }
    /** Best-effort DHIS2 Messages → envelope icon in the global header. Never blocks the transfer. */
    queueInbox(ctx, row, kind = row.status) {
        Promise.resolve(this.pushNavbar(ctx, row, kind)).catch(() => {})
    }
    emit(ctx, row, kind = row.status) {
        this.queueInbox(ctx, row, kind)
        return this.publicRow(ctx, row)
    }
    async pushNavbar(ctx, row, kind) {
        const body = inboxText[kind]
        if (!body || !ctx?.auth || !row) return
        // Address centres via organisationUnits so ordinary staff do not need
        // permission to list other centres' users (users?filter=... often returns []).
        const organisationUnits = this.s.centresFor(kind, row).filter(uid)
        const users = []
        if (uid(row.requester) && row.requester !== ctx.user.id &&
            ['COMPLETED', 'REJECTED', 'CANCELLED', 'FAILED', 'NEEDS_REVIEW', 'TRANSFERRING'].includes(kind)) {
            users.push(row.requester)
        }
        if (!organisationUnits.length && !users.length) return
        await this.d.message(ctx.auth, 'Ownership transfer',
            `${body}\n\nOpen Tracker Ownership Transfers:\n${this.c.origin}/apps/tracker-ownership-transfers`,
            { users, organisationUnits })
    }
    cancel(ctx, id, data) {
        const row = this.row(ctx, id)
        if (!ctx.request || !ctx.centres.has(row.target) || ctx.user.id !== row.requester) deny()
        if (row.status !== 'PENDING') throw new Problem(409, 'NOT_PENDING', 'Only pending requests can be cancelled.')
        return this.emit(ctx, this.s.transaction(() => this.s.change(row, 'CANCELLED', ctx.user.id, { decision: reason(data.reason) })))
    }
    async medicalHistory(ctx, id) {
        const row = this.row(ctx, id)
        if (row.status !== 'COMPLETED' || !ctx.request || !ctx.centres.has(row.target)) deny()
        await this.ensureReady(ctx)
        const now = await this.d.record(row.patient, ctx.auth)
        if (now.owner !== row.target) throw new Problem(403, 'OWNER_CHANGED', 'This centre is no longer the programme owner.')
        const result = await this.d.history(ctx.auth, row.patient)
        if (result.trackedEntity !== row.patient || !Array.isArray(result.enrollments))
            throw new Problem(502, 'HISTORY_RESPONSE', 'Could not verify the medical history response.')
        const enrollments = result.enrollments.filter(e => e.program === this.c.program)
        const elements = [...new Set(enrollments.flatMap(e => (e.events || []).flatMap(v => (v.dataValues || []).map(d => d.dataElement))))]
        const labels = {}
        for (let start = 0; start < elements.length; start += 100) {
            const part = elements.slice(start,start+100).map(requireUid)
            const metadata = await this.d.call(ctx.auth, 'dataElements', {
                filter: `id:in:[${part.join(',')}]`, fields: 'id,displayName', paging: false,
            })
            for (const item of metadata.dataElements || []) labels[item.id] = item.displayName
        }
        this.s.audit(ctx.user.id, 'MEDICAL_HISTORY_VIEWED', id)
        // Capture deep links use the *current* user's native DHIS2 permissions.
        const basePath = new URL(this.c.base).pathname.replace(/\/$/, '')
        const captureUrl = `${basePath}/dhis-web-capture/#/enrollment?${new URLSearchParams({
            teiId: row.patient, programId: this.c.program, orgUnitId: row.target,
            ...(enrollments.length === 1 ? { enrollmentId: enrollments[0].enrollment } : {}),
        })}`
        return { trackedEntity: row.patient, enrollments, labels, captureUrl }
    }
    notifications(ctx) {
        const ids = [...ctx.centres]
        if (!ids.length) return { items: [] }
        const rows = this.s.db.prepare(`SELECT n.*,r.source,r.target,r.program,r.configId FROM notifications n
            JOIN requests r ON r.id=n.request WHERE n.centre IN (${ids.map(() => '?')})
            ${this.c.configId?'AND r.configId=?':''}
            AND NOT EXISTS (SELECT 1 FROM notification_reads v WHERE v.notification=n.id AND v.user=?)
            ORDER BY n.created DESC LIMIT 100`).all(...ids,...(this.c.configId?[this.c.configId]:[]),ctx.user.id)
        return { items: rows.filter(n => this.visible(ctx,n)).map(({source,target,configId,...item}) => item) }
    }
    markRead(ctx, id) {
        const n = this.s.db.prepare('SELECT * FROM notifications WHERE id=?').get(id)
        if (!n || !ctx.centres.has(n.centre)) deny()
        this.row(ctx,n.request)
        this.s.transaction(() => {
            this.s.db.prepare('INSERT OR IGNORE INTO notification_reads VALUES (?,?)').run(id, ctx.user.id)
            this.s.audit(ctx.user.id, 'NOTIFICATION_READ', n.request)
        })
        return { ok: true }
    }
    audit(ctx, id, query) {
        this.row(ctx,id)
        const after = Math.max(0, Number(query.get('after')) || 0)
        this.s.audit(ctx.user.id, 'AUDIT_VIEWED', id)
        return { items: this.s.db.prepare('SELECT seq,time,actor,action,detail,hash FROM audit WHERE request=? AND seq>? ORDER BY seq LIMIT 100')
            .all(id, after).map(x => ({ ...x, detail: JSON.parse(x.detail) })) }
    }
}
