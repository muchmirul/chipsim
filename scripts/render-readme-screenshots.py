"""Render captured ChipSim terminal rows as PNG; never invent UI content."""
import json
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

root = Path(__file__).resolve().parent.parent
destination = root / "docs" / "screenshots"
data = json.loads((destination / "frames.json").read_text())
font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", 16)
cell = round(font.getlength("M"))
line = 23
padding = 18
background = "#0b1220"
palette = {
    "": "#d0d9e8", "title": "#6de0eb", "selected": "#06121c",
    "dim": "#91a0b6", "wave": "#6de0eb", "event": "#ffd479",
    "status": "#91e6a7", "error": "#ff8994",
}
for frame in data["frames"]:
    width = frame["columns"] * cell + padding * 2
    height = frame["height"] * line + padding * 2
    image = Image.new("RGB", (width, height), background)
    draw = ImageDraw.Draw(image)
    for index, row in enumerate(frame["rows"]):
        y = padding + index * line
        style = row.get("style", "")
        if style == "selected":
            draw.rectangle((padding, y, width - padding - 1, y + line - 1), fill="#75dce6")
        draw.text((padding, y), row["text"], fill=palette.get(style, palette[""]), font=font)
    image.save(destination / (frame["id"] + ".png"), optimize=True)
    print("Rendered", frame["id"])
