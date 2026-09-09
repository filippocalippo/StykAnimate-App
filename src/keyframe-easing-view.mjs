import {EASING_MODES, DEFAULT_BEZIER, keyEasing, easedProgress} from './keyframe-easing.mjs';

/** Shared easing controls for document frames and independent channel keys. */
export function createEasingControls(container, {initial, discrete = false, onChange = () => {}, onSelect = () => {}} = {}) {
  container.innerHTML = `<div class="styk-easing-options" role="radiogroup" aria-label="Easing mode"></div>
    <svg class="styk-easing-curve" viewBox="0 0 280 160" aria-label="Easing curve preview" role="img">
      <path d="M30 10V140H260 M30 140L260 10" fill="none" stroke="#dce3eb"/>
      <path data-curve fill="none" stroke="#0d99ff" stroke-width="3"/>
      <g data-handles stroke="#8499af"><path data-guides fill="none" stroke-dasharray="3 3"/>
        <circle data-handle="0" r="6" fill="#fff"/><circle data-handle="1" r="6" fill="#fff"/></g>
      <text x="30" y="156">Time →</text><text x="3" y="12">1</text><text x="3" y="140">0</text>
    </svg><div class="styk-timeline-fields styk-easing-points"></div>`;
  let mode = initial?.interpolation ?? null, points = [...(initial?.bezier ?? DEFAULT_BEZIER)];
  const options = container.querySelector('.styk-easing-options');
  const svg = container.querySelector('svg'), fields = container.querySelector('.styk-easing-points');
  const inputs = ['Control 1 · X', 'Control 1 · Y', 'Control 2 · X', 'Control 2 · Y'].map((name, index) => {
    const label = document.createElement('label'); label.textContent = ['X₁','Y₁','X₂','Y₂'][index];
    const input = document.createElement('input'); input.type = 'number'; input.min = '0'; input.max = '1'; input.step = 'any'; input.value = points[index];
    input.setAttribute('aria-label', name); input.required = true;
    input.addEventListener('input', () => { points[index] = input.valueAsNumber; render(); });
    label.append(input); fields.append(label); return input;
  });
  const buttons = EASING_MODES.map(item => {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = item.label;
    button.setAttribute('aria-label', item.label);
    button.setAttribute('role', 'radio'); button.dataset.easing = item.id; button.disabled = discrete && item.id !== 'constant';
    button.addEventListener('click', () => { mode = item.id; render(); onSelect(mode); });
    button.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      const enabled = buttons.filter(item => !item.disabled), direction = ['ArrowLeft','ArrowUp'].includes(event.key) ? -1 : 1;
      const next = enabled[(enabled.indexOf(button) + direction + enabled.length) % enabled.length]; next.focus();
    });
    options.append(button); return button;
  });
  function read() {
    if (!mode) throw new Error('Choose an easing mode.');
    return keyEasing({interpolation: mode, ...(mode === 'bezier' ? {bezier: points} : {})});
  }
  function render() {
    let easing;
    try { easing = read(); } catch { /* Keep invalid coordinates editable. */ }
    buttons.forEach(button => {
      const selected = button.dataset.easing === mode; button.setAttribute('aria-checked', String(selected));
      button.tabIndex = selected || !mode && button === buttons.find(item => !item.disabled) ? 0 : -1;
    });
    svg.style.display = mode === 'bezier' ? '' : 'none';
    fields.hidden = mode !== 'bezier'; inputs.forEach(input => { input.disabled = mode !== 'bezier'; });
    svg.querySelector('[data-handles]').style.display = mode === 'bezier' && easing ? '' : 'none';
    const path = !easing ? '' : mode === 'constant' ? 'M30 140H260V10' : Array.from({length: 101}, (_, i) =>
      `${i ? 'L' : 'M'}${30 + i * 2.3} ${140 - easedProgress(easing, i / 100) * 130}`).join(' ');
    svg.querySelector('[data-curve]').setAttribute('d', path);
    if (mode === 'bezier' && easing) {
      const [x1,y1,x2,y2] = points, a = [30 + x1 * 230, 140 - y1 * 130], b = [30 + x2 * 230, 140 - y2 * 130];
      svg.querySelector('[data-guides]').setAttribute('d', `M30 140L${a} M260 10L${b}`);
      svg.querySelectorAll('circle').forEach((circle, i) => { circle.setAttribute('cx', [a,b][i][0]); circle.setAttribute('cy', [a,b][i][1]); });
    }
    onChange(Boolean(easing), mode);
  }
  let drag = null;
  svg.addEventListener('pointerdown', event => {
    const handle = event.target.closest('[data-handle]'); if (!handle || mode !== 'bezier') return;
    event.preventDefault(); drag = Number(handle.dataset.handle); svg.setPointerCapture(event.pointerId);
  });
  svg.addEventListener('pointermove', event => {
    if (drag === null) return;
    const position = new DOMPoint(event.clientX, event.clientY).matrixTransform(svg.getScreenCTM().inverse());
    points[drag * 2] = Math.round(Math.max(0, Math.min(1, (position.x - 30) / 230)) * 1000) / 1000;
    points[drag * 2 + 1] = Math.round(Math.max(0, Math.min(1, (140 - position.y) / 130)) * 1000) / 1000;
    inputs.forEach((input, index) => input.value = points[index]); render();
  });
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) svg.addEventListener(event, () => drag = null);
  render();
  return {read, focus: () => (buttons.find(button => button.dataset.easing === mode) ?? buttons.find(button => !button.disabled)).focus()};
}
