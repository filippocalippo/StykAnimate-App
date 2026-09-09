/** Compact pose controls, composed into the existing Transform section. */
export function ikControlsView(ik) {
  const check = (id, label, checked) => `<label class="ik-check"><input type="checkbox" id="${id}" ${checked ? 'checked' : ''}><span>${label}</span></label>`;
  return `<div class="ik-settings"><div class="ik-switches">${check('node-is-ik', 'Is IK', ik.enabled)}${ik.enabled ?
    check('node-ik-pinned', 'Pinned', ik.pinned) + check('node-ik-stretch', 'Allow stretch', ik.allowStretch) : ''}</div>${ik.enabled ?
    `<div class="ik-grid"><label class="field"><span>Chain</span><input id="node-ik-chain" type="number" min="1" max="${ik.maxLength}" step="1" value="${ik.chainLength}" aria-label="IK chain length"></label>` +
    `<label class="field"><span>Rotation</span><input id="node-ik-rotation" type="number" step="1" value="${Math.round(ik.target.rotation * 180 / Math.PI * 100) / 100}" aria-label="IK target rotation"><small>°</small></label></div>` +
    `<div class="ik-bend-row"><span>Direction</span><div class="ik-segments" role="group" aria-label="IK bend direction">${[[-1, 'Left'], [0, 'Both'], [1, 'Right']].map(([value, label]) =>
      `<label><input type="radio" name="node-ik-bend" value="${value}" ${ik.bendDirection === value ? 'checked' : ''} aria-label="Bend ${label.toLowerCase()}"><span>${label}</span></label>`).join('')}</div></div>` : ''}</div>`;
}
