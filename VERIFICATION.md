# Verification

Version **0.5.3**. Product: **Tracker Ownership Transfers** (`tracker-ownership-transfers`).

## Automated checks (simulated DHIS2)

From the project root:

```powershell
node --test --test-isolation=none service/test/*.test.mjs
python scripts/verify-package.py
```

Recent local run: **55** service tests passed; package verify **PASS**.

These tests use a simulated DHIS2 API. They do **not** certify your live metadata, sharing or organisation-unit scopes.

## Build

```powershell
Set-Location plugin
npm ci
npm run build
```

Installable archive: `plugin/build/bundle/tracker-ownership-transfers-0.5.3.zip`  
(`manifest.webapp` at the ZIP root — required by App Management.)

## What still needs a human on your instance

- Install the app ZIP and share it with staff
- Create/select the staff user group and Save Configuration
- End-to-end request + approve with two synthetic centre accounts
- Confirm Messages (envelope) for the owning centre on a new request

See [COMPLETE_GUIDE.md](COMPLETE_GUIDE.md) for acceptance steps before production.
