# Using Patient Transfers 0.4.1

## Before starting

Use your normal DHIS2 account with **HTN Data Capture** group or role membership and native programme permissions. A requesting account must have exactly one programme centre in its capture scope, so the destination is unambiguous. Search scope can cover additional centres without assigning them as capture centres. Use separate accounts for requester and approver.

Locally, sign in at http://127.0.0.1:8095/ and open http://127.0.0.1:8095/_transfers/. To use the app grid, first install the 0.4.1 app ZIP. Follow [the complete setup guide](HOW_TO_SETUP_AND_USE.md) for server and account configuration.

## Screen 1: Request Transfer (Centre B)

1. Open **Request Transfer**. Check **Your centre** beside your account name.
2. Enter the complete 14-digit National ID and select **Search**.
3. Review the masked identifier, authorised patient name when available, and **Patient's Current Centre**. The app reads programme ownership from DHIS2.
4. Enter the reason for transfer, without clinical details.
5. Select **Request Transfer to My Centre**. The server determines the destination; you do not choose either centre.
6. Follow **My Centre's Requests** below the form. Status and decision comments refresh automatically, approximately every 15 seconds while visible.

No unique match means there is no unique result within your current access; it does not prove the patient is unregistered. An expired search requires searching again. An existing pending or uncertain request blocks a duplicate.

## Screen 2: Transfer Requests (Centre A)

1. Open **Transfer Requests** and review the patient, masked identifier, requesting centre, date and reason.
2. Select **Approve** or **Refuse**.
3. For approval, optionally add a comment, then select **Confirm approval**.
4. For refusal, enter a comment (required), then select **Confirm refusal**. Ownership remains unchanged.

There is no separate Verify patient step. The backend rechecks ownership, permissions and destination scope before approval. You cannot approve your own request.

## After approval

Centre B sees **Transferred** only when ownership at B has been verified. If the source account loses access after a successful native transfer, the receiving screen automatically checks ownership using B's session on refresh. **Check transfer**, when shown, performs the same verification; it does not send another transfer.

Once transferred, select **Open permitted history**, then **Open patient in Capture / Patient Dashboard** to continue care. The same patient UID and original visits are retained. Native DHIS2 access still determines the history returned.

## If approval is blocked or uncertain

A destination-search-scope error leaves the request **Pending** and sends no ownership transfer. An administrator must review the approving account's search organisation units; being a superuser alone does not remove this requirement.

**Needs review** means completion is uncertain. Do not retry the transfer blindly. An authorised administrator can expand **Request details**, select **Review uncertain outcome**, check DHIS2 ownership and logs, and record the verified outcome after ensuring the earlier operation has stopped. The backend rechecks ownership. This action does not transfer the patient.

Audit is available under **Request details > Audit trail**. Completed and refused requests remain in the same two lists; no separate history screen is needed. Notifications are recorded on the backend; the UI communicates updates through refreshed rows and status messages, without email or SMS.

This app prevents its own history viewer from opening before verified transfer. Access elsewhere in DHIS2 remains governed by programme access level, sharing and user scope.

For the 0.4.1 search correction, dashboard links and deployment on another port or server, see [Search and plugin portability](PORTABILITY_AND_SEARCH.md).
