"use strict";

/* =========================================================================
 * Addressables Build Layout Treemap
 * Single-file logic: parser -> model -> duplicate analysis -> render -> UI.
 * All schema-specific knowledge is confined to normalizeBuildLayout().
 * ========================================================================= */

/* ---------------------------- App state -------------------------------- */

const state = {
    rawJson: null,
    model: null,
    loadedFileName: null,
    selectedAssetId: null,
    selectedDuplicateKey: null,
    squareSize: 0,
};

// Maps an asset's first-occurrence colors, keyed by duplicateKey, so every
// duplicate occurrence renders with the same base color as the first copy.
// Each value is { color, muted }: the full color and a grayscale/dimmed fill
// used for non-highlighted cells while a selection is active.
let firstColorByDuplicateKey = new Map();

/* ----------------------------- Helpers --------------------------------- */

function formatBytes(bytes)
{
    if (bytes === null || bytes === undefined || isNaN(bytes)) return "—";
    const b = Number(bytes);
    if (b < 1024) return b + " B";
    const kb = b / 1024;
    if (kb < 1024) return kb.toFixed(1) + " KB";
    const mb = kb / 1024;
    if (mb < 1024) return mb.toFixed(1) + " MB";
    const gb = mb / 1024;
    return gb.toFixed(2) + " GB";
}

// Stable string hash returning a value in [0, 1).
function hash01(value)
{
    const str = String(value);
    let h = 2166136261 >>> 0; // FNV-1a
    for (let i = 0; i < str.length; i++)
    {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    // Spread bits, then normalize.
    h ^= h >>> 15;
    h = Math.imul(h, 2246822507);
    h ^= h >>> 13;
    return (h >>> 0) / 4294967296;
}

function lerp(a, b, t)
{
    return a + (b - a) * t;
}

function basename(path)
{
    if (!path) return "";
    const norm = String(path).replace(/\\/g, "/");
    const parts = norm.split("/");
    return parts[parts.length - 1] || norm;
}

function getDuplicateKey(asset)
{
    const raw = asset.guid || asset.path || asset.address || asset.name || asset.id;
    return String(raw).trim().replace(/\\/g, "/").toLowerCase();
}

// Best-effort label for the Addressables BuildLayout MainAssetType enum.
// The exact enum varies by package version, so unknown values fall back to
// "Type N" rather than guessing a possibly-wrong name.
const ASSET_TYPE_NAMES = {
    0: "Other",
};
function assetTypeLabel(t)
{
    if (t === null || t === undefined) return undefined;
    return ASSET_TYPE_NAMES[t] || ("Type " + t);
}

function escapeHtml(s)
{
    return String(s).replace(/[&<>"']/g, c => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c]);
}

/* ------------------------ Parser / normalization ----------------------- */

// Thrown for "parsed JSON but this is not an Addressables build layout".
class NotABuildLayoutError extends Error {}

const ASSET_CLASSES = new Set([
    "BuildLayout/ExplicitAsset",
    "BuildLayout/DataFromOtherAsset",
]);

function normalizeBuildLayout(rawJson)
{
    const warnings = [];

    const refsContainer = rawJson && rawJson.references;
    const refIds = refsContainer && Array.isArray(refsContainer.RefIds)
        ? refsContainer.RefIds
        : null;

    if (!refIds || !Array.isArray(rawJson.Groups))
    {
        throw new NotABuildLayoutError(
            "Missing references.RefIds or Groups. This does not look like a Unity Addressables build layout JSON.");
    }

    // 1. Index every serialized object by its rid.
    const byRid = new Map();
    for (const entry of refIds)
    {
        if (!entry || typeof entry.rid !== "number") continue;
        const cls = entry.type && entry.type.class ? entry.type.class : "";
        byRid.set(entry.rid, { class: cls, data: entry.data || {} });
    }

    const deref = (ref) =>
    {
        if (!ref || typeof ref.rid !== "number") return null;
        return byRid.get(ref.rid) || null;
    };

    let skippedNodes = 0;
    let missingSizeCount = 0;

    const groups = [];
    const bundles = [];
    const assets = [];
    const bundleById = new Map();
    const assetByRid = new Map(); // rid:number -> AssetRecord (for ReferencingAssets resolution)

    let autoAssetId = 0;

    // 2. Ordered walk: Groups -> Bundles -> Files -> (Assets, OtherAssets).
    //    This order defines canonical first-occurrence order.
    for (const groupRef of rawJson.Groups)
    {
        const groupObj = deref(groupRef);
        if (!groupObj || groupObj.class !== "BuildLayout/Group")
        {
            skippedNodes++;
            continue;
        }
        const groupData = groupObj.data;
        const groupName = groupData.Name || "(unnamed group)";
        const groupNode = {
            id: "g" + groupRef.rid,
            name: groupName,
            guid: groupData.Guid,
            bundles: [],
            sizeBytes: 0,
        };
        groups.push(groupNode);

        const bundleRefs = Array.isArray(groupData.Bundles) ? groupData.Bundles : [];
        for (const bundleRef of bundleRefs)
        {
            const bundleObj = deref(bundleRef);
            if (!bundleObj || bundleObj.class !== "BuildLayout/Bundle")
            {
                skippedNodes++;
                continue;
            }
            const bundleData = bundleObj.data;
            const bundleNode = {
                id: "b" + bundleRef.rid,
                name: bundleData.Name || "(unnamed bundle)",
                internalName: bundleData.InternalName,
                groupName: groupName,
                fileSize: typeof bundleData.FileSize === "number" ? bundleData.FileSize : null,
                compression: bundleData.Compression,
                assets: [],
                sizeBytes: 0,
            };
            bundles.push(bundleNode);
            bundleById.set(bundleNode.id, bundleNode);
            groupNode.bundles.push(bundleNode);

            const fileRefs = Array.isArray(bundleData.Files) ? bundleData.Files : [];
            for (const fileRef of fileRefs)
            {
                const fileObj = deref(fileRef);
                if (!fileObj || fileObj.class !== "BuildLayout/File")
                {
                    skippedNodes++;
                    continue;
                }
                const fileData = fileObj.data;
                const assetRefLists = [
                    fileData.Assets || [],       // ExplicitAsset
                    fileData.OtherAssets || [],  // DataFromOtherAsset (implicit)
                ];

                for (const list of assetRefLists)
                {
                    if (!Array.isArray(list)) continue;
                    for (const assetRef of list)
                    {
                        const assetObj = deref(assetRef);
                        if (!assetObj || !ASSET_CLASSES.has(assetObj.class))
                        {
                            skippedNodes++;
                            continue;
                        }
                        const d = assetObj.data;
                        const isExplicit = assetObj.class === "BuildLayout/ExplicitAsset";

                        const path = d.AssetPath || d.InternalId || "";
                        const serialized = typeof d.SerializedSize === "number" ? d.SerializedSize : 0;
                        const streamed = typeof d.StreamedSize === "number" ? d.StreamedSize : 0;
                        let sizeBytes = serialized + streamed;
                        if (!sizeBytes || sizeBytes <= 0)
                        {
                            sizeBytes = 1;
                            missingSizeCount++;
                        }

                        const record = {
                            id: assetRef.rid !== undefined ? String(assetRef.rid) : ("a" + (autoAssetId++)),
                            name: basename(path) || (d.Guid || d.AssetGuid || "(asset)"),
                            path: path,
                            address: isExplicit ? d.AddressableName : undefined,
                            guid: d.Guid || d.AssetGuid,
                            type: assetTypeLabel(d.MainAssetType),
                            explicit: isExplicit,
                            bundleId: bundleNode.id,
                            bundleName: bundleNode.name,
                            groupName: groupName,
                            sizeBytes: sizeBytes,
                            duplicateKey: "",
                            color: null,
                            source: d,
                        };
                        record.duplicateKey = getDuplicateKey(record);

                        assets.push(record);
                        if (typeof assetRef.rid === "number") assetByRid.set(assetRef.rid, record);
                        bundleNode.assets.push(record);
                        bundleNode.sizeBytes += sizeBytes;
                        groupNode.sizeBytes += sizeBytes;
                    }
                }
            }
        }
    }

    if (assets.length === 0)
    {
        throw new NotABuildLayoutError(
            "Parsed JSON but found no assets. Please verify the file is an Addressables build layout JSON.");
    }

    // 5. Duplicate analysis: group asset occurrences by duplicateKey.
    const dupMap = new Map();
    for (const a of assets)
    {
        let g = dupMap.get(a.duplicateKey);
        if (!g)
        {
            g = {
                duplicateKey: a.duplicateKey,
                displayName: a.name,
                occurrences: [],
                occurrenceCount: 0,
                totalBytes: 0,
                uniqueBytes: 0,
                duplicatedBytes: 0,
                bundleNames: [],
            };
            dupMap.set(a.duplicateKey, g);
        }
        g.occurrences.push(a);
    }

    let totalSizeBytes = 0;
    let totalDuplicatedBytes = 0;
    let maxOccurrenceCount = 1;
    const duplicateGroups = [];
    const bundleNameSet = new Set();

    for (const g of dupMap.values())
    {
        g.occurrenceCount = g.occurrences.length;
        if (g.occurrenceCount > maxOccurrenceCount) maxOccurrenceCount = g.occurrenceCount;
        let maxSize = 0;
        bundleNameSet.clear();
        for (const occ of g.occurrences)
        {
            g.totalBytes += occ.sizeBytes;
            if (occ.sizeBytes > maxSize) maxSize = occ.sizeBytes;
            bundleNameSet.add(occ.bundleName);
        }
        g.uniqueBytes = maxSize; // largest single occurrence; equal sizes -> first copy
        g.duplicatedBytes = g.totalBytes - g.uniqueBytes;
        g.bundleNames = Array.from(bundleNameSet).sort();

        totalSizeBytes += g.totalBytes;
        if (g.occurrenceCount > 1) totalDuplicatedBytes += g.duplicatedBytes;
        duplicateGroups.push(g);
    }

    // Attach the duplicate group to each asset, and resolve the addressable
    // assets that pulled each implicit occurrence into its bundle. Unity's
    // ReferencingAssets list always points to ExplicitAsset roots in the same
    // bundle, so this answers "why is this asset in this group".
    const dupByKey = dupMap;
    for (const a of assets)
    {
        a.dup = dupByKey.get(a.duplicateKey);

        if (a.explicit)
        {
            a.referencedBy = []; // an explicit asset is itself the addressable root
            continue;
        }
        const refs = Array.isArray(a.source.ReferencingAssets) ? a.source.ReferencingAssets : [];
        const seen = new Set();
        const referencers = [];
        for (const ref of refs)
        {
            const rec = ref && typeof ref.rid === "number" ? assetByRid.get(ref.rid) : null;
            if (rec && !seen.has(rec.id)) { seen.add(rec.id); referencers.push(rec); }
        }
        a.referencedBy = referencers;
    }

    if (skippedNodes > 0)
    {
        console.warn(`normalizeBuildLayout: skipped ${skippedNodes} unrecognized/empty nodes.`);
    }
    if (missingSizeCount > 0)
    {
        warnings.push(`${missingSizeCount} asset(s) had no size; using 1 byte as a fallback.`);
    }

    const model = {
        groups,
        bundles,
        assets,
        duplicateGroups,
        duplicateGroupsByKey: dupByKey,
        bundleById,
        totalSizeBytes,
        totalDuplicatedBytes,
        maxOccurrenceCount,
        warnings,
    };

    assignColors(model);
    return model;
}

/* ------------------------------ Colors --------------------------------- */

// Allocate each bundle a hue arc proportional to its size; assets within a
// bundle get a hue inside that arc from a stable hash of their duplicate key.
function assignColors(model)
{
    firstColorByDuplicateKey = new Map();

    // 1. Deterministic order: by group name, then bundle name.
    const ordered = model.bundles.slice().sort((a, b) =>
    {
        if (a.groupName !== b.groupName) return a.groupName < b.groupName ? -1 : 1;
        return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
    });

    const totalBundleSize = ordered.reduce((s, b) => s + (b.sizeBytes || 0), 0) || 1;

    let cumulative = 0;
    const rangeByBundleId = new Map();
    for (const b of ordered)
    {
        const startHue = (cumulative / totalBundleSize) * 360;
        cumulative += b.sizeBytes || 0;
        const endHue = (cumulative / totalBundleSize) * 360;
        rangeByBundleId.set(b.id, { startHue, endHue });
    }
    model.bundleColorRanges = rangeByBundleId;

    // 2. Assign each asset's color in first-occurrence (parse) order so that
    //    duplicates reuse the first occurrence's color (which determines the
    //    bundle hue arc). Brightness scales with how duplicated the asset is.
    const maxOcc = model.maxOccurrenceCount || 1;
    for (const asset of model.assets)
    {
        const range = rangeByBundleId.get(asset.bundleId) || { startHue: 0, endHue: 360 };
        asset.color = getAssetColor(asset, range, maxOcc);
    }
}

// Lightness encodes duplication: non-duplicated assets are dark (0.25), and
// duplicated assets brighten from 0.50 (2 copies) up to 1.00 (most duplicated).
function duplicationLightness(count, maxOcc)
{
    if (!count || count <= 1) return 0.25;
    if (maxOcc <= 2) return 1.00; // only 2x dups exist -> all at top of the bright range
    const t = Math.min(1, Math.log(count - 1) / Math.log(maxOcc - 1));
    return lerp(0.50, 1.00, t);
}

function makeAssetColors(asset, bundleRange, maxOcc)
{
    // Hue and chroma derive from the duplicate key so every occurrence of a
    // duplicated asset gets exactly the same flat color.
    const hue = lerp(bundleRange.startHue, bundleRange.endHue, hash01(asset.duplicateKey));
    const chroma = lerp(0.06, 0.14, hash01(asset.duplicateKey + ":c"));
    const count = asset.dup ? asset.dup.occurrenceCount : 1;
    const lightness = duplicationLightness(count, maxOcc);
    const color = `oklch(${lightness.toFixed(3)} ${chroma.toFixed(3)} ${hue.toFixed(1)})`;

    // Muted fill for the "everything except the selection" state: drop chroma to
    // 0 (grayscale) and blend lightness toward the dark treemap bg (L≈0.19),
    // baking the old `saturate(0)` + `opacity:.55` look into a flat color. This
    // lets selection swap a fill attribute instead of applying a per-cell SVG
    // filter, which was forcing thousands of offscreen raster passes.
    const mutedL = lightness * 0.55 + 0.085;
    const muted = `oklch(${mutedL.toFixed(3)} 0 ${hue.toFixed(1)})`;

    return { color, muted };
}

function getAssetColor(asset, bundleRange, maxOcc)
{
    let entry = firstColorByDuplicateKey.get(asset.duplicateKey);
    if (!entry)
    {
        entry = makeAssetColors(asset, bundleRange, maxOcc);
        firstColorByDuplicateKey.set(asset.duplicateKey, entry);
    }
    asset.colorMuted = entry.muted;
    return entry.color;
}

/* ------------------------------ Render --------------------------------- */

function buildHierarchy(model)
{
    return {
        name: "root",
        children: model.groups.map(g => ({
            name: g.name,
            kind: "group",
            children: g.bundles.map(b => ({
                name: b.name,
                kind: "bundle",
                bundle: b,
                children: b.assets.map(a => ({
                    name: a.name,
                    kind: "asset",
                    sizeBytes: a.sizeBytes,
                    asset: a,
                })),
            })),
        })),
    };
}

let cachedRoot = null; // d3 hierarchy, reused across resizes

function computeTreemapSize()
{
    const area = document.getElementById("treemap-square");
    const rect = area.getBoundingClientRect();
    return {
        w: Math.max(50, Math.floor(rect.width)),
        h: Math.max(50, Math.floor(rect.height)),
    };
}

// Truncate a label with an ellipsis so it fits within `widthPx`.
const LABEL_FONT = 11;
const LABEL_CHAR_W = 6.2; // approx px per character at LABEL_FONT
function fitLabel(text, widthPx)
{
    const maxChars = Math.floor((widthPx - 8) / LABEL_CHAR_W);
    if (maxChars >= text.length) return text;
    if (maxChars <= 1) return "";
    return text.slice(0, maxChars - 1) + "…";
}

// A group box gets a reserved label strip only when it is large enough to
// hold readable text; the same test gates the label's visibility.
function groupHasLabelStrip(node)
{
    return (node.x1 - node.x0) > 60 && (node.y1 - node.y0) > 26;
}

function renderTreemap()
{
    if (!state.model) return;
    const { w, h } = computeTreemapSize();
    state.squareSize = Math.min(w, h);

    const svg = d3.select("#treemap-svg")
        .attr("viewBox", `0 0 ${w} ${h}`)
        .attr("preserveAspectRatio", "none");

    if (!cachedRoot)
    {
        cachedRoot = d3.hierarchy(buildHierarchy(state.model))
            .sum(node => node.sizeBytes || 0)
            .sort((a, b) => b.value - a.value);
    }

    d3.treemap()
        .tile(d3.treemapSquarify)
        .size([w, h])
        .paddingOuter(2)
        // Reserve a 16px label strip only for groups big enough to label;
        // tiny groups get minimal top padding so their content fills the box.
        .paddingTop(node => node.depth === 1 ? (groupHasLabelStrip(node) ? 16 : 2) : 1)
        // No inner padding: adjacent cells touch with no gap. Cells stay
        // distinguishable via a thin centered stroke (see .cell-base in CSS),
        // which sits on the shared edge so hovering the border still hits a
        // cell — there is no gap to fall into.
        .paddingInner(0)(cachedRoot);

    // ---- Group container rectangles + labels ----
    const groupNodes = cachedRoot.descendants().filter(d => d.depth === 1);

    let containers = svg.select("g.containers");
    if (containers.empty()) containers = svg.append("g").attr("class", "containers");

    containers.selectAll("rect.group-rect")
        .data(groupNodes, d => d.data.name)
        .join("rect")
        .attr("class", "group-rect")
        .attr("x", d => d.x0).attr("y", d => d.y0)
        .attr("width", d => Math.max(0, d.x1 - d.x0))
        .attr("height", d => Math.max(0, d.y1 - d.y0));

    containers.selectAll("text.group-label")
        .data(groupNodes.filter(groupHasLabelStrip), d => d.data.name)
        .join("text")
        .attr("class", "group-label")
        .attr("x", d => d.x0 + 4)
        .attr("y", d => d.y0 + 12)
        .text(d => fitLabel(d.data.name, d.x1 - d.x0));

    // ---- Asset leaf cells (flat color, no overlay) ----
    // Skip sub-pixel cells for performance; they remain counted in totals.
    const leaves = cachedRoot.leaves().filter(d =>
        (d.x1 - d.x0) > 0.6 && (d.y1 - d.y0) > 0.6 && d.data.asset);

    let cellsLayer = svg.select("g.cells");
    if (cellsLayer.empty()) cellsLayer = svg.append("g").attr("class", "cells");

    const cells = cellsLayer.selectAll("g.asset-cell")
        .data(leaves, d => d.data.asset.id)
        .join(enter =>
        {
            const g = enter.append("g")
                .attr("class", "asset-cell")
                .attr("data-asset-id", d => d.data.asset.id)
                .attr("data-duplicate-key", d => d.data.asset.duplicateKey);
            g.append("rect").attr("class", "cell-base");
            return g;
        });

    cells.attr("transform", d => `translate(${d.x0},${d.y0})`);
    cells.select("rect.cell-base")
        .attr("width", d => Math.max(0, d.x1 - d.x0))
        .attr("height", d => Math.max(0, d.y1 - d.y0))
        .attr("fill", d => d.data.asset.color);

    // (Re)wire interaction handlers. Clicking the selected asset or any of its
    // duplicates toggles the selection off.
    cells
        .on("click", (event, d) =>
        {
            const asset = d.data.asset;
            if (state.selectedDuplicateKey === asset.duplicateKey) clearSelection();
            else selectAsset(asset);
        })
        .on("mousemove", (event, d) => showTooltip(event, d.data.asset))
        .on("mouseleave", hideTooltip);

    applySelectionClasses();
}

/* --------------------------- Selection --------------------------------- */

function selectAsset(asset)
{
    state.selectedAssetId = asset.id;
    state.selectedDuplicateKey = asset.duplicateKey;
    applySelectionClasses();
    renderDetail(asset);
    document.getElementById("deselect-btn").hidden = false;
    syncOffenderActive();
}

function selectDuplicateKey(duplicateKey)
{
    const group = state.model.duplicateGroupsByKey.get(duplicateKey);
    if (!group || group.occurrences.length === 0) return;
    // Use the first (largest-context) occurrence as the "selected" asset.
    selectAsset(group.occurrences[0]);
}

function clearSelection()
{
    state.selectedAssetId = null;
    state.selectedDuplicateKey = null;
    applySelectionClasses();
    document.getElementById("detail").innerHTML = defaultDetailHtml();
    document.getElementById("deselect-btn").hidden = true;
    syncOffenderActive();
}

// Shown in the bottom panel when nothing is selected: a hint plus a legend
// explaining the brightness-encodes-duplication color scheme.
function defaultDetailHtml()
{
    return '<p class="placeholder">Select an asset to view info.</p>' +
        '<div class="legend">' +
        '<div class="legend-title">Brighter colors indicate higher duplication</div>' +
        '<div class="legend-bar"></div>' +
        '<div class="legend-scale"><span>unique</span><span>most duplicated</span></div>' +
        '</div>';
}

function applySelectionClasses()
{
    const square = document.getElementById("treemap-square");
    const key = state.selectedDuplicateKey;
    square.classList.toggle("has-selection", !!key);

    const cells = d3.selectAll("#treemap-svg g.asset-cell")
        .classed("is-duplicate-highlight", d => key && d.data.asset.duplicateKey === key)
        .classed("is-selected", d => state.selectedAssetId && d.data.asset.id === state.selectedAssetId);

    // Dim non-selected cells by swapping to a precomputed muted fill rather than
    // an SVG filter, so selecting (and repainting while selected) stays cheap.
    cells.select("rect.cell-base").attr("fill", d =>
    {
        const asset = d.data.asset;
        return (key && asset.duplicateKey !== key) ? asset.colorMuted : asset.color;
    });
}

/* ----------------------------- Sidebar --------------------------------- */

function renderSummary(model, fileName)
{
    const dupGroups = model.duplicateGroups.filter(g => g.occurrenceCount > 1);
    const dupPct = model.totalSizeBytes > 0
        ? (model.totalDuplicatedBytes / model.totalSizeBytes) * 100
        : 0;

    const stat = (label, value, wide) =>
        `<div class="stat${wide ? " wide" : ""}"><span class="label">${label}</span><span class="value">${value}</span></div>`;

    const summary = document.getElementById("summary");
    summary.innerHTML =
        stat("File", escapeHtml(fileName || "—"), true) +
        stat("Total size", formatBytes(model.totalSizeBytes)) +
        stat("Duplicated", formatBytes(model.totalDuplicatedBytes)) +
        stat("Duplicate %", dupPct.toFixed(1) + "%") +
        stat("Bundles", model.bundles.length) +
        stat("Assets", model.assets.length.toLocaleString()) +
        stat("Dup groups", dupGroups.length.toLocaleString());
}

function renderOffenders(model)
{
    const offenders = model.duplicateGroups
        .filter(g => g.occurrenceCount > 1)
        .sort((a, b) => b.duplicatedBytes - a.duplicatedBytes)
        .slice(0, 300);

    const ul = document.getElementById("offenders");
    ul.innerHTML = "";

    for (const g of offenders)
    {
        const li = document.createElement("li");
        li.className = "offender";
        li.dataset.duplicateKey = g.duplicateKey;
        const entry = firstColorByDuplicateKey.get(g.duplicateKey);
        const color = entry ? entry.color : "#888";
        li.innerHTML =
            `<div class="o-name"><span class="swatch" style="background:${color}"></span>${escapeHtml(g.displayName)}</div>` +
            `<div class="o-meta">${formatBytes(g.duplicatedBytes)} wasted · ${g.occurrenceCount}× · ${g.bundleNames.length} bundles</div>`;
        li.addEventListener("click", () => selectDuplicateKey(g.duplicateKey));
        ul.appendChild(li);
    }

    if (offenders.length === 0)
    {
        ul.innerHTML = '<li class="offender" style="cursor:default">No duplicated assets found.</li>';
    }
}

function syncOffenderActive()
{
    const key = state.selectedDuplicateKey;
    document.querySelectorAll("#offenders .offender").forEach(li =>
    {
        li.classList.toggle("is-active", !!key && li.dataset.duplicateKey === key);
    });
    const active = document.querySelector("#offenders .offender.is-active");
    if (active) active.scrollIntoView({ block: "nearest" });
}

// Per-group breakdown of *why* each group contains the duplicated asset:
// the addressable root assets (ExplicitAssets) whose dependency closure pulled
// it into that group's bundle, read from each occurrence's referencedBy list.
const MAX_REFS_SHOWN = 5;
function renderWhyGroups(g)
{
    // Aggregate occurrences by group, preserving each group's referencers.
    const byGroup = new Map();
    for (const occ of g.occurrences)
    {
        let entry = byGroup.get(occ.groupName);
        if (!entry) { entry = { directlyAddressable: false, refs: new Map() }; byGroup.set(occ.groupName, entry); }
        if (occ.explicit) entry.directlyAddressable = true;
        for (const ref of (occ.referencedBy || []))
        {
            if (!entry.refs.has(ref.id)) entry.refs.set(ref.id, ref);
        }
    }

    const groupNames = Array.from(byGroup.keys()).sort();
    let html = `<div class="d-section-title">Groups containing this asset (${groupNames.length})</div>`;

    for (const name of groupNames)
    {
        const entry = byGroup.get(name);
        html += `<div class="d-why-group">${escapeHtml(name)}</div>`;

        const refs = Array.from(entry.refs.values());
        const parts = [];
        if (entry.directlyAddressable) parts.push("directly addressable here");
        if (refs.length)
        {
            const shown = refs.slice(0, MAX_REFS_SHOWN).map(r => escapeHtml(r.name)).join(", ");
            const extra = refs.length > MAX_REFS_SHOWN ? ` (+${refs.length - MAX_REFS_SHOWN} more)` : "";
            parts.push("pulled in by: " + shown + extra);
        }
        if (parts.length === 0) parts.push("no recorded referencer");

        html += `<div class="d-why-refs">${parts.join("<br>")}</div>`;
    }
    return html;
}

function renderDetail(asset)
{
    const g = asset.dup;
    const isDuplicated = g && g.occurrenceCount > 1;

    const row = (label, value) =>
        value === undefined || value === null || value === ""
            ? ""
            : `<div class="d-row"><span class="label">${label}</span><span class="value">${escapeHtml(value)}</span></div>`;

    let html = `<p class="d-name">${escapeHtml(asset.name)}</p>`;

    if (asset.path)
    {
        html += '<div class="d-path">' +
            `<span class="d-path-text">${escapeHtml(asset.path)}</span>` +
            '<button class="copy-path" type="button">Copy Path</button>' +
            '</div>';
    }

    html += row("Address", asset.address);
    html += row("GUID", asset.guid);
    html += row("Size", formatBytes(asset.sizeBytes));

    if (g)
    {
        html += row("Occurrences", g.occurrenceCount);
        html += row("Total (all copies)", formatBytes(g.totalBytes));
        html += row("Wasted (duplicated)", formatBytes(g.duplicatedBytes));
    }

    html += row("Group", asset.groupName);

    if (isDuplicated)
    {
        html += renderWhyGroups(g);
    }
    else
    {
        html += '<p class="no-dupes">No duplicates found for this asset.</p>';
    }

    const detailEl = document.getElementById("detail");
    detailEl.innerHTML = html;

    const copyBtn = detailEl.querySelector(".copy-path");
    if (copyBtn)
    {
        copyBtn.addEventListener("click", () =>
        {
            navigator.clipboard.writeText(asset.path).then(() =>
            {
                copyBtn.textContent = "Copied!";
                setTimeout(() => { copyBtn.textContent = "Copy Path"; }, 1200);
            }).catch(() =>
            {
                copyBtn.textContent = "Copy failed";
                setTimeout(() => { copyBtn.textContent = "Copy Path"; }, 1200);
            });
        });
    }
}

/* ----------------------------- Tooltip --------------------------------- */

const tooltipEl = () => document.getElementById("tooltip");

function showTooltip(event, asset)
{
    const g = asset.dup;
    const isDup = g && g.occurrenceCount > 1;
    let html = `<div class="t-name">${escapeHtml(asset.name)}</div>`;
    html += `<div class="t-row">Size: <b>${formatBytes(asset.sizeBytes)}</b></div>`;
    html += `<div class="t-row">Group: <b>${escapeHtml(asset.groupName)}</b></div>`;
    if (isDup)
    {
        html += `<div class="t-row t-dup">Duplicated ${g.occurrenceCount}× · ${formatBytes(g.duplicatedBytes)} wasted</div>`;
    }

    const t = tooltipEl();
    t.innerHTML = html;
    t.classList.add("visible");

    const pad = 14;
    let x = event.clientX + pad;
    let y = event.clientY + pad;
    const r = t.getBoundingClientRect();
    if (x + r.width > window.innerWidth) x = event.clientX - r.width - pad;
    if (y + r.height > window.innerHeight) y = event.clientY - r.height - pad;
    t.style.left = x + "px";
    t.style.top = y + "px";
}

function hideTooltip()
{
    tooltipEl().classList.remove("visible");
}

/* ------------------------------ Messages ------------------------------- */

function showMessage(text, kind)
{
    const el = document.getElementById("messages");
    el.innerHTML = `<div class="message ${kind || "error"}">${escapeHtml(text)}</div>`;
}

function appendMessage(text, kind)
{
    const el = document.getElementById("messages");
    el.insertAdjacentHTML("beforeend", `<div class="message ${kind || "warn"}">${escapeHtml(text)}</div>`);
}

function clearMessages()
{
    document.getElementById("messages").innerHTML = "";
}

/* ------------------------------ App flow ------------------------------- */

function renderApp(model, fileName)
{
    state.model = model;
    state.loadedFileName = fileName;
    state.selectedAssetId = null;
    state.selectedDuplicateKey = null;
    cachedRoot = null;

    document.getElementById("empty-state").classList.add("hidden");

    renderSummary(model, fileName);
    renderOffenders(model);
    document.getElementById("detail").innerHTML = defaultDetailHtml();
    document.getElementById("deselect-btn").hidden = true;

    renderTreemap();

    if (model.warnings && model.warnings.length)
    {
        for (const w of model.warnings) appendMessage(w, "warn");
    }

    console.log("Build layout loaded:", {
        groups: model.groups.length,
        bundles: model.bundles.length,
        assets: model.assets.length,
        duplicateGroups: model.duplicateGroups.filter(g => g.occurrenceCount > 1).length,
        totalSize: formatBytes(model.totalSizeBytes),
        totalDuplicated: formatBytes(model.totalDuplicatedBytes),
    });
}

async function loadFile(file)
{
    if (!file) return;
    clearMessages();
    showMessage(`Parsing ${file.name} …`, "warn");

    try
    {
        const text = await file.text();
        let json;
        try
        {
            json = JSON.parse(text);
        }
        catch (e)
        {
            clearMessages();
            showMessage("Invalid JSON: " + e.message, "error");
            return;
        }

        // Yield so the "Parsing…" message paints before the heavy work.
        await new Promise(r => setTimeout(r, 0));

        let model;
        try
        {
            model = normalizeBuildLayout(json);
        }
        catch (e)
        {
            clearMessages();
            if (e instanceof NotABuildLayoutError)
            {
                showMessage(e.message, "error");
            }
            else
            {
                console.error(e);
                showMessage("Failed to parse build layout: " + e.message, "error");
            }
            return;
        }

        clearMessages();
        state.rawJson = json;
        renderApp(model, file.name);
    }
    catch (e)
    {
        console.error(e);
        clearMessages();
        showMessage("Could not read file: " + e.message, "error");
    }
}

/* ---------------------------- Wiring / events -------------------------- */

function initEvents()
{
    const fileInput = document.getElementById("file-input");
    document.getElementById("open-file-btn").addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () =>
    {
        if (fileInput.files && fileInput.files[0]) loadFile(fileInput.files[0]);
        fileInput.value = "";
    });

    // Drag & drop anywhere on the page.
    const overlay = document.getElementById("drop-overlay");
    let dragDepth = 0;
    window.addEventListener("dragenter", (e) =>
    {
        e.preventDefault();
        dragDepth++;
        overlay.classList.add("active");
    });
    window.addEventListener("dragover", (e) => e.preventDefault());
    window.addEventListener("dragleave", (e) =>
    {
        e.preventDefault();
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) overlay.classList.remove("active");
    });
    window.addEventListener("drop", (e) =>
    {
        e.preventDefault();
        dragDepth = 0;
        overlay.classList.remove("active");
        const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (file) loadFile(file);
    });

    // Deselect button + Escape both clear the current selection.
    document.getElementById("deselect-btn").addEventListener("click", clearSelection);
    window.addEventListener("keydown", (e) =>
    {
        if (e.key === "Escape") clearSelection();
    });

    // Responsive re-layout, debounced via rAF.
    let rafId = null;
    const ro = new ResizeObserver(() =>
    {
        if (!state.model) return;
        if (rafId) cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(() => { rafId = null; renderTreemap(); });
    });
    ro.observe(document.getElementById("treemap-square"));
}

initEvents();
