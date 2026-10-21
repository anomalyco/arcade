# Lot interior

Architecture, fixtures, seating, plants and document placement are baked from Aiden's Ashwood builders.
`scene.json` records the SHA-256 of each source read by the read-only importer. Three.js is an offline tool;
the game draws native kit vertex buffers and static PNG-textured glTF props.

The grayscale tile, terrazzo, vinyl, plaster and ceiling finish maps are authored procedurally by
`scripts/interior-assets.ts` (seed 71). The EXIT lettering is rasterized with the system Arial Bold font;
no font files ship. Reception CRT, telephone, office chair and filing drawers are authored kit geometry.

Imported CC0 props: [PROP-CREDITS.md](PROP-CREDITS.md). Ashwood's authored document atlas and rendered-font
credits: [DOCUMENT-CREDITS.md](DOCUMENT-CREDITS.md). The source's non-CC0 office props are not imported.
