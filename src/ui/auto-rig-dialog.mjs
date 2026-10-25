import { createDialog } from './ui-dialog.mjs';
import { estimatePose, detectMimeTypeFromBuffer } from '../pose-estimation-client.mjs';
import { buildFigureFromPoseLandmarks } from '../pose-topology.mjs';
import { presentError } from '../error-presentation.mjs';
import { messageError } from '../localized-error.mjs';
import { createObject, createFrame } from '../demo.mjs';

function parseColorToRgb(color) {
  if (Array.isArray(color) && color.length >= 3) {
    return [Number(color[0]), Number(color[1]), Number(color[2])];
  }
  if (typeof color === 'string') {
    const hex = color.replace(/^#/, '');
    if (hex.length === 6) {
      return [
        parseInt(hex.slice(0, 2), 16),
        parseInt(hex.slice(2, 4), 16),
        parseInt(hex.slice(4, 6), 16)
      ];
    }
  }
  return [13, 153, 255];
}

function rgbToHex(rgb) {
  if (!Array.isArray(rgb) || rgb.length < 3) return '#0d99ff';
  return '#' + rgb.slice(0, 3).map(x => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('');
}

/**
 * Wraps synthesized figure and 2-bone IK setup in a valid StykAnimate Document.
 */
export function createRiggedFigureDocument(landmarks, options = {}) {
  const { figure, ikSetup, rootPosition } = buildFigureFromPoseLandmarks(landmarks, options);
  const _stykIK = {};
  for (const item of ikSetup) {
    _stykIK[String(item.segment_id)] = {
      enabled: item.enabled,
      pinned: item.pinned,
      allowStretch: false,
      chainLength: item.chainLength,
      bendDirection: item.bendDirection,
      target: item.target ?? { x: rootPosition.x, y: rootPosition.y, rotation: 0 },
      followers: {}
    };
  }
  const object = createObject(figure, 1, rootPosition.x, rootPosition.y, {
    angles: figure.segments.map(s => s.angle_rad),
    _stykIK
  });
  return {
    version: 5,
    canvas_width: 960,
    canvas_height: 540,
    fps: 24,
    auto_easing: false,
    auto_easing_disabled_raw: 1,
    figure_types: [figure],
    backgrounds: [],
    keyframes: [createFrame([object], 1)],
    _styk: { format: 'StykAnimate', format_version: 1, name: figure.name }
  };
}

/**
 * Draws the source image (if loaded) and overlays the detected skeleton, joints,
 * and 2-bone IK end-effectors onto the staging canvas.
 */
export function renderSkeletonPreview(canvas, image, landmarks, { color = [13, 153, 255] } = {}) {
  const ctx = canvas?.getContext?.('2d');
  if (!ctx) return;

  const w = canvas.width || 480;
  const h = canvas.height || 360;
  ctx.clearRect(0, 0, w, h);

  let drawW = w;
  let drawH = h;
  let offsetX = 0;
  let offsetY = 0;

  if (image) {
    const imgW = image.naturalWidth || image.width || w;
    const imgH = image.naturalHeight || image.height || h;
    const aspect = Math.min(w / imgW, h / imgH);
    drawW = imgW * aspect;
    drawH = imgH * aspect;
    offsetX = (w - drawW) / 2;
    offsetY = (h - drawH) / 2;
    try {
      ctx.drawImage(image, offsetX, offsetY, drawW, drawH);
    } catch {
      // Ignore draw errors in test environments
    }
  } else {
    ctx.fillStyle = '#1e1e1e';
    ctx.fillRect(0, 0, w, h);
  }

  if (!landmarks || landmarks.length < 17) return;

  const isMediaPipe = landmarks.length >= 33;
  const toCanvas = (lm) => ({
    x: offsetX + (lm.x ?? 0.5) * drawW,
    y: offsetY + (lm.y ?? 0.5) * drawH
  });

  const nose = toCanvas(landmarks[0]);
  const lShoulder = toCanvas(landmarks[isMediaPipe ? 11 : 5]);
  const rShoulder = toCanvas(landmarks[isMediaPipe ? 12 : 6]);
  const lElbow = toCanvas(landmarks[isMediaPipe ? 13 : 7]);
  const rElbow = toCanvas(landmarks[isMediaPipe ? 14 : 8]);
  const lWrist = toCanvas(landmarks[isMediaPipe ? 15 : 9]);
  const rWrist = toCanvas(landmarks[isMediaPipe ? 16 : 10]);
  const lHip = toCanvas(landmarks[isMediaPipe ? 23 : 11]);
  const rHip = toCanvas(landmarks[isMediaPipe ? 24 : 12]);
  const lKnee = toCanvas(landmarks[isMediaPipe ? 25 : 13]);
  const rKnee = toCanvas(landmarks[isMediaPipe ? 26 : 14]);
  const lAnkle = toCanvas(landmarks[isMediaPipe ? 27 : 15]);
  const rAnkle = toCanvas(landmarks[isMediaPipe ? 28 : 16]);

  const pNeck = { x: (lShoulder.x + rShoulder.x) / 2, y: (lShoulder.y + rShoulder.y) / 2 };
  const pRoot = { x: (lHip.x + rHip.x) / 2, y: (lHip.y + rHip.y) / 2 };

  const hexCol = `rgb(${color[0]}, ${color[1]}, ${color[2]})`;

  // Draw skeletal bones
  const bones = [
    [pRoot, pNeck],          // Torso
    [pNeck, nose],           // Head
    [pNeck, lShoulder],
    [pNeck, rShoulder],
    [lShoulder, lElbow],     // Left upper arm
    [lElbow, lWrist],        // Left forearm
    [rShoulder, rElbow],     // Right upper arm
    [rElbow, rWrist],        // Right forearm
    [pRoot, lHip],
    [pRoot, rHip],
    [lHip, lKnee],           // Left thigh
    [lKnee, lAnkle],         // Left lower leg
    [rHip, rKnee],           // Right thigh
    [rKnee, rAnkle]          // Right lower leg
  ];

  ctx.save();
  ctx.strokeStyle = hexCol;
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  for (const [p1, p2] of bones) {
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();
  }

  // Draw Head circleFill
  const headRadius = Math.max(12, Math.hypot(nose.x - pNeck.x, nose.y - pNeck.y) * 0.8);
  ctx.beginPath();
  ctx.arc(nose.x, nose.y, headRadius, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(${color[0]}, ${color[1]}, ${color[2]}, 0.35)`;
  ctx.fill();
  ctx.strokeStyle = hexCol;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Draw joints
  const joints = [
    pRoot, pNeck, nose,
    lShoulder, rShoulder,
    lElbow, rElbow,
    lHip, rHip,
    lKnee, rKnee
  ];

  for (const pt of joints) {
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#FFFFFF';
    ctx.fill();
    ctx.strokeStyle = hexCol;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // Draw IK End-Effectors (Left/Right Forearms and Lower Legs)
  const effectors = [
    { pt: lWrist, name: 'Left Hand IK' },
    { pt: rWrist, name: 'Right Hand IK' },
    { pt: lAnkle, name: 'Left Foot IK' },
    { pt: rAnkle, name: 'Right Foot IK' }
  ];

  for (const { pt } of effectors) {
    // Outer reticle ring
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 9, 0, Math.PI * 2);
    ctx.strokeStyle = '#FFB800'; // Amber IK indicator
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // Center handle
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#FFB800';
    ctx.fill();

    // Crosshair ticks
    ctx.beginPath();
    ctx.moveTo(pt.x - 12, pt.y);
    ctx.lineTo(pt.x + 12, pt.y);
    ctx.moveTo(pt.x, pt.y - 12);
    ctx.lineTo(pt.x, pt.y + 12);
    ctx.strokeStyle = 'rgba(255, 184, 0, 0.7)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  ctx.restore();
}

/**
 * Creates and initializes the Auto-Rig Dialog.
 */
export function createAutoRigDialog(editor, builderSession, options = {}) {
  const doc = options.document ?? globalThis.document;
  let currentLandmarks = null;
  let currentImage = null;

  const bodyNode = doc.createElement('div');
  bodyNode.className = 'ui-auto-rig-dialog-body';

  // Drop zone
  const dropZone = doc.createElement('div');
  dropZone.className = 'auto-rig-dropzone';
  dropZone.setAttribute('role', 'button');
  dropZone.setAttribute('tabindex', '0');
  dropZone.style.cssText = 'border: 2px dashed #555; border-radius: 8px; padding: 16px; text-align: center; cursor: pointer; transition: border-color 0.15s, background-color 0.15s; margin-bottom: 12px;';

  const fileInput = doc.createElement('input');
  fileInput.type = 'file';
  fileInput.className = 'auto-rig-file-input';
  fileInput.accept = 'image/png,image/jpeg,image/webp,image/svg+xml';
  fileInput.style.display = 'none';

  const promptText = doc.createElement('div');
  promptText.className = 'auto-rig-dropzone-prompt';
  promptText.innerHTML = '<span style="font-size: 20px; display: block; margin-bottom: 4px;">📁</span><strong>Choose an image or drop here</strong><br><small style="color: #888;">PNG, JPEG, WebP, or SVG</small>';

  dropZone.appendChild(fileInput);
  dropZone.appendChild(promptText);
  bodyNode.appendChild(dropZone);

  // Canvas wrap
  const canvasWrap = doc.createElement('div');
  canvasWrap.className = 'auto-rig-canvas-wrap';
  canvasWrap.style.cssText = 'position: relative; text-align: center; margin-bottom: 12px;';

  const canvas = doc.createElement('canvas');
  canvas.className = 'auto-rig-preview';
  canvas.width = 480;
  canvas.height = 360;
  canvas.style.cssText = 'width: 100%; max-width: 480px; height: auto; aspect-ratio: 4/3; background: #1a1a1a; border: 1px solid #333; border-radius: 6px; display: block; margin: 0 auto;';
  canvasWrap.appendChild(canvas);
  bodyNode.appendChild(canvasWrap);

  // Localized Error Notice
  const errorNotice = doc.createElement('div');
  errorNotice.className = 'auto-rig-error ui-dialog-error';
  errorNotice.setAttribute('role', 'alert');
  errorNotice.hidden = true;
  errorNotice.style.cssText = 'color: #ff6b6b; margin-top: 8px; font-size: 13px; text-align: center;';
  bodyNode.appendChild(errorNotice);

  // Configuration options row
  const optionsRow = doc.createElement('div');
  optionsRow.className = 'auto-rig-options';
  optionsRow.style.cssText = 'display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; margin-top: 8px;';

  // Name
  const nameCol = doc.createElement('div');
  nameCol.className = 'ui-form-row';
  nameCol.style.cssText = 'flex: 2; min-width: 140px;';
  const nameLabel = doc.createElement('label');
  nameLabel.className = 'ui-field-label';
  nameLabel.textContent = 'Figure Name';
  nameLabel.style.cssText = 'display: block; font-size: 12px; margin-bottom: 4px;';
  const nameInput = doc.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'ui-field-input auto-rig-name';
  nameInput.value = options.name || 'Auto-Rig Figure';
  nameInput.style.cssText = 'width: 100%; box-sizing: border-box;';
  nameCol.appendChild(nameLabel);
  nameCol.appendChild(nameInput);

  // Scale
  const scaleCol = doc.createElement('div');
  scaleCol.className = 'ui-form-row';
  scaleCol.style.cssText = 'flex: 1; min-width: 120px;';
  const scaleLabel = doc.createElement('label');
  scaleLabel.className = 'ui-field-label';
  scaleLabel.style.cssText = 'display: block; font-size: 12px; margin-bottom: 4px;';
  const scaleVal = doc.createElement('span');
  scaleVal.className = 'auto-rig-scale-val';
  scaleVal.textContent = String(options.scale || 300);
  scaleLabel.textContent = 'Scale: ';
  scaleLabel.appendChild(scaleVal);
  const scaleInput = doc.createElement('input');
  scaleInput.type = 'range';
  scaleInput.className = 'auto-rig-scale';
  scaleInput.min = '100';
  scaleInput.max = '600';
  scaleInput.value = String(options.scale || 300);
  scaleInput.style.cssText = 'width: 100%;';
  scaleCol.appendChild(scaleLabel);
  scaleCol.appendChild(scaleInput);

  // Color
  const colorCol = doc.createElement('div');
  colorCol.className = 'ui-form-row';
  colorCol.style.cssText = 'flex: 0 0 60px;';
  const colorLabel = doc.createElement('label');
  colorLabel.className = 'ui-field-label';
  colorLabel.textContent = 'Color';
  colorLabel.style.cssText = 'display: block; font-size: 12px; margin-bottom: 4px;';
  const colorInput = doc.createElement('input');
  colorInput.type = 'color';
  colorInput.className = 'auto-rig-color';
  colorInput.value = rgbToHex(options.color || [13, 153, 255]);
  colorInput.style.cssText = 'width: 100%; height: 28px; padding: 2px; border: 1px solid #444; border-radius: 4px; background: transparent; cursor: pointer;';
  colorCol.appendChild(colorLabel);
  colorCol.appendChild(colorInput);

  optionsRow.appendChild(nameCol);
  optionsRow.appendChild(scaleCol);
  optionsRow.appendChild(colorCol);
  bodyNode.appendChild(optionsRow);

  function renderPreview() {
    renderSkeletonPreview(canvas, currentImage, currentLandmarks, {
      color: parseColorToRgb(colorInput.value)
    });
  }

  // Event handlers for configuration changes
  scaleInput.addEventListener('input', () => {
    scaleVal.textContent = scaleInput.value;
    renderPreview();
  });
  colorInput.addEventListener('input', () => {
    renderPreview();
  });

  const dialog = createDialog({
    size: 'md',
    title: options.title || 'Auto-Rig from Image',
    description: options.description || 'Import an image or SVG to detect pose landmarks and synthesize a stick figure rig.',
    body: bodyNode,
    actions: [
      { label: 'Cancel', cancel: true, variant: 'ghost' },
      { label: 'Confirm Rig', value: 'confirm', variant: 'primary', id: 'auto-rig-confirm' }
    ],
    onSubmit: (value) => {
      if (value === 'confirm') {
        if (!currentLandmarks || currentLandmarks.length < 17) {
          return { error: 'Please select an image with a detectable pose before confirming.' };
        }
        const name = nameInput.value.trim() || 'Auto-Rig Figure';
        const scale = Number(scaleInput.value) || 300;
        const color = parseColorToRgb(colorInput.value);

        const figureDocument = createRiggedFigureDocument(currentLandmarks, {
          name,
          scale,
          color
        });

        const position = {
          x: editor?.report?.canvas_width ? editor.report.canvas_width / 2 : 480,
          y: editor?.report?.canvas_height ? editor.report.canvas_height / 2 : 270
        };

        let importedObject = null;
        if (typeof editor?.importFigure === 'function') {
          importedObject = editor.importFigure(figureDocument, { position });
        }

        if (builderSession) {
          if (builderSession.mode === 'create' && !builderSession.typeId && editor?.figure) {
            builderSession.typeId = editor.figure.figure_type_id;
            builderSession.uid = editor.selectedUid;
          }
        }

        return { value: { figureDocument, object: importedObject } };
      }
    },
    ...options
  });

  const confirmBtn = dialog.element.querySelector('#auto-rig-confirm') ?? dialog.element.querySelector('[data-primary]');
  if (confirmBtn) confirmBtn.disabled = true;

  async function handleFile(file) {
    if (!file) return;

    errorNotice.hidden = true;
    errorNotice.textContent = '';
    dialog.setError('');
    dialog.setBusy(true);

    try {
      let buffer;
      if (file instanceof ArrayBuffer) {
        buffer = file;
      } else if (typeof file.arrayBuffer === 'function') {
        buffer = await file.arrayBuffer();
      } else if (file.buffer instanceof ArrayBuffer) {
        buffer = file.buffer;
      } else {
        throw messageError(new Error('Invalid image buffer'), 'errors.poseEstimationWorker.invalidImageFormat');
      }

      const mimeType = file.type || detectMimeTypeFromBuffer(buffer) || 'image/png';
      const result = await estimatePose(buffer, { mimeType });
      const landmarks = result?.landmarks ?? (Array.isArray(result) ? result : null);

      if (!landmarks || landmarks.length < 17) {
        throw messageError(new Error('No pose detected in image'), 'errors.poseEstimationWorker.noPoseDetected');
      }

      currentLandmarks = landmarks;

      if (typeof Image !== 'undefined' && typeof URL?.createObjectURL === 'function' && file instanceof Blob) {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
          currentImage = img;
          renderPreview();
          URL.revokeObjectURL(url);
        };
        img.onerror = () => {
          currentImage = null;
          renderPreview();
          URL.revokeObjectURL(url);
        };
        img.src = url;
      } else {
        currentImage = null;
        renderPreview();
      }

      if (file.name && typeof file.name === 'string') {
        const baseName = file.name.replace(/\.[^/.]+$/, '').trim();
        if (baseName && (nameInput.value === 'Auto-Rig Figure' || !nameInput.value)) {
          nameInput.value = `${baseName} Rig`;
        }
      }

      if (confirmBtn) confirmBtn.disabled = false;
    } catch (err) {
      currentLandmarks = null;
      currentImage = null;
      if (confirmBtn) confirmBtn.disabled = true;

      // Present localized error notice without polluting figure definitions table
      presentError(errorNotice, err);
      errorNotice.hidden = false;
      dialog.setError(err);

      const ctx = canvas.getContext?.('2d');
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    } finally {
      dialog.setBusy(false);
    }
  }

  // Dropzone drag-and-drop wiring
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.style.borderColor = '#0D99FF';
    dropZone.style.backgroundColor = 'rgba(13, 153, 255, 0.05)';
  });
  dropZone.addEventListener('dragleave', () => {
    dropZone.style.borderColor = '#555';
    dropZone.style.backgroundColor = 'transparent';
  });
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.style.borderColor = '#555';
    dropZone.style.backgroundColor = 'transparent';
    const file = e.dataTransfer?.files?.[0];
    if (file) handleFile(file);
  });
  dropZone.addEventListener('click', (e) => {
    if (e.target !== fileInput) fileInput.click();
  });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) handleFile(file);
  });

  // Render initial blank canvas
  renderPreview();

  return Object.assign(dialog, {
    fileInput,
    dropZone,
    canvas,
    errorNotice,
    confirmButton: confirmBtn,
    nameInput,
    scaleInput,
    colorInput,
    handleFile,
    get landmarks() { return currentLandmarks; },
    setLandmarks(landmarks, image = null) {
      currentLandmarks = landmarks;
      currentImage = image;
      if (confirmBtn) confirmBtn.disabled = !landmarks;
      renderPreview();
    }
  });
}

/**
 * Convenience entry point to create and show the modal dialog.
 */
export async function showAutoRigDialog(editor, builderSession, options = {}) {
  const dialog = createAutoRigDialog(editor, builderSession, options);
  return dialog.showModal();
}
