import {segmentPaint, paintCSS} from './paint.mjs';
import { icon } from "./icons.mjs";
import { isStatic } from "./pivot/geometry.mjs";
import { formatPropertyValue } from "./property-controls.mjs";
import { cameraActionsView } from "./camera-view.mjs";
import { cameraValues } from "./editor-camera.mjs";
import { builderDrawables } from './editor-builder-style.mjs';
import { isBuilderContext } from './builder-aids.mjs';
import {resolveInstanceFigure} from './animation-style.mjs';
import {ikControlsView} from './ik-view.mjs';
import {isMovieclip} from './movieclips.mjs';
import {movieclipInspector} from './movieclip-ui.mjs';
import {sheetKeyAt} from './layer-sheet.mjs';
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const hex = (rgb) =>
  "#" +
  (rgb || [43, 43, 43])
    .map((n) => Math.round(n).toString(16).padStart(2, "0"))
    .join("");
const num = (n) => Number(Number(n ?? 0).toFixed(2));
const animatedProperties = new Set([
  "scale",
  "figure_opacity",
  "figure_z_order",
  "outline_opacity",
  "outline_width",
  "thickness",
  "segment_opacity",
  "segment_gradient_opacity",
  "camera_x",
  "camera_y",
  "camera_scale",
  "camera_angle",
]);
const integerProperties = new Set([
  "fps",
  "canvas_width",
  "canvas_height",
  "duration",
]);
function numericField(
  label,
  key,
  value,
  unit = "",
  limits = "",
  state = {},
  options = {},
) {
  const animated = options.animated ?? animatedProperties.has(key),
    precision = integerProperties.has(key) || key.endsWith('_z_order') ? 0 : 3;
  value = state?.value ?? value;
  const description =
    options.description || `${label}${unit ? ` (${unit})` : ""}`;
  const keys = animated
    ? keyControlGroup(key, description, state)
    : "";
  return `<div class="property-row${keys ? " is-animatable" : options.wide ? " is-wide" : ""}" data-property-row="${key}" data-animation-source="${state?.source ?? ''}"><label class="field"><span class="property-scrub" data-property-scrub tabindex="0" role="button" aria-label="Scrub ${esc(description)}" title="Drag to adjust · Shift: fine · Alt: extra fine">${label}</span><input type="number" ${options.id ? `id="${options.id}"` : ""} ${options.legacyField === false ? "" : `data-field="${key}"`} data-property="${key}" data-property-value="${esc(value)}" data-property-precision="${precision}" data-property-step="1" value="${formatPropertyValue(value, precision)}" step="any" aria-label="${esc(description)}" ${limits}><small>${unit}</small></label>${keys}</div>`;
}
function keyControls(key, label, state = {}) {
  if (state?.poseOnly || (state?.source === 'pose' || state?.poseKeyed || state?.poseAnimated) && !state?.animated && !state?.keyed) return '';
  const title = `${state?.keyed ? 'Remove' : 'Add'} ${label} keyframe`;
  const classes = state?.keyed ? 'is-keyed' : state?.animated ? 'is-animated' : '';
  const marker =
    `<button type="button" data-property-key="${key}" class="${classes}" aria-pressed="${Boolean(state?.keyed)}" title="${esc(title)}" aria-label="${esc(title)}">${icon('diamond')}</button>`;
  return `<button type="button" data-property-nav="${key}" data-direction="-1" title="Previous ${esc(label)} keyframe" aria-label="Previous ${esc(label)} keyframe" ${state?.previous ? '' : 'disabled'}>${icon('chevron-left')}</button>${marker}<button type="button" data-property-nav="${key}" data-direction="1" title="Next ${esc(label)} keyframe" aria-label="Next ${esc(label)} keyframe" ${state?.next ? '' : 'disabled'}>${icon('chevron-right')}</button>`;
}
function keyControlGroup(key, label, state) {
  const controls = keyControls(key, label, state);
  return controls ? `<div class="property-key-controls">${controls}</div>` : '';
}
const heading = (title, symbol) =>
  `<div class="property-context-heading"><span>${icon(symbol)}</span><div><strong>${esc(title)}</strong></div></div>`;
const button = (action, symbol, title, disabled = false) =>
  `<button class="icon-button" data-action="${action}" title="${title}" aria-label="${title}" ${disabled ? "disabled" : ""}>${icon(symbol)}</button>`;
const secondarySections = new Set(["Connections", "Polygons", "Canvas alignment", "Neighboring pose"]);
const group = (title, body, extra = "") => secondarySections.has(title)
  ? `<details class="inspector-section inspector-disclosure" data-section="${esc(title)}"><summary class="inspector-title"><span>${title}</span>${extra}</summary><div class="inspector-disclosure-body">${body}</div></details>`
  : `<section class="inspector-section"><div class="inspector-title"><span>${title}</span>${extra}</div>${body}</section>`;
const grid = (body) => `<div class="field-grid">${body}</div>`;
const tools = (body) => `<div class="transform-actions">${body}</div>`;
const builderOrderButtons = (kind, index) => tools(
  [['back','send-to-back','Send to back'],['down','chevron-left','Send backward'],['up','chevron-right','Bring forward'],['front','bring-to-front','Bring to front']]
    .map(([direction,symbol,label]) => `<button type="button" class="icon-button" data-action="builder-order" data-kind="${kind}" data-index="${index}" data-direction="${direction}" title="${label} · ${kind}" aria-label="${label} · ${kind}">${icon(symbol)}</button>`).join(''),
);
const colorRow = (id, label, value, opacityId, opacity) =>
  `<div class="color-row"><input id="${id}" type="color" value="${value}" aria-label="${label}"><span class="hex-label">${value.slice(1).toUpperCase()}</span>${opacityId ? `<input id="${opacityId}" type="number" value="${num(opacity)}" min="0" max="100" aria-label="${label} opacity"><small>%</small>` : ""}</div>`;

function figureLayerField(editor){
  if(!editor.selectedUids.size)return '';
  const ids=new Set([...editor.selectedUids].map(uid=>editor.layerForUid(uid))),current=ids.size===1?[...ids][0]:'';
  return `<div class="figure-layer-field"><label for="figure-layer">${icon('layers')}Layer</label><select id="figure-layer" class="inline-select" aria-label="Figure layer">${!current?'<option value="" disabled selected>Mixed</option>':''}${editor.layers.filter(layer=>layer.kind==='layer').reverse().map(layer=>`<option value="${esc(layer.id)}" ${layer.id===current?'selected':''} ${layer.locked?'disabled':''}>${esc(layer.name)}</option>`).join('')}</select></div>`;
}

export function inspectorView({
  editor,
  tab = "design",
  tool = "select",
  rigMode = "move",
  selectionCount = 1,
  bounds,
  rangeIndices = [],
  applyRange = false,
  polygonPage = 0,
  context = "auto",
  propertyState,
  builderBranch = false,
}) {
  if(editor.report._styk?.layerSheet){const original=propertyState;propertyState=key=>({...original?.(key),poseOnly:true});}
  const report = editor.report,
    frame = editor.frame,
    object = editor.object;
  const field = (label, key, value, unit = "", limits = "", options = {}) =>
    numericField(
      label,
      key,
      value,
      unit,
      limits,
      propertyState?.(key),
      options,
    );
  const resolvedContext =
    context === "auto"
      ? tab === "animation"
        ? "frame"
        : object
          ? "figure"
          : "scene"
      : context;
  if (resolvedContext === "camera") return cameraView(editor, field);
  if (resolvedContext === "layer") return layerView(editor);
  if (resolvedContext === "frame") return frameView(editor, field);
  if (resolvedContext === "scene" || !object)
    return sceneView(editor, field, propertyState);
  if (selectionCount===1 && isMovieclip(editor.figure)) return figureLayerField(editor)+movieclipInspector(editor,field);
  const range =
    rangeIndices.length > 1
      ? group(
          "Frame range",
          `<label class="check-row"><input id="apply-range-movement" type="checkbox" ${applyRange ? "checked" : ""}>Apply to ${rangeIndices.length} selected frames</label>`,
        )
      : "";
  if (selectionCount > 1) {
    const b = bounds;
    return (
      heading(`${selectionCount} figures`, "layers") + figureLayerField(editor) +
      group(
        "Selection",
        tools(
          button("duplicate", "duplicate", "Duplicate selection") +
            button("delete", "trash", "Delete selection"),
        ),
      ) +
      range +
      group(
        "Transform",
        grid(
          field("X", "group_x", b.minX, "px") +
            field("Y", "group_y", b.minY, "px") +
            field("W", "group_width", b.maxX - b.minX, "px", 'min="0.01"') +
            field("H", "group_height", b.maxY - b.minY, "px", 'min="0.01"'),
        ) +
          tools(
            button("mirror", "flip", "Flip horizontally") +
              button("rotate", "rotate", "Rotate 15°") +
              button("center", "center", "Center selection"),
          ),
      ) +
      group(
        "Align",
        tools(
          [
            ["left", "align-left"],
            ["center-x", "align-horizontal-center"],
            ["right", "align-right"],
            ["top", "align-top"],
            ["center-y", "align-vertical-center"],
            ["bottom", "align-bottom"],
          ]
            .map(([a, i]) =>
              button(`align-${a}`, i, `Align ${a.replace("-", " ")}`),
            )
            .join(""),
        ),
      ) +
      group(
        "Appearance",
        colorRow("figure-color", "Figure color", "#2b2b2b") +
          `<div class="field-grid property-opacity-grid">${field("Opacity", "figure_opacity", (1 - (object.field28 || 0) / 255) * 100, "%", 'min="0" max="100"', { id: "figure-opacity", legacyField: false, animated: false, wide: true })}</div>` +
          tools(
            button("reset-color", "undo", "Reset colors") +
              button("layer-down", "send-to-back", "Send backward") +
              button("layer-up", "bring-to-front", "Bring forward"),
          ),
      ) +
      group(
        "Connections",
        `<button class="button" data-action="combine-figures">${icon("combine")}Combine connected</button>`,
      )
    );
  }
  const figure = resolveInstanceFigure(editor.figure, object),
    joint = editor.selectedJoint,
    segment = figure.segments[joint],
    style = figure.segment_decode?.global_style || {},
    raw = Number(object.color_override_raw) >>> 0;
  const drawOrder = new Map(builderDrawables(figure).map((item,index)=>[`${item.kind}:${item.index}`,index+1]));
  const orderLimits = `min="1" max="${drawOrder.size}"`;
  const fill = hex(
    raw >>> 24
      ? [raw & 255, (raw >>> 8) & 255, (raw >>> 16) & 255]
      : figure.segments[0]?.color_rgb,
  );
  const kind = figure.segments.every((s) => s.primitive_code === 5)
    ? "text"
    : figure.segments.every((s) => s.primitive_code === 2)
      ? "image"
      : "figure";
  const title = group(
    "",
    `<div class="object-heading"><span>${icon(kind === "text" ? "text" : kind === "image" ? "image" : "person")}</span><input id="figure-name" class="figure-name" value="${esc(figure.name || "Figure")}" aria-label="Figure name" title="Rename figure definition"></div>`,
  );
  // Pivot origins use -1; segment endpoint indices start at zero.
  const jointScope = joint >= 0 && Boolean(segment);
  let html = (jointScope ? "" : title) + figureLayerField(editor) + range;
  if (!jointScope) {
    if (object.join || frame.objects.some(part => part.join?.target_object_slot === object.object_slot)) {
      html += group('Connected figure',
        `<button type="button" class="button" data-action="combine-figures">${icon('combine')}Merge into one figure</button>`);
    }
    if (tool === "rig")
      html += group(
        "Edit rig",
        `<select id="rig-mode" class="inline-select" aria-label="Rig edit mode"><option value="move" ${rigMode === "move" ? "selected" : ""}>Move joint</option><option value="rotate" ${rigMode === "rotate" ? "selected" : ""}>Rotate branch</option></select><button type="button" class="button" data-action="add-sprite-segment">${icon('image')}Add sprite part…</button>`,
      );
    if (figure.text_assets?.some((asset) => asset.glyphs?.length))
      html += group(
        "Text",
        `<button class="button" data-action="edit-text">${icon("text")}Edit text</button>`,
      );
    html += group(
      "Transform",
      grid(
        field("X", "root_x", object.root_x, "px") +
          field("Y", "root_y", object.root_y, "px") +
          field("Scale", "scale", object.scale * 100, "%", 'min="0.01"') +
          field(
            "Angle",
            "rotation",
            (((object.angles[0] ?? 0) - (figure.segments[0]?.angle_rad ?? 0)) *
              180) /
              Math.PI,
            "°",
          ),
      ),
    );
    html += group(
      "Appearance",
      `<div class="property-paint-row">${colorRow("figure-color", "Figure color", fill)}${keyControlGroup('figure_color', 'figure color', propertyState?.('figure_color'))}${field("Opacity", "figure_opacity", (1 - (object.field28 || 0) / 255) * 100, "%", 'min="0" max="100"', { id: "figure-opacity", legacyField: false })}</div>`,
      button("reset-color", "undo", "Reset colors"),
    );
    html += group(
      "Stacking",
      grid(field('Z-index', 'figure_z_order', object._stykZIndex ?? 0, '', 'min="-1000000" max="1000000"')) +
      tools(button('layer-back', 'send-to-back', 'Send to back') + button('layer-down', 'chevron-left', 'Send backward') + button('layer-up', 'chevron-right', 'Bring forward') + button('layer-front', 'bring-to-front', 'Bring to front')),
    );
    html += group(
      "Outline",
      grid(
        field("Width", "outline_width", style.outline_thickness || 0, "px", 'min="0"') +
        field("Opacity", "outline_opacity", (1 - (style.u30 ?? 0) / 255) * 100, "%", 'min="0" max="100"', {
          id: "outline-opacity", legacyField: false, description: "Outline opacity",
        }),
      ) + `<div class="property-row property-color-line">${colorRow("outline-color", "Outline color", hex(style.rgb))}${keyControlGroup('outline_color','outline color',propertyState?.('outline_color'))}</div>`,
    );
  }
  if (jointScope && segment) {
    html += heading(`${editor.branchSelected ? 'Branch from joint' : 'Joint'} ${segment.segment_id}`, "nodes");
    const ik = editor.getIKSettings();
    const shape = [
      "line",
      "circle",
      "image",
      "circleFill",
      "circleClear",
      "text",
      "squareLine",
    ][segment.primitive_code ?? 0];
    html += group(
      "Transform",
      grid(
        field(
          "Angle",
          "joint_angle",
          ((object.angles[joint] ?? segment.angle_rad) * 180) / Math.PI,
          "°",
        ) +
          field(
            "Length",
            "joint_length",
            object.len_flag ? object.lengths[joint] : segment.length,
            "px",
            'min="0"',
          ) +
          field(
            "Bend",
            "joint_bend",
            ((object.bend_flag ? object.bends[joint] : segment.bend_rad || 0) *
              180) /
              Math.PI,
            "°",
        ),
      ) + ikControlsView(ik),
    );
    html += group("Appearance",
        grid(field("Width", "thickness", segment.thickness, "px", 'min="0"') +
        field('Order', 'segment_z_order', drawOrder.get(`segment:${joint}`), '', orderLimits, {animated:false})) +
        (isBuilderContext(tool) ? `<label class="check-row"><input type="checkbox" id="builder-branch" ${builderBranch ? 'checked' : ''}>Apply to branch</label>` : '') +
        `<select id="segment-shape" class="inline-select" aria-label="Segment shape" ${["image", "text"].includes(shape) ? "disabled" : ""}>${[["line", "Round line"], ["squareLine", "Square line"], ["circle", "White circle"], ["circleFill", "Filled circle"], ["circleClear", "Clear circle"], ...(["image", "text"].includes(shape) ? [[shape, shape]] : [])].map(([v, n]) => `<option value="${v}" ${shape === v ? "selected" : ""}>${n}</option>`).join("")}</select>` +
        `<div class="property-paint-row"><button type="button" id="segment-color" data-paint-picker class="paint-trigger" aria-label="Segment color"><i style="background:${paintCSS(segmentPaint(segment))}"></i><span>${segmentPaint(segment).type === 'solid' ? hex(segment.color_rgb).toUpperCase() : segmentPaint(segment).type[0].toUpperCase()+segmentPaint(segment).type.slice(1)+' gradient'}</span></button>` +
        `${keyControlGroup('segment_color','segment color',propertyState?.('segment_color'))}${field(segment.secondary ? "Primary opacity" : "Opacity", "segment_opacity", (1 - (segment.transparency || 0) / 255) * 100, "%", 'min="0" max="100"', { id: "segment-opacity", legacyField: false, description: "Primary color opacity" })}</div>` +
        (segment.secondary ? grid(field("Secondary opacity", "segment_gradient_opacity", (1-(segment.secondary.a??0)/255)*100, "%", 'min="0" max="100"', {description:"Secondary gradient color opacity"})) : '') +
        `<label class="check-row"><input type="checkbox" id="static-joint" ${isStatic(segment) ? "checked" : ""}>Static</label>`,
    );
  }
  if (jointScope) return html;
  const parent = object.join
      ? frame.objects[object.join.target_object_slot]
      : null,
    parentName =
      parent &&
      (parent.name ||
        report.figure_types.find(
          (f) => f.figure_type_id === parent.figure_type_id,
        )?.name ||
        "Figure");
  html += group(
    "Connection",
    `<div class="connection-row"><span>${parent ? esc(parentName) + " · " + object.join.target_handle_id : "None"}</span>${button("attach-figure", "link", "Attach to a joint")}${button("detach-figure", "detach", "Detach figure", !parent)}${button("combine-figures", "combine", "Combine connected figures", !parent && !frame.objects.some((o) => o.join?.target_object_slot === object.object_slot))}</div>`,
  );
  const polygons = figure.polyfills || [],
    start = Math.min(
      Math.max(0, polygonPage) * 12,
      Math.max(0, Math.floor((polygons.length - 1) / 12) * 12),
    );
  if (polygons.length)
    html += group(
      "Polygons",
      polygons
        .slice(start, start + 12)
        .map(
          (p, i) =>
            `<div class="polygon-item"><div class="polygon-row"><span>Polygon ${start + i + 1}</span><input type="color" data-polygon-color="${start + i}" aria-label="Polygon ${start + i + 1} color" value="${hex(p.color_rgb)}"><button class="icon-button" data-delete-polygon="${start + i}" aria-label="Delete polygon ${start + i + 1}">${icon("trash")}</button></div><details class="polygon-style-details" data-polygon-index="${start+i}"><summary>Opacity &amp; draw order</summary>${field('Opacity', `polygon_${start+i}_opacity`, (p.alpha_raw !== undefined ? 1-p.alpha_raw/255 : p.color_alpha ?? 1)*100, '%', 'min="0" max="100"', {animated:Boolean(editor.propertyChannels)})}${field('Order', `polygon_${start+i}_z_order`, drawOrder.get(`polygon:${start+i}`), '', orderLimits, {animated:false})}${builderOrderButtons('polygon',start+i)}</details></div>`,
        )
        .join("") +
        (polygons.length > 12
          ? `<div class="polygon-pagination">${button("polygons-previous", "chevron-left", "Previous polygons", start === 0)}<span>${start + 1}–${Math.min(start + 12, polygons.length)} / ${polygons.length}</span>${button("polygons-next", "chevron-right", "Next polygons", start + 12 >= polygons.length)}</div>`
          : ""),
      `<span>${polygons.length}</span>`,
    );
  return html;
}

function sceneView(editor, field, propertyState) {
  const r = editor.report,
    f = editor.frame,
    colorState = propertyState?.("scene_color"),
    backgroundState = propertyState?.("scene_background"),
    bg = r.backgrounds?.find(
      (b) => b.background_id === (backgroundState?.value ?? f.background_id),
    );
  const rawColor = colorState?.value ?? bg?.color ?? 0xffffffff;
  const color =
    typeof rawColor === "string" && /^#[0-9a-f]{6}$/i.test(rawColor)
      ? rawColor
      : "#" + (rawColor & 0xffffff).toString(16).padStart(6, "0");
  return (
    heading(
      "Scene",
      "scene",
    ) +
    group(
      "Canvas",
      grid(
        field(
          "W",
          "canvas_width",
          r.canvas_width,
          "px",
          'min="1" max="16384"',
        ) +
          field(
            "H",
            "canvas_height",
            r.canvas_height,
            "px",
            'min="1" max="16384"',
          ),
      ),
    ) +
    group(
      "Background",
      `<div class="property-row property-color-line">${colorRow("background-color", "Background color", color)}${keyControlGroup("scene_color", "background color", colorState)}</div>` +
        `<div class="property-row property-background-line"><span class="property-background-name" title="${esc(bg?.name || "White")}">${esc(bg?.name || "White")}</span>${keyControlGroup("scene_background", "background", backgroundState)}</div>` +
        tools(
          button("background-style", "sliders", "Background settings") +
            button("import-background", "image", "Import background"),
        ),
    ) +
    group(
      "Playback",
      grid(field("Rate", "fps", r.fps, "fps", 'min="1" max="120"')),
    )
  );
}

function cameraView(editor, field) {
  const c = cameraValues((editor.evaluatedFrame || editor.frame).camera);
  return (
    '<div class="camera-inspector">' +
    `<div class="camera-heading"><span>${icon('camera')}</span><div><strong>Camera</strong><small>Compose your shot</small></div><span class="camera-live">Live</span></div>` +
    `<div class="camera-monitor"><canvas data-camera-monitor aria-label="Live camera output"></canvas><div class="camera-monitor-caption"><span>${editor.report.canvas_width} × ${editor.report.canvas_height}</span><span data-camera-magnification>${num(100/c.scale)}% zoom</span></div></div>` +
    `<div class="camera-quick-actions"><button data-action="camera-guides" aria-pressed="true" title="Show composition guides">${icon('grid')}<span>Guides</span></button><button data-action="camera-level" title="Set camera rotation to zero">${icon('rotate')}<span>Level</span></button><button data-action="camera-reset" title="Reset camera pose">${icon('undo')}<span>Reset</span></button></div>` +
    group(
      "Transform",
      grid(
        field("X", "camera_x", c.x || 0, "px") +
          field("Y", "camera_y", c.y || 0, "px") +
          field(
            "Scale",
            "camera_scale",
            (c.scale || 1) * 100,
            "%",
            'min="0.01"',
          ) +
          field(
            "Rotation",
            "camera_angle",
            ((c.angle_rad || 0) * 180) / Math.PI,
            "°",
          ),
      ),
    ) +
    `<p class="camera-help">Drag the center to move, corners to scale, or the top grip to rotate. <kbd>Shift</kbd> snaps rotation and scale. <kbd>Ctrl</kbd> locks movement to an axis.</p>` +
    cameraActionsView({ editor, button, group, tools }) + '</div>'
  );
}

function frameView(editor, field) {
  if(editor.report._styk?.layerSheet){const track=editor.report._styk.layerSheet.tracks[editor.activeLayerId],{key,next}=sheetKeyAt(track,editor.tick);
    return heading(`Frame ${editor.tick+1}`,'diamond')+group(editor.getLayer(editor.activeLayerId)?.name??'Layer',
      grid(field('Exposure','duration',(next?.tick??track?.end??editor.tick+1)-(key?.tick??editor.tick),'frames','min="1" max="65535"')))+group('Frames',tools(button('add-frame','diamond','Insert keyframe (F6)')));}
  const frame = editor.frame,
    index = editor.frameIndex ?? 0;
  return (
    heading(
      `Keyframe ${index + 1}`,
      "diamond",
    ) +
    group(
      "Timing",
      grid(
        field(
          "Duration",
          "duration",
          frame.duration_raw ?? 1,
          "ticks",
          'min="0" max="65535"',
        ),
      ),
    )
  );
}

function layerView(editor) {
  const layer = editor.getLayer?.(editor.activeLayerId) ?? {
    id: "layer-1",
    name: "Layer",
    visible: true,
    locked: false,
    figureUids: [],
  };
  return (
    heading(
      layer.name,
      "layers",
    ) +
    group(
      "Layer",
      `<label class="field-label" for="inspector-layer-name">Name</label><input id="inspector-layer-name" class="property-layer-name" data-layer-id="${esc(layer.id)}" value="${esc(layer.name)}" aria-label="Layer name" maxlength="160"><label class="check-row"><input id="inspector-layer-visible" data-layer-id="${esc(layer.id)}" type="checkbox" ${layer.visible ? "checked" : ""}>Visible</label><label class="check-row"><input id="inspector-layer-locked" data-layer-id="${esc(layer.id)}" type="checkbox" ${layer.locked ? "checked" : ""}>Locked</label>`,
    )
  );
}
