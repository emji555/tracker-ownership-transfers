# Tracker Ownership Transfers

DHIS2 2.42 app and Node backend for Tracker programme-ownership transfers between centres.

Version **0.5.3** · App ID: `tracker-ownership-transfers`

Programme, searchable identifier, display attributes and staff membership are configured in the app. The frontend ZIP installs the UI only; you also need the Node service and a same-origin `/transfer-api/` proxy.

## Documentation

| Doc | Purpose |
| --- | --- |
| **[COMPLETE_GUIDE.md](COMPLETE_GUIDE.md)** | Full setup, use, troubleshooting, production |
| [DEPLOYMENT_AND_ADMIN_SETUP.md](DEPLOYMENT_AND_ADMIN_SETUP.md) | Local + production deployment |
| [SETUP_AND_TRAINING.md](SETUP_AND_TRAINING.md) | Short staff training outline |
| [HOW_TO_SETUP_AND_USE.md](HOW_TO_SETUP_AND_USE.md) | Short pointer + staff workflow |
| [PORTABILITY_AND_SEARCH.md](PORTABILITY_AND_SEARCH.md) | Search scope and Capture plugin URLs |
| [VERIFICATION.md](VERIFICATION.md) | Tests and acceptance boundary |

## Quick local start

1. Start DHIS2 (example: host port `8081`).
2. Copy `service/.env.example` → `service/.env` and adjust example UIDs for your instance.
3. Run `scripts/start-local.ps1` (gateway on `8080`, service on `8094`).
4. Install `plugin/build/bundle/tracker-ownership-transfers-0.5.3.zip` in App Management.
5. Open `http://127.0.0.1:8080/apps/tracker-ownership-transfers`.

## Configuration access

Configuration requires a DHIS2 role named **Superuser** with verified `ALL` on that role and for the signed-in user.
