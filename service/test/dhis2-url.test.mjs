import test from 'node:test'
import assert from 'node:assert/strict'
import { Dhis2 } from '../src/dhis2.mjs'

test('tracker filter keeps literal colons so DHIS2 can parse attribute criteria', async () => {
    let requested
    const dhis = new Dhis2({ base: 'http://127.0.0.1:8080' }, async (url) => {
        requested = String(url)
        return new Response(JSON.stringify({ ok: true }), {
            status: 200, headers: { 'content-type': 'application/json' },
        })
    })
    await dhis.call({}, 'tracker/trackedEntities', {
        program: 'pMIglSEqPGS',
        orgUnitMode: 'ACCESSIBLE',
        filter: 'a1N4sJukutU:EQ:00000000000001',
        fields: 'trackedEntity',
    })
    assert.match(requested, /filter=a1N4sJukutU:EQ:00000000000001/)
    assert.doesNotMatch(requested, /filter=a1N4sJukutU%3AEQ%3A/)
})
