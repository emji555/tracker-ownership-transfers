import { resolve } from 'node:path'

export class Problem extends Error {
    constructor(status, code, message) { super(message); this.status = status; this.code = code }
}
export const uid = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9]{10}$/.test(value)
export function requireUid(value) {
    if (!uid(value)) throw new Problem(400, 'INVALID_UID', 'Invalid identifier.')
    return value
}
export function readConfig(env = process.env) {
    const base = new URL(env.DHIS2_BASE_URL || 'http://127.0.0.1:8081')
    const origin = new URL(env.PUBLIC_ORIGIN || 'http://127.0.0.1:8080')
    for (const url of [base, origin]) {
        if (url.username || url.password || url.search || url.hash ||
            !(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)))) {
            throw new Error('URLs must use HTTPS, or HTTP on loopback, without credentials/query/hash.')
        }
    }
    if (origin.pathname !== '/') throw new Error('PUBLIC_ORIGIN must be an origin without a path.')
    const ids = name => {
        const list = (env[name] || '').split(',').map(x => x.trim()).filter(Boolean)
        if (!list.every(uid)) throw new Error(`Invalid UID in ${name}`)
        return [...new Set(list)]
    }
    const config = {
        base: base.href.replace(/\/$/, ''), origin: origin.origin,
        program: env.TRANSFER_PROGRAM_ID || 'pMIglSEqPGS',
        identifier: env.TRANSFER_IDENTIFIER_ATTRIBUTE || 'a1N4sJukutU',
        nameAttributes: env.TRANSFER_NAME_ATTRIBUTE_IDS ? ids('TRANSFER_NAME_ATTRIBUTE_IDS') : ['sB1IHYu2xQT', 'wS7QQnuWCtc', 'ENRjVGxVL6l'],
        dbPath: resolve(env.TRANSFER_DATABASE || './data/transfers.sqlite'),
        port: Number(env.TRANSFER_PORT || 8094),
    }
    if (![config.program, config.identifier].every(uid) || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
        throw new Error('Invalid programme, attribute or service port.')
    }
    return config
}
