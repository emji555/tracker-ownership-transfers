> **Configuration access update (0.5.1):** Configuration is restricted to an assigned DHIS2 role named **Superuser** (case-insensitive), with `ALL` verified on that role and for the authenticated user. `ALL` from Package User Role or another role alone is insufficient. The backend protects configuration reads, metadata, validation and saving. Existing transfer permissions and native DHIS2 role assignments are unchanged.

# How We Built the Tracker Patient Transfers App

**Meeting walkthrough for a Resolve to Save Lives colleague**  
**Implementation:** version 0.5.0, reviewed 22 October 2026  
**Audience:** programme staff, DHIS2 administrators and developers

This document explains the existing implementation. Code blocks marked **actual code** are excerpts from the linked source files. Blocks marked **simplified example** explain a concept and are not complete replacement implementations. Patient examples are synthetic.

## 1. Start the meeting with this explanation

> We built a DHIS2 app that manages the request and approval process for moving a patient between centres. The receiving centre searches by a configured identifier and requests the transfer. The current centre approves or refuses it. After approval, our backend calls the DHIS2 programme-ownership transfer API and verifies the outcome before showing the transfer as completed.
>
> DHIS2 remains the source of patient and clinical data. Our separate SQLite database stores the workflow: requests, comments, statuses, configuration and audit records. We preserve the original patient UID and historical visits.
>
> We first implemented the Hypertension and Diabetes workflow, then made its programme, identifier, display-name fields and authorised staff membership configurable. Administrators can change these settings inside the app without rebuilding it. Existing requests keep their original programme and configuration.

Suggested 20-minute agenda:

| Time | What to explain |
| --- | --- |
| 0–3 minutes | The problem and the two-centre workflow |
| 3–6 minutes | Frontend, backend, SQLite and DHIS2 responsibilities |
| 6–12 minutes | Search, request, approval and ownership verification |
| 12–15 minutes | Generic configuration and security |
| 15–20 minutes | Synthetic demonstration, tests and questions |

## 2. What exactly is the “plugin”?

There are three related pieces:

| Piece | Purpose | Main file |
| --- | --- | --- |
| Installed DHIS2 application | Full transfer interface launched from the app menu | [App.jsx](plugin/src/App.jsx) |
| Optional Capture companion plugin | Small panel linking users to the transfer app | [Plugin.jsx](plugin/src/Plugin.jsx) |
| Node backend | Enforces the workflow, stores state and calls DHIS2 | [server.mjs](service/src/server.mjs) |

The installable ZIP contains the frontend app and Capture entry point. The backend must run separately. Uploading the ZIP alone does not install Node, create a running service or configure the API proxy. Installing the app also does not automatically place its companion panel in a Capture layout.

The existing patient dashboard is separate. The transfer app opens permitted history and provides a Capture link; it does not replace the dashboard or calculate CVD risk.

## 3. Architecture and technologies

```text
Staff browser: DHIS2 session + React transfer app
                         |
                         | same-origin /transfer-api/
                         v
               Existing public gateway/proxy
                         |
                         v
                    Node backend
                    /          \
                   v            v
          SQLite workflow    DHIS2 Web API
          and configuration  patient/owner/history/metadata
```

| Technology | Why it is used |
| --- | --- |
| React 18 | Forms, request tables, decisions and administrator configuration |
| DHIS2 App Platform | Builds the DHIS2 app, shell, manifests and installable ZIP |
| `@dhis2/app-runtime` | Supplies DHIS2 app context, including the base URL |
| Node.js 24.14.1+ | Runs the backend and its built-in SQLite integration |
| SQLite | Persists requests, configuration revisions, notifications and audit records |
| DHIS2 Tracker API | Reads authorised records and transfers programme ownership |
| Node test runner, jsdom and esbuild | Test backend behaviour and React interactions with simulated DHIS2 |

The local browser address is `http://127.0.0.1:8080/`. The gateway routes normal DHIS2 traffic to port **8081** and transfer API traffic to the backend on **8094**. These are deployment settings, not patient-transfer business rules. Production uses its own public HTTPS origin and the corresponding proxy route.

## 4. How we implemented it, step by step

### Step 1 — Define the workflow before writing the screens

The requirements determine what the backend must protect:

1. Centre B identifies a patient and requests a move.
2. The current programme owner, Centre A, decides.
3. Refusal leaves ownership unchanged.
4. Approval initiates a native DHIS2 ownership transfer.
5. Only a verified result becomes completed.
6. Clinical history in this app stays closed until verified completion and an authorised history read.

Centre A is derived from **programme ownership**. Centre B is derived from the authenticated user's authorised capture scope. Neither centre is chosen from a browser dropdown.

### Step 2 — Register the app and Capture entry point

**Actual code — [plugin/d2.config.js](plugin/d2.config.js):**

```javascript
module.exports = {
    type: 'app',
    name: 'tracker-patient-transfers',
    title: 'Tracker Patient Transfers',
    description: 'Request and approve patient transfers between authorised centres.',
    pluginType: 'CAPTURE',
    entryPoints: { app: './src/App.jsx', plugin: './src/Plugin.jsx' },
}
```

`App.jsx` renders the full application. `Plugin.jsx` renders the smaller companion. The App Platform generates the manifest and packages their assets. The app retains its existing name so upgrades preserve established links.

### Step 3 — Build two staff screens and one administrator screen

**Request Transfer:** search, limited patient identity, detected current/destination centres, reason, outgoing requests and outcomes.

**Transfer Requests:** incoming requests, approval/refusal, comments, audit details and outcome-review actions when authorised.

**Configuration:** visible to administrators with native DHIS2 `ALL` authority. It selects the programme, identifier, name attributes, validation rules and authorised group/role.

The UI uses server-returned capabilities such as `canDecide` and `canOpen`. These control the buttons, but the backend repeats the permission checks when an action is submitted. Hiding a button alone would not prevent a direct API request.

### Step 4 — Reuse the staff member's DHIS2 session

The browser calls the backend through the same public origin. It sends the existing DHIS2 session cookie automatically. There is no shared administrator or directory token in the frontend.

**Actual excerpt — [plugin/src/api.mjs](plugin/src/api.mjs):**

```javascript
response = await transport(`${base}${path}`, {
    method: data === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    headers,
    body: data === undefined ? undefined : JSON.stringify(data),
    signal: signal || AbortSignal.timeout(60000),
})
```

The client sets `X-Patient-Transfers: 1` and forwards the DHIS2 CSRF token when present. The server checks the request origin and session, and asks DHIS2 for the user's identity, groups, roles and organisation units. It forwards that user's session for native API calls.

The custom header is an additional same-origin request control, not a password or an authority grant. A user's role or centre supplied in a browser payload is not trusted.

### Step 5 — Resolve the destination automatically

The backend intersects programme-assigned centres with the user's capture scope. Capture assignments can include ancestor organisation units, so it evaluates each centre's organisation-unit path.

**Actual excerpt — [transfer-workflow.mjs](service/src/transfer-workflow.mjs):**

```javascript
destination(ctx) {
    if(!ctx.request)throw new Problem(403,'FORBIDDEN',
        'The configured staff group or role is required to request a transfer.')
    if(ctx.facilities.length!==1)throw new Problem(409,'CENTRE_NOT_UNIQUE',
        ctx.facilities.length
            ? 'Your account covers more than one programme centre. Use a centre-specific account so the destination can be identified automatically.'
            : 'No programme centre is assigned within your capture scope. Ask your administrator to check your centre assignment.')
    return ctx.facilities[0]
}
```

An administrator assigned to a national root may cover several centres. The app deliberately refuses to guess which centre that person represents. Use a centre-specific staff account for the request demonstration. `ALL` permits configuration/review; it does not automatically replace the configured staff membership for normal requesting and approval.

### Step 6 — Search by the configured identifier

The backend validates length/pattern, rate-limits the search and uses an exact attribute filter. It requests patient UID and programme ownership first, without requesting enrollments or visits.

**Simplified example of the constructed DHIS2 query:**

```text
GET /api/tracker/trackedEntities
    ?program=<configured-programme-UID>
    &filter=<identifier-attribute-UID>:eq:<escaped-identifier>
    &orgUnitMode=ACCESSIBLE
    &pageSize=2
    &totalPages=true
    &fields=trackedEntity,deleted,programOwners[program,orgUnit]
```

The implementation tries supported query forms within the user's authorised scope. A global `ALL` search is attempted only when DHIS2 confirms the existing global-search authority or native `ALL` authority. The app never grants that authority itself.

It accepts one matching record with one valid owner for the configured programme. It checks that the owner is a participating centre and differs from the destination. Ambiguous results are not converted into a usable search ticket. This is uniqueness within the available search scope, not proof that no inaccessible duplicate exists elsewhere.

An additional identity read is attempted under the same native permissions. Only the configured name fields are assembled for display. If that read fails, the name stays blank. The response exposes a masked identifier and centre names, not clinical history.

### Step 7 — Issue a short-lived search ticket

The backend creates an unpredictable token and stores its relationship to the authenticated user, patient, source centre, destination centre and configuration revision. It is valid for five minutes and consumed when the request is created.

**Actual excerpt — [transfer-workflow.mjs](service/src/transfer-workflow.mjs):**

```javascript
const key=createHash('sha256')
    .update(`${this.c.program}:${data.identifier}`).digest('hex')
const token=randomBytes(32).toString('hex')
const masked=maskIdentifier(data.identifier)
```

The browser later submits **ticket + reason**, rather than choosing a patient UID or changing source/destination values. The backend rechecks identity and ownership before creating the request.

The ticket table temporarily contains the raw identifier to repeat the exact search. Expired tickets are invalid for use; expired rows are cleaned on subsequent searches. This is not encryption or guaranteed immediate physical erasure. Protect the database and backups accordingly. The identifier hash is a duplicate-detection aid, not anonymisation of a predictable National ID.

### Step 8 — Persist the request and prevent duplicates

Request creation consumes the ticket, inserts a `PENDING` row and appends audit/notification entries in one SQLite transaction. It rechecks the active revision inside that transaction, preventing a request from silently changing programmes during an administrator save.

**Actual database constraint — [store.mjs](service/src/store.mjs):**

```sql
CREATE UNIQUE INDEX IF NOT EXISTS one_open_transfer
ON requests(patient,program)
WHERE status IN ('PENDING','TRANSFERRING','NEEDS_REVIEW');
```

A second index protects open requests by identifier hash and programme. The database enforces duplicate protection even when two browser requests arrive together. The UI alone cannot provide that guarantee.

### Step 9 — Approve or refuse at the owning centre

Before approval, the backend checks:

- The user has the request's configured membership and source-centre scope.
- The user is not the requester, and the request is still pending.
- The source is still the patient's programme owner.
- The destination is within the approver's effective native search scope.

Refusal requires a comment and changes the request to `REJECTED`. It does not call the ownership API. Approval comments are optional.

Approval reserves the request by moving it from `PENDING` to `TRANSFERRING` in a transaction. A concurrent approval cannot reserve that same pending request again.

**Actual native transfer method — [dhis2.mjs](service/src/dhis2.mjs):**

```javascript
transfer(auth, patient, target) {
    // Only the authenticated approver's credentials can perform this PUT.
    return this.call(auth, 'tracker/ownership/transfer', {
        trackedEntity: patient,
        program: this.config.program,
        orgUnit: target,
    }, 'PUT')
}
```

This produces a `PUT /api/tracker/ownership/transfer` call for the original patient and programme. It does not create another patient, copy visits or rewrite historical event organisation units.

### Step 10 — Verify the outcome before reporting success

DHIS2 ownership and local SQLite status cannot be committed in one database transaction. The remote call can succeed while its response is lost. The application therefore models uncertainty explicitly.

| Situation | Recorded outcome |
| --- | --- |
| Approval precheck fails | Request remains pending; no transfer sent |
| Native transfer explicitly denied | May return to pending under the implemented denial checks |
| Native call acknowledged and target ownership verified | `COMPLETED` |
| Call acknowledged but source can no longer read the record | `TRANSFERRING`, awaiting receiving-centre verification |
| Remote outcome uncertain or owner does not match | `NEEDS_REVIEW` |
| Pre-transfer failure after reservation, before sending the PUT | `FAILED` |
| Source refuses | `REJECTED` |
| Requester cancels an eligible pending request | `CANCELLED` |

Receiving-centre confirmation reads current ownership using that centre's session. It does not send another transfer. Administrator reconciliation also records a verified outcome rather than blindly retrying the PUT.

On backend restart, interrupted transfers are marked for review, except the explicitly stored awaiting-receipt state, which remains available for receiving-centre verification. This avoids calling an uncertain transfer “completed”.

### Step 11 — Open history only after further permission checks

**Actual excerpt — [workflow.mjs](service/src/workflow.mjs):**

```javascript
if (row.status !== 'COMPLETED' || !ctx.request || !ctx.centres.has(row.target)) deny()
await this.ensureReady(ctx)
const now = await this.d.record(row.patient, ctx.auth)
if (now.owner !== row.target)
    throw new Problem(403, 'OWNER_CHANGED', 'This centre is no longer the programme owner.')
const result = await this.d.history(ctx.auth, row.patient)
```

The history response is limited to the request's programme. Data-element labels are fetched from metadata, and the app provides a Capture link. Losing native access or transferring the patient again can block a later history read even if an old request once completed.

This gate applies to history opened **through this app**. It cannot remove access that DHIS2 already grants through Capture or other applications, for example under an OPEN programme.

## 5. How we made configuration generic

The original HTN/DM settings are the initial defaults. The administrator screen then loads registered Tracker programmes, programme/type attributes, user groups and user roles from the connected DHIS2 instance.

| Setting | Example | Reason |
| --- | --- | --- |
| Programme | Hypertension & Diabetes | Select the programme whose ownership moves |
| Identifier attribute | National ID or Patient Code | Different programmes can identify patients differently |
| Identifier rules | 14 digits, or a prefixed code | Reject malformed input before searching |
| Name attributes | Full name, or selected name components | Avoid hardcoded HTN/DM name fields |
| Group/role UID | Selected staff group | Verify actual native membership rather than browser claims |

Complex regular expressions are intentionally restricted. Examples supported by the validator include `^[0-9]{14}$` and `^PT-[A-Z0-9]+$`. Bounds are 1–128 characters. The configuration screen never modifies Capture OUs or TEI Search OUs.

The server derives administrator status using `/api/me/authorization/ALL`. Every configuration endpoint checks it. Validation checks metadata, identifier eligibility, group/role existence, assigned centres and the validating administrator's programme/type data permissions; it cannot prove every staff member's effective access.

### Revision-based configuration protects old requests

```text
Revision 1: Programme A, identifier A, staff role A
Request X: program=A, configId=1, status=PENDING

Administrator saves revision 2: Programme B, identifier B, staff group B

New searches use revision 2.
Request X still uses Programme A and revision 1 for approval and history.
```

**Actual excerpt — [configured-workflow.mjs](service/src/configured-workflow.mjs):**

```javascript
const revision=this.settings.revision(row.configId)
if(!revision||revision.program!==row.program)
    throw new Problem(409,'CONFIG_UNAVAILABLE',
        'Request programme/configuration mismatch; administrator review required.')
const scope=await this.scoped(ctx,revision)
scope.workflow.row(scope.ctx,id)
```

A fresh workflow/adapter is created for that revision; there is no shared mutable programme variable that could change while an approval waits for DHIS2.

Saving a configuration appends a revision, updates the active pointer and audits the change in one transaction. `expectedRevision` rejects a stale administrator save if another administrator saved first. Database triggers prevent modifying configuration revisions or changing an established request's programme/revision.

The saving UI refreshes immediately; other open sessions check on focus or within 15 seconds. Old search tickets cannot create requests under a newly active revision. No rebuild or restart is required for saved configuration changes.

Existing requests also retain their original membership policy. To revoke someone's access, change their native DHIS2 membership/permissions; replacing the active app group alone does not rewrite old requests' policies.

## 6. What is stored where?

| Location/table | Stored information |
| --- | --- |
| DHIS2 | Patient UID, attributes, programme ownership, enrollments, clinical events, metadata and native permissions |
| SQLite `requests` | Patient reference, original programme/revision, source, target, requester, reason, status and decision |
| `tickets` | Temporary server-side search proof, including the identifier needed for rechecking |
| `config_revisions` / `app_settings` | Immutable configuration history and active revision pointer |
| `audit` | Actor, time, action, request reference, details and hash chain |
| `notifications` / `notification_reads` | Centre workflow alerts and user read state |
| `limits` | Request-rate counters |

The app does not maintain a second clinical-record database. However, its patient references, temporary identifiers and free-text reasons/comments are still sensitive. Staff are instructed not to put clinical details in transfer reasons. The backend does not encrypt SQLite automatically; operating-system access and backup controls remain necessary.

The audit log is append-only through database triggers and hash-linked for consistency checking. That provides useful tamper evidence; it is not a claim that a database administrator could never alter the file.

## 7. Notifications and refresh behaviour

The implementation stores notifications in SQLite with workflow state changes. Request lists and notifications refresh periodically in the open app. The backend also attempts native DHIS2 Messages, which appear under the envelope icon when delivery succeeds.

Native messaging is **best effort**: it uses the acting user's permissions to discover recipients and send the message. A messaging failure does not roll back an otherwise valid transfer. The durable request list remains the source of workflow status. There is no guarantee of delivery to every user, and no WebSocket push service is implemented.

## 8. API map to show a developer

These are application endpoints under `/transfer-api/`; the backend calls native `/api/` endpoints separately.

| Method and route | Purpose |
| --- | --- |
| `GET /session` | Identity, centre, capabilities and active configuration labels |
| `POST /search` | Validate identifier, search and return a ticket |
| `POST /requests` | Consume ticket and create pending request |
| `GET /requests?view=incoming` | Source-centre requests |
| `GET /requests?view=outgoing` | Receiving-centre requests |
| `POST /requests/{id}/decision` | Approve or refuse with comment |
| `POST /requests/{id}/confirm` | Verify receipt after an acknowledged transfer |
| `POST /requests/{id}/reconcile` | Administrator review of uncertain outcome |
| `GET /requests/{id}/medical-history` | Authorised history after completion |
| `GET /requests/{id}/audit` | Permitted audit history |
| `GET /notifications` | Unread scoped notifications |
| `GET /configuration` | Administrator reads current settings |
| `GET /configuration/metadata/programs` | Available Tracker programmes |
| `GET /configuration/programs/{uid}` | Programme/type attribute metadata |
| `POST /configuration/validate` | Validate a draft without activating it |
| `POST /configuration` | Validate again and save a new revision |

**Simplified example of browser-to-backend messages:**

```javascript
// Centre B searches using the revision displayed in its session.
await call('/search', {
    identifier: '00000000000001', // synthetic example only
    configurationRevision: 1,
})

// Search response supplies an opaque ticket; no manual centre selection.
await call('/requests', {
    ticket: '<ticket-from-search>',
    reason: 'Synthetic patient moved to our catchment area.',
})

// A different user at Centre A decides.
await call('/requests/<request-id>/decision', {
    action: 'approve',
    reason: 'Transfer agreed.',
})
```

## 9. How we built and tested the release

From the project root, build the frontend:

```powershell
Set-Location plugin
npm ci
npm run build
```

`npm ci` installs locked dependencies on a clean setup. The installable output is `plugin/build/bundle/tracker-ownership-transfers-*.zip`, with `manifest.webapp` at the archive root. Upload that ZIP to App Management. Do not upload a full source/backend bundle there.

Run automated checks from the project root:

```powershell
node --test --test-isolation=none service/test/*.test.mjs plugin/test/api.test.mjs
node plugin/test/ui.cjs
node plugin/test/configuration-ui.cjs
python scripts/verify-package.py
```

Recorded 0.5.0 results: **56 backend/API tests and 9 interface scenarios passed**, along with build and ZIP verification. Coverage includes duplicate/concurrent requests, permissions, refusal, lost acknowledgements, receiving-centre verification, configuration persistence, old pending requests after programme switching, administrator restrictions and migration preservation.

The tests simulate DHIS2 responses. They are not evidence that every production metadata or permission setup works. Authenticated native DHIS2 acceptance with synthetic centre accounts remains required. See [VERIFICATION.md](VERIFICATION.md) for the exact scope and limitations.

## 10. A demonstration you can follow in the meeting

Prepare an isolated test instance with synthetic data. Use one administrator account and separate centre-specific staff accounts for Centre A and Centre B. Keep the synthetic patient owned by Centre A initially. Use separate browser profiles for the two staff sessions.

1. **Administrator:** show Configuration, the selected programme/identifier and staff membership. Explain Validate versus Save.
2. **Centre B:** show its automatically detected centre. Search for the synthetic identifier. Point out the masked identifier, optional name and current centre.
3. **Centre B:** enter a non-clinical reason and submit. Show Pending in the outgoing list.
4. **Centre A:** refresh incoming requests. Show the requester centre, reason and decision options.
5. **Centre A:** approve. Explain that the backend verifies ownership; clicking Approve alone is not the completion condition.
6. **Centre B:** show the completed status, decision comment and permitted history. Check that the patient UID and historical visits are the original ones.
7. **Second synthetic request:** demonstrate refusal and the required comment. Show that ownership does not move.
8. **Optional developer demonstration:** leave a synthetic request pending, switch the active programme, then show that the old request retains its original programme and remains independently authorised.

If an account is denied access, show the actual warning and explain the native permission check. Do not grant broad search scope during the meeting just to make the demonstration pass. Have the test metadata and approved account scopes prepared beforehand.

After a local PC restart, open Docker Desktop, wait for DHIS2, then run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-local.ps1
```

Open `http://127.0.0.1:8080/`. This starts the transfer backend and gateway if needed; it is not a Windows automatic-start registration. Detailed deployment and administrator instructions are in [COMPLETE_GUIDE.md](COMPLETE_GUIDE.md).

## 11. Questions your colleague may ask

| Question | Answer |
| --- | --- |
| Why use a backend? | It enforces decisions, owns durable workflow state, checks permissions and coordinates the native transfer. Frontend controls can be bypassed. |
| Why SQLite when DHIS2 already has a database? | SQLite stores app-specific approvals/configuration/audit. DHIS2 continues to own clinical records. We do not edit DHIS2 database tables directly. |
| Can this work for another programme? | Yes, after selecting valid metadata and membership in Configuration. Native sharing and scope still need to support the workflow. |
| Can several programmes be active together? | One active programme is supported now. Historical requests can span programmes through their saved revisions; simultaneous active-programme selection would require further work. |
| Does changing programme affect pending requests? | No reassignment occurs. Each request retains its programme and immutable revision. Native permissions are still checked when acting on it. |
| Does a failed message mean a failed transfer? | No. Native messages are best effort. Check the request's verified status. |
| Why is search scope needed? | All native reads and transfers use the staff member's DHIS2 session. App membership cannot bypass native organisation-unit access. |
| Can staff bypass approval using another native app/API? | This workflow governs its own path. Enforcing organisation-wide use also depends on the deployment's existing proxy restrictions, upstream isolation and native permissions. The app alone is not a universal restriction on DHIS2. |
| What happens on network failure? | The request remains unconfirmed or awaits receipt verification; the app does not automatically repeat an uncertain ownership call. |
| Does this use AI or machine learning? | No. Patient Transfers is a deterministic workflow. The separate knowledge chatbot is a different application. |
| Is it production-certified? | No such claim is made. Automated checks passed; native synthetic acceptance and normal operational review remain necessary. |

## 12. Source files to open during a technical discussion

Read these in order rather than presenting every file:

1. [d2.config.js](plugin/d2.config.js) — how the app/plugin is registered.
2. [App.jsx](plugin/src/App.jsx) and [Configuration.jsx](plugin/src/Configuration.jsx) — screens and user interactions.
3. [server.mjs](service/src/server.mjs) — session checks and application endpoints.
4. [transfer-workflow.mjs](service/src/transfer-workflow.mjs) — automatic centres, exact search, tickets and request creation.
5. [capture-workflow.mjs](service/src/capture-workflow.mjs) — decisions, ownership checks and uncertain outcomes.
6. [dhis2.mjs](service/src/dhis2.mjs) — the native ownership call and authorised reads.
7. [settings.mjs](service/src/settings.mjs) and [configured-workflow.mjs](service/src/configured-workflow.mjs) — saved configuration and per-request revisions.
8. [store.mjs](service/src/store.mjs) — persistence, constraints, audit and restart recovery.
9. [configuration.test.mjs](service/test/configuration.test.mjs) — evidence that programme changes preserve existing requests.

For the meeting, keep the explanation centred on three responsibilities: **DHIS2 owns the patient data; the backend enforces the approval workflow; the React app makes that workflow usable.**
