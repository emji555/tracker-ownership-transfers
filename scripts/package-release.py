"""Package source, docs, tests, synthetic fixtures and the app ZIP, excluding local state."""
from pathlib import Path
import hashlib
import json
import zipfile

root=Path(__file__).resolve().parents[1]
version=json.loads((root/"plugin/package.json").read_text())["version"]
target=root/f"patient-transfer-system-{version}.zip"
files=[]
for folder in ("deploy","fixtures","scripts","service","plugin"):
    start=root/folder
    # Explicit walk excludes junctions, build trees and any runtime/credential files.
    import os
    for directory, dirs, names in os.walk(start, followlinks=False):
        dirs[:]=[d for d in dirs if d not in {"node_modules",".d2","build","data","__pycache__"}]
        for name in names:
            path=Path(directory)/name
            if (name.startswith(".env") and name!=".env.example") or name.endswith((".sqlite",".sqlite-wal",".sqlite-shm",".lock",".log")):
                continue
            if path.parent==root/"service/scripts" and name.startswith("fix-"):
                continue
            files.append(path)
files += list(root.glob("*.md"))
files += [root/".gitignore",root/f"plugin/build/bundle/tracker-ownership-transfers-{version}.zip",
          root/"plugin/build/package-verification.json"]
with zipfile.ZipFile(target,"w",zipfile.ZIP_DEFLATED) as out:
    for path in sorted(set(files)):
        out.write(path,path.relative_to(root).as_posix())
with zipfile.ZipFile(target) as out:
    assert out.testzip() is None
    assert not any("node_modules/" in n or n.endswith("/.env") for n in out.namelist())
result={"release":target.name,"files":len(files),"sha256":hashlib.sha256(target.read_bytes()).hexdigest()}
(root/"release-verification.json").write_text(json.dumps(result,indent=2)+"\n")
print(json.dumps(result,indent=2))
