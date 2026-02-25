---
name: todo-extract
description: >
  This skill should be used when the user asks to "extract tasks from emails",
  "find my action items", "what do I need to do from this thread",
  "create todos from email", "parse tasks from conversation",
  or "find deadlines in my emails". It extracts ONLY personal action items
  from threaded email conversations.
version: 0.1.0
---

# To-Do Extraction Skill

Extract actionable tasks from threaded email conversations. The critical
distinction is identifying what **the user personally needs to do** versus
what other people in the thread are responsible for.

## User Context

The user's email accounts are configured in `~/.config/emclient-monitor/accounts.json`.
Load this file at runtime to determine the user's email addresses.

When analyzing threads, messages sent FROM any of the user's configured addresses are
from the user. Messages sent TO any of these addresses are directed at the user.

## Core Principle: Personal Tasks Only

**CRITICAL**: Extract ONLY tasks that the user needs to perform.

### DO Extract (Assigned to User)

- "○○先生、報告書をご提出ください" (when ○○ = user)
- "添付の書類にご記入の上、返送をお願いします" (when sent TO user)
- "次回の会議までに資料を準備してください" (when user is addressed)
- Tasks the user explicitly volunteered for in the thread
- Follow-up items the user mentioned they would do ("私の方で確認します")
- Deadlines the user is responsible for meeting

### DO NOT Extract (Other People's Tasks)

- "田中さんに確認をお願いします" (someone else's task)
- "事務局で手続きを進めます" (administrative staff's task)
- Tasks delegated to other named individuals
- Replies the user is waiting FOR (not actions the user needs to take)
- General announcements with no personal action required

## Task Extraction Process

### Step 1: Thread Analysis

1. Read all messages in chronological order
2. Identify which messages are from the user (check sender against known addresses)
3. Identify which messages are addressed to the user
4. Track the conversation flow to understand context

### Step 2: Action Item Identification

For each message directed at the user, look for:

- **Explicit requests**: お願いします, ください, してほしい, 必要です
- **Deadlines mentioned**: 期限, 締切, までに, 〆切
- **Approval requests**: 承認, 確認, 許可, 決裁
- **Submission requests**: 提出, 送付, 回答, 返信
- **Preparation tasks**: 準備, 作成, 手配, 予約
- **Review requests**: レビュー, 査読, チェック, 確認

Also check for self-assigned tasks in the user's own messages:

- "私が対応します" (I will handle it)
- "確認しておきます" (I will check)
- "後ほど送ります" (I will send later)
- "検討します" (I will consider)

### Step 3: Priority Assessment

| Priority | Criteria |
|----------|----------|
| **high** | Contains 至急/緊急/ASAP, deadline within 2 days, from supervisor/dean |
| **medium** | Has specific deadline within 2 weeks, from colleague/student, routine task |
| **low** | No explicit deadline, informational follow-up, nice-to-have action |

### Step 4: Deadline Detection

Extract deadlines from Japanese text patterns:

- Absolute dates: `X月X日`, `X/X`, `YYYY年X月X日`, `YYYY/MM/DD`
- Relative dates: `明日`, `今週中`, `来週`, `今月末`, `年度末`
- Contextual: `次回の会議まで`, `来月の○○まで`
- Academic calendar: `前期開始まで`, `後期末`, `入試前`

When multiple dates appear, use the earliest as the primary deadline.

### Step 5: Category Assignment

| Category | Patterns |
|----------|----------|
| deadline | 締切, 期限, 〆切, 提出日 |
| meeting | 会議, 打ち合わせ, ミーティング, 委員会 |
| travel | 出張, 旅費, 交通費, 宿泊 |
| admin | 申請, 報告, 届出, 事務手続き |
| submission | 提出, 送付, 納品 |
| reply | 返信, 回答, 返事 |
| request | 依頼, お願い, 要望 |
| research | 研究, 論文, 科研費, 学会 |
| teaching | 授業, 講義, シラバス, 成績 |
| advising | 学生, 指導, 卒論, 修論 |
| info | 連絡, 確認, お知らせ, 共有 |
| general | (default if no pattern matches) |

## Output Format

For each extracted task, produce:

```json
{
  "id": "todo-{mailId}-{index}",
  "action": "委員会報告書を作成して提出する",
  "priority": "high",
  "deadline": "2026-03-15T00:00:00.000Z",
  "sourceThreadId": "conv-123456",
  "sourceMailId": 12345,
  "assignedToMe": true,
  "category": "submission",
  "isCompleted": false,
  "accountEmail": "user@example.ac.jp",
  "context": "学部長から委員会報告書の提出依頼。3月15日締切。"
}
```

## Japanese Text Handling

### Encoding

- All text is UTF-8
- Handle full-width characters (全角): numbers, letters, punctuation
- Normalize full-width to half-width where appropriate for date parsing

### Honorific Awareness

- Recognize that 先生, 様, さん, くん after names indicate person references
- When the user's name appears with these suffixes, the task is for the user
- When other names appear with these suffixes, the task is for someone else

### Keigo (Formal Speech) Patterns

Action requests in Japanese business email often use keigo:

- ～していただけますか (Could you please...)
- ～をお願いいたします (I request that you...)
- ～くださいますよう (Please kindly...)
- ～いただきたく存じます (I would like you to...)
- ～ご検討ください (Please consider...)
- ～ご対応のほど (Regarding your response...)

All of these indicate a task request directed at the recipient.

### Thread Position Context

- Earlier messages provide context, later messages may override
- "Cancel" or "取り消し" in later messages invalidates earlier tasks
- "完了しました" or "done" in user's messages marks tasks as completed
- "変更" (change) in later messages may modify earlier task details

## Processing Guidelines

1. **One thread at a time**: Analyze the complete thread before extracting tasks
2. **Deduplication**: If the same task is mentioned multiple times, extract once
3. **Consolidation**: Merge related sub-tasks into a single actionable item
4. **Specificity**: Make action descriptions specific and actionable
   - Bad: "返信する" (reply)
   - Good: "委員会報告書の進捗について田中先生に返信する" (reply to Prof. Tanaka about committee report progress)
5. **Cross-account**: The same thread may span multiple accounts; check all known addresses
6. **Recency**: Weight recent messages more heavily for task status
7. **Batch limit**: Process at most 10 emails per batch to stay within token limits

## Error Handling

- If thread messages are empty, return empty task list
- If sender/recipient cannot be determined, skip that message
- If deadline parsing fails, set deadline to null (do not guess)
- If priority cannot be determined, default to "low"
- Never include email body content verbatim in task descriptions (summarize instead)
- Never expose personal email addresses in task output beyond what is needed
