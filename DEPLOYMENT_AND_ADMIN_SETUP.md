# Deployment and administrator setup

Version **0.5.3**. App ID: `tracker-ownership-transfers`.

The App Management ZIP installs the **UI only**. Every server also needs the Node transfer service and a same-origin `/transfer-api/` proxy.

## Local (development)

1. DHIS2 on `http://127.0.0.1:8081` (private).
2. From this project: `powershell -ExecutionPolicy Bypass -File .\scripts\start-local.ps1`
3. Gateway on **8080**, transfer service on **8094**.
4. Sign in at `http://127.0.0.1:8080/` and open `/apps/tracker-ownership-transfers`.
5. Install `plugin/build/bundle/tracker-ownership-transfers-0.5.3.zip` (or the copy under `distribution/`) via App Management.

Health check:

```powershell
Invoke-RestMethod 'http://127.0.0.1:8080/transfer-api/health'
```

Expect `service: tracker-ownership-transfers`, `version: 0.5.3`.

## Staging / production

1. Copy `service/.env.example` → `service/.env`. Set private `DHIS2_BASE_URL`, public HTTPS `PUBLIC_ORIGIN`, `TRANSFER_PORT`, and a persistent `TRANSFER_DATABASE` path.
2. First-run programme/identifier UIDs in `.env` are **examples** — replace them, then set the real programme and staff group in **Configuration**.
3. Run **one** backend process: `node --env-file=.env src/server.mjs` from `service/`.
4. Proxy `/transfer-api/` to the service. See `deploy/nginx.conf.example`. Preserve cookies and CSRF headers. Do not expose Tomcat or the transfer port publicly.
5. Block public access to native Tracker ownership APIs so staff cannot bypass this app’s approval flow.
6. Staff: configured group/role, exactly one capture centre for requesters, reciprocal TEI search organisation units for request and approve.
7. Back up the SQLite database (and WAL/SHM if present). Restrict filesystem access; do not commit `.env` or the database.

## Administrator checklist

- [ ] App ZIP installed and shared with staff roles/groups
- [ ] Configuration saved (programme, identifier, staff membership)
- [ ] At least two centres on the programme
- [ ] `/transfer-api/health` OK on the public origin
- [ ] Synthetic request + approve between two staff accounts
- [ ] Messages (envelope) reach the owning centre on new requests

Full narrative: [COMPLETE_GUIDE.md](COMPLETE_GUIDE.md). Search scope notes: [PORTABILITY_AND_SEARCH.md](PORTABILITY_AND_SEARCH.md).
