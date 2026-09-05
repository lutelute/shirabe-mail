// === Claude CLI runner (APIキー不要・Claude Code のログイン資格情報で動く) ===
//
// 夜間執事の AI 呼び出しはすべてここを通す。ポイント:
//  - `--system-prompt` で既定のシステムプロンプトを丸ごと置き換え(≈1k tokens, 2秒)
//  - `--strict-mcp-config` + 空の MCP 設定で、ユーザーの MCP サーバー群を読み込まない
//  - `--tools ""` でツール無し(分類・下書きは純粋な生成タスク)
//  - `--json-schema` で構造化出力を強制(パース失敗を構造的に減らす)
//  - 専用の空ディレクトリを cwd にして CLAUDE.md 等の巻き込みを防ぐ
//  - 同時実行数を制限(既定2)

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface ClaudeRunnerConfig {
  cliPath: string;
  env: Record<string, string>;
  workDir: string;          // 空の作業ディレクトリ(存在しなければ作る)
  concurrency?: number;     // 同時実行数(既定2)
  log?: (msg: string) => void;
}

export interface StructuredCall {
  prompt: string;
  systemPrompt: string;
  model: string;            // 'haiku' | 'sonnet' | 'opus' | full model id
  schema?: object;          // JSON Schema。省略時はテキスト応答
  timeoutMs?: number;
  label?: string;           // ログ用
}

export interface RunResult<T> {
  ok: boolean;
  data: T | null;           // schema 指定時の構造化出力
  text: string;             // 生テキスト(schema 無し、またはフォールバック)
  costUsd: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  error?: string;
}

interface CliJsonEnvelope {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  total_cost_usd?: number;
  duration_ms?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  errors?: string[];
}

// --- 小さなセマフォ ---
class Semaphore {
  private active = 0;
  private queue: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active += 1;
  }
  release(): void {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) next();
  }
}

/** ```json フェンスや前後の説明文を剥がして JSON を取り出す */
export function extractJson<T>(text: string): T | null {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], text];
  for (const c of candidates) {
    if (!c) continue;
    const trimmed = c.trim();
    try {
      return JSON.parse(trimmed) as T;
    } catch {
      // 先頭の { または [ から末尾の } または ] まで
      const objMatch = trimmed.match(/\{[\s\S]*\}/);
      const arrMatch = trimmed.match(/\[[\s\S]*\]/);
      for (const m of [objMatch, arrMatch]) {
        if (!m) continue;
        try {
          return JSON.parse(m[0]) as T;
        } catch {
          /* try next */
        }
      }
    }
  }
  return null;
}

function friendlyError(stderr: string, resultText: string, exitCode: number | null): string {
  const blob = `${stderr}\n${resultText}`;
  if (/not logged in|login required|please run \/login|authentication_error|invalid api key|401/i.test(blob)) {
    return 'Claude Code にログインしていません。ターミナルで `claude` を起動してログインしてください。';
  }
  if (/rate limit|429|overloaded|529/i.test(blob)) {
    return 'Claude の利用上限に達しています。しばらく待ってから再実行してください。';
  }
  if (/ENOENT/.test(blob)) {
    return 'Claude CLI が見つかりません。';
  }
  const firstLine = (stderr || resultText).split('\n').find((l) => l.trim()) ?? '';
  return `Claude CLI エラー (exit ${exitCode ?? '?'}): ${firstLine.slice(0, 200)}`;
}

export interface ClaudeRunner {
  run<T = unknown>(call: StructuredCall): Promise<RunResult<T>>;
  readonly available: boolean;
}

export function createClaudeRunner(cfg: ClaudeRunnerConfig): ClaudeRunner {
  const sem = new Semaphore(Math.max(1, cfg.concurrency ?? 2));
  const log = cfg.log ?? (() => undefined);

  // 作業ディレクトリと空の MCP 設定を用意
  let mcpConfigPath = '';
  try {
    fs.mkdirSync(cfg.workDir, { recursive: true });
    mcpConfigPath = path.join(cfg.workDir, 'empty-mcp.json');
    if (!fs.existsSync(mcpConfigPath)) {
      fs.writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: {} }), 'utf-8');
    }
  } catch (err) {
    log(`[claude-runner] workDir init failed: ${(err as Error).message}`);
  }

  const available = !!cfg.cliPath && fs.existsSync(cfg.cliPath);

  async function run<T>(call: StructuredCall): Promise<RunResult<T>> {
    const started = Date.now();
    const base: RunResult<T> = {
      ok: false, data: null, text: '', costUsd: 0, durationMs: 0, inputTokens: 0, outputTokens: 0,
    };
    if (!available) {
      return { ...base, error: 'Claude CLI が見つかりません。Claude Code をインストールしてください。' };
    }

    await sem.acquire();
    try {
      const args = [
        '-p', '-',
        '--output-format', 'json',
        '--model', call.model,
        // 構造化出力は内部的にツール呼び出し1回を挟むことがあり、1ターンだと
        // "Reached maximum number of turns" で落ちる。ツール無しなので余裕を持たせても害はない
        '--max-turns', '3',
        '--tools', '',
        '--strict-mcp-config',
        '--setting-sources', '',
        '--no-session-persistence',
        '--system-prompt', call.systemPrompt,
      ];
      if (mcpConfigPath) args.push('--mcp-config', mcpConfigPath);
      if (call.schema) args.push('--json-schema', JSON.stringify(call.schema));

      const env = { ...cfg.env };
      delete env.CLAUDECODE;
      delete env.CLAUDE_CODE;
      env.PATH = `${path.dirname(cfg.cliPath)}:${env.PATH ?? ''}`;

      const timeoutMs = call.timeoutMs ?? 120_000;

      const outcome = await new Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }>((resolve) => {
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let proc: ReturnType<typeof spawn>;
        try {
          proc = spawn(cfg.cliPath, args, { cwd: cfg.workDir, env, stdio: ['pipe', 'pipe', 'pipe'] });
        } catch (err) {
          resolve({ stdout: '', stderr: (err as Error).message, code: 1, timedOut: false });
          return;
        }
        const timer = setTimeout(() => {
          timedOut = true;
          proc.kill('SIGTERM');
          setTimeout(() => { if (!proc.killed) proc.kill('SIGKILL'); }, 3000);
        }, timeoutMs);

        proc.stdout?.on('data', (c: Buffer) => { stdout += c.toString(); });
        proc.stderr?.on('data', (c: Buffer) => { stderr += c.toString(); });
        proc.on('error', (err) => {
          clearTimeout(timer);
          resolve({ stdout, stderr: `${stderr}\n${err.message}`, code: 1, timedOut });
        });
        proc.on('close', (code) => {
          clearTimeout(timer);
          resolve({ stdout, stderr, code, timedOut });
        });
        // プロンプトは stdin から(引数長の制限を避ける)
        proc.stdin?.on('error', () => undefined);
        proc.stdin?.end(call.prompt);
      });

      const durationMs = Date.now() - started;
      if (outcome.timedOut) {
        log(`[claude-runner] ${call.label ?? ''} timeout after ${timeoutMs}ms`);
        return { ...base, durationMs, error: `Claude の応答がタイムアウトしました(${Math.round(timeoutMs / 1000)}秒)` };
      }

      // 出力は1行JSON(まれに前置きの警告が混ざるので最後のJSON行を探す)
      let envelope: CliJsonEnvelope | null = null;
      const lines = outcome.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        if (!lines[i].startsWith('{')) continue;
        try {
          envelope = JSON.parse(lines[i]) as CliJsonEnvelope;
          break;
        } catch { /* keep looking */ }
      }
      if (!envelope) {
        // JSONでない → 生テキストを最後の望みとして扱う
        const text = outcome.stdout.trim();
        if (outcome.code === 0 && text) {
          const data = call.schema ? extractJson<T>(text) : null;
          return { ...base, ok: !!data || !call.schema, data, text, durationMs };
        }
        return { ...base, durationMs, error: friendlyError(outcome.stderr, text, outcome.code) };
      }

      const text = envelope.result ?? '';
      const costUsd = envelope.total_cost_usd ?? 0;
      const inputTokens = (envelope.usage?.input_tokens ?? 0) + (envelope.usage?.cache_read_input_tokens ?? 0) + (envelope.usage?.cache_creation_input_tokens ?? 0);
      const outputTokens = envelope.usage?.output_tokens ?? 0;

      if (envelope.is_error || (envelope.subtype && envelope.subtype !== 'success')) {
        const msg = (envelope.errors ?? []).join('; ') || text;
        log(`[claude-runner] ${call.label ?? ''} error: ${msg.slice(0, 200)}`);
        return { ...base, text, costUsd, durationMs, inputTokens, outputTokens, error: friendlyError(outcome.stderr, msg, outcome.code) };
      }

      let data: T | null = null;
      if (call.schema) {
        data = (envelope.structured_output as T | undefined) ?? extractJson<T>(text);
        if (!data) {
          return { ...base, text, costUsd, durationMs, inputTokens, outputTokens, error: '構造化出力の解析に失敗しました' };
        }
      }
      log(`[claude-runner] ${call.label ?? ''} ok in ${durationMs}ms (in=${inputTokens}, out=${outputTokens})`);
      return { ok: true, data, text, costUsd, durationMs, inputTokens, outputTokens };
    } finally {
      sem.release();
    }
  }

  return { run, available };
}
