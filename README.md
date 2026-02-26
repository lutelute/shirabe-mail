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
- **AI**: Claude Code CLI (分析・ドラフト生成)
- **MCP**: @modelcontextprotocol/sdk (Claude Code 連携)
- **IPC**: Electron contextBridge (renderer ↔ main プロセス通信)
