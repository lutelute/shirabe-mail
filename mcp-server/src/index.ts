#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { getAccounts } from './tools/get-accounts.js';
import { getUnreadMails } from './tools/get-unread-mails.js';
import { getRecentMails } from './tools/get-recent-mails.js';
import { getMailDetail } from './tools/get-mail-detail.js';
import { getCalendarEvents } from './tools/get-calendar-events.js';
import { getTasks } from './tools/get-tasks.js';
import { searchMails } from './tools/search-mails.js';
import { getMailThread } from './tools/get-mail-thread.js';
import { listMailFolders } from './tools/list-mail-folders.js';
import { getFolderMails } from './tools/get-folder-mails.js';
import { analyzeThread } from './tools/analyze-thread.js';
import { loadProjectContext } from './tools/load-project-context.js';
import { scanHistoricalEmails } from './tools/scan-historical-emails.js';
import { moveToTrash } from './tools/move-to-trash.js';
import { copyMailToFolder } from './tools/copy-mail-to-folder.js';
import { getSentMails } from './tools/get-sent-mails.js';
import { getDeadlineItems } from './tools/get-deadline-items.js';
import { ensureNotesDir, findNotePath } from './utils.js';

const server = new McpServer({
  name: 'shirabe',
  version: '1.0.0',
});

// --- get_accounts ---
server.tool(
  'get_accounts',
  'List all configured eM Client email accounts',
  {},
  async () => {
    const accounts = getAccounts();
    return {
      content: [{ type: 'text', text: JSON.stringify(accounts, null, 2) }],
    };
  },
);

// --- get_unread_mails ---
server.tool(
  'get_unread_mails',
  'Get unread emails across all accounts or a specific account',
  {
    account: z.string().optional().describe('Email address to filter by. Omit for all accounts.'),
    limit: z.number().int().min(1).max(500).default(50).describe('Maximum number of mails to return'),
    days_back: z.number().int().min(1).max(365).default(30).describe('How many days back to search'),
  },
  async (params) => {
    const result = getUnreadMails({
      account: params.account,
      limit: params.limit,
      days_back: params.days_back,
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  },
);

// --- get_recent_mails ---
server.tool(
  'get_recent_mails',
  'Get recent emails (both read and unread) across all accounts or a specific account',
  {
    days_back: z.number().int().min(1).max(365).default(3).describe('How many days back to search'),
    account: z.string().optional().describe('Email address to filter by. Omit for all accounts.'),
    limit: z.number().int().min(1).max(500).default(100).describe('Maximum number of mails to return'),
    include_read: z.boolean().default(true).describe('Include read emails'),
  },
  async (params) => {
    const result = getRecentMails({
      days_back: params.days_back,
      account: params.account,
      limit: params.limit,
      include_read: params.include_read,
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  },
);

// --- get_mail_detail ---
server.tool(
  'get_mail_detail',
  'Get detailed information about a specific email',
  {
    mail_id: z.number().int().describe('The mail ID'),
    account: z.string().describe('The account email address this mail belongs to'),
  },
  async (params) => {
    const result = getMailDetail({
      mail_id: params.mail_id,
      account: params.account,
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  },
);

// --- get_calendar_events ---
server.tool(
  'get_calendar_events',
  'Get calendar events from eM Client accounts',
  {
    days_forward: z.number().int().min(0).max(365).default(7).describe('How many days forward to look'),
    days_back: z.number().int().min(0).max(365).default(0).describe('How many days back to look'),
    account: z.string().optional().describe('Email address to filter by. Omit for all accounts. IMAP accounts without calendar are auto-skipped.'),
  },
  async (params) => {
    const result = getCalendarEvents({
      days_forward: params.days_forward,
      days_back: params.days_back,
      account: params.account,
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  },
);

// --- get_tasks ---
server.tool(
  'get_tasks',
  'Get tasks from eM Client accounts',
  {
    account: z.string().optional().describe('Email address to filter by. Omit for all accounts. IMAP accounts without tasks are auto-skipped.'),
    include_completed: z.boolean().default(false).describe('Include completed tasks'),
  },
  async (params) => {
    const result = getTasks({
      account: params.account,
      include_completed: params.include_completed,
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  },
);

// --- search_mails ---
server.tool(
  'search_mails',
  'Search emails by keyword in subject and preview text',
  {
    keyword: z.string().min(1).describe('Search keyword (matches subject and preview)'),
    account: z.string().optional().describe('Email address to filter by. Omit for all accounts.'),
    days_back: z.number().int().min(1).max(365).default(30).describe('How many days back to search'),
    limit: z.number().int().min(1).max(200).default(30).describe('Maximum number of results'),
  },
  async (params) => {
    const result = searchMails({
      keyword: params.keyword,
      account: params.account,
      days_back: params.days_back,
      limit: params.limit,
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  },
);

// --- get_mail_thread ---
server.tool(
  'get_mail_thread',
  'Get the full conversation thread for a mail, including sent replies. Use this to understand thread context before triaging.',
  {
    mail_id: z.number().int().describe('The mail ID to get the thread for'),
    account: z.string().describe('The account email address this mail belongs to'),
  },
  async (params) => {
    const result = getMailThread({
      mail_id: params.mail_id,
      account: params.account,
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  },
);

// --- list_mail_folders ---
server.tool(
  'list_mail_folders',
  'List all mail folders for an account with mail counts. Use this to discover folder structure and find past work folders.',
  {
    account: z.string().optional().describe('Email address to filter by. Omit for all accounts.'),
  },
  async (params) => {
    const result = listMailFolders({ account: params.account });
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  },
);

// --- get_folder_mails ---
server.tool(
  'get_folder_mails',
  'Get mails from a specific folder with flexible date filtering. Use year parameter for annual recurring tasks (e.g. year:2024 to check last year\'s work). Supports subfolder inclusion for browsing entire folder trees.',
  {
    folder_id: z.number().int().describe('Folder ID (from list_mail_folders)'),
    account: z.string().describe('The account email address'),
    year: z.number().int().optional().describe('Filter by calendar year (e.g. 2024). Overrides date_from/date_to.'),
    date_from: z.string().optional().describe('Start date in ISO format (e.g. "2023-04-01"). Ignored if year is set.'),
    date_to: z.string().optional().describe('End date in ISO format (e.g. "2024-03-31"). Ignored if year is set.'),
    limit: z.number().int().min(1).max(500).default(50).describe('Maximum number of mails to return'),
    include_subfolders: z.boolean().default(true).describe('Include mails from subfolders'),
  },
  async (params) => {
    const result = getFolderMails({
      folder_id: params.folder_id,
      account: params.account,
      year: params.year,
      date_from: params.date_from,
      date_to: params.date_to,
      limit: params.limit,
      include_subfolders: params.include_subfolders,
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  },
);

// --- analyze_thread ---
server.tool(
  'analyze_thread',
  'Analyze an email thread for action items, urgency, and participant roles. Returns structured analysis including personal tasks, thread state (awaiting_reply/needs_action/informational/resolved), and urgency level.',
  {
    mail_id: z.number().int().describe('The mail ID to analyze the thread for'),
    account: z.string().describe('The account email address this mail belongs to'),
  },
  async (params) => {
    const result = analyzeThread({
      mail_id: params.mail_id,
      account: params.account,
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  },
);

// --- load_project_context ---
server.tool(
  'load_project_context',
  'Load project context from a folder path. Reads README files, lists subfolders and files, and extracts schedule hints from README content or file metadata.',
  {
    folder_path: z.string().min(1).describe('Absolute path to the project folder to load context from'),
  },
  async (params) => {
    const result = loadProjectContext({
      folder_path: params.folder_path,
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  },
);

// --- scan_historical_emails ---
server.tool(
  'scan_historical_emails',
  'Scan historical emails over a date range with optional topic filtering. Returns monthly activity breakdown, key threads, and paginated mail results. Use for auditing 2-3 years of email history.',
  {
    account: z.string().describe('The account email address to scan'),
    date_from: z.string().describe('Start date in ISO format (e.g. "2023-01-01")'),
    date_to: z.string().describe('End date in ISO format (e.g. "2025-12-31")'),
    topic: z.string().optional().describe('Optional keyword to filter by subject and preview text'),
    limit: z.number().int().min(1).max(500).default(100).describe('Maximum number of mails to return per page'),
    offset: z.number().int().min(0).default(0).describe('Offset for pagination (skip this many results)'),
  },
  async (params) => {
    const result = scanHistoricalEmails({
      account: params.account,
      date_from: params.date_from,
      date_to: params.date_to,
      topic: params.topic,
      limit: params.limit,
      offset: params.offset,
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  },
);

// --- move_to_trash ---
server.tool(
  'move_to_trash',
  'Move emails to the trash folder. Writes directly to eM Client DB. Restart eM Client after use to see changes.',
  {
    mail_ids: z.array(z.number().int()).min(1).max(200).describe('Array of mail IDs to move to trash'),
    account: z.string().describe('The account email address these mails belong to'),
  },
  async (params) => {
    const result = moveToTrash({
      mail_ids: params.mail_ids,
      account: params.account,
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  },
);

// --- copy_mail_to_folder ---
server.tool(
  'copy_mail_to_folder',
  'Copy emails to a specific folder. Duplicates are automatically skipped (dedup by subject+date). Writes directly to eM Client DB. Restart eM Client after use to see changes.',
  {
    mail_ids: z.array(z.number().int()).min(1).max(200).describe('Array of mail IDs to copy'),
    account: z.string().describe('The account email address these mails belong to'),
    target_folder_id: z.number().int().describe('Target folder ID (from list_mail_folders)'),
  },
  async (params) => {
    const result = copyMailToFolder({
      mail_ids: params.mail_ids,
      account: params.account,
      target_folder_id: params.target_folder_id,
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  },
);

// --- get_sent_mails ---
server.tool(
  'get_sent_mails',
  'Get sent emails from Sent folders. Useful for annual pattern analysis and checking what you have sent.',
  {
    days_back: z.number().int().min(1).max(365).default(30).describe('How many days back to search'),
    account: z.string().optional().describe('Email address to filter by. Omit for all accounts.'),
    limit: z.number().int().min(1).max(500).default(50).describe('Maximum number of mails to return'),
    keyword: z.string().optional().describe('Optional keyword to filter by subject and preview'),
  },
  async (params) => {
    const result = getSentMails({
      days_back: params.days_back,
      account: params.account,
      limit: params.limit,
      keyword: params.keyword,
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  },
);

// --- get_deadline_items ---
server.tool(
  'get_deadline_items',
  'Extract deadline items from calendar events, tasks with due dates, and email subjects containing deadline keywords (締切, 〆切, 期限, deadline, due, until, まで). Returns a unified date-sorted list with source labels (calendar/task/mail) and urgency classification (overdue/today/this_week/upcoming).',
  {
    days_forward: z.number().int().min(1).max(90).default(14).describe('How many days forward to look for deadlines'),
    account: z.string().optional().describe('Email address to filter by. Omit for all accounts.'),
    include_mail_deadlines: z.boolean().default(true).describe('Include deadline-keyword matches from email subjects (past 7 days)'),
  },
  async (params) => {
    const result = getDeadlineItems({
      days_forward: params.days_forward,
      account: params.account,
      include_mail_deadlines: params.include_mail_deadlines,
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  },
);

// --- tag_mail ---
server.tool(
  'tag_mail',
  'Add or remove tags on a mail note. Tags: reply, action, hold, done, unnecessary, info, urgent',
  {
    mail_id: z.number().int().describe('The mail ID'),
    account: z.string().describe('The account email address'),
    add_tags: z.array(z.string()).optional().describe('Tag IDs to add'),
    remove_tags: z.array(z.string()).optional().describe('Tag IDs to remove'),
  },
  async (params) => {
    const fs = await import('fs');
    const notesDir = ensureNotesDir();
    const found = findNotePath(params.mail_id);
    const now = new Date().toISOString();

    let note: Record<string, unknown>;
    if (found.exists) {
      note = JSON.parse(fs.readFileSync(found.path, 'utf-8'));
    } else {
      note = {
        id: found.id,
        mailId: params.mail_id,
        accountEmail: params.account,
        subject: '',
        content: '',
        todos: [],
        tags: [],
        history: [{ timestamp: now, type: 'created', content: 'MCPタグ操作' }],
        createdAt: now,
        updatedAt: now,
      };
    }

    let tags = (note.tags as string[]) ?? [];
    if (params.add_tags) {
      tags = [...new Set([...tags, ...params.add_tags])];
    }
    if (params.remove_tags) {
      tags = tags.filter(t => !params.remove_tags!.includes(t));
    }
    note.tags = tags;
    note.updatedAt = now;

    fs.writeFileSync(found.path, JSON.stringify(note, null, 2), 'utf-8');

    return {
      content: [{ type: 'text', text: JSON.stringify({ mail_id: params.mail_id, tags }, null, 2) }],
    };
  },
);

// --- get_mail_tags ---
server.tool(
  'get_mail_tags',
  'Get tags for a mail',
  {
    mail_id: z.number().int().describe('The mail ID'),
    account: z.string().describe('The account email address'),
  },
  async (params) => {
    const fs = await import('fs');
    const found = findNotePath(params.mail_id);

    if (!found.exists) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ mail_id: params.mail_id, tags: [] }) }],
      };
    }

    const note = JSON.parse(fs.readFileSync(found.path, 'utf-8'));
    const tags = note.tags ?? (note.quickLabel ? [note.quickLabel] : []);

    return {
      content: [{ type: 'text', text: JSON.stringify({ mail_id: params.mail_id, tags }, null, 2) }],
    };
  },
);

// --- get_note ---
server.tool(
  'get_note',
  'Read the existing note for a mail. Returns note content, todos, tags, and history. Returns null if no note exists.',
  {
    mail_id: z.number().int().describe('The mail ID'),
    account: z.string().describe('The account email address'),
  },
  async (params) => {
    const fs = await import('fs');
    const found = findNotePath(params.mail_id);

    if (!found.exists) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ mail_id: params.mail_id, note: null }) }],
      };
    }

    const note = JSON.parse(fs.readFileSync(found.path, 'utf-8'));
    return {
      content: [{ type: 'text', text: JSON.stringify({ mail_id: params.mail_id, note }, null, 2) }],
    };
  },
);

// --- update_note ---
server.tool(
  'update_note',
  'Create or update a mail note with investigation findings. Merges with existing content. Use after analyzing a thread to persist results.',
  {
    mail_id: z.number().int().describe('The mail ID'),
    account: z.string().describe('The account email address'),
    subject: z.string().optional().describe('Mail subject (used when creating new note)'),
    content: z.string().describe('Markdown content for the note (analysis results, summary, etc.)'),
    todos: z.array(z.string()).optional().describe('Array of todo text items to add'),
    tags: z.array(z.string()).optional().describe('Tag IDs to set: reply, action, hold, done, unnecessary, info, urgent'),
    replace_content: z.boolean().default(false).describe('If true, replace entire content. If false, append new content with timestamp separator.'),
  },
  async (params) => {
    const fs = await import('fs');
    ensureNotesDir();
    const found = findNotePath(params.mail_id);
    const now = new Date().toISOString();
    const dateLabel = new Date().toLocaleDateString('ja-JP', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

    let note: Record<string, unknown>;
    if (found.exists) {
      note = JSON.parse(fs.readFileSync(found.path, 'utf-8'));
    } else {
      note = {
        id: found.id,
        mailId: params.mail_id,
        accountEmail: params.account,
        subject: params.subject ?? '',
        content: '',
        todos: [],
        tags: [],
        history: [],
        createdAt: now,
        updatedAt: now,
      };
    }

    // Update subject if provided and empty
    if (params.subject && !(note.subject as string)) {
      note.subject = params.subject;
    }

    // Update content
    const existingContent = (note.content as string) ?? '';
    if (params.replace_content || !existingContent.trim()) {
      note.content = params.content;
    } else {
      // Append with separator
      note.content = `${existingContent}\n\n---\n_更新: ${dateLabel}_\n\n${params.content}`;
    }

    // Merge todos
    if (params.todos && params.todos.length > 0) {
      const existingTodos = (note.todos as Array<{ id: string; text: string; completed: boolean; createdAt: string }>) ?? [];
      const existingTexts = new Set(existingTodos.map(t => t.text));
      for (const text of params.todos) {
        if (!existingTexts.has(text)) {
          existingTodos.push({
            id: `todo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            text,
            completed: false,
            createdAt: now,
          });
        }
      }
      note.todos = existingTodos;
    }

    // Merge tags
    if (params.tags && params.tags.length > 0) {
      const existingTags = (note.tags as string[]) ?? [];
      note.tags = [...new Set([...existingTags, ...params.tags])];
    }

    // Add history entry
    const history = (note.history as Array<Record<string, string>>) ?? [];
    history.push({
      timestamp: now,
      type: found.exists ? 'updated' : 'created',
      content: `MCP調査結果を${found.exists ? '更新' : '作成'}`,
    });
    note.history = history;
    note.updatedAt = now;

    fs.writeFileSync(found.path, JSON.stringify(note, null, 2), 'utf-8');

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          mail_id: params.mail_id,
          note_id: note.id,
          status: found.exists ? 'updated' : 'created',
          content_length: (note.content as string).length,
          todo_count: (note.todos as unknown[]).length,
          tags: note.tags,
        }, null, 2),
      }],
    };
  },
);

// --- Start ---
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Shirabe MCP Server running on stdio');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
