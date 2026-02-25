import { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

// ── Module-level state (survives React unmount/remount) ──
let _term: Terminal | null = null;
let _fit: FitAddon | null = null;
let _ptyStarted = false;
let _dataCleanup: (() => void) | null = null;

const TERM_THEME = {
  background: '#0d0f14',
  foreground: '#e2e2f0',
  cursor: '#6366f1',
  selectionBackground: '#6366f140',
  black: '#1a1a2e',
  red: '#ef4444',
  green: '#22c55e',
  yellow: '#eab308',
  blue: '#3b82f6',
  magenta: '#a855f7',
  cyan: '#06b6d4',
  white: '#e2e2f0',
  brightBlack: '#4a4a6a',
  brightRed: '#f87171',
  brightGreen: '#4ade80',
  brightYellow: '#facc15',
  brightBlue: '#60a5fa',
  brightMagenta: '#c084fc',
  brightCyan: '#22d3ee',
  brightWhite: '#ffffff',
};

export default function ChatPanel() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'idle' | 'connecting' | 'connected' | 'error'>(
    _ptyStarted ? 'connected' : 'idle',
  );

  // Reattach existing terminal on mount
  useEffect(() => {
    if (_term && _ptyStarted && containerRef.current) {
      // Reattach terminal DOM element to this container
      const el = _term.element;
      if (el) {
        containerRef.current.appendChild(el);
        setTimeout(() => _fit?.fit(), 50);
      }
      setStatus('connected');
    }

    return () => {
      // On unmount: detach terminal element from DOM but keep terminal alive
      if (_term?.element?.parentElement) {
        try { _term.element.parentElement.removeChild(_term.element); } catch { /* ok */ }
      }
    };
  }, []);

  // Fit on resize when connected
  useEffect(() => {
    if (status !== 'connected' || !containerRef.current) return;

    const observer = new ResizeObserver(() => {
      if (_fit) {
        _fit.fit();
        const dims = _fit.proposeDimensions();
        if (dims) window.electronAPI.ptyResize(dims.cols, dims.rows);
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [status]);

  const startPty = useCallback(async () => {
    if (_ptyStarted) return;
    setStatus('connecting');

    // Wait for next frame so container div is rendered
    await new Promise((r) => requestAnimationFrame(r));
    if (!containerRef.current) {
      setStatus('error');
      return;
    }

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 11,
      lineHeight: 1.15,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: TERM_THEME,
      allowTransparency: true,
      scrollback: 10000,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();

    _term = term;
    _fit = fitAddon;

    term.onData((data) => {
      window.electronAPI.ptyWrite(data);
    });

    _dataCleanup = window.electronAPI.onPtyData((data: string) => {
      term.write(data);
      setStatus('connected');
    });

    try {
      await window.electronAPI.ptyCreate();
      _ptyStarted = true;
      setStatus('connected');
    } catch {
      setStatus('error');
    }
  }, []);

  const showTerminal = status !== 'idle';

  return (
    <div className="flex flex-col h-full relative">
      {/* Idle overlay */}
      {status === 'idle' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 z-10 bg-surface-900">
          <button
            onClick={startPty}
            className="px-3 py-1.5 text-[11px] bg-surface-800 hover:bg-surface-700 text-surface-300 hover:text-surface-100 rounded border border-surface-600 transition-colors"
          >
            Terminal
          </button>
          <p className="text-[9px] text-surface-600">Claude Code / Shell</p>
        </div>
      )}

      {/* Header bar (visible when terminal is active) */}
      {showTerminal && (
        <div className="px-2 py-0.5 border-b border-surface-700/50 flex items-center gap-2 flex-shrink-0">
          <span className={`text-[9px] px-1 py-px rounded ${
            status === 'connected' ? 'bg-green-500/20 text-green-400' :
            status === 'error' ? 'bg-red-500/20 text-red-400' :
            'bg-yellow-500/20 text-yellow-400'
          }`}>
            {status === 'connected' ? 'Terminal' : status === 'error' ? 'Error' : '...'}
          </span>
        </div>
      )}

      {/* Terminal container (always rendered so ref is available) */}
      <div
        ref={containerRef}
        className="flex-1 overflow-hidden"
        style={{
          backgroundColor: '#0d0f14',
          display: status === 'idle' ? 'none' : undefined,
          minHeight: 0,
        }}
      />
    </div>
  );
}
