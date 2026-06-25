# Plan: Addressables Build Layout Treemap HTML Tool

## Goal

Build a small static HTML tool that lets a user drag/drop a Unity Addressables `buildlayout.json` file and visualize its AssetBundle contents as a WinDirStat-style square treemap.

The tool should make bundle size distribution, duplicated assets, and top duplication offenders obvious at a glance.

## Deliverable

Create a browser-based static app. Prefer a simple structure:

```text
addressables-treemap/
  index.html
  styles.css
  main.js
```

A single self-contained `index.html` is also acceptable if that is easier for distribution.

No server should be required. The app should run by opening the HTML file directly in a modern browser.

Using D3 is recommended for the treemap layout. Avoid large frameworks unless there is a strong reason.

## Core User Flow

1. User opens the page.
2. User drags a `buildlayout.json` file onto the page, or clicks **Open File** in the sidebar.
3. The app parses the JSON.
4. The app normalizes the Addressables build layout into groups, bundles, and assets.
5. The app renders a square treemap occupying the full available page height.
6. The sidebar shows duplicate-size summary and a scrollable **Top Offenders** list.
7. User clicks any asset rectangle.
8. All duplicate occurrences of the same asset are highlighted across the treemap.
9. The lower sidebar shows detailed information for the selected asset, including size, duplication count, wasted duplicated size, and bundles containing it.

## Visual Layout

Use a two-column layout:

```text
Sidebar Top                                     |                         ... treemap ...                        |
[Open File]                                     |                         ... treemap ...                        |
Top Offenders (scrollable list)                 |                         ... treemap ...                        |
info about size/total duplicated size           |                         ... treemap ...                        |
------------------------------------------------|                         ... treemap ...                        |
Sidebar Bottom                                  |                         ... treemap ...                        |
[Select an asset to view info]                  |                         ... treemap ...                        |
info about selected cell                        |                         ... treemap ...                        |
Size, duplication count, etc                    |                         ... treemap ...                        |
bundles that contain it                         |                         ... treemap ...                        |
```

Suggested CSS layout:

```css
body {
    margin: 0;
    overflow: hidden;
}

.app {
    display: grid;
    grid-template-columns: 360px 1fr;
    height: 100vh;
}

.sidebar {
    display: grid;
    grid-template-rows: 1fr 1fr;
    min-height: 0;
}

.sidebar-panel {
    min-height: 0;
    overflow: hidden;
}

.treemap-area {
    display: grid;
    place-items: center;
    height: 100vh;
    overflow: hidden;
}

.treemap-square {
    width: min(100vh, calc(100vw - 360px));
    height: min(100vh, calc(100vw - 360px));
}
```

If the viewport is too narrow, reduce sidebar width or stack responsively, but the primary desktop layout should preserve the full-height square treemap.

## Data Model

The sample `buildlayout.json` will be provided. The first implementation task is to inspect the real schema and write an adapter for it.

Normalize the input into this shape internally:

```ts
type BuildModel = {
    groups: GroupNode[];
    bundles: BundleNode[];
    assets: AssetRecord[];
    duplicateGroups: DuplicateGroup[];
    totalSizeBytes: number;
    totalDuplicatedBytes: number;
};

type GroupNode = {
    id: string;
    name: string;
    bundles: BundleNode[];
    sizeBytes: number;
};

type BundleNode = {
    id: string;
    name: string;
    groupName: string;
    assets: AssetRecord[];
    sizeBytes: number;
};

type AssetRecord = {
    id: string;
    name: string;
    path: string;
    address?: string;
    guid?: string;
    type?: string;
    bundleName: string;
    groupName: string;
    sizeBytes: number;
    duplicateKey: string;
    source: unknown;
};

type DuplicateGroup = {
    duplicateKey: string;
    displayName: string;
    occurrences: AssetRecord[];
    occurrenceCount: number;
    totalBytes: number;
    uniqueBytes: number;
    duplicatedBytes: number;
    bundleNames: string[];
};
```

### Duplicate Key Rule

Use the most stable identifier available:

1. `guid`, if present.
2. Asset path, if present.
3. Address, if present.
4. Normalized asset name as a fallback.

Normalize keys by trimming whitespace, replacing backslashes with slashes, and lowercasing.

```js
function getDuplicateKey(asset)
{
    const raw = asset.guid || asset.path || asset.address || asset.name || asset.id;
    return String(raw).trim().replaceAll('\\', '/').toLowerCase();
}
```

### Duplicated Size Rule

For each duplicate group:

```text
uniqueBytes = largest single occurrence size, or first occurrence size if sizes are identical
duplicatedBytes = totalBytes - uniqueBytes
```

This avoids counting the first copy as waste.

Top offenders should be duplicate groups where `occurrenceCount > 1`, sorted by `duplicatedBytes DESC`.

## Parser Plan

Because Unity Addressables build layout schemas can vary by package version, keep parsing isolated:

```js
function normalizeBuildLayout(rawJson)
{
    // Inspect known buildlayout.json fields first.
    // Fall back to recursive search if needed.
    // Return BuildModel.
}
```

Implementation approach:

1. Inspect the provided sample JSON.
2. Identify exact fields for:
   - Groups
   - Bundles
   - Bundle names
   - Bundle sizes
   - Explicit assets
   - Implicit/dependent assets
   - Asset paths
   - Asset sizes
   - Asset GUIDs, if available
3. Write a direct parser for that schema.
4. Add defensive fallbacks for missing fields.
5. Log skipped/unrecognized nodes in the console, but do not crash the UI.

If both explicit and implicit assets are available, include both in the treemap by default. Add a future toggle later if needed.

## Treemap Hierarchy

Use this hierarchy for the primary treemap:

```text
Root
  Group
    Bundle
      Asset
```

Area should be based on asset size.

If bundle size is known but individual asset sizes do not add up exactly, still use asset sizes for leaf rectangles. Show bundle-level totals in tooltips/sidebar.

Suggested D3 hierarchy:

```js
const root = d3.hierarchy(treemapRoot)
    .sum(node => node.sizeBytes || 0)
    .sort((a, b) => b.value - a.value);

d3.treemap()
    .tile(d3.treemapSquarify)
    .size([squareSize, squareSize])
    .paddingOuter(2)
    .paddingTop(node => node.depth === 1 ? 16 : 2)
    .paddingInner(1)(root);
```

Render only leaf asset cells as clickable assets. Optionally render group and bundle labels when there is enough space.

## Color System

Use OKLab/OKLCH-based colors so the palette stays pleasant.

CSS supports `oklch()` in modern browsers, which is the polar form of OKLab. Use it for simple implementation.

### Bundle Color Range Allocation

Color ranges should be divided proportionally among asset bundles so assets in the same bundle fall into the same color range.

Algorithm:

1. Sort bundles by group name, then bundle name for deterministic layout/coloring.
2. Compute total bundle size.
3. Allocate each bundle a hue arc proportional to its size:

```text
bundleHueStart = cumulativeBundleSize / totalBundleSize * 360
bundleHueEnd = (cumulativeBundleSize + bundleSize) / totalBundleSize * 360
```

4. Assign each asset in the bundle a hue inside that bundle arc using a stable hash of the asset key.
5. Use lightness in the range `0.8` to `1.0`.
6. Use moderate chroma, for example `0.06` to `0.14`, to keep colors soft and readable.

Example:

```js
function makeAssetColor(asset, bundleRange)
{
    const t = hash01(asset.duplicateKey);
    const hue = lerp(bundleRange.startHue, bundleRange.endHue, t);
    const lightness = lerp(0.80, 1.00, hash01(asset.id + ':l'));
    const chroma = lerp(0.06, 0.14, hash01(asset.id + ':c'));

    return `oklch(${lightness} ${chroma} ${hue})`;
}
```

### Duplicate Color Rule

Duplicated assets must use the same base color as their first occurrence, even if later occurrences belong to another bundle/group color range.

Implementation:

```js
const firstColorByDuplicateKey = new Map();

function getAssetColor(asset, bundleRange)
{
    if (firstColorByDuplicateKey.has(asset.duplicateKey))
    {
        return firstColorByDuplicateKey.get(asset.duplicateKey);
    }

    const color = makeAssetColor(asset, bundleRange);
    firstColorByDuplicateKey.set(asset.duplicateKey, color);
    return color;
}
```

Define “first occurrence” by normalized parse order: group order, bundle order, then asset order from the JSON.

## Cell Distinction: Gradient / Pattern

Each cell should have a subtle gradient or pattern so adjacent cells remain visually distinct even with similar colors.

Recommended SVG approach:

1. Base rectangle fill uses the asset color.
2. Add a second rectangle overlay using a generated pattern or gradient.
3. Choose one of several subtle overlays by stable hash:
   - diagonal stripes
   - reversed diagonal stripes
   - soft vertical gradient
   - soft radial highlight
   - tiny dot pattern

Keep overlays subtle. They should separate cells without turning the treemap into a clown quilt.

Example SVG structure:

```html
<g class="cell asset-cell" data-asset-id="..." data-duplicate-key="...">
    <rect class="cell-base" fill="oklch(...)" />
    <rect class="cell-overlay" fill="url(#pattern-3)" opacity="0.16" />
</g>
```

Use stroke lines for normal boundaries:

```css
.asset-cell .cell-base {
    stroke: rgba(0, 0, 0, 0.18);
    stroke-width: 0.5;
}
```

## Selection and Highlighting

Clicking an asset cell should:

1. Store `selectedDuplicateKey`.
2. Highlight all cells with that duplicate key.
3. Update the lower sidebar with selected asset details.
4. Keep the highlight active until another asset is selected or Escape clears selection.

Highlight style:

```css
.asset-cell.is-selected .cell-base {
    stroke: black;
    stroke-width: 2.5;
}

.asset-cell.is-duplicate-highlight .cell-base {
    stroke: black;
    stroke-width: 2;
    filter: drop-shadow(0 0 4px rgba(0, 0, 0, 0.35));
}
```

When a duplicated asset is selected, every occurrence should have a visible border. The clicked cell can have a slightly stronger border.

## Sidebar: Top Panel

Top panel contents:

- App title
- File open button
- Drag/drop hint
- Loaded file name
- Total build size
- Total duplicated size
- Duplicate percentage
- Bundle count
- Asset count
- Duplicate asset group count
- Scrollable **Top Offenders** list

Top offenders row should show:

```text
Asset display name
Duplicated size / occurrence count
Bundles containing it
```

Clicking a top offender row should select that duplicate group and highlight all matching cells.

## Sidebar: Bottom Panel

Default state:

```text
Select an asset to view info.
```

Selected state should show:

- Asset name
- Path
- Address, if available
- GUID, if available
- Type, if available
- Single occurrence size
- Total bytes across all occurrences
- Duplicated/wasted bytes
- Duplication count
- Current bundle
- Current group
- All bundles containing this asset
- All groups containing this asset

If the selected asset has no duplicates, show:

```text
No duplicates found for this asset.
```

## File Loading

Support both:

1. Drag/drop JSON file anywhere on the page.
2. Clicking **Open File** and choosing a JSON file.

Implementation:

```js
async function loadFile(file)
{
    const text = await file.text();
    const json = JSON.parse(text);
    const model = normalizeBuildLayout(json);
    renderApp(model, file.name);
}
```

Error states:

- Invalid JSON: show a clear error in the sidebar.
- Parsed JSON but no assets found: show a clear error and ask the user to verify the file is an Addressables build layout JSON.
- Missing sizes: still render if possible, using `1` as fallback size and warning in sidebar.

## Responsiveness

On window resize:

1. Recompute square treemap size.
2. Re-run D3 treemap layout.
3. Re-render or update cell positions.
4. Preserve current selection.

Use `ResizeObserver` on the treemap area if possible.

## Tooltips

On hover, show a small tooltip with:

- Asset name
- Size
- Bundle
- Group
- Duplicate count
- Duplicated bytes, if duplicated

Do not put too much text inside treemap cells. Labels should only appear when the cell is large enough.

## Formatting Helpers

Implement:

```js
function formatBytes(bytes)
{
    // B, KB, MB, GB with one decimal where useful.
}

function hash01(value)
{
    // Stable string hash returning 0..1.
}

function lerp(a, b, t)
{
    return a + (b - a) * t;
}
```

## State Shape

Keep app state simple:

```js
const state = {
    rawJson: null,
    model: null,
    loadedFileName: null,
    selectedAssetId: null,
    selectedDuplicateKey: null,
    squareSize: 0,
};
```

Avoid over-engineering with state management libraries.

## Suggested Implementation Order

1. Create static page shell with sidebar and treemap area.
2. Add drag/drop and file input.
3. Load JSON and show basic file metadata.
4. Inspect sample `buildlayout.json` and implement `normalizeBuildLayout()`.
5. Build duplicate analysis.
6. Build D3 treemap hierarchy.
7. Render square treemap with basic colors.
8. Implement OKLCH bundle color ranges.
9. Add duplicate color reuse based on first occurrence.
10. Add gradient/pattern overlays.
11. Add click selection and duplicate highlighting.
12. Add top offenders list.
13. Add lower selected-asset info panel.
14. Add hover tooltips.
15. Add resize handling.
16. Add error states and empty states.
17. Test with the provided sample and at least one intentionally malformed JSON file.

## Acceptance Criteria

The tool is done when:

- A user can drag/drop a `buildlayout.json` file onto the page.
- A user can also load a file using **Open File**.
- The treemap renders as a square and uses the full available page height where possible.
- Treemap hierarchy is Group → Bundle → Asset.
- Cell area corresponds to asset size.
- Bundle color ranges are allocated proportionally by bundle size.
- Asset colors are generated in OKLab/OKLCH with lightness between `0.8` and `1.0`.
- Assets within the same bundle visually fall into the same color range.
- Duplicate assets use the same base color as their first occurrence, even when found in another bundle/group.
- Cells have subtle gradients or patterns so adjacent cells remain visually distinct.
- Clicking an asset highlights all duplicate occurrences across the treemap.
- The bottom sidebar shows selected asset details.
- The top sidebar shows total size, total duplicated size, duplicate percentage, and top offenders.
- Top offenders are sorted by duplicated/wasted bytes descending.
- Clicking a top offender highlights that asset across the treemap.
- Invalid or unsupported JSON produces a helpful error instead of a blank page.
- The app works without a backend.

## Nice-to-Have Later

Do not implement these until the core tool works:

- Toggle hierarchy: Group → Bundle → Asset vs Bundle → Asset Type → Asset.
- Search/filter assets by name/path/bundle.
- Toggle explicit-only vs explicit + implicit assets.
- Export duplicate report as CSV.
- Persist last loaded file name and view settings in local storage.
- Zoom into group/bundle on double-click.
- Breadcrumb navigation for zoomed treemap.
- Dark mode.

## Notes for the AI Agent

Prioritize clarity and correctness over architectural cleverness. Keep the tool small, inspectable, and easy to modify after the real `buildlayout.json` schema is known.

The most important implementation boundary is the parser. Keep all schema-specific logic inside `normalizeBuildLayout()`. Everything after that should operate on the normalized model.