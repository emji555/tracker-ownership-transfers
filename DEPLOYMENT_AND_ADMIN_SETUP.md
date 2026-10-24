# Deploying the simplified workflow

## Current workflow: 0.4.1

Version 0.4.1 provides two screens with native NID search and automatically determined centres. It recognises HTN Data Capture as either a group or role. The 0.4.0 frontend remains compatible; manual-centre requests from 0.3.x frontends are rejected. Existing stored requests and audit records are preserved.

The directory account, directory token, administrator setup screen, role-ID settings and centre allowlist have been removed from the active application. Existing legacy environment values are ignored. Old saved wizard settings are not loaded. The backend uses the authenticated user's user group or role named HTN Data Capture and native capture scope. Programme organisation units provide the centre list.

The service is still necessary for durable approval status, permission checks, concurrency protection and audit. Installing the frontend ZIP alone does not install a backend or configure the web server.

## Local Windows installation

1. Keep DHIS2 running at http://127.0.0.1:8080.
2. Use Node.js 24.14.1 or later. From this project run `powershell -ExecutionPolicy Bypass -File scripts/start-local.ps1`.
3. The launcher creates `service/.env` if missing, starts the transfer service on loopback 8094 and the gateway on 8095. It does not restart an already-running service after source changes.
4. Sign in at http://127.0.0.1:8095/ with an HTN Data Capture account.
5. Open http://127.0.0.1:8095/_transfers/ or install `plugin/build/bundle/tracker-patient-transfers-0.4.1.zip` in App Management and use the grid at the 8095 origin.
6. If updating, stop only the verified transfer-service process and rerun the launcher. Keep `service/data` and its database. The additive schema migration preserves requests/audit, adding a nullable identifier-key column to search tickets. New requests store a masked NID and deduplication hash, not the full NID. Legacy requests retain their existing matching fields.

## Staging or production

The same frontend and service source can be deployed on supported Windows/Linux hosts. Each server still needs its own routing, runtime and persistent storage configuration; the ZIP cannot provide these automatically.

1. Configure `service/.env` from `.env.example`: private `DHIS2_BASE_URL`, public HTTPS `PUBLIC_ORIGIN`, service port and persistent database path. Use a separate database per DHIS2 instance/programme.
2. Programme defaults are pMIglSEqPGS and National ID attribute a1N4sJukutU. Change those IDs only for a different programme. `TRANSFER_NAME_ATTRIBUTE_IDS` optionally supplies comma-separated name attributes.
3. Run exactly one backend process under a service manager, with automatic restart and persistent storage. Use the matching .env explicitly: `node --env-file=.env src/server.mjs` from `service`.
4. Proxy the public origin's `/transfer-api/` to that service. See `deploy/nginx.conf.example`. For a DHIS2 context path, proxy the matching context `/transfer-api/` path too. Preserve session cookies and CSRF headers. The service does not enable cross-origin access.
5. Route public ownership API calls through the blocking gateway and restrict direct upstream ports. Otherwise users with sufficient native permissions may bypass this app's approval process. Local 8080 remains reachable for development; this is not production network isolation.
6. Give each requesting account exactly one programme centre in capture scope and native search/read permission sufficient to find the current owner by NID. Accounts covering multiple programme centres cannot request until their destination is unambiguous. Ensure each approving account's effective search scope includes its permitted receiving centres. DHIS2 2.42 uses the union of capture and tracked-entity search scope; superuser status does not bypass this requirement. Review wider access implications for OPEN programmes. Assign existing HTN Data Capture users to their capture centres and native programme/type data access. At least two centres must be assigned to the programme. Test each actual staff account's ability to match and transfer within its scope. No token or shared service account is needed.
7. If CLOSED or another native access policy prevents B from reading the patient identity/ownership, the session-only search cannot bypass it. A limited cross-centre directory with independently approved permissions would be a separate architecture; this release does not introduce one. Review programme access/sharing separately. This release does not change OPEN to CLOSED or alter metadata. It restricts its own history viewer, but cannot revoke access already granted elsewhere by DHIS2.
8. Back up the SQLite database including its transaction state consistently. Restrict its filesystem access: it contains request reasons, patient UIDs, masked NIDs, identifier hashes, and full National IDs retained in legacy requests. Hashes are deduplication keys, not anonymisation. Do not include it or session cookies in source control or release archives. Review upstream API access-log protection because exact-match API query strings contain the identifier.

## Isolated live acceptance test

Automated mocks pass; live acceptance remains required. Never use production or real patient records for these steps.

1. Use a disposable local DHIS2 2.42 instance. `fixtures/uids.json` records the generated synthetic IDs; no fixtures have been imported automatically.
2. Review `fixtures/metadata.json` and `tracker.json`. If the test instance already has an HTN Data Capture group or role, use that membership and omit the generated role. Ensure the accounts still have their usual native Capture authorities and data access. Otherwise import the generated role and configure its required native Capture permissions. The fixture role starts with no authorities.
3. Import only the synthetic programme/type/centres/patients into that isolated instance. Assign two distinct test users to HTN Data Capture and the synthetic care group, one to Centre A and one to Centre B. Confirm ordinary Capture access works for their own centres. Keep exactly one synthetic capture centre per test user. Assign Centre B to test user A's tracked-entity search scope, and Centre A to test user B's search scope. The prepared synthetic programme is OPEN to exercise the current-session cross-centre NID lookup. This fixture tests the app's history gate, not clinical isolation across all DHIS2 screens. Do not change the real programme to match a fixture. No fixture metadata has been imported automatically.
4. Copy `fixtures/test-settings.env.example` to a private local env file. Its programme and identifier UIDs deliberately differ from the real programme. Supply the two test session cookies locally; never paste them in chat. Use a separate synthetic database and stop any service using it before the guarded script.
5. From `service`, run `node --env-file=<absolute-private-test-env-path> scripts/preflight.mjs` for a read-only account/metadata check.
6. Explicitly set `TRANSFER_RUN_LIVE_TEST=YES_SYNTHETIC_ONLY` in that private file, then run `node --env-file=<absolute-private-test-env-path> scripts/live-test.mjs`. It refuses the real programme, non-loopback hosts, missing test cookies or mismatched generated IDs. It now uses the same NID-search/ticket request path as the two-screen app.
7. The script rejects one synthetic transfer and approves the other, verifies ownership, and compares visits/enrolments before and after. Record results. It is deliberately not repeatable after the approval without resetting only the disposable fixtures.

Recorded fixture IDs: Centre A tPcRhd6mxg1, Centre B GatM4hC7IIV, programme z4uNYncdupm; approval patient uS0UTiFGZjV, rejection patient iydWMjyQW2v. These are prepared IDs, not confirmation that those objects exist on your running server.

DHIS2 2.42 ownership calls use `orgUnit`, as documented in the [official upgrade notes](https://dhis2.github.io/dhis2-releases/releases/2.42/).

Native scope reference: [DHIS2 2.42.6 ownership manager](https://github.com/dhis2/dhis2-core/blob/2.42.6/dhis-2/dhis-services/dhis-service-tracker/src/main/java/org/hisp/dhis/tracker/acl/DefaultTrackerOwnershipManager.java) and [effective search scope](https://github.com/dhis2/dhis2-core/blob/2.42.6/dhis-2/dhis-api/src/main/java/org/hisp/dhis/user/User.java).

For the 0.4.1 search correction, dashboard links and deployment on another port or server, see [Search and plugin portability](PORTABILITY_AND_SEARCH.md).
