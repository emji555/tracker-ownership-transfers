import { createServer, request } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { resolve, sep, extname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { portableCaptureLinks } from './capture-links.mjs'

export function blockedOwnershipPath(path) {
    // Decode before matching; reject ambiguous double encoding and servlet path parameters.
    let decoded
    try { decoded = decodeURIComponent(path) } catch { return true }
    if (/%|;|\\/.test(decoded)) return true
    return /\/api\/(?:\d+\/)?(?:tracker\/ownership|trackerOwnership)(?:[/.]|$)/i.test(decoded.replace(/\/+/g,'/'))
}
export function createGateway({ port=8080,dhisPort=8081,servicePort=8094,chatbotPort=8091,
    appDir=fileURLToPath(new URL('../../plugin/build/app/',import.meta.url)) }={}) {
    const origin=`http://127.0.0.1:${port}`
    const types={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.json':'application/json',
        '.webapp':'application/json','.png':'image/png','.svg':'image/svg+xml','.ico':'image/x-icon','.woff2':'font/woff2'}
    return createServer((req,res)=>{
        const reject=(status,message)=>{res.writeHead(status,{'Content-Type':'text/plain','Cache-Control':'no-store'});res.end(message)}
        if(req.headers.host!==`127.0.0.1:${port}`) return reject(403,'Use the configured loopback gateway.')
        if(!req.url.startsWith('/')||req.url.startsWith('//')) return reject(400,'Invalid path.')
        const url=new URL(req.url,origin)
        if(blockedOwnershipPath(url.pathname)) return reject(403,'Use Tracker Ownership Transfers for ownership changes.')
        if(url.pathname==='/_transfers'||url.pathname==='/_transfers/') {
            res.writeHead(302,{Location:'/_transfers/index.html'});return res.end()
        }
        if(url.pathname.startsWith('/_transfers/')) {
            if(!['GET','HEAD'].includes(req.method))return reject(405,'Method not allowed.')
            ;(async()=>{
                try{
                    const file=resolve(appDir,decodeURIComponent(url.pathname.slice('/_transfers/'.length)))
                    if(!file.startsWith(resolve(appDir)+sep)||!(await stat(file)).isFile())return reject(404,'Not found.')
                    let body=await readFile(file)
                    if(extname(file)==='.html')body=Buffer.from(body.toString().replaceAll('__DHIS2_BASE_URL__',origin))
                    res.writeHead(200,{'Content-Type':types[extname(file)]||'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'})
                    res.end(req.method==='HEAD'?undefined:body)
                }catch{reject(404,'Build the Tracker Ownership Transfers app first.')}
            })()
            return
        }
        const transfer=url.pathname.startsWith('/transfer-api/'),chat=url.pathname.startsWith('/chatbot-api/')
        // Capture also reads all layout values with /dataStore/capture?fields=.
        const captureLayout=req.method==='GET'&&/^\/api\/(?:\d+\/)?dataStore\/capture(?:\/(?:enrollmentOverviewLayout|dataEntryForms))?(?:\.json)?\/?$/.test(url.pathname)
        const upstreamPort=transfer?servicePort:chat?chatbotPort:dhisPort
        const path=transfer?req.url.slice('/transfer-api'.length):chat?req.url.slice('/chatbot-api'.length):req.url
        const headers={...req.headers,host:`127.0.0.1:${port}`,'x-forwarded-host':`127.0.0.1:${port}`,'x-forwarded-proto':'http'}
        for(const key of ['forwarded','proxy-authorization','proxy-connection','x-forwarded-for'])delete headers[key]
        if(captureLayout){
            headers['accept-encoding']='identity'
            for(const key of ['if-none-match','if-modified-since','range'])delete headers[key]
        }
        const upstream=request({hostname:'127.0.0.1',port:upstreamPort,path,method:req.method,headers,timeout:90000},reply=>{
            const responseHeaders={...reply.headers}
            if(captureLayout&&reply.statusCode===200&&String(reply.headers['content-type']).includes('json')){
                const chunks=[];let size=0
                reply.on('data',chunk=>{
                    size+=chunk.length
                    if(size>4*1024*1024){upstream.destroy();return}
                    chunks.push(chunk)
                })
                reply.on('end',()=>{
                    try{
                        if(reply.headers['content-encoding']&&reply.headers['content-encoding']!=='identity')throw new Error('Unexpected encoding')
                        const result=portableCaptureLinks(JSON.parse(Buffer.concat(chunks).toString()),{
                            trustedOrigins:[`http://127.0.0.1:${dhisPort}`,`http://localhost:${dhisPort}`,origin],
                        })
                        const body=Buffer.from(JSON.stringify(result.value))
                        for(const key of ['content-length','content-encoding','transfer-encoding','etag','last-modified'])delete responseHeaders[key]
                        res.writeHead(200,{...responseHeaders,'content-length':body.length,'cache-control':'no-store'})
                        res.end(body)
                    }catch{reject(502,'Could not load the Capture plugin configuration.')}
                })
                return
            }
            if(responseHeaders.location){
                const location=new URL(responseHeaders.location,origin)
                if(['127.0.0.1','localhost'].includes(location.hostname)&&Number(location.port)===dhisPort)
                    responseHeaders.location=`${origin}${location.pathname}${location.search}${location.hash}`
            }
            res.writeHead(reply.statusCode,responseHeaders);reply.pipe(res)
        })
        upstream.on('timeout',()=>upstream.destroy())
        upstream.on('error',()=>{if(!res.headersSent)reject(502,'The local upstream service is unavailable.');else res.destroy()})
        req.on('aborted',()=>upstream.destroy());res.on('close',()=>{if(!res.writableEnded)upstream.destroy()})
        req.pipe(upstream)
    })
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
    createGateway().listen(8080,'127.0.0.1',()=>console.log('Local transfer gateway: http://127.0.0.1:8080/_transfers/'))
}
