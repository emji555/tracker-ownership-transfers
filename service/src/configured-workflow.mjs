import { Problem } from './config.mjs'
import { Dhis2 } from './dhis2.mjs'
import { Settings } from './settings.mjs'
import { PatientTransferWorkflow } from './transfer-workflow.mjs'

// A fresh workflow/adapter per configuration revision and request: never mutate
// shared programme state while an approval awaits DHIS2.
export class ConfiguredWorkflow {
    constructor(config,store,dhis){this.c=config;this.s=store;this.d=dhis;this.settings=new Settings(config,store,dhis)}
    async context(auth){
        const user=await this.d.identify(auth),audit=await this.d.call(auth,'me/authorization/ALL')===true
        let canConfigure=false
        try{canConfigure=await this.d.isConfigurationAdmin(auth,user,audit)}catch{/* Unverified role never grants configuration access. */}
        return {auth,user,audit,canConfigure}
    }
    async scoped(ctx,revision){
        if(!revision)throw new Problem(409,'CONFIG_UNAVAILABLE','The original request configuration is unavailable. Contact an administrator.')
        const config={...this.c,...revision,configId:revision.revision}
        const workflow=new PatientTransferWorkflow(config,this.s,new Dhis2(config,this.d.transport))
        return {workflow,ctx:await workflow.context(ctx.auth),revision}
    }
    async session(ctx){
        const active=this.settings.active()
        let result
        try{const scope=await this.scoped(ctx,active);result=await scope.workflow.session(scope.ctx)}
        catch(e){
            if(!(e instanceof Problem))throw e
            // Historical requests may still be actionable even without active-programme access.
            result={user:{id:ctx.user.id,name:ctx.user.displayName},roles:{request:false,approve:false,audit:ctx.audit},
                facilities:[],userCentre:null,requestEnabled:false,ready:false,message:e.message,requestMessage:e.message,
                program:active.program,programLabel:active.programLabel,identifierLabel:active.identifierLabel,
                identifierValidation:active.identifierValidation,configurationRevision:active.revision}
        }
        return {...result,canConfigure:ctx.canConfigure===true,configurationStatus:active.validated?'saved':'initial-default',
            supportedPrograms:this.s.db.prepare('SELECT DISTINCT program FROM config_revisions').all().map(r=>r.program)}
    }
    async search(ctx,data){
        const active=this.settings.active(),{configurationRevision,...input}=data
        if((configurationRevision!==undefined&&configurationRevision!==active.revision)||(configurationRevision===undefined&&active.validated))
            throw new Problem(409,'CONFIG_CHANGED','Configuration changed. Reload the application before searching.')
        const s=await this.scoped(ctx,active);return s.workflow.search(s.ctx,input)
    }
    async create(ctx,data){
        const active=this.settings.active()
        const ticket=this.s.db.prepare('SELECT configId FROM tickets WHERE token=?').get(String(data.ticket||''))
        if(!ticket||ticket.configId!==active.revision)throw new Problem(409,'SEARCH_EXPIRED','Configuration or search changed. Search again before submitting.')
        const s=await this.scoped(ctx,active);return s.workflow.create(s.ctx,data)
    }
    async requestScope(ctx,id){
        const row=this.s.get(id)
        if(!row)throw new Problem(403,'FORBIDDEN','You do not have permission for this request.')
        const revision=this.settings.revision(row.configId)
        if(!revision||revision.program!==row.program)throw new Problem(409,'CONFIG_UNAVAILABLE','Request programme/configuration mismatch; administrator review required.')
        const scope=await this.scoped(ctx,revision)
        scope.workflow.row(scope.ctx,id)
        return scope
    }
    async invoke(method,ctx,id,data){const s=await this.requestScope(ctx,id);return s.workflow[method](s.ctx,id,data)}
    decide(ctx,id,data){return this.invoke('decide',ctx,id,data)}
    cancel(ctx,id,data){return this.invoke('cancel',ctx,id,data)}
    reconcile(ctx,id,data){return this.invoke('reconcile',ctx,id,data)}
    review(ctx,id){return this.invoke('review',ctx,id)}
    confirm(ctx,id){return this.invoke('confirm',ctx,id)}
    medicalHistory(ctx,id){return this.invoke('medicalHistory',ctx,id)}
    audit(ctx,id,query){return this.invoke('audit',ctx,id,query)}
    async scopes(ctx){
        const ids=this.s.db.prepare('SELECT DISTINCT configId AS id FROM requests UNION SELECT CAST(value AS INTEGER) AS id FROM app_settings WHERE key=?').all('active')
        const scopes=[];let unavailable=0
        for(const {id} of ids){try{scopes.push(await this.scoped(ctx,this.settings.revision(id)))}catch(e){if(!(e instanceof Problem))throw e;unavailable++}}
        return {scopes,unavailable}
    }
    async list(ctx,query){
        const view=query.get('view')||'incoming'
        if(!['incoming','outgoing','history'].includes(view))throw new Problem(400,'VIEW','Unknown list.')
        const page=Math.max(1,Math.min(100000,Math.floor(Number(query.get('page'))||1)))
        const {scopes,unavailable}=await this.scopes(ctx),clauses=[],values=[]
        for(const s of scopes){
            const ids=[...s.ctx.centres],parts=[]
            if(!ids.length)continue
            const marks=ids.map(()=>'?').join(',');const scopedValues=[]
            if(view!=='outgoing'&&(s.ctx.approve||s.ctx.audit)){parts.push(`source IN (${marks})`);scopedValues.push(...ids)}
            if(view!=='incoming'&&(s.ctx.request||s.ctx.audit)){parts.push(`target IN (${marks})`);scopedValues.push(...ids)}
            if(parts.length){clauses.push(`(configId=? AND program=? AND (${parts.join(' OR ')}))`);values.push(s.revision.revision,s.revision.program,...scopedValues)}
        }
        if(!clauses.length)return {items:[],page,hasMore:false,unavailableConfigurations:unavailable}
        const rows=this.s.db.prepare(`SELECT * FROM requests WHERE (${clauses.join(' OR ')}) ${view==='history'?"AND status NOT IN ('PENDING','TRANSFERRING')":''} ORDER BY created DESC,id DESC LIMIT 26 OFFSET ?`).all(...values,(page-1)*25)
        const items=[]
        for(const row of rows.slice(0,25)){
            const s=scopes.find(s=>s.revision.revision===row.configId)
            const names=new Map(s.ctx.allFacilities.map(o=>[o.id,o.name]))
            const item={...s.workflow.publicRow(s.ctx,row),sourceName:names.get(row.source)||row.source,targetName:names.get(row.target)||row.target,patientName:''}
            items.push(...(await s.workflow.enrichList(s.ctx,{items:[item]})).items)
        }
        this.s.audit(ctx.user.id,'LIST_VIEWED',null,{view,page})
        return {items,page,hasMore:rows.length>25,unavailableConfigurations:unavailable}
    }
    async notifications(ctx){
        const {scopes}=await this.scopes(ctx),items=[]
        for(const s of scopes)items.push(...s.workflow.notifications(s.ctx).items)
        return {items:[...new Map(items.map(x=>[x.id,x])).values()].sort((a,b)=>b.created.localeCompare(a.created)).slice(0,100)}
    }
    async markRead(ctx,id){
        const n=this.s.db.prepare('SELECT request FROM notifications WHERE id=?').get(id)
        if(!n)throw new Problem(403,'FORBIDDEN','Notification unavailable.')
        const s=await this.requestScope(ctx,n.request);return s.workflow.markRead(s.ctx,id)
    }
}
