// === 夜間執事の学習ルール ===
// 先生の訂正(「この人は常に重要」「この人のメールは不要」)を永続化し、
// 次回以降の判定に決定論的に反映する。AIプロンプトにも要約を渡す。

import * as fs from 'fs';
import type { ButlerRules, ButlerSenderRule, SenderTier } from '../../src/types/index';

export const EMPTY_RULES: ButlerRules = { senders: {}, domains: {} };

export function normalizeAddress(address: string): string {
  return (address || '').trim().toLowerCase();
}

export function domainOf(address: string): string {
  const a = normalizeAddress(address);
  const at = a.lastIndexOf('@');
  return at >= 0 ? a.slice(at + 1) : '';
}

export function loadRules(filePath: string): ButlerRules {
  try {
    if (!fs.existsSync(filePath)) return { senders: {}, domains: {} };
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<ButlerRules>;
    return {
      senders: raw.senders && typeof raw.senders === 'object' ? raw.senders : {},
      domains: raw.domains && typeof raw.domains === 'object' ? raw.domains : {},
    };
  } catch {
    return { senders: {}, domains: {} };
  }
}

export function saveRules(filePath: string, rules: ButlerRules): void {
  fs.writeFileSync(filePath, JSON.stringify(rules, null, 2), 'utf-8');
}

/** ルールを設定/解除して返す(純関数) */
export function withSenderRule(
  rules: ButlerRules,
  address: string,
  tier: 'vip' | 'noise' | null,
  note?: string,
): ButlerRules {
  const key = normalizeAddress(address);
  if (!key) return rules;
  const senders = { ...rules.senders };
  if (tier === null) {
    delete senders[key];
  } else {
    const rule: ButlerSenderRule = { tier, note, updatedAt: new Date().toISOString() };
    senders[key] = rule;
  }
  return { ...rules, senders };
}

/** 学習ルールから階層を引く(無ければ null) */
export function tierFromRules(rules: ButlerRules, address: string): SenderTier | null {
  const key = normalizeAddress(address);
  if (!key) return null;
  const s = rules.senders[key];
  if (s) return s.tier;
  const d = rules.domains[domainOf(key)];
  if (d) return d.tier;
  return null;
}

/** AIプロンプト向けの要約(空なら空文字) */
export function rulesToPromptText(rules: ButlerRules): string {
  const lines: string[] = [];
  for (const [addr, r] of Object.entries(rules.senders)) {
    lines.push(`- ${addr}: ${r.tier === 'vip' ? '常に重要(先生指定)' : '不要(先生指定)'}${r.note ? ` — ${r.note}` : ''}`);
  }
  for (const [dom, r] of Object.entries(rules.domains)) {
    lines.push(`- @${dom}: ${r.tier === 'vip' ? '常に重要(先生指定)' : '不要(先生指定)'}${r.note ? ` — ${r.note}` : ''}`);
  }
  return lines.join('\n');
}
