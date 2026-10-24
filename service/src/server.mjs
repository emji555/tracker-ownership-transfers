import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { readConfig, Problem } from './config.mjs'
import { Store } from './store.mjs'
import { Dhis2 } from './dhis2.mjs'
import { ConfiguredWorkflow } from './configured-workflow.mjs'
import { acquireLock } from './lock.mjs'

async function body(req) {
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || ''))
        throw new Problem(415, 'CONTENT_TYPE', 'JSON requests are required.')
    let content = ''
    for await (const chunk of req) {
        content += chunk
        if (Buffer.byteLength(content) > 8192) throw new Problem(413, 'TOO_LARGE', 'Request is too large.')
    }
    try {
        const value = JSON.parse(content)
        if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error()
        return value
    } catch { throw new Problem(400, 'JSON', 'Invalid JSON request.') }
}
export function createApp(config, store, dhis = new Dhis2(config), workflow = new ConfiguredWorkflow(config,store,dhis)) {
    if(!workflow.settings)store.bindProgram(config.program,config.base)
    return createServer({ requestTimeout: 30000, headersTimeout: 10000 }, async (req,res) => {
        const send = (status,data) => {
            res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
                'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' })
            res.end(JSON.stringify(data))
        }
        let actor = 'unauthenticated', route = ''
        try {
            const url = new URL(req.url, config.origin)
            // Tolerate trailing slashes and a duplicated /transfer-api prefix when the
            // app shell resolves baseUrl to the gateway path instead of the DHIS2 root.
            route = url.pathname.replace(/\/+$/, '') || '/'
            if (route === '/transfer-api' || route.startsWith('/transfer-api/'))
                route = route.slice('/transfer-api'.length) || '/'
            if (req.method === 'GET' && route === '/health') return send(200, { service: 'tracker-ownership-transfers', version: '0.5.3' })
            // Same-origin custom header is mandatory even for sensitive GETs. No CORS support.
            if (req.headers['x-patient-transfers'] !== '1' ||
                (req.headers.origin && req.headers.origin !== config.origin) ||
                req.headers['sec-fetch-site'] === 'cross-site')
                throw new Problem(403, 'ORIGIN', 'Open the transfer app through the configured DHIS2 gateway.')
            if (req.method !== 'GET' && req.headers.origin !== config.origin)
                throw new Problem(403, 'ORIGIN', 'Same-origin requests are required.')
            if (!req.headers.cookie) throw new Problem(401, 'SIGN_IN', 'Sign in to DHIS2 first.')
            store.rate(`network:${req.socket.remoteAddress}`, 600)
            const auth = { Cookie: req.headers.cookie }
            // Forward DHIS2's CSRF header if its session configuration requires it.
            if (req.headers['x-xsrf-token']) auth['X-XSRF-TOKEN'] = req.headers['x-xsrf-token']
            const ctx = await workflow.context(auth)
            actor = ctx.user.id
            store.rate(`user:${actor}`, 120)
            const data = req.method === 'POST' ? await body(req) : {}
            if(route.startsWith('/configuration')&&workflow.settings){
                const settings=workflow.settings;settings.admin(ctx)
                if(req.method==='GET'&&route==='/configuration')return send(200,{settings:settings.active()})
                if(req.method==='POST'&&route==='/configuration/validate')return send(200,await settings.validate(ctx,data))
                if(req.method==='POST'&&route==='/configuration')return send(200,await settings.save(ctx,data))
                const metadata=route.match(/^\/configuration\/metadata\/(programs|userGroups|userRoles)$/)
                if(req.method==='GET'&&metadata)return send(200,await settings.options(ctx,metadata[1],url.searchParams.get('page')))
                const programme=route.match(/^\/configuration\/programs\/([A-Za-z][A-Za-z0-9]{10})$/)
                if(req.method==='GET'&&programme)return send(200,await settings.metadata(ctx,programme[1]))
            }
            if (req.method === 'GET' && route === '/session') return send(200,await workflow.session(ctx))
            if (req.method === 'POST' && route === '/search') return send(200,await workflow.search(ctx,data))
            if (req.method === 'POST' && route === '/requests') return send(201,await workflow.create(ctx,data))
            if (req.method === 'GET' && route === '/requests') return send(200,await workflow.list(ctx,url.searchParams))
            if (req.method === 'GET' && route === '/notifications') return send(200,await workflow.notifications(ctx))
            const action = route.match(/^\/requests\/([0-9a-f-]{36})\/(decision|cancel|reconcile|review|confirm|medical-history|audit)$/)
            if (action) {
                const [,id,name] = action
                if (req.method === 'POST' && name === 'review') return send(200,await workflow.review(ctx,id))
                if (req.method === 'POST' && name === 'confirm') return send(200,await workflow.confirm(ctx,id))
                if (req.method === 'POST' && name === 'decision') return send(200,await workflow.decide(ctx,id,data))
                if (req.method === 'POST' && name === 'cancel') return send(200,await workflow.cancel(ctx,id,data))
                if (req.method === 'POST' && name === 'reconcile') return send(200,await workflow.reconcile(ctx,id,data))
                if (req.method === 'GET' && name === 'medical-history') return send(200,await workflow.medicalHistory(ctx,id))
                if (req.method === 'GET' && name === 'audit') return send(200,await workflow.audit(ctx,id,url.searchParams))
            }
            const notification = route.match(/^\/notifications\/([0-9a-f-]{36})\/read$/)
            if (req.method === 'POST' && notification) return send(200,await workflow.markRead(ctx,notification[1]))
            throw new Problem(404, 'NOT_FOUND', 'Unknown transfer operation.')
        } catch (e) {
            const status = e instanceof Problem ? e.status : 500
            try { store.audit(actor, 'REQUEST_DENIED_OR_FAILED', route.match(/^\/requests\/([0-9a-f-]{36})\//)?.[1] || null, {
                code: e instanceof Problem ? e.code : 'INTERNAL', method: req.method,
                // Do not log raw URLs, patient identifiers, cookies or request bodies.
                operation: /^\/requests\/[0-9a-f-]{36}\//.test(route) ? route.split('/').at(-1) :
                    ['/session','/search','/requests','/notifications','/configuration','/configuration/validate'].includes(route) ? route : 'unknown',
            }) } catch { /* Database failure must still return an error, never a success. */ }
            send(status, { error: e instanceof Problem ? e.message : 'The service could not complete this operation.',
                code: e instanceof Problem ? e.code : 'INTERNAL' })
        }
    })
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
    const config = readConfig()
    const release = acquireLock(config.dbPath)
    const store = new Store(config.dbPath)
    const server = createApp(config,store)
    server.listen(config.port,'127.0.0.1',() => {
        store.recover()
        console.log(`Patient transfer service listening on loopback port ${config.port}`)
    })
    const stop = () => server.close(() => { store.close(); release(); process.exit(0) })
    server.on('error',() => {store.close();release();process.exitCode=1})
    process.on('SIGINT',stop); process.on('SIGTERM',stop)
}
