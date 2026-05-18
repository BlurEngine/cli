# World Image Rendering Standard

This standard records the current expectations and lessons learned for `blr world image` and generated `assets.zip` world image outputs.

## Current Outputs

`blr world image` exports deterministic top-down PNG assets from the selected Bedrock project world source:

- `map.png`: loaded-column coverage from `Data3D` records.
- `map.terrain.png`: terrain colors from actual top-column block data.
- `map.shade.png`: grayscale local relief shading from block-derived top-column Y values.
- `map.full.png`: terrain colors multiplied by local relief shading.
- `map.terrain.audit.json`: processed world dimensions, palette, tint, fallback, and diagnostic counts for the terrain render.

The `assets` package target includes the same generated files when `package.assets.worldImage.enabled` is `true`.

## Source Of Truth

Terrain truth comes from `SubChunkPrefix` block data. Do not use the `Data3D` heightmap cache as terrain truth; it has already proven unreliable for exact terrain height and can create misleading output.

`Data3D` remains useful for:

- loaded-column coverage;
- biome palettes used for grass, foliage, and water tinting;
- diagnostics around available world data.

The terrain renderer follows this rule:

```text
one output pixel = the actual top visible block in that (x,z) column
```

Do not fill holes in trees, infer hidden leaves, average nearby blocks, or replace the chosen block with a more visually convenient neighbor. If the actual top visible block in a column is stone, grass, water, leaves, or a flower, that block is the pixel source.

## Color Palette

The terrain palette is generated from an external `bedrock-samples` checkout. The CLI repo may commit compact derived color metadata, but must not commit texture assets, copied upstream asset files, or machine-local asset paths.

Biome tinting happens at render time. Grass, foliage, and water colors use the biome at the selected top block's Y slice. Modern Bedrock biome data should be treated as Y-aware; do not assume biomes are XZ-only.

Keep the terrain audit useful. It should expose processed world bounds, block dimensions, image dimensions, top-block Y range, unknown blocks, fallback colors, variant-defaulted blocks, tint-role counts, tintable blocks without biome data, and other diagnostics that help maintain the palette.

## Shading

`map.shade.png` is a local relief map, not an absolute height map. It communicates neighboring column differences such as slopes, cliffs, roof edges, tree-canopy texture, and island rims. It does not promise that a flat high plateau will differ from a flat low beach.

That distinction should stay clear in docs and code:

- local relief shading answers "where does this surface change nearby?";
- absolute height output, if added later, answers "how high is this column in the world?".

The current `map.full.png` is the first user-facing combined view. It keeps the block-derived terrain colors and applies the local relief signal without re-reading LevelDB.

## Blur And Smoothing

Do not blur the default shade or full outputs.

A blur experiment was reviewed against a large real-world project area with dense foliage, built structures, shorelines, flat filled regions, and steep terrain. A small blur made foliage look calmer, but it also spread local height signals into neighboring columns. A larger blur washed out useful relief. Stronger shade variants looked embossed rather than factual.

For this CLI feature, smoothing is disingenuous as a default because it invents continuity that is not present in the per-column top-block data. If a stylized smoothed render is ever useful, add it as an explicitly named optional variant rather than changing `map.shade.png` or `map.full.png`.

## Performance Boundary

Do not add image variants by re-reading LevelDB. The expensive step is the world scan.

The expected flow is:

1. Copy the world `db/` directory to a temporary location.
2. Read Bedrock world data once.
3. Build loaded-column and terrain column data from that pass.
4. Derive audit, shade, terrain, and full outputs from the in-memory terrain columns.
5. Write all PNGs and JSON outputs.

One large real-world export showed that shading is cheap compared with the world read:

- `build-shading-map`: about `318ms`;
- `render-shade`: about `79ms`;
- `render-full`: about `972ms`;
- total export stayed around `31s`.

That performance is acceptable while the visual contract is still evolving.

## Future Work

Prefer factual new layers over smoothing or visual guesswork:

- block-derived absolute height PNG with a documented fixed Y range;
- separate relative-relief or edge PNGs;
- optional contour output derived directly from neighboring column differences;
- output selection flags once stable variants are known.

Avoid default behavior that hides the exact top-block signal, fills holes, blurs sparse structures, or makes the map look more complete than the world data supports.
