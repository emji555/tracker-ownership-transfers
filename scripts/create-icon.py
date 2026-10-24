"""Create native geometric app icons; no external image downloads."""
from pathlib import Path
from PIL import Image, ImageDraw

out = Path(__file__).resolve().parents[1] / "plugin" / "public"
out.mkdir(parents=True, exist_ok=True)
im = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
d = ImageDraw.Draw(im)
d.rounded_rectangle((8, 8, 504, 504), radius=104, fill="#116e68")
for x in (92, 320):
    d.rounded_rectangle((x, 135, x+100, 375), radius=15, fill="white")
    d.rectangle((x+39, 165, x+61, 237), fill="#116e68")
    d.rectangle((x+18, 190, x+82, 212), fill="#116e68")
    d.rectangle((x+38, 307, x+62, 375), fill="#beded9")
d.line((187, 264, 316, 264), fill="#ffe69d", width=22)
d.polygon(((292, 236), (332, 264), (292, 292)), fill="#ffe69d")
for name, size in [("dhis2-app-icon.png",48),("android-chrome-192x192.png",192),
                   ("android-chrome-384x384.png",384),("mstile-150x150.png",150),
                   ("favicon-16x16.png",16),("favicon-32x32.png",32),("favicon-48x48.png",48),
                   ("apple-touch-icon.png",180),("transfer-icon-512.png",512)]:
    im.resize((size,size), Image.Resampling.LANCZOS).save(out/name)
im.save(out/"favicon.ico", sizes=[(16,16),(32,32),(48,48)])
print("Transfer app icons created.")
