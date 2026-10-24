import { openSync, writeFileSync, readFileSync, closeSync, unlinkSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

// A single workflow process owns a database. SQLite still serialises concurrent
// HTTP requests; the process lock prevents a second startup from recovering a live PUT.
export function acquireLock(dbPath) {
    const path = `${dbPath}.service.lock`
    mkdirSync(dirname(path), { recursive:true, mode:0o700 })
    let handle
    try { handle = openSync(path,'wx',0o600) }
    catch (e) {
        if (e.code !== 'EEXIST') throw e
        const pid = Number(readFileSync(path,'utf8'))
        if (!Number.isInteger(pid) || pid < 1) throw new Error('Invalid service lock. Investigate before removing it.')
        let running = true
        try { process.kill(pid,0) } catch (error) { if(error.code==='ESRCH')running=false;else throw error }
        if (running) throw new Error('A transfer service already owns this database. Run exactly one instance.')
        unlinkSync(path)
        handle = openSync(path,'wx',0o600)
    }
    writeFileSync(handle,String(process.pid));closeSync(handle)
    return () => {
        if (readFileSync(path,'utf8') === String(process.pid)) unlinkSync(path)
    }
}
