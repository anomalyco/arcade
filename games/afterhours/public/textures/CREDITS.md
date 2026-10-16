# Texture credits

Every texture here is **CC0 1.0 (public domain)**; no attribution is required, but sources are recorded so the set is
reproducible. Regenerate with `bun scripts/fetch-textures.ts` (`--force` to refetch). Each folder holds
`color.jpg` (sRGB), `normal.jpg` (OpenGL) and `arm.jpg` (R AO, G roughness, B metalness), re-encoded from the
originals with ffmpeg.

- Poly Haven licence: https://polyhaven.com/license
- ambientCG licence: https://docs.ambientcg.com/license/

| Folder | Site | Asset | Res | Licence | Use |
| --- | --- | --- | --- | --- | --- |
| `asphalt/` | Poly Haven | [asphalt_02](https://polyhaven.com/a/asphalt_02) | 2k | CC0 1.0 | road surface with hairline cracks |
| `asphalt_lot/` | Poly Haven | [worn_asphalt](https://polyhaven.com/a/worn_asphalt) | 2k | CC0 1.0 | worn parking-lot asphalt |
| `gravel/` | ambientCG | [Gravel022](https://ambientcg.com/view?id=Gravel022) | 1k | CC0 1.0 | grey gravel shoulders |
| `forest_floor/` | ambientCG | [Ground072](https://ambientcg.com/view?id=Ground072) | 1k | CC0 1.0 | forest duff with pine needles |
| `forest_moss/` | Poly Haven | [forrest_ground_01](https://polyhaven.com/a/forrest_ground_01) | 1k | CC0 1.0 | mossy needle ground, blended into the forest floor |
| `grass/` | Poly Haven | [withered_grass](https://polyhaven.com/a/withered_grass) | 1k | CC0 1.0 | dry withered grass |
| `dirt/` | ambientCG | [Ground048](https://ambientcg.com/view?id=Ground048) | 1k | CC0 1.0 | dark soil |
| `concrete_wall/` | Poly Haven | [wood_textured_concrete](https://polyhaven.com/a/wood_textured_concrete) | 2k | CC0 1.0 | board-formed concrete |
| `concrete_dark/` | ambientCG | [Concrete033](https://ambientcg.com/view?id=Concrete033) | 1k | CC0 1.0 | dark bunker concrete |
| `concrete_floor/` | Poly Haven | [concrete_floor_worn_001](https://polyhaven.com/a/concrete_floor_worn_001) | 1k | CC0 1.0 | worn concrete slab |
| `bark/` | ambientCG | [Bark014](https://ambientcg.com/view?id=Bark014) | 1k | CC0 1.0 | fir bark |
| `wood_pole/` | Poly Haven | [rough_wood](https://polyhaven.com/a/rough_wood) | 1k | CC0 1.0 | weathered wood grain (utility poles) |
| `metal_painted/` | ambientCG | [PaintedMetal001](https://ambientcg.com/view?id=PaintedMetal001) | 1k | CC0 1.0 | scratched paint (normal/roughness only; colour is tinted) |
| `metal_galvanized/` | ambientCG | [Metal032](https://ambientcg.com/view?id=Metal032) | 1k | CC0 1.0 | plain grey steel |
| `metal_dark/` | ambientCG | [Metal046B](https://ambientcg.com/view?id=Metal046B) | 1k | CC0 1.0 | dark dirty steel |
| `ceiling_tile/` | ambientCG | [OfficeCeiling001](https://ambientcg.com/view?id=OfficeCeiling001) | 1k | CC0 1.0 | fissured acoustic ceiling tiles |
| `terrazzo/` | ambientCG | [Terrazzo019S](https://ambientcg.com/view?id=Terrazzo019S) | 1k | CC0 1.0 | beige terrazzo |
| `plaster/` | ambientCG | [Plaster001](https://ambientcg.com/view?id=Plaster001) | 1k | CC0 1.0 | smooth plaster (painted wall) |
| `imperfections/` | ambientCG | [SurfaceImperfections003](https://ambientcg.com/view?id=SurfaceImperfections003) | 1k | CC0 1.0 | smudges for glossy roughness variation (its colour map is packed as roughness) |

Procedural (generated at runtime in `src/render/materials.ts`, no external source): chain-link mesh, barbed wire,
pine branch card, ceramic wall tile, linoleum, window glass, rubber, emissive lenses.
