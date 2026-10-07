# Claude Code から相棒を使う(MCP)

アプリ「調」と MCP サーバーは同じ状態(`~/Library/Application Support/shirabe/`)を共有する。
Claude Code 側の Claude が頭脳になり、調が手足(実送信・片付け・定期確認)になる。

## 典型の流れ

```
partner_today                      # 申し送り・決めてほしいこと・送るだけ・やること・送信予定・返事待ち
partner_case  { case_id }          # 必要なら詳細とスレッド本文
partner_style { account }          # 先生の文体・判断ルール・連絡先・見本・署名(下書きを書く前に必ず)
partner_decide { case_id, answer } # 問いに先生の答えを記録
partner_set_draft { case_id, body }# 先生の文体で下書き(本文のみ。署名・引用は送信時に調が付ける)
partner_send { case_id }           # 送信予定へ(設定の猶予分後に調が送る。取消は partner_cancel_send)
partner_case_status { case_id, status: done|later|dismissed }
partner_followups / partner_nudge { followup_id, body } / partner_followup_status
partner_sender_rule { address, tier: vip|noise|null }
partner_journal / partner_run
```

## 約束ごと

- **送信は必ず猶予付き**。`partner_send` は即送らない。調が起動していなければ送信時刻に起動したときに送る
- **SMTP 未設定のアカウントでは送れない**(調の 設定 → 相棒 → アカウントの接続)。その場合は下書きまで
- 先生が決めるべきこと(可否・金額・日程)は `partner_decide` の答えが無い限り勝手に決めない。下書きでは【 】で空欄にする
- 日誌(`partner_journal`)に全部残る。調の「今日」画面の「相棒の日誌」と同じ

## 設定

Claude Code の MCP 設定(調が `~/.mcp.json` と userData に自動生成):

```json
{ "mcpServers": { "shirabe": { "command": "/opt/homebrew/bin/node", "args": ["/Applications/調 - Shirabe.app/Contents/Resources/mcp-server/build/index.js"] } } }
```

開発中は `mcp-server/build/index.js` を指す。`SHIRABE_USER_DATA` で状態の場所を変えられる(テスト用)。

## 作業の受け渡し(どこで Claude を開いても)

調が作った作業指示書は `~/Library/Application Support/shirabe/handoff/index.json` の**共有キュー**に載る。先生がフォルダを移してから Claude を開いても拾える。

| 入口 | やること |
|------|---------|
| Claude Code(どのフォルダでも) | 起動時に `[調] 受け渡し待ちの作業が N 件…` と出る(SessionStart hook)。`shirabe-task take` で指示書を読む |
| ターミナル | `shirabe-task`(一覧) / `shirabe-task take [N]` / `shirabe-task claude [N]`(その場で Claude Code を起動して渡す) / `shirabe-task done [N]` |
| MCP(shirabe) | `partner_tasks` → `partner_take_task` → `partner_task_done` |
| コピペ | 調の「指示をコピー」で指示書ごとクリップボードへ。Claude でも ChatGPT でも貼るだけ |

受け取り(誰が・どこで・いつ)は調の案件カードに反映される。CLI `~/.local/bin/shirabe-task` は調の起動時に自動で置かれる。hook は `~/.claude/settings.json` の `SessionStart`(matcher `startup|clear|resume`)。

### 予定の登録
「カレンダーに登録」(ICS → eM Client)のほかに「ChatGPT で登録」: 予定の文面をコピーして ChatGPT を開く。先生が ChatGPT に予定登録を頼む流れに合わせたもの。
