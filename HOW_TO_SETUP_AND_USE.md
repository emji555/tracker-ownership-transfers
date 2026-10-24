# Tracker Ownership Transfers - Setup and User Guide

**Prefer [COMPLETE_GUIDE.md](COMPLETE_GUIDE.md) for current 0.5.3 steps.** This file retains older workflow notes.

**DHIS2 2.42 | any configured Tracker programme**

## 1. What changed

The app now has only two screens:

- **Request Transfer**: National ID search, current centre, automatically selected destination and your centre's outgoing requests.
- **Transfer Requests**: incoming requests, Approve and Refuse, and decision comments.

There are no centre dropdowns and no separate Verify patient step. Approval comments are optional; refusal comments are required. History and audit open within these screens.

**Update both the frontend and backend to 0.4.1.** The old frontend submits manual centre fields that the new backend rejects. Existing requests and audit records are preserved.

## 2. What you need

| Requirement | Purpose |
| --- | --- |
| DHIS2 2.42 | Programme, patients, centres and user permissions |
| Node.js 24.14.1 or later | Runs the transfer service |
| Transfer backend and persistent SQLite storage | Requests, approval state, audit and concurrency protection |
| Same-origin `/transfer-api/` proxy | Connects the installed app to the backend using the user's session |
| Two distinct staff accounts | Separate requester and approver |
| User group **Tracker Ownership Transfers** (or any group/role selected in Configuration) | Enables staff workflow within authorised centre scope |
| Programme/type permissions and appropriate search scope | Allows native patient lookup and transfer |

No directory account, directory token or separate transfer role is required. The app ZIP installs the frontend only; every local, staging or production server also needs the backend and proxy.

## 3. Start locally on Windows

Confirm DHIS2 opens at http://127.0.0.1:8080/. Then run in PowerShell:

```powershell
node --version
powershell -ExecutionPolicy Bypass -File .\scripts\start-local.ps1
```

The launcher creates `service/.env` from the example if missing, then starts the backend on **8094** and gateway on **8095**. It preserves already-running processes; it does not restart them after code changes.

Sign in through http://127.0.0.1:8095/ and open the latest built preview:

http://127.0.0.1:8095/_transfers/

Use **8095** for this local setup. Opening the app at **8080** bypasses the transfer proxy unless that origin is separately configured to provide it.

Check service version:

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:8095/transfer-api/health'
```

Expected service: `patient-transfers`; version: `0.4.1`. Health confirms connectivity, not staff permissions or successful live transfers.

## 4. Update the app grid

1. Sign in through http://127.0.0.1:8095/ with application-installation permission.
2. Open **App Management > Manually install an app**.
3. Upload `plugin/build/bundle/tracker-ownership-transfers-*.zip` (or the distribution copy from the release pack).
4. Complete the update and reload with **Ctrl+F5**.
5. Open **Tracker Ownership Transfers** from the app grid.

Installed local address (gateway layout): http://127.0.0.1:8080/apps/tracker-ownership-transfers

**Do not upload a full source/service bundle ZIP to App Management.** It will produce a missing-manifest error.

## 5. Prepare staff permissions

An administrator should review these settings in DHIS2's user, user-group and programme management:

1. Both staff accounts belong to the user group selected in Configuration (recommended name: **Tracker Ownership Transfers**). Prefer a group over inventing a new role; keep Capture authorities on existing roles.
2. Both centres are assigned to the Hypertension & Diabetes programme.
3. Both accounts have native programme and tracked-entity data access appropriate to their duties.
4. Centre B's account resolves to **exactly one programme centre** in data-capture scope: Centre B. The app cannot infer a destination from an account covering several programme centres; use a centre-specific account.
5. Centre B has authorised search access to find the patient at Centre A. The app uses B's own session and never searches with a shared privileged account.
6. Centre A's approver has source capture access and **Centre B within effective search scope**. DHIS2 2.42 uses capture plus tracked-entity search organisation-unit hierarchies for the destination check, including for superusers.
7. Requester and approver are different users.

### Destination outside approver search scope

If approve fails with a destination-scope error, the destination centre is usually missing from the approver’s **Search organisation units / tracked-entity search organisation units**. Keep capture at the owning centre; add only the destination to search scope if your access policy allows. Save, sign out/in, then reopen the pending request.

For search in the other direction, the requester needs search coverage of the current owning centre. Account membership alone does not grant that access.

**Access-policy consequence:** your local programme is OPEN. Expanding search scope can allow access to clinical information through other DHIS2 screens/APIs. This app gates its own history viewer, but cannot revoke native access. No account scope or programme access level is changed automatically. If your requirement is to hide clinical history everywhere in DHIS2 before approval, that needs a separately validated programme access and limited-lookup design. Simply switching to CLOSED may prevent this session-based NID lookup.

## 6. Centre B: request transfer

1. Open **Request Transfer** and check **Your centre** beside your name.
2. Enter the full 14-digit National ID and select **Search**.
3. Check the masked NID, authorised name if available, and **Patient's Current Centre**.
4. Enter a reason without clinical details.
5. Select **Request Transfer to My Centre**.
6. Follow the request in **My Centre's Requests** below the form.

The backend reads the current programme owner from DHIS2 and derives the destination from the authenticated account. It rejects client-supplied centre or patient values. Search results expire after five minutes and belong to the searching user. Existing open or uncertain requests block duplicates.

No unique match means no unique result was available within your access, not that the patient does not exist. Check the NID and native search permissions; do not create a duplicate patient to work around an access problem.

## 7. Centre A: approve or refuse

1. Sign in with the distinct current-centre account.
2. Open **Transfer Requests**.
3. Review patient, masked identifier, requesting centre, date and reason.
4. Select **Approve**, optionally add a comment, then **Confirm approval**; or select **Refuse**, add the required comment, then **Confirm refusal**.

Approval rechecks permissions and ownership, then calls the DHIS2 Tracker Ownership API as the approver. A destination-scope denial sends no transfer and keeps the request pending. Refusal leaves ownership unchanged. A person cannot approve their own request.

## 8. Centre B: follow the result

The request list refreshes approximately every 15 seconds while visible. Decisions and comments appear in the same list.

| Status | Meaning |
| --- | --- |
| Pending | Waiting for Centre A's decision |
| Verifying transfer | Native operation or receiving ownership verification is outstanding |
| Transferred | Ownership at Centre B has been verified |
| Refused | Centre A declined; read the comment; ownership unchanged |
| Cancelled | Requester cancelled the pending request |
| Failed | Attempt closed unsuccessfully; check the cause before another request |
| Needs review | Outcome unconfirmed; administrator investigation required |

If the old centre loses access after a successful transfer, the receiving screen automatically verifies ownership with B's session on refresh. **Check transfer**, when available, checks the same result without repeating the transfer call.

Only after **Transferred**, choose **Open permitted history**, then **Open patient in Capture / Patient Dashboard** to continue care. The original patient UID, visits and recorded clinical values are preserved. Native DHIS2 permissions determine the history returned.

Completed and refused requests remain in their respective lists. Audit is under **Request details > Audit trail**. The backend records notifications; this simple interface presents updates through rows/status messages, not a separate notifications screen. No email or SMS is sent.

## 9. Uncertain outcomes

A timeout or lost acknowledgement is not treated as success and does not trigger an automatic retry. The request remains blocked against duplicates until reviewed.

An authorised administrator must check current programme ownership and logs and ensure the earlier call has stopped. Then expand **Request details > Review uncertain outcome**, explicitly choose the verified result and enter a reason. The backend checks ownership again. This action records the outcome; it cannot force a transfer.

If the original centre still owns the record, selecting transferred is incorrect. Select **Not transferred; still at the original centre** only after verification. If ownership is at a third centre, investigate rather than guessing either outcome.

## 10. Troubleshooting

| Problem | Action |
| --- | --- |
| Missing manifest | Install the app ZIP, not the source/service ZIP |
| Service disconnected | Start backend/gateway and use port 8095 locally |
| Old buttons or manual centre fields | Install frontend 0.4.1, verify backend 0.4.1, then reload |
| Search disabled | Review configured group/role membership and exact single-centre assignment |
| Multiple centres message | Use an account with exactly one programme centre in capture scope |
| No unique result / DHIS2 denied | Check NID, duplicate identifiers, search scope and native data access |
| Destination outside search scope | Administrator reviews the approver's effective search scope; request stays pending |
| Duplicate request | Check existing pending/in-progress/uncertain request before trying again |
| No Approve action | Check source-centre access and separate requester/approver accounts |
| Needs review | Investigate and reconcile; do not repeat the ownership call blindly |

Logs: `patient-transfers/local-runtime/logs`. Share only error messages when troubleshooting, not cookies, tokens or patient records.

## 11. Updating the backend safely

1. Wait for active transfer calls to finish.
2. Stop only the process verified as this transfer service.
3. Preserve `service/data` and its SQLite database/transaction files. The upgrade adds a ticket column without deleting requests or audit records.
4. Run `scripts/start-local.ps1` again and check the health version.
5. Update the frontend ZIP as well, or use the built preview.

Do not stop all Node.js processes; the chatbot may also use Node.js.

## 12. Other machines, staging and production

Use the same source and app ZIP, but configure that server's backend, persistent storage and same-origin HTTPS proxy. The local addresses work only on the computer running these services.

Current local routing settings, not credentials:

```dotenv
DHIS2_BASE_URL=http://127.0.0.1:8080
PUBLIC_ORIGIN=http://127.0.0.1:8095
TRANSFER_PORT=8094
TRANSFER_PROGRAM_ID=pMIglSEqPGS
TRANSFER_IDENTIFIER_ATTRIBUTE=a1N4sJukutU
TRANSFER_DATABASE=./data/transfers.sqlite
```

Production must restrict direct upstream access and protect native ownership routes against bypassing approval. See [deployment and isolated tests](DEPLOYMENT_AND_ADMIN_SETUP.md) and `deploy/nginx.conf.example`.

## 13. Verification boundary

45 automated Node tests and eight simulated React integration scenarios passed. The layout was reviewed in Chrome with synthetic data. These checks do not replace authenticated testing on your DHIS2 instance. The generated synthetic fixture files and guarded live-test script are provided; live transfers between two configured synthetic accounts remain outstanding. No production patient records were modified during this implementation.

See [VERIFICATION.md](VERIFICATION.md) for build/package and local connectivity evidence.

For the 0.4.1 search correction, dashboard links and deployment on another port or server, see [Search and plugin portability](PORTABILITY_AND_SEARCH.md).
