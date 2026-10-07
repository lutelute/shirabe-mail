// === 作業の共有キュー: どの Claude(ターミナル / FinderAI / MCP)からでも受け取れるようにする ===
//
// 調が作った作業指示書は userData/handoff/index.json に「受け渡し待ち」として載る。
// 先生がどこで Claude を開いても、
//   - Claude Code の SessionStart hook が `shirabe-task hook` を呼び、待ちがあれば案内を出す
//   - `shirabe-task take` で指示書を受け取る(受け取った場所・時刻が index に残り、調の画面に反映される)
//   - `shirabe-task claude` はその場で Claude Code を起動して指示書を渡す
// CLI 本体は Python(標準ライブラリのみ)。アプリ起動時に ~/.local/bin/shirabe-task へ置く。

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface HandoffTask {
  id: string;
  caseId: string;
  title: string;
  docPath: string;
  folder: string | null;
  deliverable: string;
  createdAt: string;
  status: 'pending' | 'taken' | 'done';
  takenAt?: string;
  takenBy?: string;
  doneAt?: string;
}

export interface HandoffIndex { version: 1; tasks: HandoffTask[] }

export function indexPath(userDataDir: string): string {
  return path.join(userDataDir, 'handoff', 'index.json');
}

export function loadIndex(userDataDir: string): HandoffIndex {
  try {
    const raw = JSON.parse(fs.readFileSync(indexPath(userDataDir), 'utf-8')) as Partial<HandoffIndex>;
    return { version: 1, tasks: Array.isArray(raw.tasks) ? raw.tasks : [] };
  } catch {
    return { version: 1, tasks: [] };
  }
}

export function saveIndex(userDataDir: string, idx: HandoffIndex): void {
  const p = indexPath(userDataDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(idx, null, 2), 'utf-8');
  fs.renameSync(tmp, p);
}

export function upsertTask(idx: HandoffIndex, t: Omit<HandoffTask, 'status' | 'createdAt'> & Partial<Pick<HandoffTask, 'status' | 'createdAt'>>): HandoffIndex {
  const prev = idx.tasks.find((x) => x.id === t.id);
  const next: HandoffTask = {
    ...(prev ?? { status: 'pending' as const, createdAt: new Date().toISOString() }),
    ...t,
    status: t.status ?? (prev?.status === 'done' ? 'pending' : prev?.status ?? 'pending'),
    createdAt: prev?.createdAt ?? t.createdAt ?? new Date().toISOString(),
  };
  // 作り直したら受け取り情報はリセット
  if (prev && prev.docPath === t.docPath && !t.status) { /* keep taken info */ } else if (prev && !t.status) { delete next.takenAt; delete next.takenBy; next.status = 'pending'; }
  return { version: 1, tasks: [...idx.tasks.filter((x) => x.id !== t.id), next].slice(-200) };
}

export function markTask(idx: HandoffIndex, id: string, status: 'taken' | 'done', by?: string): HandoffIndex {
  const now = new Date().toISOString();
  return {
    version: 1,
    tasks: idx.tasks.map((x) => (x.id === id ? { ...x, status, ...(status === 'taken' ? { takenAt: now, takenBy: by ?? x.takenBy } : { doneAt: now }) } : x)),
  };
}

export const TASK_CLI_VERSION = '1';

/** ~/.local/bin/shirabe-task に置く CLI(Python、標準ライブラリのみ) */
export function taskCliSource(userDataDir: string): string {
  return `#!/usr/bin/env python3
# shirabe-task v${TASK_CLI_VERSION} — 調(しらべ)が用意した作業指示を、どこで開いた Claude からでも受け取る
# 使い方:
#   shirabe-task              受け渡し待ちの一覧
#   shirabe-task show [N]     N 番目(省略時は最新)の指示書を表示
#   shirabe-task take [N]     指示書を表示し「受け取り済み」にする(調の画面に反映)
#   shirabe-task claude [N]   この場で Claude Code を起動し、指示書を渡す
#   shirabe-task done [N]     作業が終わった印を付ける
#   shirabe-task hook         Claude Code の SessionStart hook 用(待ちがあれば案内を出す。無ければ何も出さない)
import json, os, sys, subprocess, tempfile
from datetime import datetime, timezone

INDEX = ${JSON.stringify(indexPath(userDataDir))}

def load():
    try:
        with open(INDEX, encoding='utf-8') as f:
            d = json.load(f)
        return d if isinstance(d.get('tasks'), list) else {'version': 1, 'tasks': []}
    except Exception:
        return {'version': 1, 'tasks': []}

def save(d):
    os.makedirs(os.path.dirname(INDEX), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(INDEX), suffix='.tmp')
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        json.dump(d, f, ensure_ascii=False, indent=2)
    os.replace(tmp, INDEX)

def pending(d):
    return [t for t in d['tasks'] if t.get('status') in ('pending', 'taken')]

def age(iso):
    try:
        t = datetime.fromisoformat(iso.replace('Z', '+00:00'))
        m = int((datetime.now(timezone.utc) - t).total_seconds() // 60)
        return f"{m}分前" if m < 60 else (f"{m // 60}時間前" if m < 1440 else f"{m // 1440}日前")
    except Exception:
        return ''

def pick(d, arg):
    ps = sorted(pending(d), key=lambda t: t.get('createdAt', ''), reverse=True)
    if not ps:
        return None
    if not arg or arg == 'latest':
        return ps[0]
    try:
        n = int(arg)
        return ps[n - 1] if 1 <= n <= len(ps) else None
    except ValueError:
        return next((t for t in ps if t['id'] == arg or t.get('caseId') == arg), None)

def read_doc(t):
    try:
        with open(t['docPath'], encoding='utf-8') as f:
            return f.read()
    except Exception as e:
        return f"(指示書が読めません: {e})"

def list_tasks(d):
    ps = sorted(pending(d), key=lambda t: t.get('createdAt', ''), reverse=True)
    if not ps:
        print('調からの受け渡し待ちはありません。'); return
    for i, t in enumerate(ps, 1):
        mark = '受け取り済み' if t.get('status') == 'taken' else '待ち'
        print(f"{i}. [{mark}] {t.get('title','')}  —  {t.get('folder') or '(フォルダ未定)'}  ({age(t.get('createdAt',''))})")
    print("\\n受け取る: shirabe-task take [番号]   /   この場で Claude を起動: shirabe-task claude [番号]")

def prompt_for(t):
    return ("調からの作業指示です。まず作業指示書 " + t['docPath'] + " を読み、"
            + ("このフォルダ" if not t.get('folder') else "作業フォルダ(" + t['folder'] + "。今いる場所が違えばこの場所で)")
            + "で作業を進めてください。終わったら成果物の場所と、相手への返信文案を短く報告してください。")

def main():
    args = sys.argv[1:]
    cmd = args[0] if args else 'list'
    d = load()
    if cmd == 'list':
        list_tasks(d); return
    if cmd == 'hook':
        ps = [t for t in pending(d) if t.get('status') == 'pending']
        if not ps:
            return
        ps.sort(key=lambda t: t.get('createdAt', ''), reverse=True)
        print(f"[調] 受け渡し待ちの作業が {len(ps)} 件あります(調のアプリが用意した指示書)。")
        for i, t in enumerate(ps[:3], 1):
            print(f"[調]  {i}. {t.get('title','')} — {t.get('folder') or 'フォルダ未定'} ({age(t.get('createdAt',''))}) 指示書: {t['docPath']}")
        print("[調] 受け取るなら「shirabe-task take [番号]」を実行して指示書を読む(受け取った場所が調に記録される)。先生が今いるフォルダで作業してよい。無関係な作業中ならこの案内は無視してよい。")
        return
    t = pick(d, args[1] if len(args) > 1 else None)
    if not t:
        print('該当する作業がありません。shirabe-task で一覧を確認してください。', file=sys.stderr); sys.exit(1)
    if cmd == 'show':
        print(read_doc(t)); return
    if cmd in ('take', 'claude'):
        now = datetime.now(timezone.utc).isoformat()
        for x in d['tasks']:
            if x['id'] == t['id']:
                x['status'] = 'taken'; x['takenAt'] = now; x['takenBy'] = 'cli:' + os.getcwd()
        save(d)
        if cmd == 'take':
            print(read_doc(t))
            print("\\n--- 受け取りました(" + os.getcwd() + ")。終わったら: shirabe-task done " + t['id'])
            return
        env = dict(os.environ); env.pop('CLAUDECODE', None); env.pop('CLAUDE_CODE', None)
        os.execvpe('claude', ['claude', prompt_for(t)], env)
    if cmd == 'done':
        now = datetime.now(timezone.utc).isoformat()
        for x in d['tasks']:
            if x['id'] == t['id']:
                x['status'] = 'done'; x['doneAt'] = now
        save(d); print('完了にしました: ' + t.get('title', '')); return
    print('使い方: shirabe-task [list|show|take|claude|done|hook] [番号]', file=sys.stderr); sys.exit(2)

if __name__ == '__main__':
    main()
`;
}

/** ~/.local/bin/shirabe-task を用意する(中身が変わったときだけ書き換える)。返り値は置いたパス(失敗時 null) */
export function ensureTaskCli(userDataDir: string, log: (m: string) => void): string | null {
  const binDir = path.join(os.homedir(), '.local', 'bin');
  const target = path.join(binDir, 'shirabe-task');
  const src = taskCliSource(userDataDir);
  try {
    fs.mkdirSync(binDir, { recursive: true });
    let current = '';
    try { current = fs.readFileSync(target, 'utf-8'); } catch { /* none */ }
    if (current !== src) {
      fs.writeFileSync(target, src, { encoding: 'utf-8', mode: 0o755 });
      fs.chmodSync(target, 0o755);
      log(`[partner] installed ${target}`);
    }
    return target;
  } catch (err) {
    log(`[partner] task cli install failed: ${(err as Error).message}`);
    return null;
  }
}
