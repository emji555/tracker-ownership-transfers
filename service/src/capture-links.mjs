// Only these installed MOHP plugins are migrated; unrelated/external plugins stay untouched.
const installed=new Set(['cvd-patient-dashboard','cvd-risk-plugin','htn-insulin-widget','htn-scheduler'])
export function portableCaptureLinks(value,{trustedOrigins=[],contextPath=''}={}) {
    const prefix=contextPath.replace(/\/$/,'')
    if(prefix && (!prefix.startsWith('/')||prefix.startsWith('//')||/[?#\\]/.test(prefix)))throw new Error('Invalid DHIS2 context path')
    const changes=[]
    function visit(item,path=[]) {
        if(Array.isArray(item))return item.map((v,i)=>visit(v,[...path,i]))
        if(!item||typeof item!=='object')return item
        return Object.fromEntries(Object.entries(item).map(([key,v])=>{
            if(item.type==='plugin'&&['source','pluginSource'].includes(key)&&typeof v==='string'){
                let url
                try{url=new URL(v,'https://relative.invalid')}catch{return [key,v]}
                const relative=v.startsWith('/')&&!v.startsWith('//')
                const match=url.pathname.match(/\/api\/apps\/([^/]+)\/plugin\.html$/)
                if(match&&installed.has(match[1])&&!url.search&&!url.hash&&!url.username&&!url.password&&
                    (relative||trustedOrigins.includes(url.origin))){
                    const next=`${prefix}/api/apps/${match[1]}/plugin.html`
                    if(next!==v)changes.push({path:[...path,key].join('.'),from:v,to:next})
                    return [key,next]
                }
            }
            return [key,visit(v,[...path,key])]
        }))
    }
    return {value:visit(value),changes}
}
