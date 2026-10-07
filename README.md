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
│       ├── tools/    # 21 ツール + partner/ 相棒 14 ツール
│       └── db/       # eM Client DB アクセス層
└── README.md
```

## Features

### 相棒 v3（メール処理を代わりにこなす）
開いたら「判断だけが残っている」状態にし、判断したら送るところまでやる。

| 段階 | 内容 |
|------|------|
| 集める | 前回確認以降の新着（初回は未読 N 日分）。30 分ごと・起動時・スリープ復帰時 |
| ふるう | サーバーの `[SPAM]`・ブランド詐称・CFP/広告を AI の前に除外 |
| 片付ける | 一斉配信を **既読 + アーカイブ**（IMAP。可逆、「戻す」あり） |
| 判断する | 案件ごとに 要件・期限・優先度・返信の種類・**先生に聞くべき問い**・自動送信して安全か |
| 用意する | 返信下書き（先生の文体）。問いがある案件は答えてから下書き |
| 任せる | 権限「任せる」なら常連・学内・面識ありへの定型返信（お礼・確認・了解・日程確定）を送信予定へ |
| 送る | **遅延送信（既定 5 分）+ 取消**。SMTP で返信ヘッダ付き、送信済みにも保存、元メールに返信済みの印 |
| 見張る | 先生が送って返事が無いスレッドを追跡。催促文を用意、返事が来たら自動で閉じる |
| 作業に移す | 案件から該当フォルダを推定して作業指示書を書き、ターミナル（Claude Code）/ FinderAI / Finder で開く。指示書は共有キューに載り、どこで Claude を開いても `shirabe-task take` で受け取れる（起動時に案内）。「指示をコピー」で貼り付けも可。下書きは eM Client の「下書き」にも入れられる |
| 予定を見張る | メールの会議・締切をカレンダーと照合し、未登録なら警告。ICS で eM Client の登録ダイアログを開くか、「ChatGPT で登録」で文面をコピーして ChatGPT に頼む |
| 報告する | 申し送り + 「今日」画面 + 日誌（何をしたかを全部残す） |

- **権限レベル**（設定 → 相棒）: 見るだけ / 下書き・整理まで（既定、送信は先生の 1 タップ） / 定型返信は任せる
- **接続は eM Client から自動検出**: IMAP/SMTP のホスト・ポート・ユーザー名・表示名・署名を `accounts.dat` と送信済みメールから推定。先生が入れるのはパスワードだけ（Gmail はアプリパスワード）。未設定でも「送る」は eM Client の作成画面にフォールバック
- **APIキー不要**: AI は Claude Code CLI 経由（ツール無し・MCP 無しの軽量呼び出し）
- **学習する**: 「常に重要 / 不要」が `butler-rules.json` に残り、人物像・判断ルールは設定の「相棒に教える」で編集
- **安全ライン**: 片付けは移動のみ、送信は猶予付き、削除（ゴミ箱）は承認制。全操作を `journal/` に記録
- 検証: `npm test`（34 件）、`npm run butler:dryrun -- <account> <days> <maxCases> <maxDrafts> [observe|assist|delegate]`（実DB読み取り＋実CLI、書き込みなし）
- 設計メモ: `docs/PARTNER_DESIGN.md`

### 🌙 夜間執事 v2（相棒の土台）
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

### MCP サーバー（35 ツール）
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
| `get_note` | メールノート取得 |
| `update_note` | メールノート更新 |

#### 相棒ツール（v3、アプリ「調」と同じ状態を共有）
Claude Code から「今日」を読み、決め、下書きを書き、送信予定に載せる。AI は呼び出し元の Claude が担い、実際の送信は調が行う（遅延 + 取消）。

| ツール | 説明 |
|--------|------|
| `partner_today` | 申し送り・決めてほしいこと・送るだけ・やること・送信予定・返事待ちの一覧 |
| `partner_case` | 案件の詳細（判定・根拠・下書き・問い）とスレッド本文 |
| `partner_style` | 先生の文体・人物像・判断ルール・連絡先・送信メール見本・署名 |
| `partner_decide` | 問いに先生の答えを記録 |
| `partner_set_draft` | 返信下書きを保存 |
| `partner_send` | 返信を送信予定へ（猶予付き・取消可） |
| `partner_cancel_send` | 送信予定を取り消す |
| `partner_case_status` | 済み / 後で / しない / 戻す |
| `partner_followups` | 返事待ちの一覧 |
| `partner_nudge` | 催促を送信予定へ |
| `partner_followup_status` | 返事待ちを閉じる / まだ待つ / 戻す |
| `partner_sender_rule` | 送信者を常に重要 / 不要として覚える |
| `partner_journal` | 相棒の日誌 |
| `partner_run` | 調に今すぐ確認を頼む |

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
- **Mail I/O**: imapflow（既読・アーカイブ・送信済み保存）+ nodemailer（SMTP 送信）
- **AI**: Claude Code CLI (相棒の判定・下書き・催促文・申し送り、分析)
- **MCP**: @modelcontextprotocol/sdk (Claude Code 連携)
- **IPC**: Electron contextBridge (renderer ↔ main プロセス通信)
