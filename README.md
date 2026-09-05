# 調 - Shirabe

> **調（しらべ）** — 調べる = to investigate, to look into
>
> メールの洪水から本質を調べ出す。
> eM Client のローカルデータベースを読み取り、AIがメールを分類・分析・要約する macOS デスクトップアプリ。
>
> 「調」にはもう一つの意味 — 音楽の「調べ」(melody)。日々のコミュニケーションに調和をもたらすツール。

## Architecture

```
shirabe-mail/
├── monitor/          # Electron デスクトップアプリ (React + Vite)
│   └── src/
│       ├── views/    # 各ビュー (ShirabeView, MailView, CalendarView, ...)
│       ├── components/
│       └── types/
├── mcp-server/       # MCP サーバー (Claude Code 連携)
│   └── src/
│       ├── tools/    # 17 ツール
│       └── db/       # eM Client DB アクセス層
└── README.md
```

## Features

### 🌙 夜間執事 v2（案件ベースの秘書モデル）
新着メールを裏で読み、朝ダッシュボードを開いたときには「判断だけが残っている」状態にする。

| 段階 | 内容 |
|------|------|
| 集める | 前回実行以降の未読（初回は N 日分）を受信箱相当のフォルダから取得 |
| ふるう | サーバーの `[SPAM]` マーク・ブランド詐称・CFP/広告パターンを AI の前に除外 |
| 束ねる | スレッド単位の「案件」にし、本文全文（引用・署名除去）、経緯、相手との付き合い（受信/返信/送信数）を添える |
| 判断する | Claude が「先生は何をすべきか」「期限」「優先度 P1〜P4」「根拠」を構造化して返す |
| 用意する | 返信が要る案件は、先生の実際の送信メールを文体見本にして下書きを作る（送信はしない） |
| 報告する | 朝の申し送り＋案件カード＋迷惑メールの一括承認グループ |

- **APIキー不要**: AI 判定は Claude Code CLI 経由（ログイン済みの資格情報を使う）。MCP/ツールを読み込まない軽量呼び出しで 1 案件あたり数秒
- **人物像・判断ルールを毎回参照**: `~/.claude/skills/shirabe/references/{decision-rules,contacts}.md` と `userData/butler-profile.md`（任意）を読み込む
- **学習する**: 案件カードの「この人は常に重要 / 不要」が `butler-rules.json` に残り、次回以降の判定に効く
- **安全ライン**: 可逆（タグ・下書き・隔離）は自動、不可逆（削除・送信）は必ず承認。削除はゴミ箱移動のみ
- 検証: `npm test`（純関数＋パイプライン）、`npm run butler:dryrun -- <account> <days> <maxCases> <maxDrafts>`（実DB読み取り＋実CLI、書き込みなし）

### 調 Dashboard
起動時に表示される統合ダッシュボード。4象限レイアウトで状況を一覧。

| パネル | 内容 |
|--------|------|
| 緊急 | 未読メール上位 + 期限超過タスク |
| 今週の予定 | カレンダーイベント (7日間) |
| 学位審査 | 博士・修士・学士の審査進捗 |
| ルーティン | 月次タスク完了率 |

### メール
- メール一覧・スレッド表示（eM Client DB 直接読み取り）
- AI返信ドラフト生成
- AI自動タグ付け（reply / action / hold / done / unnecessary / info / urgent）
- Claude Code CLI によるAI分析（light / deep モード）
- リアルタイム分析ログ（stream-json）
- 送信済みメール検索・年次パターン分析

### カレンダー・タスク
- カレンダーイベント表示
- タスク一覧（期限・進捗管理）
- 締切統合抽出（カレンダー + タスク + メール件名からの自動検出）

### AI 分析
- トリアージ（メール優先度分類）
- To-Do 抽出
- プロジェクト分析
- 監査（過去メール履歴分析）
- ゴミメール検出

### MCP サーバー（17 ツール）
Claude Code から直接メール・カレンダー・タスクを操作。

| ツール | 説明 |
|--------|------|
| `get_accounts` | アカウント一覧 |
| `get_unread_mails` | 未読メール取得 |
| `get_recent_mails` | 最近のメール取得 |
| `get_sent_mails` | 送信済みメール取得 |
| `get_mail_detail` | メール詳細 |
| `get_mail_thread` | スレッド取得 |
| `search_mails` | メール検索 |
| `list_mail_folders` | フォルダ一覧 |
| `get_folder_mails` | フォルダ内メール取得 |
| `get_calendar_events` | カレンダーイベント |
| `get_tasks` | タスク一覧 |
| `get_deadline_items` | 締切統合抽出 |
| `analyze_thread` | スレッド分析 |
| `scan_historical_emails` | 履歴スキャン |
| `load_project_context` | プロジェクトコンテキスト |
| `move_to_trash` | ゴミ箱移動 |
| `copy_mail_to_folder` | フォルダコピー |
| `tag_mail` | タグ付け |
| `get_mail_tags` | タグ取得 |

## Install

1. [Releases](https://github.com/lutelute/shirabe-mail/releases) から DMG をダウンロード
2. /Applications にドラッグ
3. eM Client がインストール済みであること

## Setup

### アカウント設定

`~/.config/shirabe/accounts.json` を作成:

```json
[
  {
    "email": "user@example.com",
    "accountUid": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "mailSubdir": "mail_data/local-account",
    "eventSubdir": "calendar_data/local-account",
    "taskSubdir": "task_data/local-account",
    "label": "メインアカウント",
    "type": "imap"
  }
]
```

`accountUid` と各 `subdir` は eM Client のデータディレクトリ(`~/Library/Application Support/eM Client/`)から確認。

### MCP サーバー設定

Claude Code の MCP 設定に追加:

```json
{
  "mcpServers": {
    "shirabe": {
      "command": "node",
      "args": ["/path/to/shirabe-mail/mcp-server/build/index.js"]
    }
  }
}
```

## Development

```bash
# Monitor (Electron app)
cd monitor
npm install
npm run dev

# MCP Server
cd mcp-server
npm install
npm run build
```

## Tech Stack

- **Frontend**: Electron + React + TypeScript + Vite + Tailwind CSS
- **DB Access**: better-sqlite3 (eM Client SQLite DB 直接読み取り)
- **AI**: Claude Code CLI (夜間執事の判定・下書き・申し送り、分析、ドラフト生成)
- **MCP**: @modelcontextprotocol/sdk (Claude Code 連携)
- **IPC**: Electron contextBridge (renderer ↔ main プロセス通信)
