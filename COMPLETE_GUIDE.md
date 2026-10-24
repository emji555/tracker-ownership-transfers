# Tracker Ownership Transfers — Complete guide

Version **0.5.3**. App ID: `tracker-ownership-transfers`.

This app moves Tracker programme ownership of a tracked entity between centres. Programme, identifier and staff membership are set in Configuration. When upgrading, install the new ZIP, keep the existing SQLite database, and keep the same `/transfer-api/` route.

Configuration (from 0.5.1) requires a DHIS2 role named **Superuser** with verified `ALL` on that role and for the signed-in user. `ALL` from another role alone is not enough. Transfer permissions and other DHIS2 roles are unchanged.

| Item | Value |
| --- | --- |
| DHIS2 | 2.42 |
| App ZIP | `plugin/build/bundle/tracker-ownership-transfers-0.5.3.zip` |
| Navbar alerts | Transfer events also create **DHIS2 Messages** (envelope icon in the top bar) |
| Backend | `service/` (0.5.0; required with this app) |
| Example first-run programme UID | `pMIglSEqPGS` (replace with your Tracker programme; configurable in the app) |
| Example first-run identifier attribute | `a1N4sJukutU` (replace with your searchable TE attribute; configurable in the app) |
| Staff membership | Create a user group (recommended name below), then select it by UID in Configuration |

# Version 0.5.0 — Upgrade and administrator configuration

The app supports one active Tracker programme. Staff keep the two transfer screens. DHIS2 administrators with native **ALL** authority also see **Configuration**. The backend enforces this authority on every configuration and configuration-metadata request; hiding the button is not the security control.

## Upgrade an existing installation

1. Use an isolated/test instance first. Finish in-flight transfers and stop only the transfer backend before replacing its code. Do not interrupt an ownership call.
2. Back up the existing SQLite database with SQLite's backup operation, or copy the database and its WAL/SHM companions together while the backend is stopped. Preserve the configured `TRANSFER_DATABASE` path and existing `.env` infrastructure settings. Never replace the database with an empty release file.
3. Replace `service/src/` and `service/scripts/` with the 0.5.0 release; keep the existing database, `.env`, proxy and authentication setup. Start one backend process with Node **24.14.1 or later**. This upgrade requires one restart; subsequent in-app configuration changes do not.
4. Check `/transfer-api/health` returns version **0.5.0**. The startup migration adds configuration revisions and binds existing requests to their original programme. Existing requests, decisions, notifications and audit entries are retained. Only pre-upgrade short-lived search tickets are discarded; search again if needed.
5. Upload **`tracker-ownership-transfers-0.5.3.zip`** through DHIS2 App Management. Older “patient transfers” app IDs are different; verify the new app before removing a previous install. Do not upload the source/service bundle.
6. Reload the app. Existing HTN/DM defaults work before the first configuration save. Do not save a new configuration until the new frontend is installed: older frontends cannot safely submit searches after a configuration change.

No Nginx, API-proxy, Capture OU, TEI Search OU, account-role or programme-sharing changes are performed by this upgrade. Other public origins still need their existing same-origin `/transfer-api/` route; a frontend ZIP does not deploy a server.

## Configure the programme, identifier and authorised staff

1. Sign in to DHIS2 with an administrator account that has **ALL**. Open **Tracker Ownership Transfers → Configuration**.
2. Choose **Active Tracker programme**. The list loads registered Tracker programmes from this DHIS2 instance. Selecting one loads its programme and tracked-entity-type attributes.
3. Choose **Searchable identifier**. Eligible fields are readable, searchable or unique text/numeric attributes. If a field is missing, review its metadata with the DHIS2 administrator; this app does not alter that metadata.
4. Select optional **Display-name attributes**. Their values are combined in the selected order, and shown only when DHIS2 permits identity access. Select no fields to display masked identifiers only. Do not select clinical attributes as names. Labels come from DHIS2 metadata.
5. Set minimum and maximum identifier length (1–128). An optional pattern constrains accepted characters. Examples: `^[0-9]{14}$` for a 14-digit National ID; `^PT-[A-Z0-9]+$` for a prefixed patient code. Only one character class, optional literal prefix/suffix and a simple repetition are supported. Groups, alternatives and arbitrary complex expressions are rejected to avoid unsafe regular expressions. Leave the pattern blank for length-only validation. No automatic case conversion or leading-zero removal occurs.
6. Select **User group** (preferred) or **User role**, then the one you created for this app. It is saved by UID, so a same-named unrelated group cannot grant access. Until you save a group/role UID, first-run installs use a temporary name match on **Tracker Ownership Transfers** only.
7. Select **Validate Configuration**. This checks programme/type identity, registration type, available identifier/name attributes, identifier rules, selected membership, at least two assigned centres, and the validating administrator's programme/type data read/write access. Read the warnings: validation cannot prove every staff account has the necessary native data permissions.
8. Select **Save**. The status reports a saved revision. Server-side validation runs again before saving. If another administrator saved first, reload the screen and review their configuration before trying again.

The saving administrator sees new labels immediately. Other open app sessions refresh configuration on focus or within 15 seconds. New searches and requests use the saved revision immediately; a search result from an earlier revision must be searched again. No rebuild or restart is required.

## Permissions and switching programmes

- Membership enables requesting/approving only within the authenticated user's relevant programme centres. The receiving centre is still inferred from exactly one authorised capture centre; there is no centre selector.
- Native DHIS2 data sharing and search/capture scope remain necessary. This screen never enlarges either scope. An administrator must review access-denied warnings individually; staff should sign out and sign in after approved DHIS2 permission changes.
- Changing the active programme affects **new requests**. Every existing request retains its original programme and immutable configuration revision, including identifier and membership policy. Lists show the original programme beside each request. Approvals, refusals, notifications, ownership verification and permitted history continue against that original programme.
- Changing a selected group/role does not replace the membership policy of existing requests. To revoke a person's access, remove the underlying membership/permissions in DHIS2; native identity and scope are checked again on requests. Keep required historical programme metadata and memberships available until old requests are resolved.
- A missing/restricted historical programme produces a list warning or a blocked action; the app never reassigns its requests to another programme. A newly active programme being unavailable does not prevent independently authorised actions on old requests.
- Capture's companion panel can link to the app for previously configured programmes. New requests still use the active programme. The existing Patient Dashboard is not rewritten.

DHIS2's native ownership and access rules still apply; see the [Tracker API documentation](https://docs.dhis2.org/en/develop/using-the-api/dhis-core-version-master/tracker.html) and [2.42 API upgrade notes](https://dhis2.github.io/dhis2-releases/releases/2.42/).

## Persistence, auditing and recovery

Settings live in the backend SQLite database (`config_revisions` and `app_settings`), not browser storage or the frontend bundle. Initial `.env` programme/attribute values seed the database once; later changes to those variables do not override saved settings. Routing, database location and port remain infrastructure environment settings.

Configuration saves append an immutable revision and a `CONFIGURATION_SAVED` entry containing actor, time, previous revision and normalised new settings in the existing hash-linked audit log. Revisions contain metadata and rules, not credentials or patient values. Protect the entire database and backups with service-account filesystem permissions; SQLite storage is not encrypted by this app. The database stays bound to its original DHIS2 upstream, preventing accidental reuse against another instance.

To return to previous settings, select those values and save a new revision. Do not edit or delete historical revisions. Downgrading the backend after configuration saves is unsupported; restore a consistent pre-upgrade database and code backup only as a planned rollback that accounts for any transfers performed since backup.

## Acceptance testing before production

Use synthetic patients and separate Centre A/B users in an isolated DHIS2 instance. Check search, hidden/authorised names, request, duplicate prevention, approval, refusal/comment, notifications, history and uncertain outcomes. Then leave a request pending, change programme, finish the old request, and verify the original programme owner and unchanged clinical history. Restart the service and verify saved configuration and history persist. Test ordinary staff cannot access configuration APIs. Automated local tests simulate DHIS2; they do not certify your production permissions or metadata.

---

# Part A — Architecture

Two parts. **Both** are required.

| Part | Folder | Purpose |
| --- | --- | --- |
| **Frontend (DHIS2 app)** | `plugin/` | React UI: Request Transfer + Transfer Requests |
| **Backend (Node service)** | `service/` | Search, tickets, approve/refuse, ownership transfer, SQLite audit |

- Uploading the ZIP in App Management installs **only the UI**.
- Without the Node service and same-origin `/transfer-api/`, search and approve fail.
- Staff use their own DHIS2 login. No shared “directory” account or token.

### Screens

1. **Request Transfer** — Identifier search, current centre, destination = your centre, outgoing list.
2. **Transfer Requests** — Incoming list, Approve / Refuse, comments, audit / history when allowed.

---

# Part B — App structure

### Technology

- DHIS2 **App Platform** (`@dhis2/cli-app-scripts`)
- React 18 + `@dhis2/app-runtime`
- Config: `plugin/d2.config.js`
- Package name: `tracker-ownership-transfers`

### Important source files

**Frontend**

| File | Role |
| --- | --- |
| `plugin/src/App.jsx` | Staff screens and configuration navigation |
| `plugin/src/Configuration.jsx` | Administrator metadata, validation and save screen |
| `plugin/src/Plugin.jsx` | Small Capture companion panel |
| `plugin/src/api.mjs` | Calls `/transfer-api/` on the same origin |

**Backend**

| File | Role |
| --- | --- |
| `service/src/server.mjs` | HTTP API |
| `service/src/settings.mjs` | Validated, audited SQLite configuration revisions |
| `service/src/configured-workflow.mjs` | Active programme and per-request revision routing |
| `service/src/identifier.mjs` | Configurable validation, masking and filter escaping |
| `service/src/transfer-workflow.mjs` | NID search + create request |
| `service/src/capture-workflow.mjs` | Approve / refuse / confirm |
| `service/src/dhis2.mjs` | DHIS2 Tracker client |
| `service/src/gateway.mjs` | **Local only** reverse proxy |
| `service/data/transfers.sqlite` | Requests + audit (not DHIS2 DB) |

### Build the ZIP (frontend)

```powershell
Set-Location plugin
npm install
npm run build
```

Installable file:

`plugin/build/bundle/tracker-ownership-transfers-*.zip`

**Do not** upload a full source/service bundle ZIP to App Management (missing app manifest).

---

# Part C — Local setup (current working layout)

### Ports

| Port | Role |
| --- | --- |
| **8080** | What you open in the browser (gateway = DHIS2 + transfers) |
| **8081** | Docker DHIS2 on the host (private) |
| **8094** | Transfer Node service (private) |

**Always use:** http://127.0.0.1:8080/

### 1. Start DHIS2 (Docker)

Example compose: `C:\dhis2-local\compose.yaml`  
Host port **8081** → container 8080.

### 2. Configure `service/.env`

```env
DHIS2_BASE_URL=http://127.0.0.1:8081
PUBLIC_ORIGIN=http://127.0.0.1:8080
TRANSFER_PORT=8094
TRANSFER_PROGRAM_ID=pMIglSEqPGS
TRANSFER_IDENTIFIER_ATTRIBUTE=a1N4sJukutU
TRANSFER_DATABASE=./data/transfers.sqlite
```

Why two URLs on the same PC: `PUBLIC_ORIGIN` = browser; `DHIS2_BASE_URL` = how Node talks to Tomcat privately. Staff never type 8094.

### 3. Start backend + gateway

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-local.ps1
```

### 4. Health check

```powershell
Invoke-RestMethod 'http://127.0.0.1:8080/transfer-api/health'
```

Expect a healthy JSON response with the service name `tracker-ownership-transfers` (or the configured product name) and version.

### 5. Install the app

1. Sign in at http://127.0.0.1:8080/
2. **App Management** → upload `tracker-ownership-transfers-*.zip`
3. Open **Tracker Ownership Transfers**  
   → http://127.0.0.1:8080/apps/tracker-ownership-transfers

Optional repair/helper scripts in the source tree are for lab troubleshooting only. They are not part of the generic configuration workflow; do not run broad scope/metadata repair scripts as an installation step.

---

# Part D — DHIS2 admin settings (required)

### Staff who may use transfers (create this once)

Do **not** rely on programme-specific names such as HTN Data Capture. Not every instance has that group.

**Preferred:** create a **user group** (Users → User group management):

| Field | Recommended value |
| --- | --- |
| Name | **Tracker Ownership Transfers** |
| Members | Centre staff who may request or approve transfers |

Why a **group**, not a new role: this app only checks membership. Capture / Tracker authorities stay on each user’s existing DHIS2 roles. A group is a clean allow-list without inventing duplicate authorities.

Then open **Tracker Ownership Transfers → Configuration**, choose **User group**, select that group, **Validate**, and **Save**. After save, access is by UID (rename-safe).

If your instance already has a suitable group or role (for example from an older HTN package), select that instead of creating a new one — any group/role works once saved in Configuration.

### Other required settings

1. Both centres assigned to the configured programme.
2. Requester account: **exactly one** programme centre in **capture** scope.
3. Selected identifier eligible for search under programme/type metadata. Prefer global uniqueness when appropriate; ambiguous matches are refused.
4. **Tracked entity search organisation units** (required for search and approve):
   - Requester must include the tracked entity’s **current** owning centre (example: Centre A requests a transfer from Centre B → requester search scope must include Centre B).
   - Approver must include the **destination** centre (example: Centre B approves a move to Centre A → approver search scope must include Centre A).
   - Review the minimum necessary scope for each account under your organisation's access policy. The configuration screen never changes these settings.
5. After changing search OUs → **sign out and sign in**.
6. Requester ≠ approver (different users).

---

# Part E — Staff how to use

### Receiving centre (e.g. Centre A) — request

1. Open **Request Transfer** — check **Your centre**.
2. Enter the labelled identifier → **Search** (initial default: 14-digit National ID; change in Configuration).
3. Check masked identifier, name (if authorised), **Current Centre**.
4. Enter reason (no clinical detail) → **Request Transfer to My Centre**.
5. Follow status under **My Centre’s Requests**.

### Owning centre (e.g. Centre B) — approve / refuse

1. Open **Transfer Requests**.
2. Review identifier, centre, reason.
3. **Approve** (optional comment) or **Refuse** (comment required).
4. You cannot approve your own request.

### After transfer

| Status | Meaning |
| --- | --- |
| Pending | Waiting for decision |
| Verifying transfer | Ownership check still in progress |
| Transferred | Ownership verified at receiving centre |
| Refused | Declined; ownership unchanged |
| Failed / Needs review | Investigate; do not blind-retry |

When **Transferred**, use **Open permitted history** then Capture/Dashboard as allowed by DHIS2.

---

# Part F — Problems we fixed (and troubleshooting)

| Symptom | Cause | Fix |
| --- | --- | --- |
| Switching 8080 / 8095 | DHIS2 alone has no `/transfer-api/` | Gateway on **8080**, DHIS2 on **8081** |
| 409 “attributes should be mentioned” on search | Bad Tracker query / load TE without filter | Backend Tracker URL + load by UID |
| Approve: destination outside search scope | Destination not in approver’s TEI search OUs | Add destination to search OUs; re-login |
| Unknown transfer operation | Wrong `/transfer-api` path | Backend route normalisation |
| “ZIP will fix it” | ZIP is UI only | Fix service + DHIS2 scope |

| Problem now | Action |
| --- | --- |
| Missing manifest | Upload the **app** ZIP from `plugin/build/bundle/` |
| Service disconnected | Start backend/gateway; use **8080** |
| Search disabled / multiple centres | Staff in configured group (or role) + exactly one capture centre |
| No unique match | Check identifier + requester search OUs |
| Destination outside search scope | Add destination to **approver** TEI search OUs; sign out/in |
| Duplicate request | Finish or cancel existing open request first |

Logs (local): `local-runtime/logs` — share errors only, never cookies or identifiers.

### Safe backend update (local)

1. Wait for active transfers to finish.
2. Stop only the transfer Node process.
3. Keep `service/data` (SQLite).
4. Restart `scripts/start-local.ps1`; check health version.
5. Reinstall app ZIP only if the UI changed.

---

# Part G — Production (clean steps)

### Idea

- **One** public HTTPS site for staff.
- nginx/IIS = public front (replaces local `gateway.mjs`).
- Node + Tomcat stay on localhost, not on the internet.

### Production `.env`

```env
DHIS2_BASE_URL=http://127.0.0.1:8080
PUBLIC_ORIGIN=https://your-dhis.example
TRANSFER_PORT=8094
TRANSFER_PROGRAM_ID=pMIglSEqPGS
TRANSFER_IDENTIFIER_ATTRIBUTE=a1N4sJukutU
TRANSFER_DATABASE=/var/lib/tracker-ownership-transfers/transfers.sqlite
```

Same machine is fine: public HTTPS for browsers, private `127.0.0.1` for Node → Tomcat.

### Steps

1. Copy `service/` to the server; install **Node.js 24+**.
2. Create `service/.env` (above).
3. Run **one** process as a Windows/Linux service:  
   `node --env-file=.env src/server.mjs`
4. Reverse proxy (`deploy/nginx.conf.example`):
   - `/transfer-api/` → `http://127.0.0.1:8094/`
   - Block public `/api/.../tracker/ownership` (and legacy ownership paths)
   - Do not expose Tomcat or 8094 publicly
5. Upload **`tracker-ownership-transfers-*.zip`** in App Management on HTTPS.
6. Use the admin **Configuration** screen to select and validate this instance's programme, identifier and membership. Review native scope requirements individually; retain one authorised capture centre per requester.
7. Staff sign out/in after approved permission changes; test a full transfer with synthetic records first.
8. Back up the SQLite file with normal backups.

### Production checklist

- [ ] `https://…/transfer-api/health` → healthy service name/version
- [ ] Public ownership API → 403
- [ ] Tomcat not reachable from the internet
- [ ] Request + approve works with two staff accounts
- [ ] SQLite path persistent and backed up

### nginx sketch

```nginx
location ~* ^/api/(?:[0-9]+/)?(?:tracker/ownership|trackerOwnership)(?:[/\.]|$) {
    return 403;
}
location /transfer-api/ {
    proxy_pass http://127.0.0.1:8094/;
    proxy_set_header Host $host;
    proxy_set_header Cookie $http_cookie;
    proxy_set_header Origin $http_origin;
    proxy_set_header X-Patient-Transfers $http_x_patient_transfers;
    proxy_set_header X-XSRF-TOKEN $http_x_xsrf_token;
}
```

Keep existing `/`, `/api/`, `/apps/` to DHIS2.

### Capture plugin links (production tip)

Prefer **root-relative** Capture layout plugin URLs, e.g. `/api/apps/cvd-patient-dashboard/plugin.html`, not `http://127.0.0.1:8080/...`. Local gateway can rewrite some of these; production should store portable links in metadata.

---

# Part H — File map

| Path | Use |
| --- | --- |
| `plugin/build/bundle/tracker-ownership-transfers-*.zip` | Install in App Management |
| `service/` + `.env` | Backend |
| `scripts/start-local.ps1` | Local start |
| `deploy/nginx.conf.example` | Production proxy |
| `COMPLETE_GUIDE.md` | This guide |

---

# Summary

Build and upload the app ZIP for the UI, run the Node service with `.env`, put `/transfer-api/` on the same public origin as DHIS2, then configure programme, identifier, staff membership and reciprocal search organisation units.
