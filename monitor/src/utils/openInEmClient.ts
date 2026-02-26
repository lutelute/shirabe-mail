/**
 * Open a mail in eM Client — copies subject to clipboard and activates eM Client.
 * Shows a brief toast notification to let the user know.
 */
export async function openInEmClient(params: { subject: string; fromAddress?: string }): Promise<void> {
  const result = await window.electronAPI.openMailInEmClient(params);

  if (result.clipboardCopied) {
    showToast('件名をクリップボードにコピーしました — eM Clientの検索に貼り付けてください');
  } else if (!result.success) {
    showToast('eM Clientを開けませんでした', true);
  }
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;

function showToast(message: string, isError = false): void {
  // Remove existing toast
  const existing = document.getElementById('shirabe-toast');
  if (existing) existing.remove();
  if (toastTimer) clearTimeout(toastTimer);

  const el = document.createElement('div');
  el.id = 'shirabe-toast';
  el.textContent = message;
  Object.assign(el.style, {
    position: 'fixed',
    bottom: '20px',
    left: '50%',
    transform: 'translateX(-50%)',
    padding: '8px 16px',
    borderRadius: '6px',
    fontSize: '12px',
    color: '#e4e6eb',
    background: isError ? '#7f1d1d' : '#1e293b',
    border: `1px solid ${isError ? '#991b1b' : '#334155'}`,
    zIndex: '99999',
    opacity: '0',
    transition: 'opacity 0.2s',
    pointerEvents: 'none' as const,
  });

  document.body.appendChild(el);
  requestAnimationFrame(() => { el.style.opacity = '1'; });

  toastTimer = setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 300);
  }, 3000);
}
