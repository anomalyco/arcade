# salvo

- After every meaningful change, run `bun run check` then `bun run deploy` so the latest build is live at https://anoma.ly/labs/salvo/.
- Simulation code in `src/sim` must stay deterministic and DOM-free: the client and the Room Durable Object both run it and compare hashes.
- WebGPU is not used; the renderer is Canvas2D. Test visuals with a headless browser against `concept/`.
