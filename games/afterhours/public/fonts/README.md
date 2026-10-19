# HUD font

`SpecialElite-hud.woff2`: Special Elite by Astigmatic (Apache License 2.0, github.com/google/fonts
`apache/specialelite`), the documents' typewriter face, subset to printable ASCII plus · – — ‘ ’ “ ” … and arrows for
the interaction prompts and the help bar (`pyftsubset --flavor=woff2`).

# Map fonts (src/game/map)

Subset to printable ASCII plus ° · ½ × – — ‘ ’ “ ” … ′ ″ arrows № (`pyftsubset --flavor=woff2 --layout-features='*'`),
from github.com/google/fonts:

- `Caveat-map.woff2`: Caveat by Impallari Type (OFL), the ballpoint annotations.
- `LibreFranklin-map.woff2`: Libre Franklin by Impallari Type (OFL, variable weight), the plan lettering.
- `Oswald-map.woff2`: Oswald by Vernon Adams (OFL, variable weight), title block and sheet numbers.
- `ArchivoBlack-Regular-map.woff2`: Archivo Black by Omnibus-Type (OFL), the rubber stamps.

# Title font (src/game/shell, the home screen)

`RubikGlitch-title.woff2`: Rubik Glitch by The Rubik Filtered Project Authors (SIL Open Font License 1.1; licence
text in `OFL-RubikGlitch.txt`), from github.com/google/fonts `ofl/rubikglitch`, subset to space, digits and A–Z a–z
for the ASHWOOD title (`pyftsubset --flavor=woff2 --layout-features='*'`).
