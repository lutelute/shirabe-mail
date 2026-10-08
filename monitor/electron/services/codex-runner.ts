// === Codex CLI runner(OpenAI Codex、ChatGPT ログインで動く) ===
//
// ClaudeRunner と同じ形(run / available)で、相棒の判定・下書き・申し送りを Codex に任せる。
//  - `codex exec -`(プロンプトは stdin)/ `--ignore-user-config`(MCP 等を読まない)/ `-s read-only`
//  - `--output-schema` で構造化出力。OpenAI の strict スキーマに合わせて変換(全プロパティ required、
//    任意項目は null 許容、additionalProperties:false)
//  - 応答は `-o <file>` の最終メッセージを読む
//  - Codex にはシステムプロンプトの口が無いので、「# 指示」として本文の先頭に置く

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { ClaudeRunner, StructuredCall, RunResult } from './claude-runner';
import { extractJson } from './claude-runner';

export interface CodexRunnerConfig {
  cliPath: string;
  env: Record<string, string>;
  workDir: string;
  concurrency?: number;
  log?: (msg: string) => void;
  getModel?: () => string | undefined;     // 例 'gpt-6-astra'(空 = Codex の既定)
  getEffort?: () => string | undefined;    // minimal|low|medium|high|xhigh
}

/** JSON Schema を OpenAI strict 形式へ(純関数) */
export function strictifySchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strictifySchema);
  if (!schema || typeof schema !== 'object') return schema;
  const s = { ...(schema as Record<string, unknown>) };
  const types = Array.isArray(s.type) ? (s.type as string[]) : s.type ? [s.type as string] : [];
  if (types.includes('object') && s.properties && typeof s.properties === 'object') {
    const props = s.properties as Record<string, Record<string, unknown>>;
    const req = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(props)) {
      let pv = strictifySchema(v) as Record<string, unknown>;
      if (!req.has(k)) {
        // 任意項目は null 許容にして required へ
        const t = pv.type;
        if (Array.isArray(t)) { if (!t.includes('null')) pv = { ...pv, type: [...t, 'null'] }; }
        else if (typeof t === 'string') { if (t !== 'null') pv = { ...pv, type: [t, 'null'] }; }
        if (Array.isArray(pv.enum) && !(pv.enum as unknown[]).includes(null)) pv = { ...pv, enum: [...(pv.enum as unknown[]), null] };
      }
      next[k] = pv;
    }
    s.properties = next;
    s.required = Object.keys(props);
    s.additionalProperties = false;
  }
  if (s.items) s.items = strictifySchema(s.items);
  return s;
}

/** Claude の effort 名を Codex の reasoning effort へ */
export function codexEffort(e?: string): string {
  if (e === 'max' || e === 'xhigh') return 'xhigh';
  if (e === 'high' || e === 'medium' || e === 'low' || e === 'minimal') return e;
  return 'high';
}

export function codexFriendlyError(text: string, code: number | null): string {
  if (/usage limit|rate limit|429/i.test(text)) {
    const m = text.match(/try again at ([^.\n]+)/i);
    return `Codex の利用上限に達しています${m ? `(${m[1]} に回復)` : ''}`;
  }
  if (/not logged in|login|unauthorized|401/i.test(text)) return 'Codex にログインしていません(ターミナルで codex login)';
  if (/ENOENT/.test(text)) return 'Codex CLI が見つかりません';
  const line = text.split('\n').map((l) => l.trim()).reverse().find((l) => /^ERROR/i.test(l)) ?? text.split('\n').find((l) => l.trim()) ?? '';
  return `Codex CLI エラー (exit ${code ?? '?'}): ${line.slice(0, 200)}`;
}

class Semaphore {
  private active = 0;
  private queue: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  async acquire(): Promise<void> {
    if (this.active < this.limit) { this.active += 1; return; }
    await new Promise<void>((r) => this.queue.push(r));
    this.active += 1;
  }
  release(): void { this.active -= 1; this.queue.shift()?.(); }
}

export function createCodexRunner(cfg: CodexRunnerConfig): ClaudeRunner {
  const sem = new Semaphore(Math.max(1, cfg.concurrency ?? 2));
  const log = cfg.log ?? (() => undefined);
  try { fs.mkdirSync(cfg.workDir, { recursive: true }); } catch { /* ignore */ }
  const available = !!cfg.cliPath && fs.existsSync(cfg.cliPath);

  async function run<T>(call: StructuredCall): Promise<RunResult<T>> {
    const started = Date.now();
    const base: RunResult<T> = { ok: false, data: null, text: '', costUsd: 0, durationMs: 0, inputTokens: 0, outputTokens: 0 };
    if (!available) return { ...base, error: 'Codex CLI が見つかりません' };
    await sem.acquire();
    const id = randomUUID();
    const outFile = path.join(cfg.workDir, `out-${id}.txt`);
    const schemaFile = path.join(cfg.workDir, `schema-${id}.json`);
    try {
      const model = cfg.getModel?.();
      const args = ['exec', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '-s', 'read-only', '-C', cfg.workDir, '--color', 'never', '-o', outFile,
        '-c', `model_reasoning_effort="${codexEffort(call.effort ?? cfg.getEffort?.())}"`];
      if (model) args.push('-m', model);
      if (call.schema) {
        fs.writeFileSync(schemaFile, JSON.stringify(strictifySchema(call.schema)), 'utf-8');
        args.push('--output-schema', schemaFile);
      }
      args.push('-');
      const input = `# 指示\n${call.systemPrompt}\n\n# 入力\n${call.prompt}${call.schema ? '\n\n指定のスキーマに沿った JSON だけを返してください。' : ''}`;
      const timeoutMs = call.timeoutMs ?? 180_000;
      const outcome = await new Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }>((resolve) => {
        const outChunks: Buffer[] = [];
        const errChunks: Buffer[] = [];
        let timedOut = false;
        let proc: ReturnType<typeof spawn>;
        try {
          proc = spawn(cfg.cliPath, args, { cwd: cfg.workDir, env: cfg.env, stdio: ['pipe', 'pipe', 'pipe'] });
        } catch (err) {
          resolve({ stdout: '', stderr: (err as Error).message, code: 1, timedOut: false });
          return;
        }
        const timer = setTimeout(() => { timedOut = true; proc.kill('SIGTERM'); setTimeout(() => { if (!proc.killed) proc.kill('SIGKILL'); }, 3000); }, timeoutMs);
        proc.stdout?.on('data', (c: Buffer) => outChunks.push(c));
        proc.stderr?.on('data', (c: Buffer) => errChunks.push(c));
        proc.on('error', (err) => { clearTimeout(timer); resolve({ stdout: Buffer.concat(outChunks).toString('utf8'), stderr: `${Buffer.concat(errChunks).toString('utf8')}\n${err.message}`, code: 1, timedOut }); });
        proc.on('close', (code) => { clearTimeout(timer); resolve({ stdout: Buffer.concat(outChunks).toString('utf8'), stderr: Buffer.concat(errChunks).toString('utf8'), code, timedOut }); });
        proc.stdin?.on('error', () => undefined);
        proc.stdin?.end(input);
      });
      const durationMs = Date.now() - started;
      if (outcome.timedOut) return { ...base, durationMs, error: `Codex の応答がタイムアウトしました(${Math.round(timeoutMs / 1000)}秒)` };
      let text = '';
      try { text = fs.readFileSync(outFile, 'utf-8').trim(); } catch { /* none */ }
      if (outcome.code !== 0 || !text) {
        const err = codexFriendlyError(`${outcome.stderr}\n${outcome.stdout}`, outcome.code);
        log(`[codex-runner] ${call.label ?? ''} ${err}`);
        return { ...base, durationMs, text, error: err };
      }
      let data: T | null = null;
      if (call.schema) {
        data = extractJson<T>(text);
        if (!data) return { ...base, durationMs, text, error: 'Codex の構造化出力を解析できませんでした' };
      }
      log(`[codex-runner] ${call.label ?? ''} ok in ${durationMs}ms`);
      return { ok: true, data, text, costUsd: 0, durationMs, inputTokens: 0, outputTokens: 0 };
    } finally {
      for (const f of [outFile, schemaFile]) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
      sem.release();
    }
  }
  return { run, available };
}

/** 設定に応じて Claude / Codex を切り替える runner。Codex が失敗(上限など)したら Claude で続ける */
export function createEngineRunner(opts: {
  claude: ClaudeRunner;
  codex: ClaudeRunner;
  getEngine: () => 'claude' | 'codex';
  claudeModelFor: (requested: string) => string;
  onFallback?: (reason: string) => void;
}): ClaudeRunner {
  return {
    get available() { return opts.claude.available || opts.codex.available; },
    async run<T>(call: StructuredCall): Promise<RunResult<T>> {
      if (opts.getEngine() === 'codex' && opts.codex.available) {
        const r = await opts.codex.run<T>(call);
        if (r.ok) return r;
        opts.onFallback?.(r.error ?? 'Codex が失敗');
        return opts.claude.run<T>({ ...call, model: opts.claudeModelFor(call.model) });
      }
      return opts.claude.run<T>(call);
    },
  };
}
