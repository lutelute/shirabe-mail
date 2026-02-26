---
name: email-triage
description: >
  This skill should be used when the user asks to "triage emails",
  "classify emails", "sort emails by importance", "prioritize my inbox",
  "check what needs a reply", or "find emails that need action".
  It classifies emails as reply-only vs create-todo and scores personal relevance.
version: 0.1.0
---

# Email Triage Skill

Classify incoming emails into actionable categories for a university employee
managing 4 email accounts. The goal is to quickly separate emails that need
a simple reply from those requiring a tracked To-Do item.

## User Context

The user's email accounts are configured in `~/.config/emclient-monitor/accounts.json`.
Load this file at runtime to determine the user's email addresses and account types.

Email content is predominantly in **Japanese**, with occasional English.
Date references follow Japanese conventions (X月X日, 今週, 来週, 今月末).

## Classification Rules

### Category 1: Reply-Only (返信のみ)

Emails that only require a short textual response, no tracked task needed:

- Simple confirmations (了解です, 承知しました)
- Scheduling responses (日程の確認, 出欠の返事)
- Quick questions with known answers
- FYI acknowledgements
- Meeting attendance confirmations
- CC-only emails where no direct action is needed

### Category 2: Create To-Do (To-Do作成)

Emails requiring tracked action items with deadlines or multi-step follow-up:

- Submissions with deadlines (提出期限, 締切)
- Approval requests (承認依頼, 申請)
- Document preparation requests (書類作成, 資料準備)
- Travel arrangements (出張手配, 旅費精算)
- Committee/administrative tasks (委員会業務, 事務処理)
- Research-related tasks (研究報告, 科研費, 論文レビュー)
- Student advising requests (学生指導, 卒論指導)
- Multi-step coordination with external parties

## Relevance Scoring

Score each email on a 0-100 scale for personal relevance:

### High Relevance (80-100)

- Directly addressed to the user (TO field, not CC/BCC)
- Contains the user's name or role
- From direct supervisor, department head, or dean
- Contains explicit deadlines mentioning the user
- Student advising requests from assigned students
- Research grant or funding notifications
- Important university announcements requiring personal action

### Medium Relevance (40-79)

- CC'd on relevant departmental communications
- Meeting invitations for committees the user may attend
- General faculty announcements requiring awareness
- Collaborative document edits or shared drive notifications
- Emails from known colleagues in related departments
- Newsletter or mailing list content related to research area

### Low Relevance (0-39)

- Mass mailings to all-staff distribution lists
- Marketing emails or subscriptions
- Automated notifications (system alerts, CI/CD, etc.)
- Emails addressed to other people (forwarded for info only)
- Social media notifications
- Spam or promotional content
- Emails from unknown senders with no university affiliation

## Output Format

For each email, produce a classification result:

```json
{
  "mailId": 12345,
  "classification": "reply" | "todo",
  "relevanceScore": 85,
  "reasoning": "直接宛てのメールで提出期限が明記されている。委員会報告書の提出が必要。",
  "suggestedAction": "委員会報告書を作成して3月15日までに提出",
  "suggestedPriority": "high" | "medium" | "low",
  "estimatedEffort": "15min" | "30min" | "1hour" | "half-day" | "multi-day"
}
```

## Japanese Keyword Detection

### High Priority Indicators

- 至急, 緊急, ASAP, 本日中, 今すぐ, 直ちに
- 重要, 最優先, 必ず

### Medium Priority Indicators

- 締切, 提出, 返信, 依頼, 申請, 報告
- お願いします, ご対応ください, ご確認ください

### Low Priority Indicators

- 出張, 会議, 打ち合わせ, 連絡, 確認, お知らせ
- ご参考まで, FYI, 念のため

### Category Detection Patterns

| Pattern | Category |
|---------|----------|
| 締切, 期限, 〆切 | deadline |
| 会議, 打ち合わせ, ミーティング | meeting |
| 出張 | travel |
| 申請, 報告, 届出 | admin |
| 提出 | submission |
| 返信, 回答 | reply |
| 依頼, お願い | request |
| 連絡, 確認, お知らせ | info |

### Japanese Date Patterns

Detect deadlines from these patterns:
- `X月X日` (e.g., 3月15日)
- `X/X` (e.g., 3/15)
- `明日` (tomorrow)
- `今週` (this week, defaults to Friday)
- `来週` (next week, defaults to next Friday)
- `今月末` (end of this month)
- `年度末` (end of fiscal year, March 31)
- `来月` (next month)

## Processing Guidelines

1. **Batch Size**: Process emails in batches of up to 10 for efficiency
2. **Language**: Analyze both Japanese and English content in emails
3. **Thread Context**: If thread history is available, consider the full conversation
4. **Account Context**: Consider which account received the email
   - University accounts: Higher base relevance for institutional emails
   - Personal Gmail: Higher relevance for personal administrative tasks
5. **Sender Recognition**: Known university domains (.ac.jp) get higher trust
6. **Time Sensitivity**: Emails with near-term deadlines get priority boost
7. **Deduplication**: If the same thread appears in multiple accounts, classify once

## Error Handling

- If email content is empty or unreadable, classify as `reply` with relevanceScore 50
- If language detection fails, assume Japanese and proceed
- If deadline extraction fails, omit deadline but still classify
- Never expose API keys, credentials, or personal data in output
