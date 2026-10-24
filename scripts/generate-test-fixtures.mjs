import { randomInt } from 'node:crypto'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const dir=fileURLToPath(new URL('../fixtures/',import.meta.url))
mkdirSync(dir,{recursive:true})
if(existsSync(join(dir,'uids.json')))throw new Error('Fixtures already exist; retain these UIDs for reproducible tests.')
const letters='abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
const chars=letters+'0123456789'
const uid=()=>letters[randomInt(letters.length)]+Array.from({length:10},()=>chars[randomInt(chars.length)]).join('')
const ids=Object.fromEntries(['root','centreA','centreB','program','stage','entityType','nationalId','name',
    'systolic','requestRole','approveRole','auditRole','careGroup','directoryGroup',
    'approvePatient','rejectPatient','approveEnrollment','rejectEnrollment','approveVisit','rejectVisit'].map(k=>[k,uid()]))
const careSharing={publicAccess:'--------',externalAccess:false,userGroupAccesses:[{id:ids.careGroup,access:'r-rw----'},
    ]}
const metadataSharing={publicAccess:'r-------',externalAccess:false}
const attribute=(id,name,unique=false)=>({id,name,shortName:name,valueType:'TEXT',aggregationType:'NONE',unique,...metadataSharing})
const metadata={
    organisationUnits:[
        {id:ids.root,name:'SYNTHETIC Transfer Test Root',shortName:'Transfer test root',openingDate:'2020-01-01'},
        ...[['centreA','Centre A'],['centreB','Centre B']].map(([key,name])=>({
            id:ids[key],name:`SYNTHETIC ${name}`,shortName:name,parent:{id:ids.root},openingDate:'2020-01-01',
        })),
    ],
    userGroups:[{id:ids.careGroup,name:'SYNTHETIC Transfer Care Users'}],
    userRoles:[['requestRole','HTN Data Capture']].map(([key,name])=>({
        id:ids[key],name,authorities:[],...metadataSharing,
    })),
    trackedEntityTypes:[{id:ids.entityType,name:'SYNTHETIC Transfer Patient',...careSharing}],
    trackedEntityAttributes:[attribute(ids.nationalId,'SYNTHETIC National ID',true),attribute(ids.name,'SYNTHETIC Patient name')],
    dataElements:[{id:ids.systolic,name:'SYNTHETIC Systolic BP',shortName:'Test systolic BP',valueType:'NUMBER',
        domainType:'TRACKER',aggregationType:'NONE',...metadataSharing}],
    programs:[{id:ids.program,name:'SYNTHETIC Transfer Test Programme',shortName:'Transfer test',programType:'WITH_REGISTRATION',
        accessLevel:'OPEN',onlyEnrollOnce:true,trackedEntityType:{id:ids.entityType},organisationUnits:[{id:ids.centreA},{id:ids.centreB}],
        programTrackedEntityAttributes:[ids.nationalId,ids.name].map((id,i)=>({
            trackedEntityAttribute:{id},displayInList:true,mandatory:true,searchable:true,sortOrder:i+1,
        })),...careSharing}],
    programStages:[{id:ids.stage,name:'SYNTHETIC Visit',program:{id:ids.program},repeatable:true,minDaysFromStart:0,
        programStageDataElements:[{dataElement:{id:ids.systolic},compulsory:false,sortOrder:1}],...careSharing}],
}
const patients=[['approve','00000000000001','APPROVAL'],['reject','00000000000002','REJECTION']]
const tracker={trackedEntities:patients.map(([key,national,label])=>({
    trackedEntity:ids[`${key}Patient`],trackedEntityType:ids.entityType,orgUnit:ids.centreA,
    attributes:[{attribute:ids.nationalId,value:national},{attribute:ids.name,value:`SYNTHETIC TRANSFER ${label}`}],
    enrollments:[{enrollment:ids[`${key}Enrollment`],program:ids.program,orgUnit:ids.centreA,status:'ACTIVE',
        enrolledAt:'2026-01-01T00:00:00',occurredAt:'2026-01-01T00:00:00',
        events:[{event:ids[`${key}Visit`],program:ids.program,programStage:ids.stage,orgUnit:ids.centreA,
            status:'COMPLETED',occurredAt:'2026-01-02T10:00:00',dataValues:[{dataElement:ids.systolic,value:'128'}]}],
    }],
}))}
for(const [name,value]of Object.entries({'uids.json':ids,'metadata.json':metadata,'tracker.json':tracker}))
    writeFileSync(join(dir,name),JSON.stringify(value,null,2)+'\n')
writeFileSync(join(dir,'test-settings.env.example'),[
    'DHIS2_BASE_URL=http://127.0.0.1:8080','PUBLIC_ORIGIN=http://127.0.0.1:8095',
    `TRANSFER_PROGRAM_ID=${ids.program}`,`TRANSFER_IDENTIFIER_ATTRIBUTE=${ids.nationalId}`,`TRANSFER_NAME_ATTRIBUTE_IDS=${ids.name}`,
    'TRANSFER_DATABASE=./data/synthetic-transfers.sqlite',
    '# Session cookies are optional, only for the guarded live-test script. Never share them.',
    'TRANSFER_TEST_A_COOKIE=','TRANSFER_TEST_B_COOKIE=','TRANSFER_RUN_LIVE_TEST=false','',
].join('\n'))
console.log('Generated isolated-test fixture files and UIDs. Nothing was imported into DHIS2.')
