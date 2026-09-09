const element = (tag, className, parent) => { const node = document.createElement(tag); node.className = className; parent?.append(node); return node; };
const DIALOG_STYLES = `.styk-timeline-dialog{padding:20px;width:370px;max-width:calc(100vw - 32px);border:1px solid #ddd;border-radius:10px;background:#fff;color:#333;box-shadow:0 16px 64px #0003;font:12px Inter,InterFallback,'Segoe UI',sans-serif}
.styk-timeline-dialog::backdrop{background:#0003;backdrop-filter:none}
.styk-timeline-dialog h2{margin:0 0 10px;font-size:16px;font-weight:600;color:#333}
.styk-timeline-dialog p{margin:0 0 14px;font-size:11px;line-height:1.6;color:#777}
.styk-timeline-dialog .styk-timeline-fields{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:16px 0 12px}
.styk-timeline-dialog label{display:block;font-size:11px;color:#666}
.styk-timeline-dialog input{display:block;box-sizing:border-box;width:100%;height:34px;margin-top:7px;padding:0 10px;border:1px solid #d9d9d9;border-radius:5px;background:#fafafa;color:#333;font:12px inherit;appearance:textfield}
.styk-timeline-dialog input:focus{outline:2px solid #0d99ff;outline-offset:1px}
.styk-timeline-presets{display:flex;align-items:center;gap:6px;margin:0 0 14px}
.styk-timeline-presets button{height:25px;min-width:33px;border:1px solid #e5e5e5;border-radius:4px;padding:0 8px;background:#fff;color:#666;font:10px inherit;cursor:pointer}
.styk-timeline-presets button:hover{background:#e5f4ff;border-color:#9fd6ff}
.styk-timeline-dialog .styk-timeline-dialog-note{font-size:10px;color:#888;margin-bottom:12px}
.styk-timeline-dialog-error{min-height:15px;margin:8px 0;color:#d14343;font-size:11px}
.styk-timeline-dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
.styk-timeline-dialog-actions button{height:32px;padding:0 14px;border:1px solid #ddd;border-radius:5px;background:#fff;color:#444;font:11px inherit;cursor:pointer}
.styk-timeline-dialog-actions button[type=submit]{background:#0d99ff;border-color:#0d99ff;color:#fff}
.styk-timeline-dialog-actions button:disabled{opacity:.5;cursor:default}
`;
export function createTimelineDialog(title, description, actionLabel) {
    if (!document.querySelector('[data-styk-keyframe-dialog-style]')) {
      const style = document.createElement('style'); style.dataset.stykKeyframeDialogStyle = ''; style.textContent = DIALOG_STYLES; document.head.append(style);
    }
    this.dialog?.close();
    if (this.menu) this.menu.hidden = true;
    this.onSeek?.(this.editor.tick, this.editor.frameIndex);
    const dialog = element('dialog', 'styk-timeline-dialog', document.body);
    this.dialog = dialog;
    dialog.setAttribute('aria-label', title);
    const form = element('form', '', dialog);
    const heading = element('h2', '', form); heading.textContent = title;
    const introduction = element('p', '', form); introduction.textContent = description;
    const content = element('div', '', form);
    const error = element('div', 'styk-timeline-dialog-error', form); error.setAttribute('role', 'alert');
    const actions = element('div', 'styk-timeline-dialog-actions', form);
    const cancel = element('button', '', actions); cancel.type = 'button'; cancel.textContent = 'Cancel';
    const apply = element('button', '', actions); apply.type = 'submit'; apply.textContent = actionLabel;
    cancel.addEventListener('click', () => dialog.close());
    dialog.addEventListener('keydown', event => event.stopPropagation());
    dialog.addEventListener('close', () => {
      dialog.remove();
      if (this.dialog === dialog) this.dialog = null;
      if (!this._destroyed && !this.disposed) (this.scroll ?? this.strip).focus({preventScroll: true});
    });
    return {dialog, form, content, error, apply, cancel};
  }
