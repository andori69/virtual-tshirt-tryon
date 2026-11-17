# Usage (from backend/): .venv/bin/python scripts/fetch_fit_samples.py <out_dir> [n]
# Fetch a spread of FIT eval samples (person, cloth, measurements) via the HF datasets-server rows API.
import json, sys, urllib.request, pathlib
out = pathlib.Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
n = int(sys.argv[2]) if len(sys.argv) > 2 else 30
API = "https://datasets-server.huggingface.co/rows?dataset=Yuanhao-Harry-Wang/fitvto-100k&config=default&split=eval&offset={}&length=1"
meta = []
for i in range(n):
    off = i * (5000 // n)
    sid = f"fit{off:04d}"
    try:
        row = json.load(urllib.request.urlopen(API.format(off), timeout=60))["rows"][0]["row"]
        for k in ("person", "cloth", "target"):
            f = out / f"{sid}_{k}.jpg"
            if not f.exists():
                f.write_bytes(urllib.request.urlopen(row[k]["src"], timeout=60).read())
    except Exception as e:
        print(sid, "skipped:", e); continue
    m = {k: v for k, v in row.items() if k.startswith(("body_", "garment_"))}
    meta.append({"id": sid, **m}); print(sid, m, flush=True)
(out / "meta.json").write_text(json.dumps(meta, indent=1))
