import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { CaptureWorkflow } from './capture-workflow.mjs'
import { Problem, uid } from './config.mjs'
import { validIdentifier, filterValue, maskIdentifier } from './identifier.mjs'

const nameOf=(config,record)=>config.nameAttributes.map(id=>
    record.attributes.find(a=>a.attribute===id)?.value||'').filter(Boolean).join(' ')

// Two-screen workflow. Every DHIS2 read/write uses the current user's session.
// No source/destination or patient UID supplied by the browser is trusted.
export class PatientTransferWorkflow extends CaptureWorkflow {
    async globalSearchAllowed(ctx) {
        if(ctx.audit)return true
        // Never fail the whole NID search because this probe returned 403/404.
        // Absence of authority must fall back to ACCESSIBLE, not DHIS2_DENIED.
        try{
            const allowed=await this.d.call(ctx.auth,
                'me/authorization/F_TRACKED_ENTITY_INSTANCE_SEARCH_IN_ALL_ORGUNITS')
            if(allowed===true||allowed==='true')return true
        }catch{/* probe failed; try the authority list below */}
        try{
            const authorities=await this.d.call(ctx.auth,'me/authorization')
            return Array.isArray(authorities)&&
                authorities.includes('F_TRACKED_ENTITY_INSTANCE_SEARCH_IN_ALL_ORGUNITS')
        }catch{return false}
    }
    destination(ctx) {
        if(!ctx.request)throw new Problem(403,'FORBIDDEN','The configured staff group or role is required to request a transfer.')
        if(ctx.facilities.length!==1)throw new Problem(409,'CENTRE_NOT_UNIQUE',
            ctx.facilities.length
                ? 'Your account covers more than one programme centre. Use a centre-specific account so the destination can be identified automatically.'
                : 'No programme centre is assigned within your capture scope. Ask your administrator to check your centre assignment.')
        return ctx.facilities[0]
    }
    async session(ctx) {
        const {sourceFacilities,...session}=await super.session(ctx)
        let centre=null,requestMessage=''
        try{centre=this.destination(ctx)}catch(e){requestMessage=e.message}
        return {...session,userCentre:centre?{id:centre.id,name:centre.name}:null,
            requestEnabled:session.ready&&!!centre,requestMessage,requestMode:'nid-search'}
    }
    async search(ctx,data) {
        const target=this.destination(ctx)
        if(Object.keys(data).some(k=>k!=='identifier'))throw new Problem(400,'AUTOMATIC_CENTRES','Search accepts only the configured patient identifier. Centres are identified by the server.')
        if(!validIdentifier(data.identifier,this.c))
            throw new Problem(400,'IDENTIFIER','Enter an identifier matching the configured length and pattern.')
        await this.ensureReady(ctx)
        this.s.rate(`nid-search:${ctx.user.id}`,10)
        // Honour existing DHIS2 authority; never grant or infer it from group names.
        // Try several native tracker shapes. ACCESSIBLE/ALL require the National ID to be
        // Searchable on the Person TET; SELECTED can use programme-searchable attributes.
        const searchDenied=()=>{throw new Problem(403,'SEARCH_SCOPE',
            'DHIS2 blocked this identifier search. Ask an administrator to review your native programme permissions and capture/search scope. This app does not expand them; sign in again after an authorised permission change.')}
        const attributeMissing=()=>{throw new Problem(409,'ATTRIBUTE_NOT_SEARCHABLE',
            'DHIS2 rejected the configured identifier filter. An administrator should validate the attribute search settings for this programme and tracked entity type.')}
        const isAttributeError=e=>e?.code==='DHIS2_ERROR'&&
            /non-searchable attribute|attributes should be mentioned|attribute/i.test(e.message||'')
        const uniqueHit=result=>{
            const matches=result?.trackedEntities
            if(!Array.isArray(matches)||matches.length!==1||!uid(matches[0].trackedEntity)||
                Number(result.pager?.total||1)>1||Number(result.pager?.pageCount||1)>1)return null
            const owners=(matches[0].programOwners||[]).filter(x=>x.program===this.c.program&&uid(x.orgUnit))
            if(owners.length!==1)return null
            return {patient:matches[0].trackedEntity,owner:owners[0].orgUnit,
                attributes:Array.isArray(matches[0].attributes)?matches[0].attributes:[]}
        }
        let sawAttributeError=false
        const tryQuery=async params=>{
            try{
                return uniqueHit(await this.d.call(ctx.auth,'tracker/trackedEntities',{
                    program:this.c.program,page:1,pageSize:2,totalPages:true,
                    // Ownership from the search hit — avoid a follow-up GET by UID (often 404
                    // when the account can search but cannot open the TEI directly).
                    fields:'trackedEntity,deleted,programOwners[program,orgUnit]',
                    ...params,
                }))
            }catch(e){
                if(e.code==='DHIS2_DENIED')searchDenied()
                // Soft-fail tracker rejections so later strategies can run. Never surface the raw
                // "attributes should be mentioned" 409 (also thrown by the illegal query= form).
                if(e.code==='DHIS2_ERROR'||isAttributeError(e)||/attributes should be mentioned|non-searchable attribute/i.test(e.message||'')){
                    sawAttributeError=sawAttributeError||isAttributeError(e)||/attributes should be mentioned|non-searchable attribute|409/.test(e.message||'')
                    return null
                }
                throw e
            }
        }
        // Keep literal colons via trackerUrl. Do NOT use query= or filterAttributes= —
        // on DHIS2 2.42 those forms return 409 "At least 1 attributes should be mentioned…".
        const filter=`${this.c.identifier}:eq:${filterValue(data.identifier)}`
        const allowAll=await this.globalSearchAllowed(ctx)
        const attempts=[{orgUnitMode:'ACCESSIBLE',filter}]
        if(ctx.searchableCentres.size)
            attempts.push({orgUnitMode:'SELECTED',orgUnits:[...ctx.searchableCentres].join(','),filter})
        if(allowAll)attempts.push({orgUnitMode:'ALL',filter})
        let patient=null, usedAll=false
        for(const attempt of attempts){
            patient=await tryQuery(attempt)
            if(patient){usedAll=attempt.orgUnitMode==='ALL';break}
        }
        if(!patient&&sawAttributeError)attributeMissing()
        if(!patient)throw new Problem(409,'NO_UNIQUE_MATCH',
            'No unique match is available within your DHIS2 access. Check the identifier and your authorised search scope.')
        const source=ctx.allFacilities.find(c=>c.id===patient.owner)
        if(!source)throw new Problem(409,'OWNER_NOT_PARTICIPATING','The current programme owner is not an assigned programme centre. Ask your administrator to check the record.')
        if(source.id===target.id)throw new Problem(409,'ALREADY_AT_CENTRE','This patient already belongs to your centre for this programme.')
        if(!ctx.searchableCentres.has(source.id)&&!usedAll)searchDenied()
        let patientName=''
        try{
            const named=await this.d.call(ctx.auth,'tracker/trackedEntities',{
                program:this.c.program,page:1,pageSize:2,totalPages:true,
                fields:'trackedEntity,attributes[attribute,value]',
                ...(usedAll?{orgUnitMode:'ALL',filter}:{orgUnitMode:'SELECTED',orgUnits:source.id,filter}),
            })
            const te=named?.trackedEntities?.[0]
            if(te?.trackedEntity===patient.patient)
                patientName=nameOf(this.c,{attributes:te.attributes||[]})
        }catch{/* Name is optional; never fail the search when identity attributes are denied. */}
        const key=createHash('sha256').update(`${this.c.program}:${data.identifier}`).digest('hex')
        const token=randomBytes(32).toString('hex'),masked=maskIdentifier(data.identifier)
        this.s.transaction(()=>{
            this.s.db.prepare('DELETE FROM tickets WHERE expires < ?').run(Date.now())
            this.s.db.prepare(`INSERT INTO tickets(token,user,centre,patient,owner,masked,expires,identifierKey,identifier,configId)
                VALUES (?,?,?,?,?,?,?,?,?,?)`).run(token,ctx.user.id,target.id,patient.patient,source.id,masked,Date.now()+300000,key,data.identifier,this.c.configId||null)
            this.s.audit(ctx.user.id,'NID_SEARCH_MATCHED',null,{source:source.id,target:target.id})
        })
        return {ticket:token,patientName,masked,sourceName:source.name,destinationName:target.name,expiresInSeconds:300}
    }
    async create(ctx,data) {
        const target=this.destination(ctx)
        if(Object.keys(data).some(k=>!['ticket','reason'].includes(k)))
            throw new Problem(400,'AUTOMATIC_CENTRES','Reload the updated app and search by the configured patient identifier. Centres are identified automatically; manual centre or patient values are not accepted.')
        if(typeof data.reason!=='string'||!data.reason.trim()||data.reason.trim().length>1000||
            /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(data.reason))
            throw new Problem(400,'REASON_REQUIRED','Enter a transfer reason between 1 and 1,000 characters.')
        const ticket=this.s.db.prepare('SELECT * FROM tickets WHERE token=?').get(String(data.ticket||''))
        if(!ticket||ticket.user!==ctx.user.id||ticket.centre!==target.id||ticket.expires<Date.now()||
            !validIdentifier(ticket.identifier,this.c)||(this.c.configId&&ticket.configId!==this.c.configId))
            throw new Problem(409,'SEARCH_EXPIRED','Search again before submitting this request.')
        await this.ensureReady(ctx)
        this.s.rate(`create:${ctx.user.id}`,10)
        // Re-check with the same NID attribute filter as search. Never GET-by-UID then
        // collection-without-filter (DHIS2 2.42 → 409 "At least 1 attributes should be mentioned").
        const filter=`${this.c.identifier}:eq:${filterValue(ticket.identifier)}`
        const allowAll=await this.globalSearchAllowed(ctx)
        const attempts=[{orgUnitMode:'SELECTED',orgUnits:ticket.owner,filter},
            {orgUnitMode:'ACCESSIBLE',filter}]
        if(allowAll)attempts.push({orgUnitMode:'ALL',filter})
        let patient=null
        for(const attempt of attempts){
            try{
                const result=await this.d.call(ctx.auth,'tracker/trackedEntities',{
                    program:this.c.program,page:1,pageSize:2,totalPages:true,
                    fields:'trackedEntity,deleted,programOwners[program,orgUnit]',...attempt,
                })
                const matches=result?.trackedEntities
                if(Array.isArray(matches)&&matches.length===1&&uid(matches[0].trackedEntity)&&
                    Number(result.pager?.total||1)<=1&&Number(result.pager?.pageCount||1)<=1){
                    const owners=(matches[0].programOwners||[]).filter(x=>x.program===this.c.program&&uid(x.orgUnit))
                    if(owners.length===1)patient={patient:matches[0].trackedEntity,owner:owners[0].orgUnit}
                }
                if(patient)break
            }catch(e){
                if(e.code==='DHIS2_DENIED')continue
                if(e.code==='DHIS2_ERROR'&&/attributes should be mentioned|non-searchable attribute/i.test(e.message||''))continue
                throw e
            }
        }
        if(!patient||patient.patient!==ticket.patient||patient.owner!==ticket.owner)
            throw new Problem(409,'OWNER_CHANGED','The current centre changed after the search. Search again.')
        if(!ctx.allFacilities.some(c=>c.id===ticket.owner)||ticket.owner===target.id)
            throw new Problem(409,'OWNER_NOT_PARTICIPATING','The patient is no longer eligible for this transfer.')
        try {
            const row=this.s.transaction(()=>{
                if(this.c.configId&&this.s.db.prepare("SELECT value FROM app_settings WHERE key='active'").get()?.value!==String(this.c.configId))
                    throw new Problem(409,'CONFIG_CHANGED','Configuration changed. Reload and search again.')
                if(!this.s.db.prepare('DELETE FROM tickets WHERE token=? AND expires>=?').run(ticket.token,Date.now()).changes)
                    throw new Problem(409,'SEARCH_EXPIRED','This search result has already been used or expired. Search again.')
                const id=randomUUID(),time=new Date().toISOString()
                this.s.db.prepare(`INSERT INTO requests
                    (id,patient,program,source,target,requester,reason,masked,status,created,updated,identifierKey,configId)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,patient.patient,this.c.program,patient.owner,target.id,
                        ctx.user.id,data.reason.trim(),ticket.masked,'PENDING',time,time,ticket.identifierKey,this.c.configId||null)
                this.s.audit(ctx.user.id,'REQUESTED',id,{source:patient.owner,target:target.id})
                const created=this.s.get(id);this.s.notify(created,'REQUESTED');return created
            })
            return this.emit(ctx,row,'REQUESTED')
        }catch(e){
            if(String(e.message).includes('UNIQUE constraint'))throw new Problem(409,'DUPLICATE','An open transfer request already exists for this patient.')
            throw e
        }
    }
    async list(ctx,query) {
        const list=await super.list(ctx,query)
        return this.enrichList(ctx,list)
    }
    async enrichList(ctx,list) {
        for(const item of list.items) {
            const row=this.s.get(item.id)
            const sourceView=ctx.centres.has(row.source)
            if(!sourceView&&!item.canOpen)continue
            try{
                const record=uid(row.patient)
                    ? await this.d.record(row.patient,ctx.auth,true)
                    : await this.match(ctx,row,true) // Preserves pending requests from 0.3.
                if(sourceView&&row.status==='PENDING'&&record.owner!==row.source)continue
                if(!sourceView&&record.owner!==row.target)continue
                item.patientName=nameOf(this.c,record)
            }catch{/* Native permission failure leaves the masked identifier only. */}
        }
        return list
    }
}
