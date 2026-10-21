"""uv run --with pillow prepare-carpet.py Carpet001_1K-JPG.zip public/props

ambientCG Carpet001, CC0. Retain GL normals; pack roughness into glTF's G channel.
"""
import io
import sys
import zipfile
from pathlib import Path
from PIL import Image

archive, output = Path(sys.argv[1]), Path(sys.argv[2])
output.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(archive) as source:
    def image(suffix):
        name = next(n for n in source.namelist() if n.endswith(suffix + ".jpg"))
        return Image.open(io.BytesIO(source.read(name))).convert("RGB").resize((1024,1024), Image.Resampling.LANCZOS)
    image("Color").save(output / "carpet-color.webp", quality=92)
    image("NormalGL").save(output / "carpet-normal.webp", lossless=True)
    roughness = image("Roughness").convert("L")
    Image.merge("RGB", (Image.new("L", roughness.size, 255), roughness, Image.new("L", roughness.size, 0))).save(output / "carpet-orm.webp", lossless=True)
