export function apiBase(baseUrl, location = window.location) {
    const here = location.href || location.origin
    const page = new URL(here)
    const base = new URL(baseUrl || '/', here)
    if (base.origin !== page.origin) throw new Error('Open this app through the DHIS2 transfer gateway on the same origin.')
    // DHIS2 app shells run under /apps/... or /api/apps/... — never derive the
    // transfer API from the page path (that produced /api/transfer-api → 404 HTML).
    // Use site-root /transfer-api unless baseUrl is a real context path (e.g. /dhis).
    let path = base.pathname.replace(/\/$/, '')
    if (
        !path ||
        path === '/' ||
        path === '/api' ||
        /\/apps(\/|$)/.test(path) ||
        /^\/api(\/|$)/.test(path) ||
        /\/transfer-api$/.test(path)
    ) {
        return '/transfer-api'
    }
    return `${path}/transfer-api`
}
export function client(base, transport = fetch) {
    return async (path, data, signal) => {
        const headers = { 'X-Patient-Transfers': '1' }
        const csrf = document.cookie.split(';').map(x => x.trim()).find(x => x.startsWith('XSRF-TOKEN='))
        if (csrf) headers['X-XSRF-TOKEN'] = decodeURIComponent(csrf.slice('XSRF-TOKEN='.length))
        if (data !== undefined) headers['Content-Type'] = 'application/json'
        let response
        try {
            response = await transport(`${base}${path}`, {
                method: data === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers,
                body: data === undefined ? undefined : JSON.stringify(data),
                signal: signal || AbortSignal.timeout(60000),
            })
        } catch (error) {
            if (error.name === 'AbortError') throw error
            throw new Error('Connection interrupted. Refresh the request status before trying again.')
        }
        let result
        try { result = await response.json() } catch {
            const here = typeof window !== 'undefined' ? window.location : null
            const port = here ? (here.port || (here.protocol === 'https:' ? '443' : '80')) : ''
            if (here && (here.hostname === 'localhost' || port === '8081' || port === '8095'))
                throw new Error('Open this app at http://127.0.0.1:8080/apps/tracker-ownership-transfers (not localhost or port 8081).')
            throw new Error('The transfer service is not connected. Use the DHIS2 gateway origin that provides /transfer-api/.')
        }
        if (!response.ok) throw new Error(result.error || 'The operation could not be completed.')
        return result
    }
}
