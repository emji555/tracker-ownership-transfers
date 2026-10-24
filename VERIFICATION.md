# Generic app name: 0.5.2, 22 October 2026

The product is now Tracker Patient Transfers. Its package/app ID is `tracker-patient-transfers`, and the backend package is `tracker-patient-transfer-service`. Manifest title, translations, companion links, notification links, launcher output and package verification use the new name. Existing programme IDs, SQLite database paths, saved settings, permissions and workflow rules are unchanged.

57 backend/API tests and the administrator UI test passed after the rename. The production build passed with the existing vendor-bundle size warning. The new installable archive is `tracker-patient-transfers-0.5.2.zip`. No installed DHIS2 app was replaced automatically and no local backend restart was performed for the rename. Install and verify the new app before retiring the old app entry; retain the same database when deploying the renamed backend. Native DHIS2 acceptance limitations below still apply.

# Configuration access correction: 0.5.1, 22 October 2026

Read-only local metadata inspection found all four accounts have native ALL authority, including through Package User Role. The previous ALL-only check consequently exposed Configuration to those accounts.

The backend now requires an assigned role named Superuser, validates its UID/name/ALL authority against DHIS2 metadata, and also requires the user's native ALL authority. Unavailable, mismatched or unverified role metadata fails closed. All configuration routes use the same guard. A live read-only metadata check confirmed one Superuser-role account and three other accounts with ALL; the new guard accepts the actual Superuser account. Local backend health reports 0.5.1. No user roles, native permissions, saved configuration or patient data were modified. Existing workflow review permissions remain unchanged; this patch restricts Configuration specifically.

57 backend/API tests passed, including a new regression covering ALL from another role, role removal, inaccessible role metadata, missing role authority and mismatched UID. The administrator UI test also checks a staff user with native ALL cannot see Configuration. See the 0.5.0 evidence below for the wider workflow and migration checks.

# Verification: Patient Transfers 0.5.0

Verified 22 October 2026. No production records were modified or transferred.

## Implemented changes

- `plugin/src/Configuration.jsx`: ALL-only administrator screen with live Tracker programmes, eligible identifier and display attributes, bounded identifier validation, group/role selection, validation, save and revision status.
- `plugin/src/App.jsx`, `Plugin.jsx`, `style.css`: configuration navigation; dynamic labels; focus/15-second configuration refresh; historical programme labels and companion links. Staff retain two transfer screens. Historical approvals do not depend on active-programme readiness.
- `service/src/settings.mjs`: persistent immutable configuration revisions, initial HTN/DM defaults, server-side ALL checks, live metadata validation, optimistic concurrency and append-only configuration audit.
- `service/src/configured-workflow.mjs`: request-scoped programme/configuration routing, combined historical lists and notifications; stale searches/tickets cannot create requests against another configuration.
- `service/src/store.mjs`: additive schema migration, per-request and ticket revision columns, configuration tables and immutable request-programme bindings.
- `service/src/identifier.mjs`, `transfer-workflow.mjs`, `capture-workflow.mjs`, `workflow.mjs`, `server.mjs`: generic validation/masking, configurable membership and display attributes, administration endpoints and revision-aware request actions. Existing native transfer and notification mechanisms retained.
- `service/scripts/preflight.mjs`, `.env.example`: diagnostics read the saved active configuration; environment programme fields are initial seeds only.
- New configuration backend and UI tests; extended synthetic fixture; package verification; package versions and COMPLETE_GUIDE.md updated.

## Test results

- **56 backend/API tests passed, zero failures.** Includes the nine configuration tests: ALL-only routes; metadata/access and identifier validation; persistence across reopening; concurrent-save conflict; programme switching with old pending/completed/refused requests; original membership policy; stale tickets; identifier format; legacy schema migration; and changing configuration during an in-flight approval.
- **Eight existing React/HTTP integration scenarios passed**, using simulated DHIS2: approval, refusal, lost acknowledgement, group-only membership, missing destination scope, ambiguous centre, hidden identity and receipt verification.
- **One administrator React/HTTP integration scenario passed**: metadata loading, validation, save, live labels, persisted screen settings, staff exclusion, old-programme approval and new-identifier search.
- **DHIS2 App Platform production build passed.** The existing vendor bundle size warning remains (approximately 659 KB before gzip); it is not a build error.
- **ZIP validation passed:** root manifest, version, launch pages, icons/assets, archive integrity, no local database/credentials/test patients, no hardcoded HTN programme or identifier UID in frontend JavaScript, and no browser ownership-transfer call.
- The configuration form was visually reviewed in headless Edge using synthetic metadata and an isolated browser profile. This is a layout check, not an authenticated DHIS2 browser acceptance test.

## Local upgrade verification

Before the upgrade the local backend reported 0.4.5. There were zero TRANSFERRING requests. A SQLite online backup was created under `local-runtime/backups/` (excluded from release packages).

A copy-only migration rehearsal verified all existing request fields, notifications and the original audit chain remained unchanged. Then only the identified local transfer backend was restarted; the gateway and DHIS2 were left running. The existing origin is **http://127.0.0.1:8080**, with DHIS2 upstream **8081** and transfer service **8094**. Health now reports **0.5.0**.

Post-upgrade checks confirmed all **11 requests**, **1,655 prior audit entries**, **80 notifications** and **77 prior notification-read records** were preserved. Existing requests received their original configuration revision. SQLite integrity check returned `ok`. Subsequent normal list views and one notification-read action added audit/read records; migration did not remove them. No real request was approved, refused or reconciled by this work.

The local installed DHIS2 frontend still needs the new app ZIP uploaded through App Management. The local preview serves the new build. No native account scopes, role assignments, programme sharing, authentication architecture or proxy configuration were changed.

## Remaining acceptance work

Authenticated end-to-end testing against native DHIS2 with two synthetic centre accounts has **not** been performed in this task. Automated transfer tests use a simulated DHIS2 API. The user must validate native metadata, sharing and permissions in an isolated environment before production deployment. No promise of zero errors on every server is made.

After installing the new frontend, sign in as a DHIS2 ALL administrator and follow [COMPLETE_GUIDE.md](COMPLETE_GUIDE.md). Configuration validation does not prove every staff member's native permissions. Do not expand capture/search scope automatically. A saved configuration requires no subsequent rebuild or restart; infrastructure changes and this initial backend upgrade still require normal deployment.

## Reproduce

Run from the workspace root:

```powershell
node --test --test-isolation=none patient-transfers/service/test/*.test.mjs patient-transfers/plugin/test/api.test.mjs
node patient-transfers/plugin/test/ui.cjs
node patient-transfers/plugin/test/configuration-ui.cjs
python patient-transfers/scripts/verify-package.py
```

Build from `patient-transfers/plugin` with `npm run build` using the existing locked dependencies. Install `plugin/build/bundle/tracker-patient-transfers-0.5.0.zip`. Package SHA-256 is recorded in `plugin/build/package-verification.json`.

`patient-transfer-system-0.5.0.zip` contains source, service, docs, tests and the app ZIP; it is not itself installable through App Management. Runtime data, backups and environment secrets are excluded.
