// 作業指示書(handoff)の実データ検証: 直近ダイジェストの action 案件を1件選び、フォルダ推定と指示書を出す(書き込み無し)
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createClaudeRunner } from '../electron/services/claude-runner';
import { buildJudgmentContext, prepareHandoff, resolveReferencesDir } from '../electron/services/butler-brain';
import { getThreadContext } from '../electron/services/mail-intel';
import { getAccounts } from '../electron/services/db-reader';
import { loadRules } from '../electron/services/butler-rules';

const [digestPath = path.join(os.homedir(), 'Library/Application Support/shirabe/nightly-digest.json'), pick = 'action'] = process.argv.slice(2);
const digest = JSON.parse(fs.readFileSync(digestPath, 'utf-8')) as { cases: Array<Record<string, any>> };
const c = digest.cases.find((x) => x.status === 'open' && (pick === 'any' || x.category === pick) && x.conversationId);
if (!c) { console.error('no case'); process.exit(1); }
const cli = [path.join(os.homedir(), '.local/bin/claude'), '/usr/local/bin/claude'].find((p) => fs.existsSync(p)) ?? 'claude';
const runner = createClaudeRunner({ cliPath: cli, env: process.env as Record<string, string>, workDir: path.join(os.tmpdir(), 'shirabe-handoff-smoke'), concurrency: 1, log: (m) => console.error(m) });
const userData = path.join(os.homedir(), 'Library/Application Support/shirabe');
const ctx = buildJudgmentContext({ homeDir: os.homedir(), userDataDir: userData }, loadRules(path.join(userData, 'butler-rules.json')), getAccounts().map((a) => a.email));
const ref = resolveReferencesDir({ homeDir: os.homedir(), userDataDir: userData });
const folderMap = ref ? fs.readFileSync(path.join(ref, 'folder-map.md'), 'utf-8').slice(0, 7000) : '';
const thread = getThreadContext(c.accountEmail, c.conversationId, { maxMessages: 8, maxCharsPerMessage: 1500 });
console.log(`案件: [${c.category}] ${c.subject}\n  ask: ${c.ask}`);
prepareHandoff(runner, ctx, { subject: c.subject, fromName: c.fromName, fromAddress: c.fromAddress, ask: c.ask, summary: c.summary, deadline: c.deadline, category: c.category, thread: thread.messages, folderMap, recentFolders: [] }, 'sonnet')
  .then((r) => {
    if (!r.ok || !r.data) { console.error('failed:', r.error); process.exit(1); }
    console.log(`\nフォルダ: ${r.data.folder} (exists=${r.data.folder ? fs.existsSync(r.data.folder) : '-'})\n理由: ${r.data.folderReason}\n題: ${r.data.title}\n成果物: ${r.data.deliverable}\n\n${r.data.instructions}`);
  });
