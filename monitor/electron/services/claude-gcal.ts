// === Claude の Google カレンダー連携(claude.ai コネクタ)経由で予定を登録・削除する ===
//
// 先生の Claude アカウントで既に認可済みの Google カレンダー連携を、Claude Code CLI から使う。
// Google Cloud で OAuth クライアントを作らなくてよい。1 回の操作 = ツール 1 回の機械的な呼び出しなので
// 速いモデル(haiku)で十分。許可するツールは操作ごとに 1 つだけ(create / delete / list)。

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { CaseEvent } from '../../src/types/index';
import { extractJson } from './claude-runner';

const TOOL_LIST = 'mcp__claude_ai_Google_Calendar__list_calendars';
const TOOL_CREATE = 'mcp__claude_ai_Google_Calendar__create_event';
const TOOL_DELETE = 'mcp__claude_ai_Google_Calendar__delete_event';

export interface ClaudeGcalDeps {
  cliPath: string;
  env: Record<string, string>;
  workDir: string;
  log: (m: string) => void;
}

interface CliEnvelope { subtype?: string; is_error?: boolean; result?: string; permission_denials?: unknown[]; total_cost_usd?: number }

/** CaseEvent → create_event の引数(純関数)。時刻は +09:00 付き ISO、終日は 0:00〜翌 0:00 + allDay */
export function createEventArgs(calendarId: string, ev: CaseEvent & { description?: string }): Record<string, unknown> {
  const m = ev.start.match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/);
  if (!m) throw new Error(`予定の日時が読めません: ${ev.start}`);
  const allDay = ev.allDay || !m[2];
  const nextDay = (day: string) => {
    const d = new Date(`${day}T00:00:00`);
    d.setDate(d.getDate() + 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  let startTime: string;
  let endTime: string;
  if (allDay) {
    const endDay = (ev.end ?? '').slice(0, 10);
    startTime = `${m[1]}T00:00:00+09:00`;
    endTime = `${nextDay(endDay && endDay >= m[1] ? endDay : m[1])}T00:00:00+09:00`;
  } else {
    startTime = `${m[1]}T${m[2]}:00+09:00`;
    const me = (ev.end ?? '').match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
    if (me) endTime = `${me[1]}T${me[2]}:00+09:00`;
    else {
      const d = new Date(`${m[1]}T${m[2]}:00`);
      d.setHours(d.getHours() + 1);
      endTime = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:00+09:00`;
    }
  }
  const args: Record<string, unknown> = {
    calendarId,
    summary: ev.title,
    startTime,
    endTime,
    timeZone: 'Asia/Tokyo',
    useDefaultReminders: true,
    notificationLevel: 'NONE',
  };
  if (allDay) args.allDay = true;
  if (ev.location) args.location = ev.location;
  if (ev.description) args.description = ev.description.slice(0, 3000);
  return args;
}

export function createClaudeGcal(deps: ClaudeGcalDeps) {
  try { fs.mkdirSync(deps.workDir, { recursive: true }); } catch { /* ignore */ }

  async function callTool<T>(tool: string, instruction: string, timeoutMs = 90_000): Promise<T> {
    if (!deps.cliPath || !fs.existsSync(deps.cliPath)) throw new Error('Claude CLI が見つかりません');
    const env = { ...deps.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE;
    env.PATH = `${path.dirname(deps.cliPath)}:${env.PATH ?? ''}`;
    const args = [
      '-p', '-',
      '--model', 'haiku',
      '--output-format', 'json',
      '--max-turns', '4',
      '--no-session-persistence',
      '--setting-sources', '',
      '--tools', '',
      '--allowedTools', tool,
      '--system-prompt', 'あなたは Google カレンダーのツールを 1 回だけ呼ぶ係。渡された JSON の値はそのまま使い、勝手に変えない。ツールの結果から求められた JSON だけを返す。説明やコードブロックは不要。',
    ];
    const out = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
      const oc: Buffer[] = [];
      const ec: Buffer[] = [];
      const proc = spawn(deps.cliPath, args, { cwd: deps.workDir, env, stdio: ['pipe', 'pipe', 'pipe'] });
      const timer = setTimeout(() => proc.kill('SIGTERM'), timeoutMs);
      proc.stdout.on('data', (c: Buffer) => oc.push(c));
      proc.stderr.on('data', (c: Buffer) => ec.push(c));
      proc.on('error', (e) => { clearTimeout(timer); resolve({ stdout: '', stderr: e.message, code: 1 }); });
      proc.on('close', (code) => { clearTimeout(timer); resolve({ stdout: Buffer.concat(oc).toString('utf8'), stderr: Buffer.concat(ec).toString('utf8'), code }); });
      proc.stdin.on('error', () => undefined);
      proc.stdin.end(instruction);
    });
    const line = out.stdout.split('\n').map((l) => l.trim()).reverse().find((l) => l.startsWith('{'));
    let env2: CliEnvelope | null = null;
    try { env2 = line ? (JSON.parse(line) as CliEnvelope) : null; } catch { env2 = null; }
    if (!env2) throw new Error(`Claude の Google カレンダー連携を呼べませんでした: ${(out.stderr || out.stdout).split('\n').find((l) => l.trim())?.slice(0, 160) ?? `exit ${out.code}`}`);
    if (env2.is_error || (env2.subtype && env2.subtype !== 'success')) throw new Error(`Google カレンダー連携: ${(env2.result ?? env2.subtype ?? '').slice(0, 200)}`);
    if (Array.isArray(env2.permission_denials) && env2.permission_denials.length > 0) {
      throw new Error('Claude の Google カレンダー連携が使えません(claude.ai の「コネクタ」で Google カレンダーを有効にしてください)');
    }
    const data = extractJson<T>(env2.result ?? '');
    if (!data) throw new Error(`Google カレンダー連携の応答を読めませんでした: ${(env2.result ?? '').slice(0, 160)}`);
    deps.log(`[claude-gcal] ${tool.split('__').pop()} ok (cost $${(env2.total_cost_usd ?? 0).toFixed(3)})`);
    return data;
  }

  async function listCalendars(): Promise<Array<{ id: string; summary: string }>> {
    const r = await callTool<Array<{ id: string; summary?: string }> | { calendars?: Array<{ id: string; summary?: string }> }>(
      TOOL_LIST,
      'list_calendars を 1 回呼び、[{"id": "...", "summary": "..."}] の形の JSON 配列だけを返してください。',
    );
    const arr = Array.isArray(r) ? r : (r.calendars ?? []);
    return arr.filter((c) => c && typeof c.id === 'string').map((c) => ({ id: c.id, summary: c.summary ?? c.id }));
  }

  async function createEvent(calendarId: string, ev: CaseEvent & { description?: string }): Promise<{ id: string; htmlLink: string; calendarId: string }> {
    const a = createEventArgs(calendarId, ev);
    const r = await callTool<{ eventId?: string; id?: string; htmlLink?: string }>(
      TOOL_CREATE,
      `create_event を次の引数そのままで 1 回呼んでください。\n${JSON.stringify(a, null, 2)}\n\n成功したら {"eventId": "<作成された予定の id>", "htmlLink": "<予定の URL(あれば)>"} の JSON だけを返してください。`,
    );
    const id = r.eventId ?? r.id;
    if (!id) throw new Error('予定の id が返りませんでした');
    return { id, htmlLink: r.htmlLink ?? '', calendarId };
  }

  async function deleteEvent(calendarId: string, eventId: string): Promise<void> {
    await callTool<{ ok?: boolean }>(
      TOOL_DELETE,
      `delete_event を次の引数そのままで 1 回呼んでください。\n${JSON.stringify({ calendarId, eventId, notificationLevel: 'NONE' })}\n\n終わったら {"ok": true} だけを返してください。`,
    );
  }

  return { listCalendars, createEvent, deleteEvent };
}

export type ClaudeGcal = ReturnType<typeof createClaudeGcal>;
