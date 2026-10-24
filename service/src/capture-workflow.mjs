import { createHash, randomUUID } from 'node:crypto'
import { Problem, requireUid, uid } from './config.mjs'
import { Workflow } from './workflow.mjs'

const ROLE='Tracker Ownership Transfers'
const deny=()=>{throw new Problem(403,'FORBIDDEN','Use an account with the configured staff membership, assigned to the relevant centre.')}
const reason=value=>{
    if(typeof value!=='string'||value.trim().length<5||value.trim().length>1000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))
        throw new Problem(400,'REASON_REQUIRED','Enter a reason between 5 and 1,000 characters.')
    return value.trim()
}
export class CaptureWorkflow extends Workflow {
    async context(auth) {
        const user=await this.d.identify(auth)
        // Prefer a Configuration-saved group/role UID. Legacy name match is only
        // for first-run before an administrator saves membership (create a user
        // group named Tracker Ownership Transfers, or select any existing group).
        const membership=this.c.membership
        const capture=membership&&membership.kind!=='legacy'
            ? (membership.kind==='group'?user.userGroups:user.userRoles).some(item=>item.id===membership.id)
            : [...user.userRoles,...user.userGroups].some(item=>uid(item.id)&&item.name===(membership?.name||ROLE))
        const audit=await this.d.call(auth,'me/authorization/ALL')===true
        if(!capture&&!audit)deny()
        const program=await this.d.call(auth,`programs/${this.c.program}`,{
            fields:'id,displayName,accessLevel,organisationUnits[id,displayName,path],trackedEntityType[id],programTrackedEntityAttributes[trackedEntityAttribute[id,displayName]]',
        })
        let attribute=program.programTrackedEntityAttributes?.find(a=>a.trackedEntityAttribute?.id===this.c.identifier)?.trackedEntityAttribute
        if(!attribute&&uid(program.trackedEntityType?.id)){
            const type=await this.d.call(auth,`trackedEntityTypes/${program.trackedEntityType.id}`,{fields:'trackedEntityTypeAttributes[trackedEntityAttribute[id,displayName]]'})
            attribute=type.trackedEntityTypeAttributes?.find(a=>a.trackedEntityAttribute?.id===this.c.identifier)?.trackedEntityAttribute
        }
        if(program.id!==this.c.program||!Array.isArray(program.organisationUnits)||!attribute)
            throw new Problem(503,'PROGRAM_CONFIGURATION','Check the programme identifier attribute and assigned centres in DHIS2.')
        const roots=new Set(user.organisationUnits.map(x=>x.id))
        // DHIS2 2.42 uses the union of capture and TEI search scope for
        // the destination of ownership transfers, including for superusers.
        const searchRoots=new Set([...user.organisationUnits,...(user.teiSearchOrganisationUnits||[])].map(x=>x.id))
        const allFacilities=[]
        for(const item of program.organisationUnits) {
            if(!uid(item.id))continue
            const ou=item.path?item:await this.d.call(auth,`organisationUnits/${item.id}`,{fields:'id,displayName,path'})
            if(ou.id!==item.id||typeof ou.path!=='string')throw new Problem(503,'CENTRE_CONFIGURATION','Could not verify programme centre scope.')
            allFacilities.push({id:item.id,name:ou.displayName||item.id,path:ou.path})
        }
        const facilities=allFacilities.filter(ou=>ou.path.split('/').some(id=>roots.has(id)))
        const searchableCentres=new Set(allFacilities.filter(ou=>ou.path.split('/').some(id=>searchRoots.has(id))).map(ou=>ou.id))
        return {user,auth,request:capture,approve:capture,audit,program,allFacilities,facilities,identifierLabel:attribute.displayName||this.c.identifierLabel||'Patient identifier',
            centres:new Set(facilities.map(x=>x.id)),searchableCentres}
    }
    async ensureReady(ctx) {
        if(ctx.program.organisationUnits.length<2)throw new Problem(503,'CENTRES_REQUIRED','Assign at least two centres to this programme in DHIS2.')
    }
    async session(ctx) {
        let ready=true,message=''
        try{await this.ensureReady(ctx)}catch(e){ready=false;message=e.message}
        return {user:{id:ctx.user.id,name:ctx.user.displayName},roles:{request:ctx.request,approve:ctx.approve,audit:ctx.audit},
            facilities:ctx.facilities.map(({id,name})=>({id,name})),sourceFacilities:ctx.allFacilities.map(({id,name})=>({id,name})),
            program:this.c.program,programLabel:ctx.program.displayName||this.c.programLabel||this.c.program,
            identifierLabel:ctx.identifierLabel,identifierValidation:this.c.identifierValidation,
            configurationRevision:this.c.configId,ready,message,roleName:this.c.membership?.name||ROLE,requestMode:'centre-request',
            accessNote:ctx.program.accessLevel==='OPEN'||ctx.program.accessLevel==='AUDITED'
                ? 'Existing DHIS2 cross-centre access remains governed by programme sharing and user scope. This app opens history only after verified transfer.' : ''}
    }
    publicRow(ctx,row) {
        const {identifier,identifierKey,...safe}=super.publicRow(ctx,row)
        return {...safe,awaitingReceipt:row.status==='TRANSFERRING'&&row.error==='AWAITING_RECEIPT',
            canConfirm:ctx.request&&ctx.centres.has(row.target)&&row.status==='TRANSFERRING'&&row.error==='AWAITING_RECEIPT',
            canReview:ctx.approve&&ctx.centres.has(row.source)&&ctx.user.id!==row.requester&&row.status==='PENDING'}
    }
    async search() {throw new Problem(410,'USE_REQUEST','Submit the National ID and current centre. The current centre verifies the match using its own access.')}
    async create(ctx,data) {
        const source=requireUid(data.source),target=requireUid(data.centre)
        if(!ctx.request||!ctx.centres.has(target))deny()
        if(source===target||!ctx.allFacilities.some(o=>o.id===source))
            throw new Problem(400,'CENTRE','Select a different current centre assigned to this programme.')
        if(typeof data.identifier!=='string'||!/^[0-9]{14}$/.test(data.identifier))
            throw new Problem(400,'IDENTIFIER','Enter the complete 14-digit National ID Number.')
        const why=reason(data.reason)
        await this.ensureReady(ctx)
        this.s.rate(`create:${ctx.user.id}`,10)
        const key=createHash('sha256').update(`${this.c.program}:${data.identifier}`).digest('hex')
        let row
        try{
            row=this.s.transaction(()=>{
                const id=randomUUID(),time=new Date().toISOString()
                this.s.db.prepare(`INSERT INTO requests
                    (id,patient,program,source,target,requester,reason,masked,status,created,updated,identifier,identifierKey)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,`unmatched:${key}`,this.c.program,source,target,ctx.user.id,
                        why,`**********${data.identifier.slice(-4)}`,'PENDING',time,time,data.identifier,key)
                this.s.audit(ctx.user.id,'REQUESTED',id,{source,target,match:'awaiting current-centre verification'})
                const created=this.s.get(id);this.s.notify(created,'REQUESTED');return created
            })
        }catch(e){
            if(String(e.message).includes('UNIQUE constraint'))throw new Problem(409,'DUPLICATE','An open request already exists for this identifier.')
            throw e
        }
        return this.emit(ctx,row,'REQUESTED')
    }
    async match(ctx,row,identity=false) {
        if(!ctx.approve||!ctx.centres.has(row.source)||ctx.user.id===row.requester)deny()
        if(!row.identifier) {
            const record=await this.d.record(row.patient,ctx.auth,identity)
            if(record.owner!==row.source)throw new Problem(409,'OWNER_CHANGED','The patient no longer belongs to the requested centre.')
            return record
        }
        this.s.rate(`match:${ctx.user.id}`,40)
        const result=await this.d.call(ctx.auth,'tracker/trackedEntities',{
            program:this.c.program,orgUnits:row.source,orgUnitMode:'SELECTED',
            filter:`${this.c.identifier}:eq:${row.identifier}`,page:1,pageSize:2,
            fields:'trackedEntity',
        })
        if(!Array.isArray(result.trackedEntities)||result.trackedEntities.length!==1||!uid(result.trackedEntities[0].trackedEntity))
            throw new Problem(409,'NO_UNIQUE_MATCH','No unique patient match at your centre. Check the identifier with the requesting centre, or reject the request.')
        const record=await this.d.record(result.trackedEntities[0].trackedEntity,ctx.auth,identity)
        if(record.owner!==row.source)throw new Problem(409,'OWNER_CHANGED','This centre is not the current programme owner.')
        return record
    }
    async review(ctx,id) {
        const row=this.row(ctx,id)
        if(row.status!=='PENDING')throw new Problem(409,'NOT_PENDING','Only pending requests can be matched.')
        const record=await this.match(ctx,row,true)
        this.s.audit(ctx.user.id,'MATCH_REVIEWED',id)
        return {matched:true,patientName:this.c.nameAttributes.map(id=>record.attributes.find(a=>a.attribute===id)?.value||'').filter(Boolean).join(' '),
            masked:row.masked,source:row.source}
    }
    async list(ctx,query) {
        const view=query.get('view')||'incoming'
        if(!['incoming','outgoing','history'].includes(view))throw new Problem(400,'VIEW','Unknown list.')
        const page=Math.max(1,Math.min(100000,Math.floor(Number(query.get('page'))||1))),ids=[...ctx.centres]
        if(!ids.length)return {items:[],page,hasMore:false}
        const marks=ids.map(()=>'?').join(','),clauses=[],values=[]
        if(view!=='outgoing'&&(ctx.approve||ctx.audit)){clauses.push(`source IN (${marks})`);values.push(...ids)}
        if(view!=='incoming'&&(ctx.request||ctx.audit)){clauses.push(`target IN (${marks})`);values.push(...ids)}
        if(!clauses.length)return {items:[],page,hasMore:false}
        const rows=this.s.db.prepare(`SELECT * FROM requests WHERE (${clauses.join(' OR ')})
            ${view==='history'?"AND status NOT IN ('PENDING','TRANSFERRING')":''} ORDER BY created DESC,id DESC LIMIT 26 OFFSET ?`)
            .all(...values,(page-1)*25)
        const names=new Map(ctx.allFacilities.map(o=>[o.id,o.name]))
        this.s.audit(ctx.user.id,'LIST_VIEWED',null,{view,page})
        return {items:rows.slice(0,25).map(row=>({...this.publicRow(ctx,row),
            sourceName:names.get(row.source)||row.source,targetName:names.get(row.target)||row.target,
            patientName:''})),page,hasMore:rows.length>25}
    }
    async decide(ctx,id,data) {
        let row=this.row(ctx,id)
        if(!ctx.approve||!ctx.centres.has(row.source)||ctx.user.id===row.requester)deny()
        if(row.status!=='PENDING')throw new Problem(409,'NOT_PENDING','Only pending requests can be decided.')
        if(!['approve','reject'].includes(data.action))throw new Problem(400,'DECISION','Select approve or reject.')
        const why=typeof data.reason==='string'?data.reason.trim():''
        if((data.reason!==undefined&&typeof data.reason!=='string')||why.length>1000||
            /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(why)||
            (data.action==='reject'&&!why))
            throw new Problem(400,'COMMENT_REQUIRED','A refusal comment is required. Comments must be at most 1,000 characters.')
        // A wrong identifier must still be rejectable; rejection never reads or writes a patient.
        if(data.action==='reject')return this.emit(ctx,this.s.transaction(()=>
            this.s.change(row,'REJECTED',ctx.user.id,{approver:ctx.user.id,decision:why})))
        await this.ensureReady(ctx)
        if(!ctx.searchableCentres.has(row.target)){
            const target=ctx.allFacilities.find(o=>o.id===row.target)?.name||row.target
            throw new Problem(403,'TARGET_OUTSIDE_SEARCH_SCOPE',
                `DHIS2 requires ${target} in the approving account's effective search scope (capture or tracked-entity search organisation units). Ask your administrator to review that scope. No transfer was sent; this request remains pending.`)
        }
        const patient=await this.match(ctx,row)
        row=this.s.transaction(()=>{
            if(this.s.get(id).status!=='PENDING')throw new Problem(409,'CHANGED','The request changed. Refresh before continuing.')
            try{this.s.db.prepare('UPDATE requests SET patient=? WHERE id=?').run(patient.patient,id)}
            catch(e){if(String(e.message).includes('UNIQUE constraint'))throw new Problem(409,'DUPLICATE','Another open request already matches this patient.');throw e}
            return this.s.change(this.s.get(id),'TRANSFERRING',ctx.user.id,{approver:ctx.user.id,decision:why})
        })
        this.queueInbox(ctx,row,'TRANSFERRING')
        let attempted=false
        try {
            const latest=await this.d.record(row.patient,ctx.auth)
            if(latest.owner!==row.source)throw new Problem(409,'OWNER_CHANGED','Ownership changed before transfer.')
            attempted=true
            await this.d.transfer(ctx.auth,row.patient,row.target)
        }catch(e){
            // Clear access refusal (403/404): ownership did not move — put the request back
            // to PENDING so staff can fix scope and approve again (no admin reconcile).
            // Do not do this for 5xx / network uncertainty (those stay NEEDS_REVIEW).
            if(attempted&&e.code==='DHIS2_DENIED'){
                let owner=null
                try{owner=(await this.d.record(row.patient,ctx.auth)).owner}catch{/* read may also be denied */}
                if(owner===row.source||owner===null){
                    const targetName=ctx.allFacilities.find(o=>o.id===row.target)?.name||row.target
                    this.s.transaction(()=>this.s.change(row,'PENDING',ctx.user.id,{
                        error:null,decision:why||row.decision,
                    }))
                    this.s.audit(ctx.user.id,'TRANSFER_REFUSED_BY_DHIS2',id,{
                        code:e.code,detail:String(e.message||'').slice(0,240),target:row.target,
                    })
                    throw new Problem(403,'TRANSFER_DENIED',
                        (e.message&&e.message!=='DHIS2 did not grant access.'?e.message+' ':'')+
                        `DHIS2 refused ownership transfer to ${targetName}. Your login session still has the old search scope (common after admin updates). Fully sign out of DHIS2, close the tab, sign back in as the approver, then approve again. The request is still pending.`)
                }
            }
            return this.emit(ctx,this.s.transaction(()=>this.s.change(row,attempted?'NEEDS_REVIEW':'FAILED',ctx.user.id,{error:e.code||'TRANSFER_UNCONFIRMED'})))
        }
        // CLOSED may remove the old centre's access immediately. Do not use a shared
        // account to work around that. The receiving centre verifies its own access.
        try {
            const current=await this.d.record(row.patient,ctx.auth)
            if(current.owner===row.target)return this.emit(ctx,this.s.transaction(()=>this.s.change(row,'COMPLETED',ctx.user.id)))
            // Source can still read the TEI but owner unchanged — uncertain; else let receiver confirm.
            return this.emit(ctx,this.s.transaction(()=>this.s.change(row,'NEEDS_REVIEW',ctx.user.id,{error:'OWNER_NOT_CONFIRMED'})))
        }catch {
            return this.emit(ctx,this.s.transaction(()=>this.s.change(row,'TRANSFERRING',ctx.user.id,{error:'AWAITING_RECEIPT'})))
        }
    }
    async confirm(ctx,id) {
        const row=this.row(ctx,id)
        if(!ctx.request||!ctx.centres.has(row.target))deny()
        if(row.status==='COMPLETED')return this.publicRow(ctx,row)
        if(row.status!=='TRANSFERRING'||row.error!=='AWAITING_RECEIPT')
            throw new Problem(409,'NOT_CONFIRMABLE','This request is not awaiting receiving-centre verification.')
        const record=await this.d.record(row.patient,ctx.auth)
        if(record.owner!==row.target)throw new Problem(409,'OWNER_MISMATCH','DHIS2 has not confirmed ownership at this centre.')
        return this.emit(ctx,this.s.transaction(()=>this.s.change(row,'COMPLETED',ctx.user.id)))
    }
    async reconcile(ctx,id,data) {
        const row=this.row(ctx,id)
        if(!ctx.audit)deny()
        if(row.status!=='NEEDS_REVIEW')throw new Problem(409,'NOT_REVIEWABLE','This request is not awaiting reconciliation.')
        const why=reason(data.reason),transferred=data.action==='confirmTransferred'
        if(!['confirmTransferred','confirmNotTransferred'].includes(data.action))throw new Problem(400,'DECISION','Choose a verified outcome.')
        const current=await this.d.record(row.patient,ctx.auth)
        if(current.owner!==(transferred?row.target:row.source)){
            const owner=ctx.allFacilities.find(o=>o.id===current.owner)?.name||current.owner
            const next=current.owner===row.source
                ? 'After checking the earlier call has stopped, select "Not transferred; still at the original centre" to close this attempt as failed. This does not transfer the patient.'
                : current.owner===row.target
                    ? 'Select "Transferred to the receiving centre" only after verifying the earlier operation has finished.'
                    : 'Ownership is at a different centre. Investigate before selecting an outcome.'
            throw new Problem(409,'OWNER_MISMATCH',`DHIS2 currently records ${owner} as the owning centre. ${next}`)
        }
        return this.emit(ctx,this.s.transaction(()=>{
            this.s.audit(ctx.user.id,'RECONCILIATION_VERIFIED',id,{owner:current.owner,reason:why})
            return this.s.change(row,transferred?'COMPLETED':'FAILED',ctx.user.id,{decision:why})
        }))
    }
}
