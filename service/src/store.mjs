import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { Problem } from './config.mjs'

export class Store {
    constructor(path) {
        if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
        this.db = new DatabaseSync(path)
        this.db.exec(`
            PRAGMA journal_mode=WAL;
            PRAGMA synchronous=FULL;
            PRAGMA foreign_keys=ON;
            PRAGMA busy_timeout=5000;
            CREATE TABLE IF NOT EXISTS requests (
                id TEXT PRIMARY KEY, patient TEXT NOT NULL, program TEXT NOT NULL,
                source TEXT NOT NULL, target TEXT NOT NULL, requester TEXT NOT NULL,
                reason TEXT NOT NULL, masked TEXT NOT NULL, status TEXT NOT NULL
                CHECK(status IN ('PENDING','TRANSFERRING','COMPLETED','REJECTED','CANCELLED','NEEDS_REVIEW','FAILED')),
                created TEXT NOT NULL, updated TEXT NOT NULL, approver TEXT, decision TEXT, error TEXT
            );
            CREATE UNIQUE INDEX IF NOT EXISTS one_open_transfer ON requests(patient,program)
                WHERE status IN ('PENDING','TRANSFERRING','NEEDS_REVIEW');
            CREATE TABLE IF NOT EXISTS audit (
                seq INTEGER PRIMARY KEY AUTOINCREMENT, time TEXT NOT NULL, actor TEXT NOT NULL,
                action TEXT NOT NULL, request TEXT, detail TEXT NOT NULL, previous TEXT NOT NULL, hash TEXT NOT NULL
            );
            CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT,'Append-only audit'); END;
            CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT,'Append-only audit'); END;
            CREATE TABLE IF NOT EXISTS notifications (
                id TEXT PRIMARY KEY, request TEXT NOT NULL REFERENCES requests(id), centre TEXT NOT NULL,
                kind TEXT NOT NULL, created TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS notification_reads (
                notification TEXT NOT NULL REFERENCES notifications(id), user TEXT NOT NULL,
                PRIMARY KEY(notification,user)
            );
            CREATE TABLE IF NOT EXISTS tickets (
                token TEXT PRIMARY KEY, user TEXT NOT NULL, centre TEXT NOT NULL, patient TEXT NOT NULL,
                owner TEXT NOT NULL, masked TEXT NOT NULL, expires INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS limits (key TEXT PRIMARY KEY, start INTEGER NOT NULL, count INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS configuration (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        `)
        const columns=new Set(this.db.prepare('PRAGMA table_info(requests)').all().map(x=>x.name))
        if(!columns.has('identifier'))this.db.exec('ALTER TABLE requests ADD COLUMN identifier TEXT')
        if(!columns.has('identifierKey'))this.db.exec('ALTER TABLE requests ADD COLUMN identifierKey TEXT')
        if(!columns.has('configId'))this.db.exec('ALTER TABLE requests ADD COLUMN configId INTEGER')
        const ticketColumns=new Set(this.db.prepare('PRAGMA table_info(tickets)').all().map(x=>x.name))
        if(!ticketColumns.has('identifierKey'))this.db.exec('ALTER TABLE tickets ADD COLUMN identifierKey TEXT')
        // Short-lived server-only copy for create re-check (never returned to the browser).
        if(!ticketColumns.has('identifier'))this.db.exec('ALTER TABLE tickets ADD COLUMN identifier TEXT')
        if(!ticketColumns.has('configId'))this.db.exec('ALTER TABLE tickets ADD COLUMN configId INTEGER')
        this.db.exec(`CREATE TABLE IF NOT EXISTS config_revisions (
            id INTEGER PRIMARY KEY AUTOINCREMENT, program TEXT NOT NULL, settings TEXT NOT NULL,
            created TEXT NOT NULL, actor TEXT NOT NULL, validated INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TRIGGER IF NOT EXISTS config_no_update BEFORE UPDATE ON config_revisions BEGIN SELECT RAISE(ABORT,'Immutable configuration revision'); END;
            CREATE TRIGGER IF NOT EXISTS config_no_delete BEFORE DELETE ON config_revisions BEGIN SELECT RAISE(ABORT,'Immutable configuration revision'); END;`)
        this.db.exec(`CREATE TRIGGER IF NOT EXISTS request_program_immutable BEFORE UPDATE OF program,configId ON requests
            WHEN NEW.program<>OLD.program OR (OLD.configId IS NOT NULL AND NEW.configId IS NOT OLD.configId)
            BEGIN SELECT RAISE(ABORT,'Immutable request programme/configuration'); END;`)
        this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS one_open_identifier ON requests(identifierKey,program)
            WHERE identifierKey IS NOT NULL AND status IN ('PENDING','TRANSFERRING','NEEDS_REVIEW')`)
    }
    bindProgram(program, base) {
        this.transaction(() => {
            for (const [key,value] of [['program',program],['upstream',base]]) {
                const existing = this.db.prepare('SELECT value FROM configuration WHERE key=?').get(key)
                if (existing && existing.value !== value) throw new Error('This database belongs to a different DHIS2 instance or programme. Use a separate database.')
                this.db.prepare('INSERT OR IGNORE INTO configuration VALUES (?,?)').run(key,value)
            }
        })
    }
    transaction(fn) {
        this.db.exec('BEGIN IMMEDIATE')
        try { const result = fn(); this.db.exec('COMMIT'); return result }
        catch (e) { this.db.exec('ROLLBACK'); throw e }
    }
    audit(actor, action, request = null, detail = {}) {
        // Call inside an existing transaction for state changes; otherwise create one.
        const add = () => {
            const previous = this.db.prepare('SELECT hash FROM audit ORDER BY seq DESC LIMIT 1').get()?.hash || ''
            const time = new Date().toISOString()
            const json = JSON.stringify(detail)
            const hash = createHash('sha256').update(JSON.stringify([previous,time,actor,action,request,json])).digest('hex')
            this.db.prepare('INSERT INTO audit(time,actor,action,request,detail,previous,hash) VALUES (?,?,?,?,?,?,?)')
                .run(time, actor, action, request, json, previous, hash)
        }
        if (this.db.isTransaction) add(); else this.transaction(add)
    }
    rate(key, maximum, windowMs = 60000) {
        this.transaction(() => {
            const now = Date.now()
            this.db.prepare('DELETE FROM limits WHERE start < ?').run(now - 3600000)
            const row = this.db.prepare('SELECT * FROM limits WHERE key=?').get(key)
            if (row && now - row.start < windowMs && row.count >= maximum) throw new Problem(429, 'RATE_LIMIT', 'Too many attempts. Try again later.')
            this.db.prepare('INSERT OR REPLACE INTO limits(key,start,count) VALUES (?,?,?)')
                .run(key, row && now-row.start < windowMs ? row.start : now, row && now-row.start < windowMs ? row.count+1 : 1)
        })
    }
    get(id) { return this.db.prepare('SELECT * FROM requests WHERE id=?').get(id) }
    /** Which centres should see an in-app alert for this event. */
    centresFor(kind, row) {
        if (kind === 'REQUESTED' || kind === 'PENDING') return [row.source]
        if (kind === 'COMPLETED' || kind === 'REJECTED' || kind === 'CANCELLED') return [row.target]
        return [row.source, row.target]
    }
    notify(row, kind, centres) {
        const list = centres ?? this.centresFor(kind, row)
        for (const centre of new Set(list.filter(Boolean))) this.db.prepare('INSERT INTO notifications VALUES (?,?,?,?,?)')
            .run(randomUUID(), row.id, centre, kind, new Date().toISOString())
    }
    change(row, status, actor, fields = {}) {
        const result = this.db.prepare(`UPDATE requests SET status=?,updated=?,approver=?,decision=?,error=? WHERE id=? AND status=?`)
            .run(status, new Date().toISOString(), fields.approver ?? row.approver,
                fields.decision ?? row.decision, fields.error ?? null, row.id, row.status)
        if (!result.changes) throw new Problem(409, 'CHANGED', 'The request changed. Refresh before continuing.')
        this.audit(actor, status, row.id, { from: row.status, ...fields })
        this.notify(row, status)
        return this.get(row.id)
    }
    recover() {
        // Run once at startup, with one service instance. Never repeat an uncertain PUT.
        this.transaction(() => {
            for (const row of this.db.prepare("SELECT * FROM requests WHERE status='TRANSFERRING' AND (error IS NULL OR error!='AWAITING_RECEIPT')").all())
                this.change(row, 'NEEDS_REVIEW', 'system', { error: 'INTERRUPTED' })
        })
    }
    close() { this.db.close() }
}
