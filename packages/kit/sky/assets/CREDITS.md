# Shared sky assets

## Yale Bright Star Catalogue 5

- Original catalogue: Dorrit Hoffleit and Wayne H. Warren Jr. (1991), Yale University Observatory / NASA NSSDC Astronomical Data Center.
- Numeric JSON conversion: **aduboisforge**, [Bright-Star-Catalog-JSON](https://github.com/aduboisforge/Bright-Star-Catalog-JSON), revision `704675ce4981e3b7ca8c7b8530165a83f9a454cc`.
- Licence: **public domain**, explicitly dedicated in the [source README](https://github.com/aduboisforge/Bright-Star-Catalog-JSON/blob/704675ce4981e3b7ca8c7b8530165a83f9a454cc/README.md#license). No HYG/CC BY-SA data is used.
- Changes: numeric coordinates, magnitudes and spectral-type-derived approximate temperatures packed for rendering; proper-motion fields retained. Names and prose are not rendered. Original file hash in `sources.json`.

## CGI Moon Kit

- NASA's Scientific Visualization Studio, **Ernie Wright**; LRO / LROC science teams. [CGI Moon Kit, item 4720](https://svs.gsfc.nasa.gov/4720/).
- Source: 2019 `lroc_color_poles_1k.jpg`, 1024×512.
- Licence: **public domain**, under [SVS's explicit content policy](https://svs.gsfc.nasa.gov/help/#faq); item lists no copyright exception.
- Changes: WebP compression; linear-light luminance normalization in the renderer. This aesthetically adjusted texture is not used as absolute measured reflectance. Source hash in `sources.json`.

Milky Way and airglow: original procedural implementation, no third-party imagery. Research equations are credited in `README.md`.

Consumers must ship this credit file with their assets. No runtime hotlinks.
