# 調 - Shirabe

> **調（しらべ）** — 調べる = to investigate, to look into
>
> メールの洪水から本質を調べ出す。
> eM Client のローカルデータベースを読み取り、AIがメールを分類・分析・要約する macOS デスクトップアプリ。
>
> 「調」にはもう一つの意味 — 音楽の「調べ」。日々のコミュニケーションに調和をもたらすツール。

## Features

- メール一覧・スレッド表示（eM Client DB 直接読み取り）
- Claude Code CLI によるAI分析（light / deep モード）
- リアルタイム分析ログ（stream-json）
- AI返信ドラフト生成
- AI自動タグ付け
- カレンダー・タスク統合
- MCP サーバー（Claude Code から直接メール操作）

## Install

1. [Releases](https://github.com/lutelute/shirabe-mail/releases) から DMG をダウンロード
2. /Applications にドラッグ
3. eM Client がインストール済みであること

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

- Electron + React + TypeScript + Vite + Tailwind CSS
- better-sqlite3 (eM Client DB 読み取り)
- Claude Code CLI (AI 分析)
- MCP Server (Claude Code 連携)
