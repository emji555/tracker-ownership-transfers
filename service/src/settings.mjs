import { Problem, uid } from './config.mjs'
import { validationRules, defaultValidation } from './identifier.mjs'

export class Settings {
    constructor(config,store,dhis){
        this.c=config;this.s=store;this.d=dhis
        store.transaction(()=>{
            const upstream=store.db.prepare("SELECT value FROM configuration WHERE key='upstream'").get()
            if(upstream&&upstream.value!==config.base)throw new Error('Database belongs to another DHIS2 instance.')
            store.db.prepare('INSERT OR IGNORE INTO configuration VALUES (?,?)').run('upstream',config.base)
            if(!this.active()){
                const original=store.db.prepare("SELECT value FROM configuration WHERE key='program'").get()?.value||config.program
                const settings={program:original,identifier:config.identifier,nameAttributes:config.nameAttributes,
                    identifierValidation:defaultValidation,membership:{kind:'legacy',name:'Tracker Ownership Transfers'},
                    programLabel:'Hypertension & Diabetes',identifierLabel:'National ID Number'}
                const id=Number(store.db.prepare('INSERT INTO config_revisions(program,settings,created,actor) VALUES (?,?,?,?)')
                    .run(original,JSON.stringify(settings),new Date().toISOString(),'migration').lastInsertRowid)
                store.db.prepare('INSERT INTO app_settings VALUES (?,?)').run('active',String(id))
                store.audit('migration','CONFIGURATION_INITIALISED',null,{revision:id,program:original})
            }
            const initial=store.db.prepare('SELECT id,program FROM config_revisions ORDER BY id LIMIT 1').get()
            if(store.db.prepare('SELECT 1 FROM requests WHERE configId IS NULL AND program<>?').get(initial.program))
                throw new Error('Unmapped historical programme; restore its configuration before migration.')
            store.db.prepare('UPDATE requests SET configId=? WHERE configId IS NULL').run(initial.id)
            // Pre-upgrade tickets are intentionally invalidated; patient requests are preserved.
            store.db.prepare('DELETE FROM tickets WHERE configId IS NULL').run()
        })
    }
    revision(id){const row=this.s.db.prepare('SELECT * FROM config_revisions WHERE id=?').get(Number(id));return row?{...JSON.parse(row.settings),revision:row.id,validated:!!row.validated,created:row.created}:null}
    active(){const id=this.s.db.prepare("SELECT value FROM app_settings WHERE key='active'").get()?.value;return id?this.revision(id):null}
    admin(ctx){if(ctx.canConfigure!==true)throw new Problem(403,'ADMIN_REQUIRED','The DHIS2 Superuser role with ALL authority is required to configure this application.')}
    async options(ctx,kind,page=1){
        this.admin(ctx)
        if(!['programs','userGroups','userRoles'].includes(kind))throw new Problem(400,'METADATA_KIND','Unknown metadata list.')
        const params={fields:'id,displayName,name',page:Math.max(1,Math.floor(Number(page)||1)),pageSize:100,totalPages:true,order:'displayName:asc'}
        if(kind==='programs')params.filter='programType:eq:WITH_REGISTRATION'
        const result=await this.d.call(ctx.auth,kind,params)
        return {items:result[kind]||[],hasMore:result.pager?.nextPage!=null||Number(result.pager?.pageCount)>params.page,page:params.page}
    }
    async metadata(ctx,id){
        this.admin(ctx)
        if(!uid(id))throw new Problem(400,'PROGRAM','Choose a Tracker programme.')
        const p=await this.d.call(ctx.auth,`programs/${id}`,{fields:'id,displayName,programType,accessLevel,access,trackedEntityType[id],organisationUnits[id],programTrackedEntityAttributes[searchable,displayInList,trackedEntityAttribute[id,displayName,valueType,unique,orgunitScope,access]]'})
        if(p.id!==id||p.programType!=='WITH_REGISTRATION'||!uid(p.trackedEntityType?.id))throw new Problem(400,'TRACKER_REQUIRED','Select a Tracker programme with registration.')
        const type=await this.d.call(ctx.auth,`trackedEntityTypes/${p.trackedEntityType.id}`,{fields:'id,displayName,access,trackedEntityTypeAttributes[searchable,displayInList,trackedEntityAttribute[id,displayName,valueType,unique,orgunitScope,access]]'})
        const attributes=new Map()
        for(const binding of [...(type.trackedEntityTypeAttributes||[]),...(p.programTrackedEntityAttributes||[])]){
            const a=binding.trackedEntityAttribute
            if(!uid(a?.id))continue
            const old=attributes.get(a.id)||{}
            attributes.set(a.id,{...old,...a,searchable:!!(old.searchable||binding.searchable||a.unique),displayInList:!!(old.displayInList||binding.displayInList)})
        }
        return {program:p,type,attributes:[...attributes.values()].map(a=>({...a,eligible:a.access?.read!==false&&
            ['TEXT','LONG_TEXT','NUMBER','INTEGER','INTEGER_POSITIVE','INTEGER_ZERO_OR_POSITIVE'].includes(a.valueType)&&a.searchable}))}
    }
    async validate(ctx,input){
        this.admin(ctx)
        if(!input||typeof input!=='object'||!uid(input.program)||!uid(input.identifier)||!Array.isArray(input.nameAttributes)||
            input.nameAttributes.length>8||!input.nameAttributes.every(uid))throw new Problem(400,'SETTINGS','Choose a programme, identifier and up to eight display-name attributes.')
        const rules=validationRules(input.identifierValidation)
        const membership=input.membership
        if(!membership||!['group','role'].includes(membership.kind)||!uid(membership.id))throw new Problem(400,'MEMBERSHIP','Choose an authorised user group or role.')
        const metadata=await this.metadata(ctx,input.program),{program:p,type,attributes}=metadata
        if(p.access?.data?.read!==true||p.access?.data?.write!==true||type.access?.data?.read!==true||type.access?.data?.write!==true)
            throw new Problem(403,'PROGRAM_ACCESS','The validating administrator needs programme and tracked-entity-type data read/write access.')
        if((p.organisationUnits||[]).length<2)throw new Problem(400,'CENTRES_REQUIRED','Assign at least two centres to this programme before saving.')
        const identifier=attributes.find(a=>a.id===input.identifier&&a.eligible)
        if(!identifier)throw new Problem(400,'IDENTIFIER_ATTRIBUTE','The identifier must be an eligible searchable programme/type attribute.')
        if(input.nameAttributes.some(id=>!attributes.some(a=>a.id===id&&a.access?.read!==false)))throw new Problem(400,'NAME_ATTRIBUTE','Display attributes must belong to this programme/type and be readable.')
        const collection=membership.kind==='group'?'userGroups':'userRoles'
        const member=await this.d.call(ctx.auth,`${collection}/${membership.id}`,{fields:'id,displayName,name,access'})
        if(member.id!==membership.id||member.access?.read===false)throw new Problem(400,'MEMBERSHIP','The selected group or role could not be verified.')
        const warnings=['Staff still need native programme/type permissions and authorised capture/search organisation units. Validation does not test every member account.',
            'No organisation-unit scope is expanded. After a DHIS2 permission change, staff should sign out and sign in again.']
        if(!identifier.unique||identifier.orgunitScope)warnings.push('Identifier uniqueness is not system-wide. Searches with more than one matching patient are refused.')
        if(['OPEN','AUDITED'].includes(p.accessLevel))warnings.push('Native cross-centre access outside this app follows programme sharing and search scope; this app only gates its own history viewer.')
        if(!input.nameAttributes.length)warnings.push('No display-name attributes selected; patients will be shown using a masked identifier.')
        return {valid:true,warnings,settings:{program:p.id,programLabel:p.displayName||p.id,identifier:identifier.id,
            identifierLabel:identifier.displayName||identifier.id,nameAttributes:[...new Set(input.nameAttributes)],
            nameAttributeLabels:Object.fromEntries(attributes.filter(a=>input.nameAttributes.includes(a.id)).map(a=>[a.id,a.displayName||a.id])),
            identifierValidation:rules,membership:{kind:membership.kind,id:member.id,name:member.displayName||member.name||member.id}}}
    }
    async save(ctx,input){
        this.admin(ctx)
        if(!Number.isInteger(input?.expectedRevision))throw new Problem(409,'CONFIG_CHANGED','Reload configuration before saving.')
        const result=await this.validate(ctx,input)
        const settings=this.s.transaction(()=>{
            if(this.active().revision!==input.expectedRevision)throw new Problem(409,'CONFIG_CHANGED','Another administrator changed configuration. Reload and review before saving.')
            const id=Number(this.s.db.prepare('INSERT INTO config_revisions(program,settings,created,actor,validated) VALUES (?,?,?,?,1)')
                .run(result.settings.program,JSON.stringify(result.settings),new Date().toISOString(),ctx.user.id).lastInsertRowid)
            this.s.db.prepare("UPDATE app_settings SET value=? WHERE key='active'").run(String(id))
            this.s.audit(ctx.user.id,'CONFIGURATION_SAVED',null,{previousRevision:input.expectedRevision,revision:id,settings:result.settings})
            return this.revision(id)
        })
        return {...result,settings}
    }
}
