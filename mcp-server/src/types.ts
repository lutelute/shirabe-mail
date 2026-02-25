// MCP output types — Date は全て ISO 文字列

export interface AccountInfo {
  email: string;
  label: string;
  type: 'imap' | 'google';
  hasCalendar: boolean;
  hasTasks: boolean;
}

export interface MailSummary {
  id: number;
  subject: string;
  date: string; // ISO
  preview: string;
  from: string; // "DisplayName <address>" or just address
  to: string; // first To recipient (for quick role assessment)
  ccCount: number; // number of CC recipients
  folderName: string;
  accountEmail: string;
  isFlagged: boolean;
  isRead: boolean;
  conversationId: string | null;
  hasMyReply: boolean; // true if I have sent a reply in this thread (same account Sent folder)
  threadCount: number; // total messages in the conversation
}

export interface MailDetail {
  id: number;
  subject: string;
  date: string; // ISO
  preview: string;
  from: string;
  to: string[];
  cc: string[];
  folderName: string;
  isRead: boolean;
  isFlagged: boolean;
  importance: number;
  accountEmail: string;
}

export interface CalendarEventOutput {
  id: number;
  summary: string;
  description: string;
  location: string;
  start: string; // ISO
  end: string; // ISO
  isAllDay: boolean;
  organizerName: string;
  organizerAddress: string;
  accountEmail: string;
}

export interface TaskOutput {
  id: number;
  summary: string;
  description: string;
  start: string | null;
  end: string | null;
  completed: string | null;
  status: number;
  percentComplete: number;
  accountEmail: string;
}
