// === 日本語入力(IME)の変換確定 Enter を「送信」と取り違えないための判定 ===
//
// Chromium では変換確定の keydown は isComposing=true / keyCode=229 になるが、
// macOS の IME では compositionend の直後に Enter が来る並びもあるので、確定から少しの間も無視する。

let lastCompositionEnd = 0;
if (typeof document !== 'undefined') {
  document.addEventListener('compositionend', () => { lastCompositionEnd = performance.now(); }, true);
}

type KeyLike = { key: string; keyCode?: number; nativeEvent?: { isComposing?: boolean }; isComposing?: boolean };

/** 変換中・変換確定直後のキー操作なら true(送信しない) */
export function isComposingKey(e: KeyLike): boolean {
  const native = e.nativeEvent ?? e;
  if (native.isComposing) return true;
  if (e.keyCode === 229) return true;
  return performance.now() - lastCompositionEnd < 120;
}

/** 送信してよい Enter か(変換確定の Enter や Shift+Enter は除く) */
export function isSubmitEnter(e: KeyLike & { shiftKey?: boolean }): boolean {
  return e.key === 'Enter' && !e.shiftKey && !isComposingKey(e);
}
