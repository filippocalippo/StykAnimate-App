// Replay-only adapter over the actual exported native-property token owner.
import {beginNativePropertyEdit, previewNativePropertyEdit, commitNativePropertyEdit, cancelNativePropertyEdit, getNativePropertyValue, canEditNativeProperty} from '../../src/native-property-edit.mjs';
export function nativePropertyReplay(editor) {
  const tokens = new Map(); let next = 0, current;
  return (method, args) => {
    if (method === '@nativeBegin') {
      const token = beginNativePropertyEdit(editor, ...args), id = ++next;
      tokens.set(id, token); current = id;
      return {token: id, value: token.value};
    }
    if (method === '@nativePreview') return previewNativePropertyEdit(tokens.get(args[1] ?? current), args[0]);
    if (method === '@nativeCommit') return commitNativePropertyEdit(tokens.get(args[0] ?? current));
    if (method === '@nativeCancel') return cancelNativePropertyEdit(tokens.get(args[0] ?? current));
    if (method === '@nativeGet') return getNativePropertyValue(editor, ...args);
    if (method === '@nativeCan') return canEditNativeProperty(editor, ...args);
    throw new Error(`Unknown native property replay call: ${method}`);
  };
}
