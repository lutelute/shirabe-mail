import { useState, useEffect, useRef } from 'react';
import type { AnalysisLogEntry } from '../types';

interface PhaseConfig {
  label: string;
  min: number;
  max: number;
}

const PHASES: Record<string, PhaseConfig> = {
  init:          { label: '準備中',         min: 0,  max: 5  },
  scanning:      { label: 'メール取得中',   min: 5,  max: 40 },
  investigating: { label: 'スレッド調査中', min: 40, max: 70 },
  analyzing:     { label: '分析中',         min: 70, max: 85 },
  thinking:      { label: 'まとめ中',       min: 85, max: 95 },
  complete:      { label: '完了',           min: 100, max: 100 },
};

const SCANNING_TOOLS = ['get_unread_mails', 'get_recent_mails', 'get_accounts'];
const INVESTIGATING_TOOLS = ['get_mail_detail', 'get_mail_thread', 'search_mails'];
const ANALYZING_TOOLS = ['analyze_thread', 'tag_mail'];

function detectPhase(entry: AnalysisLogEntry): string | null {
  if (entry.type === 'result') return 'complete';
  if (entry.type === 'info') return 'init';
  if (entry.type === 'tool') {
    const msg = entry.message.toLowerCase();
    if (SCANNING_TOOLS.some((t) => msg.includes(t))) return 'scanning';
    if (INVESTIGATING_TOOLS.some((t) => msg.includes(t))) return 'investigating';
    if (ANALYZING_TOOLS.some((t) => msg.includes(t))) return 'analyzing';
    // Unknown tool — stay in current or advance to scanning
    return 'scanning';
  }
  if (entry.type === 'text') return 'thinking';
  return null;
}

export function computeProgress(logs: AnalysisLogEntry[]): { phase: string; percent: number } {
  if (logs.length === 0) return { phase: 'init', percent: 0 };

  let currentPhase = 'init';
  let toolCountInPhase = 0;

  for (const entry of logs) {
    const detected = detectPhase(entry);
    if (!detected) continue;

    const phaseOrder = ['init', 'scanning', 'investigating', 'analyzing', 'thinking', 'complete'];
    const currentIdx = phaseOrder.indexOf(currentPhase);
    const detectedIdx = phaseOrder.indexOf(detected);

    if (detectedIdx > currentIdx) {
      currentPhase = detected;
      toolCountInPhase = 0;
    }
    if (entry.type === 'tool') toolCountInPhase++;
  }

  const config = PHASES[currentPhase] || PHASES.init;
  // Logarithmic sub-increment within phase range
  const range = config.max - config.min;
  const subProgress = toolCountInPhase > 0
    ? Math.min(1, Math.log(toolCountInPhase + 1) / Math.log(12))
    : 0;
  const percent = Math.round(config.min + range * subProgress);

  return { phase: currentPhase, percent: Math.min(percent, 100) };
}

export function useAnalysisProgress(
  logs: AnalysisLogEntry[],
  running: boolean,
): { percent: number; phaseLabel: string } {
  const [creepOffset, setCreepOffset] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const { phase, percent: basePercent } = computeProgress(logs);

  // Slow creep timer: advance 1% every 3 seconds within phase ceiling
  useEffect(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setCreepOffset(0);

    if (running && phase !== 'complete') {
      timerRef.current = setInterval(() => {
        setCreepOffset((prev) => prev + 1);
      }, 3000);
    }

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [running, phase]);

  // Reset creep when logs change (new tool call arrived)
  useEffect(() => {
    setCreepOffset(0);
  }, [logs.length]);

  if (!running && phase !== 'complete') {
    return { percent: 0, phaseLabel: '' };
  }

  const config = PHASES[phase] || PHASES.init;
  const percent = Math.min(basePercent + creepOffset, config.max, 100);

  return { percent, phaseLabel: config.label };
}
