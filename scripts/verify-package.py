"""Offline package and synthetic-fixture checks. Does not contact DHIS2."""
import hashlib
import json
import re
import zipfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
version = json.loads((root/"plugin/package.json").read_text())["version"]
bundle = root / f"plugin/build/bundle/tracker-ownership-transfers-{version}.zip"
with zipfile.ZipFile(bundle) as z:
    assert z.testzip() is None
    names = z.namelist()
    assert len(names) == len(set(n.lower() for n in names)), "Case-insensitive duplicate archive paths"
    assert not any(".." in Path(n).parts or n.startswith(("/", "\\")) for n in names)
    assert not any(n.endswith((".env", ".sqlite", ".service.lock")) for n in names)
    manifest = json.loads(z.read("manifest.webapp"))
    assert manifest["version"] == version
    assert manifest["name"] == "Tracker Ownership Transfers"
    for field in ["launch_path", "plugin_launch_path"]:
        assert manifest[field] in names
    assert z.read(manifest["icons"]["48"]).startswith(b"\x89PNG")
    for n in names:
        if n.endswith(".html"):
            for ref in re.findall(r'(?:src|href)="(\./[^"#?]+)', z.read(n).decode()):
                assert ref[2:] in names, (n, ref)
    js = "\n".join(z.read(n).decode() for n in names if n.endswith(".js"))
    assert "/transfer-api" in js
    assert "directory-test-only" not in js
    assert "TRANSFER_DIRECTORY_TOKEN" not in js
    assert "00000000000001" not in js
    assert "/tracker/ownership/transfer" not in js, "Ownership must be server-only"
    assert "Validate Configuration" in js
    assert "/configuration/validate" in js
    assert "pMIglSEqPGS" not in js and "a1N4sJukutU" not in js, "Programme metadata must come from the backend"

ids = json.loads((root/"fixtures/uids.json").read_text())
assert all(re.fullmatch(r"[A-Za-z][A-Za-z0-9]{10}", v) for v in ids.values())
assert len(ids) == len(set(ids.values()))
assert ids["program"] != "pMIglSEqPGS"
metadata = json.loads((root/"fixtures/metadata.json").read_text())
tracker = json.loads((root/"fixtures/tracker.json").read_text())
assert metadata["programs"][0]["accessLevel"] == "OPEN"
assert all(te["orgUnit"] == ids["centreA"] for te in tracker["trackedEntities"])
assert len(tracker["trackedEntities"]) == 2
for te in tracker["trackedEntities"]:
    assert any(a["value"].startswith("SYNTHETIC TRANSFER ") for a in te["attributes"])
    assert te["enrollments"][0]["events"][0]["orgUnit"] == ids["centreA"]

report = {
    "archive": str(bundle.relative_to(root)), "sha256": hashlib.sha256(bundle.read_bytes()).hexdigest(),
    "entries": len(names), "packageChecks": "PASS", "syntheticFixtureStructure": "PASS",
    "liveDHIS2Validation": "NOT RUN — authenticated synthetic test environment not configured",
}
(root/"plugin/build/package-verification.json").write_text(json.dumps(report,indent=2)+"\n")
print(json.dumps(report,indent=2))
