---
name: historical-audit
description: >
  This skill should be used when the user asks to "audit email history",
  "scan old emails", "review past email activity", "analyze email patterns",
  "find historical email data", or "review 2-3 years of email".
  It performs batch analysis of long-term email history with cost awareness.
version: 0.1.0
---

# Historical Email Audit Skill

Perform batch analysis of 2-3 years of email history to surface activity
patterns, past project involvement, communication history, and reconstruct
a timeline of the user's work. This is a resource-intensive operation
that requires careful chunking and cost management.

## User Context

The user's email accounts are configured in `~/.config/emclient-monitor/accounts.json`.
Load this file at runtime to determine the user's email addresses and account types.

Historical data may span 2-3+ years, potentially hundreds of thousands of emails.

## Chunking Strategy

### Time-Based Chunking

**CRITICAL**: Never load the entire date range at once. Always chunk by time period.

#### Monthly Chunks (Default)

Process one month at a time, across all accounts:

```
2024-01 → 2024-02 → 2024-03 → ... → 2026-02
```

For each month:
1. Query email count per account
2. Retrieve emails with LIMIT/OFFSET pagination (max 100 per page)
3. Analyze and summarize the month
4. Store monthly summary
5. Move to next month

#### Quarterly Chunks (For Quick Overview)

For faster initial scanning, chunk by quarter:

```
2024-Q1 (Jan-Mar) → 2024-Q2 (Apr-Jun) → 2024-Q3 (Jul-Sep) → 2024-Q4 (Oct-Dec)
```

#### Academic Year Chunks (For University Context)

Align with Japanese fiscal/academic year:

```
FY2023 (2023-04 to 2024-03) → FY2024 (2024-04 to 2025-03) → FY2025 (2025-04 to 2026-03)
```

### Pagination Within Chunks

Each time chunk uses database pagination:

- `LIMIT 100 OFFSET 0` for first page
- `LIMIT 100 OFFSET 100` for second page
- Continue until all emails in the chunk are processed
- Use `stmt.iterate()` pattern for memory-efficient row-by-row processing

## Progressive Review Workflow

### Phase 1: Volume Scan (量的分析)

Quick pass to count emails per month/account without reading content:

```json
{
  "monthlyActivity": {
    "2024-01": { "total": 342, "byAccount": { "user@example.ac.jp": 150, "user@g.example.ac.jp": 120, "user@gmail.com": 52, "user2@gmail.com": 20 } },
    "2024-02": { "total": 298, "byAccount": { "...": "..." } }
  }
}
```

This phase is cheap (database queries only, no AI inference).

### Phase 2: Topic Discovery (話題の発見)

For each month, identify key conversation threads by:

1. Group emails by conversationId / normalized subject
2. Rank threads by message count (most active = most important)
3. Extract unique senders/recipients
4. Identify recurring contacts

Output per month:

```json
{
  "month": "2024-01",
  "topThreads": [
    {
      "subject": "科研費申請について",
      "messageCount": 15,
      "participants": ["tanaka@example.ac.jp", "suzuki@example.ac.jp"],
      "dateRange": "2024-01-05 to 2024-01-28",
      "category": "research"
    }
  ],
  "topContacts": [
    { "address": "tanaka@example.ac.jp", "messageCount": 23, "direction": "both" }
  ],
  "categorySummary": {
    "research": 45,
    "admin": 30,
    "teaching": 25,
    "personal": 10
  }
}
```

### Phase 3: Deep Analysis (詳細分析)

User selects specific months, threads, or topics for deep analysis.
This phase uses AI inference and is the most expensive:

1. Read full thread content for selected conversations
2. Extract action items and outcomes
3. Identify patterns and relationships across threads
4. Reconstruct project timelines from email activity

### Phase 4: Confirmation Review (確認レビュー)

"Push-to-confirm" workflow:

1. Present findings to the user one section at a time
2. User confirms, edits, or dismisses each finding
3. Confirmed findings are saved to the audit report
4. Dismissed findings are excluded from the final report

## Cost Awareness

### Budget Management

**CRITICAL**: Historical email audit can be expensive. Always track and limit costs.

- Use `maxBudgetUsd` option in Agent SDK query() calls
- Default budget: $1.00 USD per operation
- For full 2-3 year scans, estimate costs before starting
- Display running cost to the user during scanning

### Cost Estimation

Before starting a scan, estimate the cost:

```
Estimated cost = (total_months × emails_per_month × tokens_per_email × price_per_token)
```

Approximate guidelines:
- Phase 1 (volume scan): ~$0.00 (database queries only)
- Phase 2 (topic discovery): ~$0.01-0.05 per month
- Phase 3 (deep analysis): ~$0.10-0.50 per thread
- Full 2-year scan with deep analysis: ~$2.00-10.00

### Cost Controls

1. **Pre-scan estimate**: Show estimated cost before starting
2. **Running total**: Track cumulative cost during scan
3. **Budget warning**: Alert when approaching 80% of maxBudgetUsd
4. **Budget halt**: Stop scanning when budget is reached
5. **Phase gating**: Require explicit user approval before Phase 3 (expensive)

### Cost Tracking Format

```json
{
  "scanId": "audit-2024-001",
  "estimatedCostUsd": 3.50,
  "currentCostUsd": 1.25,
  "maxBudgetUsd": 5.00,
  "budgetRemaining": 3.75,
  "phaseCosts": {
    "volumeScan": 0.00,
    "topicDiscovery": 0.25,
    "deepAnalysis": 1.00
  }
}
```

## Analysis Categories

### University Work Patterns

Identify patterns in university-related activities:

- **Committee cycles**: Regular meeting cadences, reporting periods
- **Grant timelines**: Application, review, reporting deadlines
- **Teaching cycles**: Semester prep, exam periods, grading periods
- **Administrative peaks**: Year-end, fiscal year transitions

### Communication Patterns

- **Top contacts**: Most frequent correspondents per account
- **Response times**: Average time to respond to different senders
- **Peak hours**: When most emails are sent/received
- **Account usage**: Which accounts are used for which purposes

### Project Reconstruction

- **Active projects per period**: What was the user working on each month
- **Project lifecycle**: Start, active period, completion/abandonment
- **Cross-project dependencies**: Overlapping timelines and shared contacts

## Output Format

### Monthly Summary

```json
{
  "month": "2024-01",
  "totalEmails": 342,
  "sentByMe": 89,
  "receivedByMe": 253,
  "topThreads": [...],
  "topContacts": [...],
  "keyFindings": [
    "科研費申請書の準備期間。田中先生との共同研究について15通のやり取り。",
    "委員会報告書の締切（1月31日）に向けた準備。"
  ],
  "confirmedByUser": null
}
```

### Final Audit Report

```json
{
  "dateRange": { "from": "2024-01-01", "to": "2026-02-28" },
  "totalMonthsScanned": 26,
  "totalEmailsProcessed": 8500,
  "totalCostUsd": 2.35,
  "executiveSummary": "2年間で約8,500通のメールを分析...",
  "monthlyActivity": [...],
  "keyProjects": [...],
  "communicationPatterns": {...},
  "recommendations": [
    "年度末（3月）にメール量が急増する傾向。事前準備を推奨。",
    "科研費関連は10-12月に集中。次年度の計画に反映を。"
  ]
}
```

## Processing Guidelines

1. **Start with Phase 1**: Always begin with the volume scan (free/cheap)
2. **User approval for Phase 3**: Never start deep analysis without user consent
3. **Interruptible**: Design for pause/resume capability at any point
4. **Memory-efficient**: Use pagination and streaming, never load all data at once
5. **Cross-account**: Scan all 4 accounts for each time period
6. **Deduplication**: Detect same thread across multiple accounts (via conversationId/subject)
7. **Progress reporting**: Report progress as "X月を分析中... (Y/Z ヶ月完了)"
8. **Cancellation**: Support clean cancellation that preserves already-scanned results
9. **Incremental save**: Save results per chunk so partial scans are still useful
10. **Privacy**: Do not include full email body content in the audit report (summaries only)

## Error Handling

- If a month has no emails, record it as empty and continue
- If database query fails for one account, continue with other accounts
- If budget is exceeded mid-scan, stop gracefully and return partial results
- If scan is cancelled, return all results collected up to that point
- If email content is corrupted or unreadable, skip and log the skip count
- Log all errors with context but do not expose internal paths or credentials
