# Water references

The water WGSL in this folder is original. No third-party source, textures or other
assets are included.

- Mark Finch, [Effective Water Simulation from Physical Models, GPU Gems chapter 1](https://developer.nvidia.com/gpugems/gpugems/part-i-natural-effects/chapter-1-effective-water-simulation-physical-models): geometry/normal frequency separation.
- Walter et al., [Microfacet Models for Refraction through Rough Surfaces](https://www.cs.cornell.edu/~srm/publications/EGSR07-btdf.pdf): GGX microfacet distribution; the implementation here uses Smith visibility and Schlick water Fresnel.
- Brian Karis, [Real Shading in Unreal Engine 4](https://blog.selfshadow.com/publications/s2013-shading-course/karis/s2013_pbs_epic_notes_v2.pdf): finite-light representative point and lobe-energy correction.
- Dan Greenheck, [Water Pro public documentation](https://docs.threejswaterpro.com/): visual and feature research only. No commercial code or bundled assets copied.
- [Tidewater](https://github.com/dgreenheck/tidewater), revision `4811ba48d795197de5621985f404e765c0b7c0ef`: MIT, © 2026 DRG Software Solutions LLC. Inspected for research; no source or assets copied.

Research, real-photo links and generated paint-over provenance are published in
[the water comparison](https://studio.taila8e7c7.ts.net:8444/raw/water-2026-10-22/index.html).
