import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'
import { readConfig } from '../src/config.mjs'
import { Store } from '../src/store.mjs'
import { createApp } from '../src/server.mjs'
import { Dhis2 } from '../src/dhis2.mjs'
import { CaptureWorkflow } from '../src/capture-workflow.mjs'

export const ids = {
    program:'pMIglSEqPGS', identifier:'a1N4sJukutU', A:'CentreAAAAA', B:'CentreBBBBB', C:'CentreCCCCC',
    patient:'PatientAAAA', second:'PatientBBBB', root:'RootAAAAAAA',
    request:'RoleRequest', approve:'RoleRequest', audit:'RoleAuditor',
    userA:'UserAAAAAAA', userB:'UserBBBBBBB', userC:'UserCCCCCCC',
    program2:'ProgramBBBB',identifier2:'IdentifierB',name2:'PatientName',type:'EntityTypeA',type2:'EntityTypeB',
}
export async function listen(server) {
    server.listen(0,'127.0.0.1'); await once(server,'listening')
    return `http://127.0.0.1:${server.address().port}`
}
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
export async function fixture({legacy=false}={}) {
    const state = {
        owner:ids.A, access:legacy?'CLOSED':'OPEN', matches:1, mode:'ok', putCalls:[], calls:[],
        identityRoles:true, extraRoot:false, accessDenied:false, removedFacility:false, directoryAll:false, directoryWrite:false,
        groupOnly:false, groupName:'Tracker Ownership Transfers', membershipNames:true, wrongGroupMetadata:false,
        targetScopeMissing:false, superApprover:false,
        nativeSearch:!legacy, requesterSearch:true, hideNames:false, closeAfterTransfer:false,
        globalSearch:false, superRequester:false,
        owner2:ids.A,metadataRead:true,searchable:true,programType:'WITH_REGISTRATION',
    }
    const clinical = { trackedEntity:ids.patient, enrollments:[{
        enrollment:'EnrollAAAAA', program:ids.program, status:'ACTIVE', orgUnit:ids.A, enrolledAt:'2026-01-01',
        events:[{event:'EventAAAAAA',programStage:'anb2cjLx3WM',orgUnit:ids.A,status:'COMPLETED',
            occurredAt:'2026-01-01T10:00:00',dataValues:[{dataElement:'SystolicAAA',value:'128'}]}],
    }] }
    const original = JSON.stringify(clinical)
    const upstream = createServer(async (req,res) => {
        const u = new URL(req.url,'http://local')
        const program=u.searchParams.get('program')||ids.program
        const owner=program===ids.program2?state.owner2:state.owner
        const who = req.headers.cookie?.match(/SESSION=([a-z]+)/)?.[1]
        const directory = req.headers.authorization === 'ApiToken directory-test-only'
        const roles = {
            a:[ids.approve], b:[ids.request], c:[ids.request,ids.approve],
            reviewer:[ids.audit,ids.request,ids.approve], both:[ids.approve,ids.request], none:[],admin:state.removeSuperRole?[]:['RoleSuperAA'],
        }
        const users = {a:ids.userA,b:ids.userB,c:ids.userC,reviewer:'UserReviewA',both:'UserBothAAA',none:'UserNoneAAA',admin:'UserAdminAA'}
        const centres = {a:[ids.A],b:[ids.B],c:[ids.C],reviewer:[ids.A,ids.B],both:[ids.A,ids.B],none:[ids.B],admin:[ids.root]}
        const searchCentres = {a:state.targetScopeMissing?[ids.A]:[ids.A,ids.B],b:state.nativeSearch&&state.requesterSearch?[ids.A,ids.B]:[ids.B],c:[ids.C],
            reviewer:[ids.root],both:state.targetScopeMissing?[]:[ids.A,ids.B],none:[],admin:[ids.root]}
        const send = (status,data) => {res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data))}
        state.calls.push({method:req.method,path:u.pathname,params:Object.fromEntries(u.searchParams),who,directory})
        if (!directory && !users[who]) return send(401,{})
        if (u.pathname==='/api/me/authorization/ALL') return send(200,directory?state.directoryAll:
            ['admin','reviewer'].includes(who)||(who==='a'&&state.superApprover)||(who==='b'&&state.superRequester))
        if (u.pathname==='/api/me/authorization/F_TRACKED_ENTITY_INSTANCE_SEARCH_IN_ALL_ORGUNITS')
            return send(200,who==='b'&&state.globalSearch)
        if (u.pathname==='/api/me'&&directory)return send(200,{id:'DirectoryAA',userRoles:[],organisationUnits:[{id:ids.root}]})
        if(u.pathname==='/api/userRoles')return send(200,{userRoles:[...new Set([ids.request,ids.approve,ids.audit])].map(id=>({id,displayName:id}))})
        if(u.pathname==='/api/userGroups')return send(200,{userGroups:[{id:'qSSuhs65xMP',displayName:'Tracker Ownership Transfers'}]})
        if(u.pathname==='/api/programs')return send(200,{programs:[{id:ids.program,displayName:'Hypertension & Diabetes'},{id:ids.program2,displayName:'Synthetic second programme'}]})
        if(u.pathname.startsWith('/api/userRoles/')){
            const id=u.pathname.split('/').at(-1)
            if(id==='RoleSuperAA')return state.superRoleDenied?send(403,{}):send(200,{id:state.superRoleMismatch?'OtherRoleAA':id,name:'Superuser',authorities:state.superRoleNoAll?[]:['ALL']})
            return [ids.request,ids.approve,ids.audit].includes(id)?send(200,{id,displayName:id,name:id===ids.request?'Tracker Ownership Transfers':'Audit'}):send(404,{})
        }
        if(u.pathname==='/api/userGroups/qSSuhs65xMP')return send(200,{
            id:state.wrongGroupMetadata?'OtherGroupA':'qSSuhs65xMP',name:state.groupName,
        })
        if (u.pathname==='/api/me') return send(200,{id:users[who],displayName:`Test user ${who}`,
            ...(state.identityRoles ? {userRoles:(state.groupOnly?roles[who].filter(id=>id!==ids.request):roles[who])
                .map(id=>({id,...(state.membershipNames?{name:id==='RoleSuperAA'?'Superuser':id===ids.request?'Tracker Ownership Transfers':'Audit'}:{})}))} : {}),
            userGroups:state.groupOnly&&roles[who].includes(ids.request)
                ? [{id:'qSSuhs65xMP',...(state.membershipNames?{name:state.groupName}:{})}] : [],
            teiSearchOrganisationUnits:searchCentres[who].map(id=>({id})),
            organisationUnits:(state.extraRoot&&who==='b'?[ids.root]:centres[who]).map(id=>({id}))})
        if ([`/api/programs/${ids.program}`,`/api/programs/${ids.program2}`].includes(u.pathname)) return send(200,{
            id:u.pathname.split('/').at(-1),displayName:u.pathname.endsWith(ids.program2)?'Synthetic second programme':'Hypertension & Diabetes',programType:state.programType,
            trackedEntityType:{id:u.pathname.endsWith(ids.program2)?ids.type2:ids.type},accessLevel:state.access,organisationUnits:(state.removedFacility?[ids.A]:[ids.A,ids.B,ids.C]).map(id=>({id})),
            access:{data:{read:state.metadataRead,write:true}},
            programTrackedEntityAttributes:[{searchable:state.searchable,trackedEntityAttribute:{id:u.pathname.endsWith(ids.program2)?ids.identifier2:ids.identifier,displayName:u.pathname.endsWith(ids.program2)?'Patient Code':'National ID Number',valueType:'TEXT',unique:state.searchable,access:{read:true}}},
                {displayInList:true,trackedEntityAttribute:{id:u.pathname.endsWith(ids.program2)?ids.name2:'sB1IHYu2xQT',displayName:'Patient full name',valueType:'TEXT',access:{read:true}}}],
        })
        if(u.pathname.startsWith('/api/trackedEntityTypes/'))return send(200,{id:u.pathname.split('/').at(-1),access:{data:{read:state.metadataRead,write:true}},trackedEntityTypeAttributes:[]})
        if (u.pathname.startsWith('/api/organisationUnits/')) {
            const id = u.pathname.split('/').at(-1)
            return send(200,{id,displayName:`Test ${id}`,path:`/${ids.root}/${id}`})
        }
        if (u.pathname==='/api/tracker/trackedEntities') {
            if(directory)return send(403,{})
            const accessible=u.searchParams.get('orgUnitMode')==='ACCESSIBLE'
            const global=u.searchParams.get('orgUnitMode')==='ALL'
            const selected=u.searchParams.get('orgUnitMode')==='SELECTED'
            if(global&&!(who==='admin'||(who==='b'&&(state.globalSearch||state.superRequester))))return send(403,{})
            if(selected){
                const asked=(u.searchParams.get('orgUnits')||'').split(',').filter(Boolean)
                if(!asked.some(id=>centres[who].includes(id)||searchCentres[who].includes(id)))return send(403,{})
            }else if(!accessible&&!global&&(!centres[who].includes(u.searchParams.get('orgUnits'))||
                u.searchParams.get('orgUnitMode')!=='SELECTED'))return send(403,{})
            const permitted=centres[who].includes(owner)||who==='admin'||
                (state.nativeSearch&&state.access==='OPEN'&&searchCentres[who].some(id=>id===owner||id===ids.root))
            const count=(accessible||selected)&&!permitted?0:state.matches
            if(state.accessDenied)return send(403,{})
            if(state.hideNames&&u.searchParams.get('fields')?.includes('attributes'))return send(403,{})
            const ownerFields=u.searchParams.get('fields')?.includes('programOwners')
            const nameFields=u.searchParams.get('fields')?.includes('attributes')
            return send(200,{trackedEntities:Array.from({length:count},(_,i)=>({trackedEntity:i?ids.second:ids.patient,
                ...(ownerFields?{programOwners:[{program,orgUnit:owner}]}:{}),
                ...(nameFields?{attributes:[{attribute:program===ids.program2?ids.name2:'sB1IHYu2xQT',value:'SYNTHETIC PATIENT'}]}:{})
            }))})
        }
        if (u.pathname===`/api/tracker/trackedEntities/${ids.patient}`) {
            // Single-TE is allowed when the account has native OU scope, or when
            // the test grants global-search / superuser (production Superuser path).
            const globalReader=who==='b'&&(state.globalSearch||state.superRequester)
            if (!directory && (state.accessDenied || who!=='admin' && !globalReader && !centres[who].includes(owner)&&
                !(state.nativeSearch&&state.access==='OPEN'&&searchCentres[who].some(id=>id===owner||id===ids.root)))) return send(403,{})
            if(state.hideNames&&u.searchParams.get('fields')?.includes('attributes'))return send(403,{})
            if (u.searchParams.get('fields')?.includes('enrollments')) return send(200,{...clinical,enrollments:clinical.enrollments.map(e=>({...e,program}))})
            return send(200,{trackedEntity:ids.patient,programOwners:[{program,orgUnit:owner}],
                ...(u.searchParams.get('fields')?.includes('attributes') ? {attributes:[
                    {attribute:program===ids.program2?ids.name2:'sB1IHYu2xQT',value:'SYNTHETIC PATIENT'}, {attribute:'hXU9UgIMQes',value:'true'},
                ]} : {}),
            })
        }
        if (u.pathname==='/api/tracker/ownership/transfer') {
            state.putCalls.push({who,directory,params:Object.fromEntries(u.searchParams),method:req.method})
            if(![...centres[who],...searchCentres[who]].some(id=>id===ids.root||id===u.searchParams.get('orgUnit')))
                return send(403,{message:'Tracked entity not transferred. Org unit supplied is not in the user scope.'})
            if (directory || who!=='admin' && !centres[who].includes(owner)) return send(403,{})
            if (state.mode==='reject') return send(500,{})
            if (state.mode==='delay') await new Promise(r=>setTimeout(r,60))
            if (state.mode!=='unchanged'){if(program===ids.program2)state.owner2=u.searchParams.get('orgUnit');else state.owner=u.searchParams.get('orgUnit')}
            if(state.closeAfterTransfer)state.access='CLOSED'
            if (state.mode==='lost-ack') return req.socket.destroy()
            res.writeHead(204);return res.end()
        }
        if (u.pathname==='/api/dataElements') return send(200,{dataElements:[{id:'SystolicAAA',displayName:'Systolic blood pressure'}]})
        if (u.pathname==='/api/users') {
            const filter=u.searchParams.get('filter')||''
            const centre=filter.match(/organisationUnits\.id:eq:([A-Za-z][A-Za-z0-9]{10})/)?.[1]
            const list=Object.entries(centres).filter(([,ous])=>!centre||ous.includes(centre))
                .map(([who])=>({id:users[who]}))
            return send(200,{users:list})
        }
        if (u.pathname==='/api/messageConversations'&&req.method==='POST') {
            let raw=''; for await (const chunk of req) raw+=chunk
            try { JSON.parse(raw||'{}') } catch { return send(400,{}) }
            return send(201,{status:'OK',message:'Message conversation created'})
        }
        return send(404,{})
    })
    const base = await listen(upstream)
    const dir = mkdtempSync(join(tmpdir(),'patient-transfer-test-'))
    const config = readConfig({
        DHIS2_BASE_URL:base, PUBLIC_ORIGIN:'http://127.0.0.1:8095',
        TRANSFER_DATABASE:join(dir,'test.sqlite'),
    })
    const store = new Store(config.dbPath)
    const dhis=new Dhis2(config)
    // Legacy creation tests exercise shared permission, persistence and transfer
    // primitives; the deployed server uses PatientTransferWorkflow by default.
    const app = legacy?createApp(config,store,dhis,new CaptureWorkflow(config,store,dhis)):createApp(config,store,dhis)
    const appUrl = await listen(app)
    const call = async (who,path,data,extra={}) => {
        const r = await fetch(appUrl+path,{
            method:data===undefined?'GET':'POST',
            headers:{Cookie:`SESSION=${who}`,'X-Patient-Transfers':'1',Origin:config.origin,'Content-Type':'application/json',...extra},
            body:data===undefined?undefined:JSON.stringify(data),
        })
        return {status:r.status,body:await r.json(),headers:r.headers}
    }
    const search = (who='b',centre=ids.B) => call(who,'/search',{
        ...(legacy?{centre}:{}),identifier:'00000000000001'})
    const request = async(who='b',centre=ids.B) => {
        if(legacy)return call(who,'/requests',{source:ids.A,centre,identifier:'00000000000001',reason:'Synthetic patient moves centre'})
        const result=await search(who)
        if(result.status!==200)return result
        return call(who,'/requests',{ticket:result.body.ticket,reason:'Synthetic patient moves centre'})
    }
    return {state,clinical,original,config,store,call,search,request,appUrl,
        async stop(){
            await close(app);await close(upstream);store.close()
            const target=resolve(dir)
            if(dirname(target)!==resolve(tmpdir())||!basename(target).startsWith('patient-transfer-test-'))throw new Error('Unsafe test cleanup path')
            rmSync(target,{recursive:true,force:true})
        }}
}
