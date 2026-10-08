// === Claude の Google カレンダー連携(claude.ai コネクタ)経由で予定を登録・削除する ===
//
// 先生の Claude アカウントで既に認可済みの Google カレンダー連携を、Claude Code CLI から使う。
// Google Cloud で OAuth クライアントを作らなくてよい。1 回の操作 = ツール 1 回の機械的な呼び出しなので
// 速いモデル(haiku)で十分。許可するツールは操作ごとに 1 つだけ(create / delete / list)。

import { spawn } from 'child_process';
import { StringDecoder } from 'string_decoder';
import * as fs from 'fs';
import * as path from 'path';
import type { CaseEvent } from '../../src/types/index';
import { extractJson } from './claude-runner';

const TOOL_LIST = 'mcp__claude_ai_Google_Calendar__list_calendars';
const TOOL_CREATE = 'mcp__claude_ai_Google_Calendar__create_event';
const TOOL_DELETE = 'mcp__claude_ai_Google_Calendar__delete_event';
const TOOL_EVENTS = 'mcp__claude_ai_Google_Calendar__list_events';

class ToolMissingError extends Error {}

export interface ClaudeGcalDeps {
  cliPath: string;
  env: Record<string, string>;
  workDir: string;
  log: (m: string) => void;
}

interface CliEnvelope { subtype?: string; is_error?: boolean; result?: string; permission_denials?: unknown[]; total_cost_usd?: number; num_turns?: number }

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

  /** 同じ会話での送り直しでも道具が出なかったときは、新しいプロセスでもう 1 回 */
  async function callTool<T>(tool: string, instruction: string, timeoutMs = 90_000, maxTurns = 4): Promise<T> {
    let last: Error | null = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        return await callToolOnce<T>(tool, instruction, timeoutMs, maxTurns);
      } catch (err) {
        last = err as Error;
        if (!(err instanceof ToolMissingError)) throw err;
        deps.log(`[claude-gcal] tool not loaded (try ${attempt}), retrying`);
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
    throw last ?? new Error('Google カレンダー連携を呼べませんでした');
  }

  async function callToolOnce<T>(tool: string, instruction: string, timeoutMs: number, maxTurns: number, minTurns = 2): Promise<T> {
    if (!deps.cliPath || !fs.existsSync(deps.cliPath)) throw new Error('Claude CLI が見つかりません');
    const env = { ...deps.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE;
    // 道具の遅延ロード(tool search)が有効だと、--tools "" で ToolSearch が無いため create_event 等が読み込まれない
    env.ENABLE_TOOL_SEARCH = 'false';
    env.PATH = `${path.dirname(deps.cliPath)}:${env.PATH ?? ''}`;
    // 入出力はストリーム形式で、会話を開いたまま進める。
    // claude.ai コネクタは裏で接続されるため、最初の依頼の時点では道具が無いことが半分ほどある(2026-10-08 実測)。
    // 同じプロセスで次の依頼を送ると、接続の完了を待ってから道具つきで始まる。そこで道具が無かった回は同じ会話で送り直す。
    const args = [
      '-p',
      '--model', 'haiku',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--max-turns', String(maxTurns),
      '--no-session-persistence',
      '--setting-sources', '',
      '--tools', '',
      '--allowedTools', tool,
      '--system-prompt', 'あなたは Google カレンダーのツールを呼ぶ係。渡された JSON の値はそのまま使い、勝手に変えない。ツールの結果から求められた JSON だけを返す。説明やコードブロックは不要。',
    ];
    type Init = { tools?: string[]; mcp_servers?: Array<{ name?: string; status?: string }> };
    const MAX_SENDS = 3;
    const out = await new Promise<{ init: Init | null; result: CliEnvelope | null; stderr: string; code: number | null; timedOut: boolean }>((resolve) => {
      const dec = new StringDecoder('utf8');
      const ec: Buffer[] = [];
      let buf = '';
      let init: Init | null = null;
      let sends = 0;
      let done = false;
      let timedOut = false;
      let timer: NodeJS.Timeout | null = null;
      const proc = spawn(deps.cliPath, args, { cwd: deps.workDir, env, stdio: ['pipe', 'pipe', 'pipe'] });
      const finish = (result: CliEnvelope | null, code: number | null) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        try { proc.stdin.end(); } catch { /* ignore */ }
        setTimeout(() => { try { proc.kill('SIGTERM'); } catch { /* ignore */ } }, 5000).unref();
        resolve({ init, result, stderr: Buffer.concat(ec).toString('utf8'), code, timedOut });
      };
      const send = (text: string) => {
        sends += 1;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { timedOut = true; finish(null, null); }, timeoutMs);
        try { proc.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`); } catch { /* close で拾う */ }
      };
      proc.stdout.on('data', (c: Buffer) => {
        buf += dec.write(c);
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line.startsWith('{')) continue;
          let d: { type?: string; subtype?: string } & CliEnvelope & Init;
          try { d = JSON.parse(line); } catch { continue; }
          if (d.type === 'system' && d.subtype === 'init') { init = d; continue; }
          if (d.type !== 'result') continue;
          const hasTool = !!init && (init.tools ?? []).includes(tool);
          if (!hasTool && sends < MAX_SENDS) {
            deps.log(`[claude-gcal] tool not loaded yet (send ${sends}), resending in the same session`);
            send(`いま Google カレンダーのツールが使えるようになりました。もう一度、必ずツールを呼んで実行してください。\n\n${instruction}`);
            continue;
          }
          if (hasTool && !d.is_error && (d.num_turns ?? 0) < minTurns && sends < MAX_SENDS) {
            deps.log(`[claude-gcal] answered without calling the tool (send ${sends}), asking again`);
            send(`まだツールを呼んでいません。推測で答えず、必ずツールを実際に呼んでから結果を返してください。\n\n${instruction}`);
            continue;
          }
          finish(d, 0);
        }
      });
      proc.stderr.on('data', (c: Buffer) => ec.push(c));
      proc.stdin.on('error', () => undefined);
      proc.on('error', (e) => { ec.push(Buffer.from(e.message)); finish(null, 1); });
      proc.on('close', (code) => finish(null, code));
      send(instruction);
    });
    if (out.timedOut) throw new Error('Google カレンダー連携の応答がタイムアウトしました');
    const { init, result: env2 } = out;
    if (init && !(init.tools ?? []).includes(tool)) {
      const st = (init.mcp_servers ?? []).find((x) => /calendar/i.test(x.name ?? ''))?.status;
      if (st && st !== 'connected' && st !== 'pending') throw new Error(`Claude の Google カレンダー連携が「${st}」です(claude.ai の設定 → コネクタで Google カレンダーを確認してください)`);
      throw new ToolMissingError('Claude の Google カレンダー連携の道具が読み込めませんでした');
    }
    if (!env2) throw new Error(`Claude の Google カレンダー連携を呼べませんでした: ${out.stderr.split('\n').find((l) => l.trim())?.slice(0, 160) ?? `exit ${out.code}`}`);
    if (env2.is_error || (env2.subtype && env2.subtype !== 'success')) throw new Error(`Google カレンダー連携: ${(env2.result ?? env2.subtype ?? '').slice(0, 200)}`);
    // 道具を実際に呼んだか(呼べば最低 2 ターン)。呼ばずに「できた」と返すことがあるので必ず確かめる
    if ((env2.num_turns ?? 0) < minTurns) throw new ToolMissingError(`Google カレンダーの道具が実行されませんでした(turns ${env2.num_turns ?? 0})`);
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

  /** カレンダーごとの権限(owner / writer / reader)。1 回の呼び出しで list_events を件数分 */
  async function checkAccess(calendarIds: string[]): Promise<Record<string, string>> {
    if (calendarIds.length === 0) return {};
    const r = await callTool<Array<{ id?: string; accessRole?: string }>>(
      TOOL_EVENTS,
      `次の各カレンダーについて list_events を startTime "2026-12-31T00:00:00+09:00"・endTime "2026-12-31T00:01:00+09:00"・pageSize 1 で 1 回ずつ呼び、応答の accessRole を読んでください。\n${JSON.stringify(calendarIds)}\n\n[{"id": "<calendarId>", "accessRole": "<owner|writer|reader|freeBusyReader>"}] の JSON 配列だけを返してください。`,
      60_000 + calendarIds.length * 15_000,
      calendarIds.length + 3,
    );
    const out: Record<string, string> = {};
    for (const x of Array.isArray(r) ? r : []) if (x?.id && x.accessRole) out[x.id] = x.accessRole;
    return out;
  }

  /** まとめて登録(1 回の Claude 呼び出しで create_event を件数分)。key → 結果 */
  async function createEvents(items: Array<{ key: string; calendarId: string; ev: CaseEvent & { description?: string } }>): Promise<Map<string, { id: string; htmlLink: string; calendarId: string }>> {
    const out = new Map<string, { id: string; htmlLink: string; calendarId: string }>();
    if (items.length === 0) return out;
    const payload = items.map((it) => ({ key: it.key, args: createEventArgs(it.calendarId, it.ev) }));
    const r = await callTool<Array<{ key?: string; eventId?: string; id?: string; htmlLink?: string }> | { results?: Array<{ key?: string; eventId?: string; id?: string; htmlLink?: string }> }>(
      TOOL_CREATE,
      `次の ${items.length} 件それぞれについて、args をそのまま使って create_event を 1 回ずつ(合計 ${items.length} 回)呼んでください。\n${JSON.stringify(payload, null, 2)}\n\n全部終わったら [{"key": "<key>", "eventId": "<作成された予定の id>", "htmlLink": "<URL(あれば)>"}] の JSON 配列だけを返してください(失敗した件は eventId を空に)。`,
      60_000 + items.length * 20_000,
      items.length + 3,
    );
    const arr = Array.isArray(r) ? r : (r.results ?? []);
    for (const x of arr) {
      const id = x?.eventId ?? x?.id;
      const it = items.find((i) => i.key === x?.key);
      if (it && id) out.set(it.key, { id, htmlLink: x.htmlLink ?? '', calendarId: it.calendarId });
    }
    return out;
  }

  async function deleteEvent(calendarId: string, eventId: string): Promise<void> {
    const r = await callTool<{ id?: string; status?: string }>(
      TOOL_DELETE,
      `delete_event を次の引数そのままで 1 回呼んでください。\n${JSON.stringify({ calendarId, eventId, notificationLevel: 'NONE' })}\n\nツールの応答の id と status をそのまま {"id": "...", "status": "..."} の JSON で返してください。`,
    );
    if (r.status && !/cancel|delet/i.test(r.status)) throw new Error(`予定を消せませんでした(status ${r.status})`);
  }

  return { listCalendars, createEvent, createEvents, deleteEvent, checkAccess };
}

export type ClaudeGcal = ReturnType<typeof createClaudeGcal>;
