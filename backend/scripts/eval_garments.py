# Usage (from backend/): .venv/bin/python -m scripts.eval_garments <fit_dir> <out_dir>
# Run the real garment pipeline on FIT flat-lay cloth images; compare sleeve_length to ground truth.
import json, sys, pathlib
import numpy as np
from PIL import Image, ImageDraw
from app.image_processing import pipeline
from app.image_processing.attributes import extract_attributes
d = pathlib.Path(sys.argv[1]); out = pathlib.Path(sys.argv[2]); out.mkdir(parents=True, exist_ok=True)
meta = json.loads((d / "meta.json").read_text())
gt = lambda s: "sleeveless" if s < 3 else "long" if s > 40 else "short"  # FIT sleeve length in cm
rows, tiles = [], []
for m in meta:
    p = d / f"{m['id']}_cloth.jpg"
    try:
        a = pipeline.process_original(p)
    except pipeline.GarmentProcessingError as e:
        rows.append({"id": m["id"], "error": str(e)}); continue
    attrs = extract_attributes(np.array(a.processed), a.anchors) if a.anchors else {}
    r = {"id": m["id"], "anchors": bool(a.anchors), "warnings": a.meta["warnings"], "ms": a.meta["processing_ms"],
         "sleeve_gt": gt(m["garment_sleeve_length"]), "sleeve_cm": round(m["garment_sleeve_length"], 1),
         "sleeve_pred": attrs.get("sleeve_length"), "neckline": attrs.get("neckline"), "color": attrs.get("color_name")}
    rows.append(r); print(r, flush=True)
    t = Image.new("RGBA", a.processed.size, (200, 200, 200, 255)); t.alpha_composite(a.processed)
    dr = ImageDraw.Draw(t); W, H = t.size
    for k, v in (a.anchors or {}).items():
        x, y = v["x"] * W, v["y"] * H; dr.ellipse((x - 8, y - 8, x + 8, y + 8), fill="red")
    dr.text((8, 8), f"{m['id']} gt={r['sleeve_gt']} pred={r['sleeve_pred']}", fill="black")
    tiles.append(t.convert("RGB").resize((256, 256)))
cols = 6; sheet = Image.new("RGB", (256 * cols, 256 * ((len(tiles) + cols - 1) // cols)), "white")
for i, t in enumerate(tiles): sheet.paste(t, ((i % cols) * 256, (i // cols) * 256))
sheet.save(out / "garments_sheet.png")
ok = [r for r in rows if "sleeve_pred" in r and r["sleeve_pred"]]
print("processed", len(rows), "errors", sum("error" in r for r in rows), "no-anchors", sum(r.get("anchors") is False for r in rows))
print("sleeve accuracy", sum(r["sleeve_pred"] == r["sleeve_gt"] for r in ok), "/", len(ok))
(out / "garments.json").write_text(json.dumps(rows, indent=1))
