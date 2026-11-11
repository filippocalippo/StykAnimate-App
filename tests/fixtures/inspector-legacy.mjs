/**
 * Today's inspector markup, verbatim from src/inspector-view.mjs,
 * src/ik-view.mjs and src/movieclip-ui.mjs (main at 64646330), so
 * tests/inspector-descriptors.test.mjs can prove that the descriptor
 * inspector (src/inspector-view.mjs rendered by src/inspector-kit.mjs with
 * src/inspector-legacy.mjs) produces the same elements, attributes and text.
 * Only the import paths and the three export names changed. The sub-modules
 * other tracks own (spatial controls, rig controls, camera, drawing, drawing
 * sets, builder surfaces) are imported from src: they render the same HTML
 * into both. The 3D rig's view and the camera's commands, ported in M4, are frozen below. Delete this file when the inspector's markup changes on purpose
 * (M4 "Keep less used settings in titled sections that remember being open").
 */
import {joinedDrawingSetsView} from '../../src/movieclip-drawings-view.mjs';
import {drawingInspector} from '../../src/drawing-view.mjs';
import {rigControlsView, connectorPositionView} from './rig-controls-legacy.mjs';
import {figureJoinAction} from '../../src/figure-join-action.mjs';
import {polygonSurfaceView} from '../../src/builder-surface-ui.mjs';
import {rigIKAllowed} from '../../src/rig-constraints.mjs';
import {cameraMotionView,parallaxView} from '../../src/camera-motion-ui.mjs';
import {paintCSS} from '../../src/paint.mjs';
import {figurePalette, displayedSegmentPaint, displayedColor} from '../../src/figure-colors.mjs';
import { icon } from "../../src/icons.mjs";
import { isStatic } from "../../src/pivot/read-view.mjs";
import { formatPropertyValue } from "../../src/property-controls.mjs";
import { cameraValues } from "../../src/pivot/model.mjs";
import { builderDrawables } from '../../src/editor-builder-style.mjs';
import { isBuilderContext } from '../../src/builder-aids.mjs';
import {resolveInstanceFigure} from '../../src/animation-style.mjs';
// ikControlsView: frozen below.
import {propertyToggle} from '../../src/property-toggle.mjs';
import {isMovieclip} from '../../src/movieclips.mjs';
// movieclipInspector: frozen below.
import {sheetKeyAt} from '../../src/layer-sheet.mjs';
import {drawingSetsView} from '../../src/movieclip-drawings-view.mjs';
import {playbackSettings,movieclipAsset,movieclipTime} from '../../src/movieclips.mjs';
// src/spatial-controls.mjs's spatialControlsView and limbControl, verbatim at 52f13960 (the 3D rig's inspector, ported in M4).
import {spatialPerspectiveAvailable} from '../../src/spatial-projection.mjs';
import {spatialBone,spatialPoint} from '../../src/rig-spatial.mjs';
import {ikChain} from '../../src/ik.mjs';
import {poseChoiceGroups} from '../../src/rig-pose-choices.mjs';
import {spatialControlMode} from '../../src/spatial-controls.mjs';
// src/camera-view.mjs, verbatim at 52f13960 (the camera's commands, which inspector-view.mjs renders since M4).
function cameraActionsView({editor, button, group, tools}) {
  const selected = Boolean(editor.selectedObjects?.length ?? editor.object);
  return group('Camera pose', tools(
    button('camera-copy', 'duplicate', 'Copy camera pose') +
    button('camera-paste', 'clipboard', 'Paste camera pose', !editor._cameraClipboard),
  )) + group('Center on selection', tools(
    button('camera-center', 'center', 'Center camera on selection', !selected) +
    button('camera-center-x', 'align-horizontal-center', 'Center camera horizontally', !selected) +
    button('camera-center-y', 'align-vertical-center', 'Center camera vertically', !selected),
  )) + group('Canvas alignment', tools(
    button('camera-align-view', 'fit', 'Fit camera to current canvas view') +
    button('camera-apply-figures', 'check', 'Apply camera transform to figures'),
  )) + group('Neighboring pose', tools(
    button('camera-locate-previous', 'chevron-left', 'Match previous camera pose', editor.frameIndex <= 0) +
    button('camera-locate-next', 'chevron-right', 'Match next camera pose', editor.frameIndex >= editor.report.keyframes.length - 1),
  ));
}
const DEG=180/Math.PI,spEsc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const wrap=a=>Math.atan2(Math.sin(a),Math.cos(a));
function limbControl(editor){
 const f=editor.figure,index=editor.selectedJoint,s=f?.segments[index];if(!s)return null;
 const ancestors=new Set();let parent=s;while(parent?._stykRig?.spatial?.parent){ancestors.add(parent._stykRig.spatial.parent);parent=f.segments.find(n=>n.segment_id===parent._stykRig.spatial.parent);}
 for(const[id,c]of Object.entries(editor.object?._stykIK??{}))if(c.spatialTarget&&(ancestors.has(Number(id))||ikChain(f,Number(id),c.chainLength).includes(index)))
  return{index:f.segments.findIndex(s=>s.segment_id===Number(id)),controller:c};
 return null;
}
function spatialControlsView(editor){
 const bones=editor.figure?.segments.flatMap((s,i)=>spatialBone(s)&&!s._stykPoseChoice?[{s,i}]:[])??[];if(!bones.length)return'';
 const mode=spatialControlMode(editor),pose=editor.getSpatialPose(),selected=editor.selectedJoint,limb=limbControl(editor),ik=limb?.controller;
 // Limbs keep their shortcuts and IK switch while IK is off.
 const targets=bones.filter(({s})=>editor.object?._stykIK?.[s.segment_id]?.spatialTarget),childOf=id=>bones.find(b=>b.s._stykRig.spatial.parent===id);
 const feet=targets.filter(({s})=>/foot|ankle/i.test(childOf(s.segment_id)?.s.name??'')),planted=feet.length&&feet.every(({s})=>editor.object._stykIK[s.segment_id].enabled&&editor.object._stykIK[s.segment_id].pinned);
 const choose=(index,name,focus=false)=>`<button type="button" data-spatial-${focus?'focus':'select'}="${index}" aria-pressed="${selected===index}">${spEsc(name)}</button>`;
 const choices=poseChoiceGroups(editor.figure,editor.object).map(g=>`<label class="spatial-choice"><span>${spEsc(g.name)}</span><select class="inline-select" data-spatial-choice="${spEsc(g.name)}" aria-label="${spEsc(g.name)}"><option value="0" ${g.value===0?'selected':''}>Hidden</option>${g.value===-1?'<option value="-1" selected disabled>Custom pose</option>':''}${g.choices.map(c=>`<option value="${c.id}" ${g.value===c.id?'selected':''}>${spEsc(c.label)}</option>`).join('')}</select></label>`).join('');
 const shortcuts=`<div class="spatial-targets" role="group" aria-label="Body controls">${choose(-1,'Move figure')}<button type="button" data-spatial-whole aria-pressed="${mode==='figure'}">Rotate figure</button>${targets.map(({s,i})=>{const child=childOf(s.segment_id);return choose(mode!=='pose'&&child?child.i:i,(child?.s.name??s.name).replace(/ ankle$/,''));}).join('')}</div>`;
 const trunk=[['Pelvis','Hips'],['Lower torso','Torso'],['Waist','Waist'],['Chest','Chest'],[bones.some(b=>b.s.name==='Head')?'Head':'Neck','Head']].flatMap(([name,label])=>{const b=bones.find(b=>b.s.name===name);return b?[choose(b.i,label)]:[];}).join('');
 const rows=pose?['pitch','turn','bend'].map((key,i)=>{const value=pose[key]*DEG,label=['Tilt','Turn','Bend'][i];return`<div class="spatial-axis spatial-${key}"><label for="spatial-${key}-number">${label}</label><input id="spatial-${key}-range" type="range" min="-180" max="180" step="0.1" value="${wrap(pose[key])*DEG}" data-spatial-axis="${key}" aria-label="${label}"><label class="field"><input id="spatial-${key}-number" type="number" step="1" value="${Math.round(value*10)/10}" data-spatial-axis="${key}" aria-label="${label} degrees"><small>°</small></label></div>`;}).join(''):'';
 const endpoint=limb?childOf(editor.figure.segments[limb.index].segment_id):null,toe=endpoint?childOf(endpoint.s.segment_id):null;
 const isFoot=/foot|ankle/i.test(endpoint?.s.name??''),chain=limb?ikChain(editor.figure,editor.figure.segments[limb.index].segment_id,ik.chainLength):[];
 const rotations=chain.map((index,i)=>choose(index,isFoot?(i===0?'Thigh rotation':'Shin rotation'):(i===0?'Upper arm rotation':'Forearm rotation'),true)).join('')+(endpoint?choose(endpoint.i,isFoot?'Ankle rotation':'Hand rotation',true):'')+(toe?choose(toe.i,'Toe bend',true):'');
 const camera=editor.getSpatialCamera(),proportions=editor.getSpatialProportions();
 const parameter=(kind,key,label,value,min,max,step=1,unit='')=>`<div class="spatial-axis spatial-proportion"><label for="spatial-${kind}-${key}">${label}</label><input type="range" min="${min}" max="${max}" step="${step}" value="${value}" data-spatial-${kind}="${key}" aria-label="${label}"><label class="field"><input id="spatial-${kind}-${key}" type="number" min="${min}" max="${max}" step="${step}" value="${Math.round(value*100)/100}" data-spatial-${kind}="${key}" aria-label="${label} value"><small>${unit}</small></label></div>`;
 const perspective=spatialPerspectiveAvailable(editor.selectionFrame.objects,editor.object,editor.report.figure_types)?`<details class="spatial-exact" data-section="spatial-perspective"><summary>Perspective</summary>${parameter('camera','strength','Perspective',camera.strength*100,0,100,1,'%')}${parameter('camera','distance','Distance',camera.distance,100,2000,10)}<p class="property-context-caption">Move a hand or foot toward the camera to enlarge it. Lower distance gives stronger foreshortening. Use figure Scale to frame the shot.</p><div class="spatial-part-actions"><button type="button" class="spatial-reset" data-spatial-center-camera>Center on figure</button><button type="button" class="spatial-reset" data-spatial-reset-camera>Reset perspective</button></div></details>`:'<p class="property-context-caption">Perspective requires a single spatial figure. Joined drawings retain their original projection.</p>';
 const proportionsView=proportions?`<details class="spatial-exact" data-section="spatial-proportions"><summary>Shape · ${spEsc(editor.figure.segments[selected].name??'Joint')}</summary>${proportions.canResizeLength?parameter('shape','size','Part size',proportions.length*100,10,300,1,'%')+parameter('shape','length','Length',proportions.length*100,10,300,1,'%'):''}${parameter('shape','width','Width',proportions.width*100,10,300,1,'%')}${parameter('shape','taper','Taper',proportions.taper*100,-90,200,1,'%')}<p class="property-context-caption">Part size includes child joints. Length, width and taper adjust this bone; positive taper widens its tip.</p><button type="button" class="spatial-reset" data-spatial-reset-shape>Reset this bone’s shape</button></details>`:'';
 const motion=editor.getSpatialMotion(),motionView=motion?`<div class="spatial-depth" data-section="spatial-motion">${parameter('motion','position',motion.type==='slide'?'Slide':'Hinge',motion.fraction*100,0,100,1,'%')}<p class="property-context-caption">Drag the handle along its track, or set how far it has moved.</p></div>`:'';
 const targetShape=limb?editor.geometry.objects.get(editor.selectedSlot)?.segments[limb.index]:null;
 const depth=targetShape?.spatialFrame?spatialPoint(targetShape.spatialFrame,targetShape.seg._stykRig.spatial.tip)[2]*editor.object.scale:ik?.spatialTarget?.depth??0;
 const limbGeometry=limb?editor.geometry.objects.get(editor.selectedSlot):null,base=limbGeometry?.segments[chain[0]],baseDepth=base?.spatialFrame?spatialPoint(base.spatialFrame,base.seg._stykRig.spatial.origin)[2]*editor.object.scale:0;
 const reach=limb?Math.max(1,chain.reduce((sum,i)=>sum+(limbGeometry.solvedLengths?.[i]??(editor.object.len_flag?editor.object.lengths[i]:editor.figure.segments[i].length)),0)*editor.object.scale):1;
 const depthControl=ik?.enabled?`<div class="spatial-depth">${parameter('reach','depth','Toward camera',depth,baseDepth-reach,baseDepth+reach,1)}<p class="property-context-caption">Left: away · Right: toward you. The leg or arm follows in 3D.</p></div>`:'';
 const limbTools=ik&&!ik.enabled?`<div class="spatial-limb" data-section="spatial-limb"><div class="property-toggle-grid">${propertyToggle('spatial-ik','IK',false,'link',{title:'Drag the hand or foot to move the whole limb'})}</div><p class="property-context-caption">IK off: dragging the ${isFoot?'foot':'hand'} swings only the ${isFoot?'shin':'forearm'}.</p></div>`:ik?`<div class="spatial-limb" data-section="spatial-limb"><div class="property-toggle-grid">${propertyToggle('spatial-ik','IK',true,'link',{title:'Drag the hand or foot to move the whole limb'})}${propertyToggle('spatial-pin',isFoot?'Plant foot':'Pin hand',ik.pinned,'pin',{title:'Keep target position and orientation when the body moves'})}</div><details class="spatial-exact" data-section="spatial-limb-options"><summary>More limb options</summary><div class="property-toggle-grid">${propertyToggle('spatial-stretch','Stretch',ik.allowStretch,'stretch-horizontal',{title:'Allow the limb to reach beyond its rest length'})}</div><label class="spatial-parameter"><span>Bend direction</span><input type="range" min="-180" max="180" step="1" value="${wrap(ik.spatialTarget.swivel)*DEG}" data-spatial-swivel aria-label="Bend direction"></label><label class="field"><span>Depth</span><input type="number" step="1" value="${Math.round(ik.spatialTarget.depth*10)/10}" data-spatial-depth aria-label="Target depth"><small>px</small></label></details><p class="property-context-caption">${ik.pinned?'Planted: position and orientation stay fixed.':isFoot?'Free: the foot follows the shin.':'Free: the hand follows the forearm.'}</p></div>`:'';
 const pad=pose&&!motion&&mode!=='pose'?`<div class="spatial-orientation" data-section="spatial-orientation"><button type="button" class="spatial-pad" data-spatial-pad aria-label="Turn and tilt" title="Drag to turn and tilt · Arrow keys adjust · Shift for precision"><svg viewBox="0 0 90 72" aria-hidden="true"><path d="M8 36H82M45 7V65"/><circle cx="${45+Math.sin(pose.turn)*31}" cy="${36+Math.sin(pose.pitch)*23}" r="5"/></svg></button><div><strong>Turn / tilt</strong><p class="property-context-caption">Drag in two directions.<br>Shift for precision.</p><button type="button" class="spatial-reset" data-spatial-reset="joint">${mode==='figure'?'Reset orientation':'Reset joint'}</button></div></div><details class="spatial-exact" data-section="spatial-exact"><summary>Exact angles</summary>${rows}</details>`:'';
 return`<section class="inspector-section spatial-rig" data-section="spatial-rig"><div class="inspector-title"><span>Character rig</span><button type="button" class="icon-button" data-spatial-reset="all" title="Reset pose" aria-label="Reset pose">${icon('rotate')}</button></div><div class="spatial-modes" role="group" aria-label="Rig tools">${[['pose','Pose','move'],['rotate','Rotate','rotate']].map(([value,label,symbol])=>`<button type="button" data-spatial-mode="${value}" aria-label="${label}" aria-pressed="${value===(mode==='figure'?'rotate':mode)}">${icon(symbol)}${label}</button>`).join('')}</div>${shortcuts}${trunk?`<div class="spatial-trunk" role="group" aria-label="Torso controls">${trunk}</div>`:''}${bones.some(b=>/sash upper$/.test(b.s.name))?`<div class="spatial-part-actions" role="group" aria-label="Belt ties">${bones.filter(b=>/sash upper$/.test(b.s.name)).map(b=>choose(b.i,b.s.name.replace('sash upper','tie'))).join('')}</div>`:''}${feet.length?`<button type="button" class="spatial-plant" data-spatial-feet="${planted?'release':'plant'}">${icon('pin')}${planted?'Release feet':'Plant both feet'}</button>`:''}<select class="inline-select" id="spatial-joint" aria-label="Articulation"><option value="-1" ${pose?'':'selected'}>Move whole character</option>${bones.map(({s,i})=>`<option value="${i}" ${selected===i?'selected':''}>${spEsc(s.name||'Joint '+s.segment_id)}</option>`).join('')}</select>${ik?`<div class="spatial-targets" role="group" aria-label="Limb rotations">${rotations}</div>`:''}${pad}${motionView}${depthControl}${limbTools}${motion?'':proportionsView}${perspective}${choices}<p class="property-context-caption">${mode==='pose'?'Drag joints to swing them in 3D; hold Shift to swing behind. Right-drag twists a part, such as turning the head. Drag a planted knee or elbow to aim its bend.':'Rotate a limb to release its pin; its hand or foot follows. Torso turns retain planted targets. Rotate figure carries the entire pose.'}</p></section>`;
}
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
    precision = integerProperties.has(key) || key.endsWith('_z_order') ? 0 : 3,
    // At rest, show readable values (456.4 px, 3.2°); focus reveals full precision.
    restPrecision = precision && (unit ? 1 : 2);
  value = state?.value ?? value;
  const description =
    options.description || `${label}${unit ? ` (${unit})` : ""}`;
  return `<div class="property-row${animated ? " is-animatable" : options.wide ? " is-wide" : ""}" data-property-row="${key}"><label class="field"><span class="property-scrub" data-property-scrub tabindex="0" role="button" aria-label="Scrub ${esc(description)}" title="Drag to adjust · Shift: fine · Alt: extra fine">${label}</span><input type="number" ${options.id ? `id="${options.id}"` : ""} ${options.legacyField === false ? "" : `data-field="${key}"`} data-property="${key}" data-property-value="${esc(value)}" data-property-precision="${precision}" data-property-display-precision="${restPrecision}" data-property-step="1" value="${formatPropertyValue(value, restPrecision)}" step="any" aria-label="${esc(description)}" ${limits}><small>${unit}</small></label></div>`;
}
const heading = (title, symbol) =>
  `<div class="property-context-heading"><span>${icon(symbol)}</span><div><strong>${esc(title)}</strong></div></div>`;
const button = (action, symbol, title, disabled = false) =>
  `<button class="icon-button" data-action="${action}" title="${title}" aria-label="${title}" ${disabled ? "disabled" : ""}>${icon(symbol)}</button>`;
const secondarySections = new Set(["Connections", "Polygons", "Canvas alignment", "Neighboring pose", "Color palette"]);
const group = (title, body, extra = "") => secondarySections.has(title)
  ? `<details class="inspector-section inspector-disclosure" data-section="${esc(title)}"><summary class="inspector-title"><span>${title}</span>${extra}</summary><div class="inspector-disclosure-body">${body}</div></details>`
  : `<section class="inspector-section"><div class="inspector-title"><span>${title}</span>${extra}</div>${body}</section>`;
const grid = (body) => `<div class="field-grid">${body}</div>`;
const scrubHint = `<p class="property-context-caption">Drag a label to scrub its value · Shift or Alt for finer steps</p>`;
const tools = (body) => `<div class="transform-actions">${body}</div>`;
const builderOrderButtons = (kind, index) => tools(
  [['back','send-to-back','Send to back'],['down','chevron-left','Send backward'],['up','chevron-right','Bring forward'],['front','bring-to-front','Bring to front']]
    .map(([direction,symbol,label]) => `<button type="button" class="icon-button" data-action="builder-order" data-kind="${kind}" data-index="${index}" data-direction="${direction}" title="${label} · ${kind}" aria-label="${label} · ${kind}">${icon(symbol)}</button>`).join(''),
);
const colorRow = (id, label, value, opacityId, opacity, caption = value.slice(1).toUpperCase()) =>
  `<div class="color-row"><input id="${id}" type="color" value="${value}" aria-label="${label}"><span class="hex-label">${esc(caption)}</span>${opacityId ? `<input id="${opacityId}" type="number" value="${num(opacity)}" min="0" max="100" aria-label="${label} opacity"><small>%</small>` : ""}</div>`;

function figureLayerField(editor){
  if(!editor.selectedUids.size)return '';
  const ids=new Set([...editor.selectedUids].map(uid=>editor.layerForUid(uid))),current=ids.size===1?[...ids][0]:'';
  return `<div class="figure-layer-field"><label for="figure-layer">${icon('layers')}Layer</label><select id="figure-layer" class="inline-select" aria-label="Figure layer">${!current?'<option value="" disabled selected>Mixed</option>':''}${editor.layers.filter(layer=>layer.kind==='layer').reverse().map(layer=>`<option value="${esc(layer.id)}" ${layer.id===current?'selected':''} ${layer.locked?'disabled':''}>${esc(layer.name)}</option>`).join('')}</select></div>`;
}

export function legacyInspectorView({
  editor,
  tab = "design",
  tool = "select",
  rigMode = "move",
  selectionCount = 1,
  bounds,
  rangeIndices = [],
  applyRange = false,
  polygonPage = 0,
  palettePage = 0,
  context = "auto",
  propertyState,
  builderBranch = false,
  builder = false,
  drawing,
  hotkeyLabel,
}) {
  if(drawing?.active){
    const o=editor.object,f=editor.figure,p=(label,key,value,unit='',limits='')=>numericField(label,key,value,unit,limits,propertyState?.(key));
    const poseView=drawing.tool==='transform'&&o?group('Transform drawing',grid(p('X','root_x',o.root_x,'px')+p('Y','root_y',o.root_y,'px')+p('Scale','scale',o.scale*100,'%','min="0.01"')+p('Angle','rotation',((o.angles[0]??0)-(f.segments[0]?.angle_rad??0))*180/Math.PI,'°')+p('Opacity','figure_opacity',(1-(o.field28??0)/255)*100,'%','min="0" max="100"'))):'';
    return drawingInspector(drawing,{numericField,group,grid,heading,hotkeyLabel,esc,propertyToggle},poseView);
  }
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
  if (selectionCount===1 && isMovieclip(editor.figure)) return figureLayerField(editor)+legacyMovieclipInspector(editor,field);
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
        ) + scrubHint +
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
    segment = figure.segments[joint];
  if(!builder&&figure.segments.some(s=>s._stykRig?.spatial?.origin)){
    return joinedDrawingSetsView(editor)+spatialControlsView(editor)+(joint<0?group('Placement',grid(field('X','root_x',object.root_x,'px')+field('Y','root_y',object.root_y,'px')+field('Scale','scale',object.scale*100,'%','min="0.01"'))):'');
  }
  if (builder && editor.selectedPolygonIndex >= 0) {
    const index=editor.selectedPolygonIndex, polygon=figure.polyfills[index];
    return group('Fill', `<div class="polygon-row"><input type="color" data-polygon-color="${index}" aria-label="Fill color" value="${hex(displayedColor(report,figure,object,polygon.color_rgb))}"><button class="icon-button" data-delete-polygon="${index}" aria-label="Delete fill">${icon('trash')}</button></div>` +
      field('Opacity',`polygon_${index}_opacity`,(polygon.alpha_raw!==undefined?1-polygon.alpha_raw/255:polygon.color_alpha??1)*100,'%', 'min="0" max="100"',{animated:Boolean(editor.propertyChannels)}) + polygonSurfaceView(editor,index) + builderOrderButtons('polygon',index));
  }
  const drawOrder = new Map(builderDrawables(figure).map((item,index)=>[`${item.kind}:${item.index}`,index+1]));
  const orderLimits = `min="1" max="${drawOrder.size}"`;
  const palette = joint < 0 ? editor.figurePalette() : [];
  const ownPalette = joint < 0 ? figurePalette(report,figure,object) : [];
  const fill = ownPalette[0]?.color ?? '#000000';
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
  let html = (jointScope ? "" : title) + figureLayerField(editor) + range + (!builder ? joinedDrawingSetsView(editor)+spatialControlsView(editor) : "");
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
      ) + scrubHint,
    );
    html += group(
      "Appearance",
      `<div class="property-paint-row">${colorRow("figure-color", "Recolor all segments", fill,undefined,undefined,ownPalette.length>1?'Mixed':undefined)}${field("Opacity", "figure_opacity", (1 - (object.field28 || 0) / 255) * 100, "%", 'min="0" max="100"', { id: "figure-opacity", legacyField: false })}</div>`,
      button("reset-color", "undo", "Reset colors"),
    );
    html += group(
      "Stacking",
      grid(field('Z-index', 'figure_z_order', object._stykZIndex ?? 0, '', 'min="-1000000" max="1000000"')) +
      tools(button('layer-back', 'send-to-back', 'Send to back') + button('layer-down', 'chevron-left', 'Send backward') + button('layer-up', 'chevron-right', 'Bring forward') + button('layer-front', 'bring-to-front', 'Bring to front')),
    );
  }
  if (jointScope && segment) {
    const displayPaint=displayedSegmentPaint(report,figure,object,segment);
    const connector=segment._stykRig?.connector;
    const staticControl = propertyToggle('static-joint', 'Static', isStatic(segment), 'diamond');
    if(connector&&editor.selectedSegmentIds.size<=1){
      const scope=editor._connectorInspector,part=scope?.uid===editor.selectedUid&&scope?.id===segment.segment_id?scope.part:'slider';
      html+=heading(`Connector ${segment.segment_id}`,'link')+`<div class="connector-property-tabs" role="group" aria-label="Connector properties">${[['segment','Segment'],['slider','Slider']].map(([value,label])=>`<button type="button" data-connector-part="${value}" aria-pressed="${part===value}">${label}</button>`).join('')}</div>`;
      if(part==='slider')return html+group('Slider',connectorPositionView(editor)+`<div class="joint-settings">${staticControl}</div>`);
    }
    if(!connector||editor.selectedSegmentIds.size>1)html += heading(editor.selectedSegmentIds.size > 1 ? `${editor.selectedSegmentIds.size} segments` : `${editor.branchSelected ? 'Branch from joint' : 'Joint'} ${segment.segment_id}`, "nodes");
    if(builder)html+=group('',`<label class="rig-select"><span>Joint name</span><input id="builder-joint-name" class="inline-select" aria-label="Joint name" maxlength="120" value="${esc(segment.name??'')}"></label>`);
    const ik = editor.getIKSettings();
    const selectedSegmentIds = editor.selectedSegmentIds;
    const supportsSecondaryColor = [1, 3, 4].includes(segment.primitive_code) &&
      (selectedSegmentIds.size <= 1 || figure.segments.every(part =>
        !selectedSegmentIds.has(part.segment_id) || [1, 3, 4].includes(part.primitive_code)));
    const hasSecondaryColor = supportsSecondaryColor && Boolean(segment.secondary);
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
        (connector?'':field(
          "Angle",
          "joint_angle",
          ((segment._stykRig?.angleLock ? editor.geometry.objects.get(editor.selectedSlot)?.segments[joint]?.angle : object.angles[joint] ?? segment.angle_rad) * 180) / Math.PI,
          "°",
          segment._stykRig?.angleLock ? 'disabled' : '',
        )) +
          (connector ? '' : field(
            "Length",
            "joint_length",
            object.len_flag ? object.lengths[joint] : segment.length,
            "px",
            'min="0"',
          )) +
          field(
            "Bend",
            "joint_bend",
            ((object.bend_flag ? object.bends[joint] : segment.bend_rad || 0) *
              180) /
              Math.PI,
            "°",
        ),
      ) + (connector ? '' : `<div class="joint-settings">${staticControl}</div>`),
    );
    if (rigIKAllowed(figure,joint)) html += legacyIkControlsView(ik);
    html += rigControlsView(editor,{builder});
    html += group("Appearance",
        grid(field("Width", "thickness", segment.thickness, "px", 'min="0"') +
        field('Order', 'segment_z_order', drawOrder.get(`segment:${joint}`), '', orderLimits, {animated:false})) +
        ((isBuilderContext(tool) || builder) && editor.selectedSegmentIds.size <= 1 ? `<label class="check-row"><input type="checkbox" id="builder-branch" ${builderBranch ? 'checked' : ''}>Apply to branch</label>` : '') +
        `<select id="segment-shape" class="inline-select" aria-label="Segment shape" ${["image", "text"].includes(shape) ? "disabled" : ""}>${[["line", "Round line"], ["squareLine", "Square line"], ["circle", "White circle"], ["circleFill", "Filled circle"], ["circleClear", "Clear circle"], ...(["image", "text"].includes(shape) ? [[shape, shape]] : [])].map(([v, n]) => `<option value="${v}" ${shape === v ? "selected" : ""}>${n}</option>`).join("")}</select>` +
        `<div class="property-paint-row"><button type="button" id="segment-color" data-paint-picker class="paint-trigger" aria-label="Segment color"><i style="background:${paintCSS(displayPaint)}"></i><span>${displayPaint.type === 'solid' ? hex(displayPaint.stops[0].color).toUpperCase() : displayPaint.type[0].toUpperCase()+displayPaint.type.slice(1)+' gradient'}</span></button>` +
        `${field(hasSecondaryColor ? "Primary opacity" : "Opacity", "segment_opacity", (1 - (segment.transparency || 0) / 255) * 100, "%", 'min="0" max="100"', { id: "segment-opacity", legacyField: false, description: "Primary color opacity" })}</div>` +
        (supportsSecondaryColor ? `<div class="secondary-color-settings">${propertyToggle('segment-gradient-enabled', 'Secondary color', hasSecondaryColor, 'circle', {controls:'segment-secondary-controls'})}<div id="segment-secondary-controls" ${hasSecondaryColor ? '' : 'hidden'}>${hasSecondaryColor ?
          `<div class="property-paint-row">${colorRow('segment-gradient-color', 'Secondary color', hex(displayedColor(report,figure,object,segment.secondary.rgb)))}${field("Secondary opacity", "segment_gradient_opacity", (1-(segment.secondary.a??0)/255)*100, "%", 'min="0" max="100"', {description:"Secondary color opacity"})}</div>` : ''}</div></div>` : ''),
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
    `<div class="connection-row"><span>${parent ? esc(parentName) + " · " + object.join.target_handle_id : "None"}</span>${button("join-figure", parent ? "detach" : "link", parent ? "Unjoin figure" : "Join figure", !figureJoinAction(editor))}${button("combine-figures", "combine", "Combine connected figures", !parent && !frame.objects.some((o) => o.join?.target_object_slot === object.object_slot))}</div>`,
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
            `<div class="polygon-item"><div class="polygon-row"><span>Polygon ${start + i + 1}</span><input type="color" data-polygon-color="${start + i}" aria-label="Polygon ${start + i + 1} color" value="${hex(displayedColor(report,figure,object,p.color_rgb))}"><button class="icon-button" data-delete-polygon="${start + i}" aria-label="Delete polygon ${start + i + 1}">${icon("trash")}</button></div><details class="polygon-style-details" data-polygon-index="${start+i}"><summary>Opacity &amp; draw order</summary>${field('Opacity', `polygon_${start+i}_opacity`, (p.alpha_raw !== undefined ? 1-p.alpha_raw/255 : p.color_alpha ?? 1)*100, '%', 'min="0" max="100"', {animated:Boolean(editor.propertyChannels)})}${field('Order', `polygon_${start+i}_z_order`, drawOrder.get(`polygon:${start+i}`), '', orderLimits, {animated:false})}${builderOrderButtons('polygon',start+i)}</details></div>`,
        )
        .join("") +
        (polygons.length > 12
          ? `<div class="polygon-pagination">${button("polygons-previous", "chevron-left", "Previous polygons", start === 0)}<span>${start + 1}–${Math.min(start + 12, polygons.length)} / ${polygons.length}</span>${button("polygons-next", "chevron-right", "Next polygons", start + 12 >= polygons.length)}</div>`
          : ""),
      `<span>${polygons.length}</span>`,
    );
  const paletteStart=Math.min(Math.max(0,palettePage)*32,Math.max(0,Math.ceil(palette.length/32)-1)*32);
  html += group('Color palette',
      `<div class="figure-palette" aria-label="Figure color palette">`+
      palette.slice(paletteStart,paletteStart+32).map(entry=>`<button type="button" data-paint-picker data-palette-color="${entry.color}" class="figure-palette-row" aria-label="Replace ${entry.color.toUpperCase()}, ${entry.segments.length} segments${entry.polygons.length?`, ${entry.polygons.length} fills`:''}"><i style="background:${entry.color}"></i><span>${entry.color.toUpperCase()}</span></button>`).join('')+'</div>'+
      (palette.length>32?`<div class="polygon-pagination">${button('palette-previous','chevron-left','Previous colors',paletteStart===0)}<span>${paletteStart+1}–${Math.min(paletteStart+32,palette.length)} / ${palette.length}</span>${button('palette-next','chevron-right','Next colors',paletteStart+32>=palette.length)}</div>`:''),`<span>${palette.length} ${palette.length===1?'color':'colors'}</span>`);
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
      `<div class="property-row property-color-line">${colorRow("background-color", "Background color", color)}</div>` +
        `<div class="property-row property-background-line"><span class="property-background-name" title="${esc(bg?.name || "White")}">${esc(bg?.name || "White")}</span></div>` +
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
  const motion=editor._cameraInspectorTab==='motion';
  return (
    '<div class="camera-inspector">' +
    `<div class="camera-heading"><span>${icon('camera')}</span><div><strong>Camera</strong></div><span class="camera-live">Live</span></div>` +
    `<div class="camera-monitor"><canvas data-camera-monitor aria-label="Live camera output"></canvas><div class="camera-monitor-caption"><span>${editor.report.canvas_width} Ã— ${editor.report.canvas_height}</span><span data-camera-magnification>${num(100/c.scale)}% zoom</span></div></div>` +
    `<div class="camera-inspector-tabs" role="tablist" aria-label="Camera controls"><button role="tab" data-camera-tab="transform" aria-selected="${!motion}">Transform</button><button role="tab" data-camera-tab="motion" aria-selected="${motion}">Motion</button></div><div ${motion?'hidden':''}>` +
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
    cameraActionsView({ editor, button, group, tools }) + `</div><div ${motion?'':'hidden'}>` + cameraMotionView(editor) + '</div></div>'
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
    ) + parallaxView(editor,layer.id)
  );
}

// ---------------------------------------------------------------------------
// src/ik-view.mjs

/** IK owns its section; dependent settings are nested beneath its master toggle. */
export function legacyIkControlsView(ik) {
  return `<section class="inspector-section ik-settings" aria-label="Inverse kinematics">${propertyToggle('node-is-ik', 'IK', ik.enabled, 'nodes', {title:'Inverse kinematics', controls:'node-ik-options'})}<div id="node-ik-options" class="ik-options" ${ik.enabled ? '' : 'hidden'}>${ik.enabled ?
    `<div class="property-toggle-grid">${propertyToggle('node-ik-pinned', 'Pinned', ik.pinned, 'pin')}${propertyToggle('node-ik-stretch', 'Stretch', ik.allowStretch, 'stretch-horizontal', {title:'Allow stretch'})}</div>` +
    `<div class="ik-grid"><label class="field"><span>Chain</span><input id="node-ik-chain" type="number" min="1" max="${ik.maxLength}" step="1" value="${ik.chainLength}" aria-label="IK chain length"></label>` +
    `<label class="field"><span>Rotation</span><input id="node-ik-rotation" type="number" step="1" value="${Math.round(ik.target.rotation * 180 / Math.PI * 100) / 100}" aria-label="IK target rotation"><small>°</small></label></div>` +
    `<div class="ik-bend-row"><span>Direction</span><div class="ik-segments" role="group" aria-label="IK bend direction">${[[-1, 'Left'], [0, 'Both'], [1, 'Right']].map(([value, label]) =>
      `<label><input type="radio" name="node-ik-bend" value="${value}" ${ik.bendDirection === value ? 'checked' : ''} aria-label="Bend ${label.toLowerCase()}"><span>${label}</span></label>`).join('')}</div></div>` : ''}</div></section>`;
}

// ---------------------------------------------------------------------------
// src/movieclip-ui.mjs, movieclipInspector and the helpers it reads
const inspectorStates=new WeakMap();
const number=value=>Number(Number(value).toFixed(3));
function inspectorState(editor){
  let state=inspectorStates.get(editor);
  if(!state||state.token!==editor._documentToken){state={token:editor._documentToken,nextKeys:1};inspectorStates.set(editor,state);}
  return state;
}
function nextKeys(editor){
  const track=editor.report._styk?.layerSheet?.tracks[editor.layerForUid(editor.selectedUid)];
  return track?track.keys.filter(key=>!key.patchOnly&&key.tick>editor.tick&&key.tick<track.end).length:editor.timeline.filter(row=>row.start>editor.tick&&row.count>0).length;
}

const mcEsc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function legacyMovieclipInspector(editor,field){
  const object=editor.object,figure=editor.figure,p=playbackSettings(object),asset=movieclipAsset(figure),state=inspectorState(editor),remaining=nextKeys(editor);
  const sample=editor.evaluatedFrame.objects.find(value=>value.unique_id===object.unique_id)?._movieclipSample??movieclipTime(asset,p,editor.tick,editor.report.fps);
  const current=sample===null?null:Math.min(asset.duration,Math.floor(sample)+1);
  const feedback=state.feedback, message=feedback?.uid===object.unique_id&&feedback.tick===editor.tick&&feedback.revision===editor.revision?feedback.message:'';
  const input=(name,label,value,min,max,unit='',disabled=false)=>`<label class="movieclip-control"><span>${label}</span><div class="field"><input type="number" data-movieclip-field="${name}" aria-label="Movieclip ${label.toLowerCase()}" value="${mcEsc(value)}" min="${min}" max="${max}" step="any" required ${disabled?'disabled':''}>${unit?`<small>${unit}</small>`:''}</div></label>`;
  return `<div class="movieclip-inspector">${drawingSetsView(figure,object)}<section class="inspector-section movieclip-header"><div class="object-heading"><span>${icon('frame')}</span><input class="figure-name" data-movieclip-name aria-label="Movieclip name" value="${mcEsc(figure.name)}" maxlength="120"></div><div class="movieclip-actions"><button class="button primary" data-action="movieclip-edit">${icon('nodes')}Edit movieclip</button><button class="button" data-action="movieclip-unique">Make unique</button></div></section>
    <section class="inspector-section movieclip-playback"><div class="movieclip-position"><div><span>Viewing frame</span><output data-movieclip-current-frame aria-label="Current movieclip frame">${current??'—'} <small>/ ${asset.duration}</small></output></div><span class="movieclip-scene-frame" title="Current scene frame">Scene ${Math.floor(editor.tick)+1}</span></div><progress class="movieclip-progress" aria-label="Movieclip progress" max="${asset.duration}" value="${current??0}"></progress><div class="movieclip-duration" data-movieclip-duration>${asset.duration} frames <span>·</span> ${number(asset.duration/asset.document.fps)} s <span>·</span> ${asset.document.fps} fps</div>
    <label class="movieclip-mode"><span>Playback</span><select class="inline-select" data-movieclip-field="mode" aria-label="Movieclip playback">${[['loop','Loop'],['hold','Play once · hold'],['once','Play once · hide'],['single','Single frame']].map(([value,label])=>`<option value="${value}" ${p.mode===value?'selected':''}>${label}</option>`).join('')}</select></label><div class="field-grid movieclip-playback-fields">${input('offset',p.mode==='single'?'Hold frame':'Start frame',p.offset+1,1,10000001)}${input('speed','Speed',p.speed,.001,100,'×',p.mode==='single')}</div></section>
    <section class="inspector-section movieclip-transform"><div class="inspector-title">Transform</div><div class="field-grid">${field('X','root_x',object.root_x,'px')}${field('Y','root_y',object.root_y,'px')}${field('Scale','scale',object.scale*100,'%','min="0.01"')}${field('Angle','rotation',((object.angles[0]??0)-(figure.segments[0]?.angle_rad??0))*180/Math.PI,'°')}${field('Opacity','figure_opacity',(1-(object.field28??0)/255)*100,'%','min="0" max="100"')}${field('Z-index','figure_z_order',object._stykZIndex??0,'','min="-1000000" max="1000000"')}</div><p class="property-context-caption">Drag a label to scrub its value · Shift or Alt for finer steps</p></section>
    <section class="inspector-section movieclip-extend"><div class="movieclip-extend-heading"><label for="movieclip-next-keys">Next keyframes</label><span>${remaining} available</span></div><div class="movieclip-extend-controls"><label class="field"><input id="movieclip-next-keys" type="number" data-movieclip-next-keys aria-label="Next keyframes" value="${state.nextKeys}" min="1" max="1000000" step="1" required></label><button class="button" data-action="movieclip-extend" ${remaining?'':'disabled'}>${icon('plus')}Add to next keyframes</button></div><div class="movieclip-feedback" data-movieclip-feedback role="status" aria-live="polite" aria-atomic="true" ${message||!remaining?'':'hidden'}>${mcEsc(message||(!remaining?'No later keyframes.':''))}</div></section>
    <details class="inspector-section inspector-disclosure movieclip-more" data-section="Movieclip actions"><summary class="inspector-title">More actions</summary><div class="movieclip-secondary-actions"><button class="button" data-action="movieclip-break" title="Replace only scene frame ${Math.floor(editor.tick)+1}">Break apart frame</button><button class="button" data-action="movieclip-bake">Bake animation</button><button class="button" data-action="movieclip-export">Export movieclip</button></div></details></div>`;
}
