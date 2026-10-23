# Textured furniture

`rotary-phone.glb`, `tv-set.glb` and `kitchen-counter.glb`: original product shots generated with OpenAI,
converted with [TRELLIS.2](https://github.com/microsoft/TRELLIS.2) (MIT code/weights) on the
[Apple Silicon port](https://github.com/shivampkumar/trellis-mac). BiRefNet (MIT) supplied cutouts.
The offline tools also use mtldiffrast (NVIDIA Source Code License) and Meta DINOv3 conditioning
([licence](https://huggingface.co/facebook/dinov3-vitl16-pretrain-lvd1689m)). Acceptance of the latter for
commercial reliance is not established by this bake.

Changes: oriented/scaled to the catalogue, decimated, UV-unwrapped, Cycles high-to-low base colour, normal,
AO and metallic/roughness transfer, lossless WebP compression. Source colours are preserved, including any
lighting already embedded by generation. Prompts: `scripts/props/sources.ts`. Hashes: `textured-sources.json`.
