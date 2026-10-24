# Search and plugin portability

## Why a search can fail across centres

A requesting account often has capture and search limited to its own centre (Centre A), while the tracked entity is owned by another centre (Centre B). Queries that use `orgUnitMode=ACCESSIBLE` only return results inside that search scope, even when the account has broader authorities elsewhere.

When DHIS2 confirms system-wide tracked-entity search authority (`ALL` / `F_TRACKED_ENTITY_INSTANCE_SEARCH_IN_ALL_ORGUNITS`), this app may use `orgUnitMode=ALL`. Other accounts continue to use `ACCESSIBLE`. No new permission is granted, and client-supplied authority claims are not accepted.

For an ordinary centre account, **capture scope** is where it can work and **search scope** is where it may find tracked entities. Configured staff-group membership enables the app workflow; it does not independently grant access to other centres. Do not add superuser access just to make a search succeed. A programme administrator must choose the permitted cross-centre search coverage.

The app still requires one unambiguous receiving capture centre. Identifier matching must return exactly one accessible tracked entity. Duplicate identifiers, an incorrect value, missing programme access, or a restricted account can still prevent a match. Search remains read-only and never opens clinical history in the transfer app.

**Approval is a separate check:** DHIS2 2.42 still requires the destination within the approver's effective capture/search scope. Global search authority does not remove that native ownership-transfer prerequisite.

Official reference: [DHIS2 Tracker organisation-unit modes](https://docs.dhis2.org/en/develop/using-the-api/dhis-core-version-242/tracker.html).

## Absolute plugin URLs in Capture layouts

If Capture was saved with absolute plugin URLs such as `http://127.0.0.1:8080/api/apps/.../plugin.html`, opening DHIS2 through another origin or port can break iframes. Prefer root-relative links:

```json
{"type":"plugin","source":"/api/apps/your-app/plugin.html"}
```

With DHIS2 at `/dhis`, use `/dhis/api/apps/.../plugin.html` instead. Do not remove SAMEORIGIN frame protection or enable wildcard CORS to work around this.

See [COMPLETE_GUIDE.md](COMPLETE_GUIDE.md) for current setup.
