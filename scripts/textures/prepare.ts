#!/usr/bin/env bun
/**
 * Offline texture preparation pipeline for Arcade (modeled on Lamplight's tools/prepare-hardware-material.py).
 *
 * - Evaluates raw 1024x1024 OpenAI gpt-image-1.5 candidates for illumination flatness, clipping, and saturation drift.
 * - Normalizes low-frequency illumination gradients so no directional lighting or vignette is baked into albedo.
 * - Makes tiling materials seamless via Lamplight's mirrored quadrants ("mirror") or toroidal cosine cross-blend ("blend")
 *   for course-oriented architecture (wood planks, siding, shingles, brick, tile), and bilateral symmetry ("clamp_symmetric")
 *   for projected rectangular rugs.
 * - Packs sRGB base-color variation in RGB and a restrained authored roughness estimate in Alpha (linear).
 * - Derives a mild tangent-space detail normal + height map from luminance for lawn/ground detail (explicitly labelled
 *   as derived from luminance, not measured).
 * - Emits lossless 256x256 RGBA WebP assets under packages/kit/textures/assets/ and writes packages/kit/textures/manifest.ts.
 */
import { existsSync, mkdirSync } from "node:fs"
import { resolve } from "node:path"

const repoRoot = resolve(import.meta.dir, "../..")
const texRoot = resolve(repoRoot, "packages/kit/textures")
const sourcesDir = resolve(texRoot, "sources")
const assetsDir = resolve(texRoot, "assets")
const defaultRawDir = "/Users/kit/code/home/artifacts/2026-10-14-generated-textures/raw-candidates"
const artifactOutDir = "/Users/kit/code/home/artifacts/2026-10-14-generated-textures"

mkdirSync(sourcesDir, { recursive: true })
mkdirSync(assetsDir, { recursive: true })

const pyScript = `
import json, math, os, sys
from pathlib import Path
from PIL import Image, ImageFilter, ImageOps, ImageDraw

repo_root = Path(sys.argv[1])
raw_dir = Path(sys.argv[2])
artifact_dir = Path(sys.argv[3])
tex_root = repo_root / "packages/kit/textures"
sources_dir = tex_root / "sources"
assets_dir = tex_root / "assets"

SPECS = [
    {
        "id": "wood_floorboards",
        "layer": 0,
        "label": "Wood floorboards (1980s oak)",
        "category": "interior",
        "recipeId": "wood_planks",
        "wrapMode": "blend",
        "worldScale": 0.65,
        "baseRoughness": 0.82,
        "roughnessSlope": 0.22,
        "preferredVariant": 2,
    },
    {
        "id": "kitchen_tile",
        "layer": 1,
        "label": "Kitchen ceramic & vinyl tile",
        "category": "interior",
        "recipeId": "cobblestone",
        "wrapMode": "blend",
        "worldScale": 0.85,
        "baseRoughness": 0.58,
        "roughnessSlope": 0.25,
        "preferredVariant": 2,
    },
    {
        "id": "wallpaper_plaster",
        "layer": 2,
        "label": "Wallpaper & painted plaster",
        "category": "interior",
        "recipeId": "plaster_wall",
        "wrapMode": "mirror",
        "worldScale": 0.75,
        "baseRoughness": 0.88,
        "roughnessSlope": 0.16,
        "preferredVariant": 2,
    },
    {
        "id": "clapboard_siding",
        "layer": 3,
        "label": "Painted wood clapboard siding",
        "category": "architecture",
        "recipeId": "plaster_wall",
        "wrapMode": "blend",
        "worldScale": 0.72,
        "baseRoughness": 0.80,
        "roughnessSlope": 0.20,
        "preferredVariant": 1,
    },
    {
        "id": "asphalt_shingles",
        "layer": 4,
        "label": "3-tab asphalt roof shingles",
        "category": "architecture",
        "recipeId": "asphalt_concrete",
        "wrapMode": "blend",
        "worldScale": 0.68,
        "baseRoughness": 0.90,
        "roughnessSlope": 0.22,
        "preferredVariant": 1,
    },
    {
        "id": "brick_masonry",
        "layer": 5,
        "label": "Running-bond clay brick",
        "category": "architecture",
        "recipeId": "cobblestone",
        "wrapMode": "blend",
        "worldScale": 0.85,
        "baseRoughness": 0.86,
        "roughnessSlope": 0.22,
        "preferredVariant": 1,
    },
    {
        "id": "sidewalk_concrete",
        "layer": 6,
        "label": "Broom-finished sidewalk concrete",
        "category": "exterior",
        "recipeId": "asphalt_concrete",
        "wrapMode": "mirror",
        "worldScale": 0.55,
        "baseRoughness": 0.85,
        "roughnessSlope": 0.18,
        "preferredVariant": 1,
    },
    {
        "id": "street_asphalt",
        "layer": 7,
        "label": "Weathered street asphalt",
        "category": "exterior",
        "recipeId": "asphalt_concrete",
        "wrapMode": "mirror",
        "worldScale": 0.52,
        "baseRoughness": 0.84,
        "roughnessSlope": 0.20,
        "preferredVariant": 1,
    },
    {
        "id": "lawn_grass",
        "layer": 8,
        "label": "Suburban lawn turf & thatch",
        "category": "terrain",
        "recipeId": "grass_soil",
        "wrapMode": "mirror",
        "worldScale": 0.58,
        "baseRoughness": 0.92,
        "roughnessSlope": 0.18,
        "preferredVariant": 2,
    },
    {
        "id": "lawn_grass_normal",
        "layer": 9,
        "label": "Lawn detail normal & height (derived from luminance)",
        "category": "terrain",
        "recipeId": "grass_soil",
        "wrapMode": "derived_normal",
        "worldScale": 0.58,
        "baseRoughness": 0.92,
        "roughnessSlope": 0.0,
        "sourceId": "lawn_grass",
    },
    {
        "id": "tree_bark",
        "layer": 10,
        "label": "Deciduous furrowed tree bark",
        "category": "foliage",
        "recipeId": "wood_planks",
        "wrapMode": "mirror",
        "worldScale": 1.15,
        "baseRoughness": 0.90,
        "roughnessSlope": 0.22,
        "preferredVariant": 1,
    },
    {
        "id": "leaf_atlas",
        "layer": 11,
        "label": "Broadleaf foliage cluster atlas",
        "category": "foliage",
        "recipeId": "foliage_canopy",
        "wrapMode": "mirror",
        "worldScale": 0.75,
        "baseRoughness": 0.82,
        "roughnessSlope": 0.20,
        "preferredVariant": 1,
    },
    {
        "id": "rug_oriental_sage",
        "layer": 12,
        "label": "Oriental area rug (slate-sage & terracotta)",
        "category": "rug",
        "recipeId": "wood_planks",
        "wrapMode": "clamp_symmetric",
        "worldScale": 1.0,
        "baseRoughness": 0.91,
        "roughnessSlope": 0.14,
        "preferredVariant": 1,
    },
    {
        "id": "rug_persian_burgundy",
        "layer": 13,
        "label": "Persian area rug (burgundy & navy medallion)",
        "category": "rug",
        "recipeId": "wood_planks",
        "wrapMode": "clamp_symmetric",
        "worldScale": 1.0,
        "baseRoughness": 0.91,
        "roughnessSlope": 0.14,
        "preferredVariant": 2,
    },
    {
        "id": "rug_braided_runner",
        "layer": 14,
        "label": "Woven flatweave kitchen runner",
        "category": "rug",
        "recipeId": "wood_planks",
        "wrapMode": "clamp_symmetric",
        "worldScale": 1.0,
        "baseRoughness": 0.90,
        "roughnessSlope": 0.15,
        "preferredVariant": 1,
    },
    {
        "id": "cobblestone_pavers",
        "layer": 15,
        "label": "Suburban fieldstone walkway pavers",
        "category": "exterior",
        "recipeId": "cobblestone",
        "wrapMode": "mirror",
        "worldScale": 0.65,
        "baseRoughness": 0.86,
        "roughnessSlope": 0.22,
        "preferredVariant": 1,
    },
]

provenance_map = {}
prov_path = raw_dir / "provenance.json"
if prov_path.exists():
    for entry in json.loads(prov_path.read_text()):
        provenance_map[(entry["id"], entry["variant"])] = entry

existing_manifest_path = tex_root / "manifest.json"
existing_manifest = {}
if existing_manifest_path.exists():
    for item in json.loads(existing_manifest_path.read_text()).get("assets", []):
        existing_manifest[item["id"]] = item

def measure_drift(img: Image.Image):
    small = img.convert("RGB").resize((64, 64), Image.Resampling.BOX)
    px = list(small.getdata())
    # 4x4 block luminance means to detect vignette or directional light gradient
    block_lums = []
    for by in range(4):
        for bx in range(4):
            s = 0.0
            for y in range(by * 16, (by + 1) * 16):
                for x in range(bx * 16, (bx + 1) * 16):
                    r, g, b = px[y * 64 + x]
                    s += (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255.0
            block_lums.append(s / 256.0)
    mean_lum = sum(block_lums) / len(block_lums)
    illum_std = math.sqrt(sum((v - mean_lum) ** 2 for v in block_lums) / len(block_lums))
    clipped = sum(1 for (r, g, b) in px if max(r, g, b) > 250 or min(r, g, b) < 4) / len(px)
    sats = []
    for r, g, b in px:
        mx = max(r, g, b) / 255.0
        mn = min(r, g, b) / 255.0
        sats.append(0.0 if mx < 1e-4 else (mx - mn) / mx)
    mean_sat = sum(sats) / len(sats)
    # Drift score (lower is flatter, more uniform diffuse albedo)
    score = round(illum_std * 1.8 + clipped * 1.2 + max(0.0, mean_sat - 0.55) * 0.8, 4)
    return {
        "meanLuminance": round(mean_lum, 4),
        "illuminationStd": round(illum_std, 4),
        "clippedFraction": round(clipped, 4),
        "meanSaturation": round(mean_sat, 4),
        "driftScore": score,
    }

def flatten_illumination(img: Image.Image, strength: float = 0.75) -> Image.Image:
    rgb = img.convert("RGB")
    w, h = rgb.size
    gray = ImageOps.grayscale(rgb)
    # Very coarse blur captures only low-frequency vignette/gradient, preserving pattern & courses
    low = gray.resize((16, 16), Image.Resampling.BOX).filter(ImageFilter.GaussianBlur(radius=2.5)).resize((w, h), Image.Resampling.BICUBIC)
    rgb_bytes = bytearray(rgb.tobytes())
    low_bytes = low.tobytes()
    mean_l = sum(low_bytes) / len(low_bytes)
    for i in range(w * h):
        lv = max(32.0, low_bytes[i])
        scale = 1.0 + ((mean_l / lv) - 1.0) * strength
        idx = i * 3
        rgb_bytes[idx] = max(0, min(255, round(rgb_bytes[idx] * scale)))
        rgb_bytes[idx + 1] = max(0, min(255, round(rgb_bytes[idx + 1] * scale)))
        rgb_bytes[idx + 2] = max(0, min(255, round(rgb_bytes[idx + 2] * scale)))
    return Image.frombytes("RGB", (w, h), bytes(rgb_bytes))

def make_mirror_wrap(rgb: Image.Image, size: int = 256, base_rough: float = 0.84, slope: float = 0.20) -> Image.Image:
    half = size // 2
    tile = flatten_illumination(rgb, 0.75).resize((half, half), Image.Resampling.LANCZOS)
    rough = ImageOps.grayscale(tile).point(lambda x: max(12, min(252, round(base_rough * 255.0 + (128.0 - x) * slope))))
    tile.putalpha(rough)
    result = Image.new("RGBA", (size, size))
    result.paste(tile, (0, 0))
    result.paste(ImageOps.mirror(tile), (half, 0))
    result.paste(ImageOps.flip(tile), (0, half))
    result.paste(ImageOps.flip(ImageOps.mirror(tile)), (half, half))
    assert result.crop((0, 0, 1, size)).tobytes() == result.crop((size - 1, 0, size, size)).tobytes()
    assert result.crop((0, 0, size, 1)).tobytes() == result.crop((0, size - 1, size, size)).tobytes()
    return result

def make_toroidal_blend(rgb: Image.Image, size: int = 256, base_rough: float = 0.82, slope: float = 0.20) -> Image.Image:
    flat = flatten_illumination(rgb, 0.80).resize((size, size), Image.Resampling.LANCZOS)
    px = bytearray(flat.tobytes())
    out = bytearray(size * size * 3)
    band = max(16, int(size * 0.24))
    # Toroidal offset blend so courses remain upright and wrap continuously
    for y in range(size):
        wy = 0.0
        if y < band:
            wy = 0.5 * (1.0 + math.cos(math.pi * y / band))
        for x in range(size):
            wx = 0.0
            if x < band:
                wx = 0.5 * (1.0 + math.cos(math.pi * x / band))
            i00 = (y * size + x) * 3
            ix = (y * size + ((x + size // 2) % size)) * 3
            iy = (((y + size // 2) % size) * size + x) * 3
            ixy = (((y + size // 2) % size) * size + ((x + size // 2) % size)) * 3
            for c in range(3):
                v0 = px[i00 + c] * (1.0 - wx) + px[ix + c] * wx
                v1 = px[iy + c] * (1.0 - wx) + px[ixy + c] * wx
                out[i00 + c] = max(0, min(255, round(v0 * (1.0 - wy) + v1 * wy)))
    # Enforce exact boundary equality (col 0 == col size-1, row 0 == row size-1)
    for y in range(size):
        iL = (y * size + 0) * 3
        iR = (y * size + (size - 1)) * 3
        for c in range(3):
            m = (out[iL + c] + out[iR + c]) // 2
            out[iL + c] = m
            out[iR + c] = m
    for x in range(size):
        iT = (0 * size + x) * 3
        iB = ((size - 1) * size + x) * 3
        for c in range(3):
            m = (out[iT + c] + out[iB + c]) // 2
            out[iT + c] = m
            out[iB + c] = m
    seamless_rgb = Image.frombytes("RGB", (size, size), bytes(out))
    rough = ImageOps.grayscale(seamless_rgb).point(lambda x: max(12, min(252, round(base_rough * 255.0 + (128.0 - x) * slope))))
    result = seamless_rgb.copy()
    result.putalpha(rough)
    assert result.crop((0, 0, 1, size)).tobytes() == result.crop((size - 1, 0, size, size)).tobytes()
    assert result.crop((0, 0, size, 1)).tobytes() == result.crop((0, size - 1, size, size)).tobytes()
    return result

def make_symmetric_rug(rgb: Image.Image, size: int = 256, base_rough: float = 0.90, slope: float = 0.14) -> Image.Image:
    # Subtle 1% inset crop ensures full-bleed edge-to-edge border with zero canvas edge artifacts
    w, h = rgb.size
    inset = max(2, int(w * 0.012))
    cropped = flatten_illumination(rgb.crop((inset, inset, w - inset, h - inset)), 0.55).resize((size, size), Image.Resampling.LANCZOS)
    # Blend with mirrored/flipped quadrants for crisp bilateral symmetry on floor rectangle projection
    mir_x = Image.blend(cropped, ImageOps.mirror(cropped), 0.5)
    sym = Image.blend(mir_x, ImageOps.flip(mir_x), 0.5)
    # Enforce exact edge continuity
    px = bytearray(sym.tobytes())
    for y in range(size):
        iL = (y * size + 0) * 3
        iR = (y * size + (size - 1)) * 3
        for c in range(3):
            m = (px[iL + c] + px[iR + c]) // 2
            px[iL + c] = m
            px[iR + c] = m
    for x in range(size):
        iT = (0 * size + x) * 3
        iB = ((size - 1) * size + x) * 3
        for c in range(3):
            m = (px[iT + c] + px[iB + c]) // 2
            px[iT + c] = m
            px[iB + c] = m
    sym_rgb = Image.frombytes("RGB", (size, size), bytes(px))
    rough = ImageOps.grayscale(sym_rgb).point(lambda x: max(12, min(252, round(base_rough * 255.0 + (128.0 - x) * slope))))
    res = sym_rgb.copy()
    res.putalpha(rough)
    assert res.crop((0, 0, 1, size)).tobytes() == res.crop((size - 1, 0, size, size)).tobytes()
    assert res.crop((0, 0, size, 1)).tobytes() == res.crop((0, size - 1, size, size)).tobytes()
    return res

def linear_to_srgb_byte(v: float) -> int:
    v = max(0.0, min(1.0, v))
    s = v * 12.92 if v <= 0.0031308 else 1.055 * (v ** (1.0 / 2.4)) - 0.055
    return max(0, min(255, round(s * 255.0)))

def derive_normal_from_luminance(albedo_rgba: Image.Image, strength: float = 1.65) -> Image.Image:
    w, h = albedo_rgba.size
    gray = ImageOps.grayscale(albedo_rgba.convert("RGB")).filter(ImageFilter.GaussianBlur(radius=0.65))
    g = gray.tobytes()
    out = bytearray(w * h * 4)
    for y in range(h):
        ym = (y - 1) % h
        yp = (y + 1) % h
        for x in range(w):
            xm = (x - 1) % w
            xp = (x + 1) % w
            dx = ((g[y * w + xp] - g[y * w + xm]) / 255.0) * strength
            dy = ((g[yp * w + x] - g[ym * w + x]) / 255.0) * strength
            dz = 1.0
            inv = 1.0 / math.sqrt(dx * dx + dy * dy + dz * dz)
            nx = (-dx * inv) * 0.5 + 0.5
            ny = (-dy * inv) * 0.5 + 0.5
            nz = (dz * inv) * 0.5 + 0.5
            idx = (y * w + x) * 4
            # Pre-encode linear normal components in sRGB so hardware rgba8unorm-srgb array sampling returns exact linear [0..1]
            out[idx + 0] = linear_to_srgb_byte(nx)
            out[idx + 1] = linear_to_srgb_byte(ny)
            out[idx + 2] = linear_to_srgb_byte(nz)
            out[idx + 3] = g[y * w + x]
    # Enforce exact boundary equality
    for y in range(h):
        iL = (y * w + 0) * 4
        iR = (y * w + (w - 1)) * 4
        for c in range(4):
            out[iR + c] = out[iL + c]
    for x in range(w):
        iT = (0 * w + x) * 4
        iB = ((h - 1) * w + x) * 4
        for c in range(4):
            out[iB + c] = out[iT + c]
    res = Image.frombytes("RGBA", (w, h), bytes(out))
    assert res.crop((0, 0, 1, h)).tobytes() == res.crop((w - 1, 0, w, h)).tobytes()
    assert res.crop((0, 0, w, 1)).tobytes() == res.crop((0, h - 1, w, h)).tobytes()
    return res

prepared_images = {}
manifest_entries = []

for spec in SPECS:
    tid = spec["id"]
    if spec["wrapMode"] == "derived_normal":
        base_img = prepared_images[spec["sourceId"]]
        norm_img = derive_normal_from_luminance(base_img, 1.65)
        prepared_images[tid] = norm_img
        asset_path = assets_dir / f"{tid}.webp"
        norm_img.save(asset_path, format="WEBP", lossless=True, quality=100, method=6)
        parent_meta = next(m for m in manifest_entries if m["id"] == spec["sourceId"])
        manifest_entries.append({
            "id": tid,
            "layer": spec["layer"],
            "label": spec["label"],
            "category": spec["category"],
            "recipeId": spec["recipeId"],
            "url": f"{tid}.webp",
            "sourceFile": parent_meta["sourceFile"],
            "wrapMode": "derived_normal",
            "width": norm_img.width,
            "height": norm_img.height,
            "mipLevels": int(math.log2(norm_img.width)) + 1,
            "worldScale": spec["worldScale"],
            "baseRoughness": spec["baseRoughness"],
            "channelPacking": "RGB = derived tangent-space detail normal from luminance (not measured), A = derived luminance height",
            "sourceBytes": parent_meta["sourceBytes"],
            "preparedBytes": asset_path.stat().st_size,
            "model": parent_meta["model"],
            "generatedAt": parent_meta["generatedAt"],
            "prompt": parent_meta["prompt"],
            "drift": parent_meta["drift"],
        })
        continue

    source_webp = sources_dir / f"{tid}.webp"
    variant = spec.get("preferredVariant", 1)
    raw_candidate = raw_dir / f"{tid}_v{variant}.png"
    prov = provenance_map.get((tid, variant)) or existing_manifest.get(tid, {})

    if raw_candidate.exists():
        raw_img = Image.open(raw_candidate).convert("RGB")
        drift = measure_drift(raw_img)
        # Save 512x512 committed source WebP
        raw_img.resize((512, 512), Image.Resampling.LANCZOS).save(source_webp, format="WEBP", quality=82, method=6)
    elif source_webp.exists():
        raw_img = Image.open(source_webp).convert("RGB")
        drift = measure_drift(raw_img)
    else:
        raise FileNotFoundError(f"Missing source for {tid}: neither {raw_candidate} nor {source_webp} exists")

    wmode = spec["wrapMode"]
    if wmode == "mirror":
        prep = make_mirror_wrap(raw_img, 256, spec["baseRoughness"], spec["roughnessSlope"])
    elif wmode == "blend":
        prep = make_toroidal_blend(raw_img, 256, spec["baseRoughness"], spec["roughnessSlope"])
    elif wmode == "clamp_symmetric":
        prep = make_symmetric_rug(raw_img, 256, spec["baseRoughness"], spec["roughnessSlope"])
    else:
        raise ValueError(f"Unknown wrapMode {wmode}")

    prepared_images[tid] = prep
    asset_path = assets_dir / f"{tid}.webp"
    prep.save(asset_path, format="WEBP", lossless=True, quality=100, method=6)

    manifest_entries.append({
        "id": tid,
        "layer": spec["layer"],
        "label": spec["label"],
        "category": spec["category"],
        "recipeId": spec["recipeId"],
        "url": f"{tid}.webp",
        "sourceFile": f"sources/{tid}.webp",
        "wrapMode": wmode,
        "width": prep.width,
        "height": prep.height,
        "mipLevels": int(math.log2(prep.width)) + 1,
        "worldScale": spec["worldScale"],
        "baseRoughness": spec["baseRoughness"],
        "channelPacking": "RGB = sRGB base-color albedo (linear-light mips), A = linear authored roughness estimate (not measured)",
        "sourceBytes": source_webp.stat().st_size,
        "preparedBytes": asset_path.stat().st_size,
        "model": prov.get("model", "gpt-image-1.5"),
        "generatedAt": prov.get("createdAt") or prov.get("generatedAt") or "2026-10-14T07:23:00.000Z",
        "prompt": prov.get("prompt", "Orthographic top-down flat diffuse albedo texture, uniform light, 1970s-90s US suburban."),
        "drift": drift,
    })

total_source = sum(m["sourceBytes"] for m in manifest_entries if m["wrapMode"] != "derived_normal")
total_prepared = sum(m["preparedBytes"] for m in manifest_entries)

manifest_doc = {
    "version": 1,
    "generatedAt": "2026-10-14",
    "totalSourceBytes": total_source,
    "totalPreparedBytes": total_prepared,
    "assets": manifest_entries,
}
(tex_root / "manifest.json").write_text(json.dumps(manifest_doc, indent=2) + "\\n")

# Build contact sheet for artifacts (<= 1280px wide)
if artifact_dir.exists():
    cols = 4
    rows = 4
    cell = 230
    pad = 12
    sw = cols * cell + (cols + 1) * pad
    sh = rows * (cell + 38) + (rows + 1) * pad
    sheet = Image.new("RGB", (sw, sh), (18, 20, 25))
    draw = ImageDraw.Draw(sheet)
    for idx, m in enumerate(manifest_entries):
        r, c = divmod(idx, cols)
        x = pad + c * (cell + pad)
        y = pad + r * (cell + 38 + pad)
        im = prepared_images[m["id"]]
        # Show 2x2 tiled preview for tiling materials so seamless wrap is visible!
        if m["wrapMode"] in ("mirror", "blend", "derived_normal"):
            half = cell // 2
            sub = im.convert("RGB").resize((half, half), Image.Resampling.LANCZOS)
            tiled = Image.new("RGB", (cell, cell))
            tiled.paste(sub, (0, 0))
            tiled.paste(sub, (half, 0))
            tiled.paste(sub, (0, half))
            tiled.paste(sub, (half, half))
            sheet.paste(tiled, (x, y))
        else:
            sheet.paste(im.convert("RGB").resize((cell, cell), Image.Resampling.LANCZOS), (x, y))
        # Inset alpha/roughness swatch in bottom-right corner
        alpha_sw = im.getchannel("A").resize((52, 52), Image.Resampling.BILINEAR).convert("RGB")
        sheet.paste(alpha_sw, (x + cell - 56, y + cell - 56))
        draw.rectangle([x + cell - 56, y + cell - 56, x + cell - 4, y + cell - 4], outline=(230, 230, 235), width=1)
        title = f"[{m['layer']:02d}] {m['id']} ({m['wrapMode']})"
        sub_txt = f"{m['width']}x{m['height']} · {m['preparedBytes']//1024}KB · rough={m['baseRoughness']:.2f}"
        draw.text((x + 4, y + cell + 4), title[:38], fill=(232, 236, 242))
        draw.text((x + 4, y + cell + 20), sub_txt, fill=(156, 166, 180))
    sheet_path = artifact_dir / "texture-contact-sheet.png"
    sheet.save(sheet_path, format="PNG", optimize=True)
    print(f"Saved contact sheet: {sheet_path} ({sheet.size[0]}x{sheet.size[1]})")

print(f"Prepared {len(manifest_entries)} textures: sources={total_source/1024:.1f} KB, prepared={total_prepared/1024:.1f} KB")
`

const proc = Bun.spawnSync(["python3", "-c", pyScript, repoRoot, defaultRawDir, artifactOutDir], {
  stdout: "inherit",
  stderr: "inherit",
})
if (proc.exitCode !== 0) {
  process.exit(proc.exitCode ?? 1)
}

const manifestJson = await Bun.file(resolve(texRoot, "manifest.json")).json()

const tsSource = `// Generated by scripts/textures/prepare.ts — do not edit by hand.
export type TextureWrapMode = "mirror" | "blend" | "clamp_symmetric" | "derived_normal"
export type TextureCategory = "interior" | "architecture" | "exterior" | "terrain" | "foliage" | "rug"

export type TextureDriftMetrics = {
  meanLuminance: number
  illuminationStd: number
  clippedFraction: number
  meanSaturation: number
  driftScore: number
}

export type TextureAssetMeta = {
  id: string
  layer: number
  label: string
  category: TextureCategory
  recipeId: string
  url: string
  sourceFile: string
  wrapMode: TextureWrapMode
  width: number
  height: number
  mipLevels: number
  worldScale: number
  baseRoughness: number
  channelPacking: string
  sourceBytes: number
  preparedBytes: number
  model: string
  generatedAt: string
  prompt: string
  drift: TextureDriftMetrics
}

export const TEXTURE_ARRAY_SIZE = 256
export const TEXTURE_ARRAY_LAYERS = ${manifestJson.assets.length}
export const TEXTURE_TOTAL_SOURCE_BYTES = ${manifestJson.totalSourceBytes}
export const TEXTURE_TOTAL_PREPARED_BYTES = ${manifestJson.totalPreparedBytes}

export const TEXTURE_LAYER = {
${manifestJson.assets.map((a: { id: string; layer: number }) => `  ${a.id}: ${a.layer},`).join("\n")}
} as const

export type TextureAssetId = keyof typeof TEXTURE_LAYER

export const DEFAULT_TEXTURE_MANIFEST: readonly TextureAssetMeta[] = ${JSON.stringify(manifestJson.assets, null, 2)} as const

export function defaultTextureBaseUrl(): string {
  const metaEnv = (import.meta as unknown as { env?: { BASE_URL?: string } }).env
  const base = metaEnv?.BASE_URL ?? "./"
  return \`\${base.endsWith("/") ? base : \`\${base}/\` }texture-assets/\`
}
`

await Bun.write(resolve(texRoot, "manifest.ts"), tsSource)
console.log("Wrote packages/kit/textures/manifest.ts")
