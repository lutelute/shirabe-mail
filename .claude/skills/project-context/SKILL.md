---
name: project-context
description: >
  Reference skill for understanding project folder structure conventions,
  README-based work tracking, and historical schedule reconstruction.
  Automatically loaded as context when analyzing project folders.
  Do not invoke this skill directly.
disable-model-invocation: false
version: 0.1.0
---

# Project Context Skill

This is a **reference skill** that provides context about the user's project
folder organization, README conventions, and work tracking patterns. It is
automatically loaded into the agent's context and should NOT be invoked directly
by the user.

## Purpose

When the agent needs to:
- Read and interpret project folder contents
- Understand README-based work tracking patterns
- Reconstruct historical schedules from file metadata
- Map current To-Do items against past project workflows

This skill provides the conventions and patterns to follow.

## Folder Structure Conventions

The user organizes work in project folders with the following typical structure:

```
project-root/
  README.md              # Project overview, status, key dates
  docs/                  # Documentation and specifications
    requirements.md
    design.md
    meeting-notes/       # Chronological meeting notes
      2024-01-15.md
      2024-02-03.md
  src/                   # Source code (if applicable)
  data/                  # Data files, datasets
  reports/               # Generated reports, submissions
    progress-report-2024Q1.pdf
    final-report.pdf
  correspondence/        # Related email exports, letters
  budget/                # Budget documents, receipts
```

### Folder Naming Conventions

- Date-prefixed folders: `YYYY-MM-DD_description` or `YYYYMMDD_description`
- Fiscal year folders: `FY2024/`, `R6/` (令和6年)
- Semester folders: `2024-前期/`, `2024-後期/`
- Project code folders: `KAKENHI-24K00123/` (research grant number)

### README Structure

Project READMEs typically contain these sections:

```markdown
# Project Title (プロジェクト名)

## Overview (概要)
Brief description of the project.

## Status (進捗状況)
- [x] Phase 1: Requirements gathering (要件定義)
- [x] Phase 2: Design (設計)
- [ ] Phase 3: Implementation (実装)
- [ ] Phase 4: Review and submission (レビュー・提出)

## Key Dates (重要な日程)
- 2024-04-01: Project start (開始)
- 2024-09-30: Mid-term review (中間報告)
- 2025-03-31: Final submission (最終提出)

## Team / Related People (関係者)
- PI: Professor Name (主任研究者)
- Co-PI: Professor Name (分担研究者)
- Student: Name (担当学生)

## Notes (備考)
Additional context and references.
```

## Schedule Reconstruction Patterns

### From README Content

1. **Checklist items**: `- [x]` completed, `- [ ]` pending
2. **Date headers**: `## 2024年度 スケジュール` followed by date-task pairs
3. **Milestone markers**: Keywords like 開始, 中間, 最終, 完了, 提出
4. **Status keywords**: 完了, 進行中, 未着手, 保留, 延期

### From File Metadata

1. **Creation dates**: When files were first created indicates phase starts
2. **Modification dates**: Last modified dates indicate recent activity
3. **File naming**: Date-prefixed files provide explicit timeline data
4. **Report files**: `progress-report-YYYYQQ.pdf` indicates quarterly reporting
5. **Meeting notes**: Chronological files in `meeting-notes/` show meeting cadence

### From Folder Structure

1. **Phase folders**: Numbered or named phase folders indicate workflow stages
2. **Version folders**: `v1/`, `v2/`, `draft/`, `final/` show revision history
3. **Archive folders**: `archive/`, `old/` indicate completed work

## Academic Calendar Context

The user operates on a Japanese academic calendar:

| Period | Dates | Key Activities |
|--------|-------|----------------|
| 前期 (First semester) | April - September | Lectures, research, mid-year reports |
| 後期 (Second semester) | October - March | Lectures, year-end reports, thesis reviews |
| 年度末 (Fiscal year end) | March | Grant reports, budget closure, thesis deadlines |
| 入試期間 (Exam period) | January - March | Entrance exams, grading, admissions |
| 夏季休暇 (Summer break) | August - September | Research focus, conference season |
| 春季休暇 (Spring break) | March - April | Year transition, new student orientation |

### Japanese Fiscal Year

- Fiscal year runs April 1 to March 31
- `令和X年度` = Japanese fiscal year designation
- R6 = 令和6年 = 2024, R7 = 令和7年 = 2025, etc.
- Budget cycles align with fiscal year

## Project Types

### Research Grants (科研費 / KAKENHI)

- Multi-year projects (typically 2-4 years)
- Annual progress reports due in April/May
- Budget reports due by March 31
- Folder pattern: `KAKENHI-{grant_number}/`

### Committee Work (委員会業務)

- Regular meeting cadence (monthly/quarterly)
- Minutes and action items tracked per meeting
- Folder pattern: `{committee_name}/FY{year}/`

### Teaching (授業関連)

- Semester-based organization
- Syllabus, lecture materials, grading
- Folder pattern: `{course_name}/{year}-{semester}/`

### Student Advising (学生指導)

- Per-student or per-cohort folders
- Thesis progress, meeting notes
- Folder pattern: `students/{student_name}/` or `thesis/{year}/`

### Administrative (事務)

- University-wide processes and compliance
- Folder pattern: `admin/{category}/FY{year}/`

## Mapping To-Dos to Projects

When the user has extracted To-Do items from emails, map them to projects:

1. **Keyword matching**: Match To-Do categories to project folder names
2. **Sender matching**: Match email sender to project team members in README
3. **Date alignment**: Match To-Do deadlines to project milestone dates
4. **Grant number matching**: Look for KAKENHI numbers in both emails and folders
5. **Course/committee matching**: Match committee names or course codes

### Mapping Output

```json
{
  "todoId": "todo-123",
  "matchedProject": "/path/to/project",
  "confidence": 0.85,
  "matchReason": "締切日が科研費年次報告の提出期限と一致",
  "relatedHistory": [
    "昨年度は3月20日に提出済み",
    "報告書テンプレートは reports/template.docx"
  ]
}
```

## Processing Guidelines

1. **Read README first**: Always start by reading the README.md in the project root
2. **Scan file structure**: List all files and folders to understand organization
3. **Date extraction**: Extract dates from filenames, README content, and file metadata
4. **Sort chronologically**: Present schedule information in chronological order
5. **Identify gaps**: Note periods with no activity (may indicate pauses or breaks)
6. **Cross-reference**: When multiple projects exist, note dependencies or overlaps
7. **Privacy**: Do not expose file paths outside the project folder in output
8. **Read-only**: Never modify project files or READMEs

## Error Handling

- If README.md is missing, analyze folder contents and file metadata instead
- If folder is empty, report "空のフォルダです" and suggest creating a README
- If file metadata is unavailable, skip schedule reconstruction from metadata
- If folder path is invalid or inaccessible, report the error clearly
- Do not attempt to read binary files (PDF, images) for content analysis
