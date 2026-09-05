// === Account Configuration ===
export interface AccountConfig {
  email: string;
  accountUid: string;
  mailSubdir: string;
  eventSubdir: string | null;
  taskSubdir: string | null;
  label: string;
  type: 'imap' | 'google';
}

// === Mail ===
export interface MailItem {
  id: number;
  subject: string;
  date: Date;
  receivedDate: Date | null;
  preview: string;
  importance: number;
  flags: number;
  folder: number;
  folderName?: string;
  from: MailAddress | null;
  to: MailAddress[];
  cc?: MailAddress[];
  isRead: boolean;
  isFlagged: boolean;
  accountEmail: string;
  conversationId?: string;
  threadCount?: number;
}

export interface MailAddress {
  displayName: string;
  address: string;
  type: AddressType;
}

// eM Client の MailAddresses.type の実値(DB実測: 1=From, 2=Sender, 3=Reply-To, 4=To, 5=Cc, 6=Bcc)
export enum AddressType {
  From = 1,
  Sender = 2,
  ReplyTo = 3,
  To = 4,
  Cc = 5,
  Bcc = 6,
}

// === Calendar Event ===
export interface CalendarEvent {
  id: number;
  summary: string;
  description: string;
  location: string;
  start: Date;
  end: Date;
  status: number;
  type: number;
  organizerName: string;
  organizerAddress: string;
  accountEmail: string;
  isAllDay: boolean;
}

// === Task ===
export interface TaskItem {
  id: number;
  summary: string;
  description: string;
  start: Date | null;
  end: Date | null;
  completed: Date | null;
  status: number;
  percentComplete: number;
  accountEmail: string;
}

// === Folder ===
export interface FolderItem {
  id: number;
  name: string;
  path: string;
  parentFolderId: number | null;
}

// === Action Item (extracted from emails) ===
export interface ActionItem {
  id: string;
  mailId: number;
  subject: string;
  action: string;
  deadline: Date | null;
  priority: 'high' | 'medium' | 'low';
  category: string;
  source: 'keyword' | 'ai' | 'agent';
  accountEmail: string;
  isCompleted: boolean;
}

// === Proposal (Claude Code analysis) ===
export interface Proposal {
  id: string;
  timestamp: Date;
  markdown: string;
  status: 'running' | 'done' | 'error';
  errorMessage?: string;
}

// === runClaudeAnalysis options ===
export interface AnalysisOptions {
  mode?: 'light' | 'deep';  // default: 'deep'（後方互換性）
}

// === Analysis Log Entry (stream-json progress) ===
export interface AnalysisLogEntry {
  time: string;
  type: 'info' | 'tool' | 'text' | 'error' | 'result';
  message: string;
}

// === Investigation (mail deep-dive via Claude Code) ===
export interface InvestigationRequest {
  id: string;              // `inv-${Date.now()}`
  mailId: number;
  accountEmail: string;
  subject: string;
  conversationId?: string;
  userMessage?: string;    // ユーザーの追加メッセージ（任意）
  status: 'pending' | 'running' | 'done' | 'error';
  resultProposalId?: string; // 結果のProposal ID
  createdAt: string;
}

// === Mail Notes ===
export interface NoteTodo {
  id: string;
  text: string;
  completed: boolean;
  createdAt: string;
}

export interface NoteHistoryEntry {
  timestamp: string;
  type: 'created' | 'updated' | 'ai_proposal';
  content: string;
}

export type QuickLabel = 'unnecessary' | 'reply' | 'action' | 'hold' | 'done';

// === Mail Tags (extends QuickLabel into a general-purpose tag system) ===
export interface MailTag {
  id: string;          // 'reply' | 'action' | 'hold' | 'done' | 'unnecessary' | 'info' | 'urgent' | custom
  label: string;       // 表示名
  color: string;       // Tailwind色名 (例: 'amber', 'red', 'emerald')
}

export const BUILTIN_TAGS: MailTag[] = [
  { id: 'reply',       label: '要返信',   color: 'amber' },
  { id: 'action',      label: '要対応',   color: 'orange' },
  { id: 'hold',        label: '保留',     color: 'violet' },
  { id: 'done',        label: '対応済',   color: 'emerald' },
  { id: 'unnecessary', label: '不要',     color: 'red' },
  { id: 'info',        label: '情報',     color: 'sky' },
  { id: 'urgent',      label: '至急',     color: 'rose' },
];

// QuickLabel → tag ID mapping (backward compat)
export const QUICKLABEL_TO_TAG: Record<QuickLabel, string> = {
  reply: 'reply',
  action: 'action',
  hold: 'hold',
  done: 'done',
  unnecessary: 'unnecessary',
};

export type SenderColorMode = 'text' | 'background' | 'none';

export interface MailNote {
  id: string;           // conversationId or `mail-${mailId}`
  mailId: number;
  accountEmail: string;
  subject: string;
  content: string;      // markdown body
  todos: NoteTodo[];
  history: NoteHistoryEntry[];
  quickLabel?: QuickLabel;
  tags?: string[];          // 複数タグID配列 (BUILTIN_TAGS.id | custom)
  threadMessageCount?: number;  // スレッドメッセージ数（自動更新トリガー用）
  createdAt: string;
  updatedAt: string;
}

// === Skill ===
export interface SkillSummary {
  name: string;
  description: string;
}

// === Junk Mail Column Config ===
export type JunkColumnId = 'from' | 'subject' | 'date' | 'attachment' | 'confidence' | 'verdict';

export interface JunkColumnDef {
  id: JunkColumnId;
  label: string;
  width: string;  // CSS flex or fixed width e.g. "1 1 0" or "80px"
}

export const JUNK_COLUMN_OPTIONS: JunkColumnDef[] = [
  { id: 'from',       label: '差出人',   width: '140px' },
  { id: 'subject',    label: '件名',     width: '1 1 0' },
  { id: 'date',       label: '受信日',   width: '70px' },
  { id: 'attachment',  label: '添付',     width: '28px' },
  { id: 'confidence', label: '確度',     width: '36px' },
  { id: 'verdict',    label: '判定',     width: '24px' },
];

export const DEFAULT_JUNK_COLUMNS: JunkColumnId[] = ['from', 'subject', 'date', 'confidence', 'verdict'];

// === Mail Column Config ===
export type MailColumnId = 'checkbox' | 'unread' | 'from' | 'subject' | 'importance' | 'attachment' | 'date' | 'junkVerdict';

export interface MailColumnDef {
  id: MailColumnId;
  label: string;
  width: string;
  sortable: boolean;
}

export const MAIL_COLUMN_OPTIONS: MailColumnDef[] = [
  { id: 'checkbox',    label: '',       width: '28px',  sortable: false },
  { id: 'unread',      label: '',       width: '20px',  sortable: false },
  { id: 'from',        label: '差出人', width: '140px', sortable: true },
  { id: 'subject',     label: '件名',   width: '1 1 0', sortable: true },
  { id: 'importance',  label: '!',      width: '20px',  sortable: true },
  { id: 'attachment',  label: '添付',   width: '28px',  sortable: false },
  { id: 'date',        label: '受信日', width: '80px',  sortable: true },
  { id: 'junkVerdict', label: '判定',   width: '28px',  sortable: true },
];

export const DEFAULT_MAIL_COLUMNS: MailColumnId[] = ['unread', 'from', 'subject', 'importance', 'date'];

export type SortDirection = 'asc' | 'desc';

export interface SortState {
  column: MailColumnId;
  direction: SortDirection;
}

// === Junk Classification ===
export interface JunkClassification {
  mailId: number;
  isJunk: boolean;
  confidence: number;       // 0.0〜1.0
  reasoning: string;
  detectedPatterns: string[];
}

// === IMAP Credentials ===
export interface ImapCredentials {
  host: string;
  port: number;
  user: string;
  password: string;
  secure: boolean;
}

export interface AccountImapConfig {
  accountEmail: string;
  credentials: ImapCredentials | null;
  trashFolderPath: string;
}

export interface MoveToTrashResult {
  mailId: number;
  success: boolean;
  error?: string;
}

// === Shirabe Digest ===
export interface ShirabeUrgentItem {
  label: string;
  source: 'mail' | 'calendar' | 'task' | 'deadline';
  sourceId?: number;
  accountEmail?: string;
  subject?: string;
  fromAddress?: string;
}

export interface ShirabeWeekEvent {
  date: string;
  summary: string;
  location?: string;
  isAllDay: boolean;
  isToday: boolean;
  preparation?: string;
}

export interface ShirabeThesisStatus {
  student: string;
  category: 'D' | 'M' | 'B';
  phase: string;
  nextMilestone: string;
  daysLeft: number | null;
}

export interface ShirabeRoutineProgress {
  month: number;
  completed: number;
  total: number;
  pending: string[];
}

export interface ShirabeDigest {
  date: string;
  urgent: ShirabeUrgentItem[];
  weekEvents: ShirabeWeekEvent[];
  thesis: ShirabeThesisStatus[];
  routine: ShirabeRoutineProgress;
  lastUpdated: string;
}

// === View Navigation ===
export type ViewType =
  | 'shirabe'
  | 'mail'
  | 'calendar'
  | 'task'
  | 'search'
  | 'triage'
  | 'todo'
  | 'project'
  | 'audit'
  | 'proposal'
  | 'chat'
  | 'junk'
  | 'settings';

// === Search ===
export interface SearchParams {
  keyword: string;
  accountEmail?: string;
  daysBack: number;
}

export interface FolderMailParams {
  folderId: number;
  accountEmail: string;
  daysBack?: number;
}

// === Triage ===
export type TriageClassification = 'reply' | 'todo';

export interface TriageResult {
  mailId: number;
  classification: TriageClassification;
  relevanceScore: number;
  reasoning: string;
}

// === Thread Message ===
export interface ThreadMessage {
  id: number;
  subject: string;
  date: Date;
  preview: string;
  from: string;
  to: string[];
  cc: string[];
  folderName: string;
  isSentByMe: boolean;
  sourceAccount: string;
}

// === To-Do Item (extracted from threads) ===
export interface TodoItem {
  id: string;
  action: string;
  priority: 'high' | 'medium' | 'low';
  deadline: Date | null;
  sourceThreadId: number;
  sourceMailId: number;
  assignedToMe: boolean;
  category: string;
  isCompleted: boolean;
  accountEmail: string;
  createdAt: Date;
  updatedAt: Date;
  source: 'thread' | 'manual';
}

// === Project Context ===
export interface ScheduleEntry {
  date: Date;
  description: string;
  status: string;
}

export interface ProjectContext {
  folderPath: string;
  readmeContent: string;
  subfolders: string[];
  schedule: ScheduleEntry[];
}

// === Historical Audit ===
export interface AuditParams {
  accountEmail: string;
  startDate: Date;
  endDate: Date;
  topic?: string;
  apiKey: string;
}

export interface AuditResult {
  dateRange: { start: Date; end: Date };
  monthlyActivity: { month: string; count: number; summary: string }[];
  keyThreads: { threadId: number; subject: string; messageCount: number; dateRange: string }[];
  findings: string[];
}

export interface AuditScanProgress {
  currentMonth: number;
  totalMonths: number;
  percentComplete: number;
  estimatedCostUsd: number;
}

// === Agent Stream State ===
export interface AgentStreamState {
  status: 'idle' | 'running' | 'done' | 'error';
  progress: number;
  result: unknown;
  costUsd: number;
  error: string | null;
}

// === Settings ===
export type ThemeType = 'dark' | 'paper';

export interface AppSettings {
  aiEnabled: boolean;
  apiKey: string;
  refreshIntervalMinutes: number;
  excludeSpam: boolean;
  selectedAccounts: string[];
  mailDaysBack: number;
  eventDaysForward: number;
  agentEnabled: boolean;
  maxBudgetUsd: number;
  projectFolderPath: string;
  // メール表示設定
  mailShowPreview: boolean;
  mailUnreadOnly: boolean;
  mailColumnRatio: [number, number, number];
  // テーマ
  theme: ThemeType;
  // Google Calendar
  googleCalendarUrl: string;
  // メールカラム設定
  mailColumns: MailColumnId[];
  // ゴミメール検出
  junkDetectionEnabled: boolean;
  junkColumns: JunkColumnId[];
  junkWhitelistDomains: string[];
  // IMAP設定
  imapConfigs: AccountImapConfig[];
  // セットアップ
  setupCompleted: boolean;
  // 差出人色モード
  senderColorMode: SenderColorMode;
  // カスタムタグ
  customTags: MailTag[];
  // AI自動タグ付け
  autoTagEnabled: boolean;
  // 夜間執事(自動パイプライン)
  butlerEnabled: boolean;
  butlerSchedule: ButlerSchedule;
  butlerQuarantineFolder: string;        // スパム自動隔離先フォルダ名
  butlerAutoQuarantineThreshold: number; // この信頼度(0-1)以上のスパムを自動隔離
  butlerMaxBudgetUsdPerRun: number;      // 1バッチの課金上限(USD)
  butlerAccounts: string[];              // 夜間執事の対象アカウント(空=選択中の全アカウント)
  butlerMaxPerAccount: number;           // 1アカウント・1回あたりの処理上限(件)。IMAP負荷対策
  // 夜間執事 v2(案件ベース)
  butlerModel: ButlerModel;              // 分類に使うモデル(Claude Code CLI経由・APIキー不要)
  butlerDraftModel: ButlerModel;         // 返信下書きに使うモデル
  butlerInitialDays: number;             // 初回実行で遡る日数(2回目以降は前回実行以降)
  butlerMaxCasesPerRun: number;          // 1回でAI判定する案件数の上限
  butlerMaxDraftsPerRun: number;         // 1回で用意する返信下書きの上限
}

export const DEFAULT_SETTINGS: AppSettings = {
  aiEnabled: false,
  apiKey: '',
  refreshIntervalMinutes: 5,
  excludeSpam: true,
  selectedAccounts: [],
  mailDaysBack: 7,
  eventDaysForward: 7,
  agentEnabled: false,
  maxBudgetUsd: 1.0,
  projectFolderPath: '',
  mailShowPreview: true,
  mailUnreadOnly: true,
  mailColumnRatio: [30, 35, 35],
  theme: 'paper',
  googleCalendarUrl: '',
  mailColumns: ['unread', 'from', 'subject', 'importance', 'date'],
  junkDetectionEnabled: true,
  junkColumns: ['from', 'subject', 'date', 'confidence', 'verdict'],
  junkWhitelistDomains: [],
  imapConfigs: [],
  setupCompleted: false,
  senderColorMode: 'text',
  customTags: [],
  autoTagEnabled: false,
  butlerEnabled: false,
  butlerSchedule: 'startup',
  butlerQuarantineFolder: '隔離',
  butlerAutoQuarantineThreshold: 0.95,
  butlerMaxBudgetUsdPerRun: 0.5,
  butlerAccounts: [],
  butlerMaxPerAccount: 100,
  butlerModel: 'sonnet',
  butlerDraftModel: 'sonnet',
  butlerInitialDays: 14,
  butlerMaxCasesPerRun: 50,
  butlerMaxDraftsPerRun: 5,
};

// === Night Butler (自動パイプライン) ===

export type ButlerSchedule = 'manual' | 'startup' | 'hourly' | 'daily';
export type ButlerModel = 'haiku' | 'sonnet' | 'opus';

// パイプラインが1通に対して下した処理の種類
// reversible(可逆)なものは自動実行済、await_* は不可逆ゆえ承認待ち
export type ButlerActionKind =
  | 'tagged'         // タグ付けした(可逆・自動実行済)
  | 'quarantined'    // スパムを隔離フォルダへ移動(可逆・自動実行済)
  | 'draft_prepared' // 返信下書きを用意(可逆・自動実行済、未送信)
  | 'await_delete'   // 削除候補(不可逆・承認待ち)
  | 'await_send'     // 送信候補(不可逆・承認待ち、下書きは用意済)
  | 'skipped';       // 対象外

// 1通に対する執事の処理結果
export interface ButlerEntry {
  mailId: number;
  accountEmail: string;
  subject: string;
  from: string;
  kind: ButlerActionKind;
  reversible: boolean;   // true=自動実行済 / false=承認待ち
  detail: string;        // 何をしたか/提案理由(根拠を一言)
  tags?: string[];       // 付与したタグ
  draft?: string;        // 用意した返信下書き(await_send/draft_prepared時)
  confidence?: number;   // AI判定の信頼度(0-1)
  createdAt: string;     // ISO8601
}

// 1バッチ(一晩)の作業報告
export interface NightlyDigest {
  runAt: string;                   // ISO8601 実行時刻
  processedCount: number;          // 処理した新着数
  autoDone: ButlerEntry[];         // 自動実行済(可逆) — 報告のみ
  awaitingApproval: ButlerEntry[]; // 承認待ち(不可逆) — OK/NG
  errors: string[];
  costUsd: number;
  running?: boolean;               // パイプライン実行中フラグ
  // --- v2: 案件ベース(秘書モデル) ---
  version?: number;                // 2 = 案件ベース
  cases?: ButlerCase[];            // 案件(スレッド単位)。前回の未完了案件も引き継ぐ
  groups?: ButlerGroup[];          // 一括承認グループ(スパム削除など)
  brief?: string;                  // 秘書の朝の一言(AI生成)
  stats?: ButlerStats;
}

// === Night Butler v2: 案件(case)ベースの秘書モデル ===

// 送信者の階層。DBの返信履歴・学習ルール・連絡先から決定論的に判定する
export type SenderTier = 'vip' | 'internal' | 'known' | 'auto' | 'unknown' | 'noise';
export type ButlerCaseCategory = 'reply' | 'action' | 'fyi' | 'noise' | 'spam' | 'unknown';
export type ButlerPriority = 'P1' | 'P2' | 'P3' | 'P4';
export type ButlerCaseStatus = 'open' | 'done' | 'later' | 'dismissed';

export interface SenderStats {
  received: number;    // 期間内に受信した数
  replied: number;     // 先生が返信した数(eM ClientのreplyDate)
  sentTo: number;      // 先生から送った数(送信済みのTo/Cc)
  lastReplyAt?: string;
}

// 1案件 = 1スレッド(会話)。秘書が「先生は何をすべきか」を判断した単位
export interface ButlerCase {
  id: string;                 // `${accountEmail}::conv-${conversationId}` または `::mail-${mailId}`
  accountEmail: string;
  conversationId?: string;
  mailId: number;             // 最新の受信メール
  mailIds: number[];          // 今回処理した新着メール
  subject: string;
  from: string;               // 表示用 "名前 <addr>"
  fromAddress: string;
  fromName: string;
  receivedAt: string;         // ISO8601
  addressedToMe: 'to' | 'cc' | 'list' | 'unknown';
  senderTier: SenderTier;
  senderStats?: SenderStats;
  threadCount: number;
  myRepliesInThread: number;
  lastFromMe: boolean;
  // --- 判定結果 ---
  category: ButlerCaseCategory;
  priority: ButlerPriority;
  ask: string;                // 先生がすべきこと(1文)
  summary: string;            // 要約(1-2行)
  deadline: string | null;    // YYYY-MM-DD
  suggestedAction: string;    // 返信する / 日程回答 / 提出 / 支払い / 読むだけ など
  reason: string;             // 根拠を一言
  needsDraft: boolean;
  draftHint?: string;
  draft?: string;
  draftStatus?: 'prepared' | 'skipped' | 'failed';
  tags: string[];
  noteId?: string;
  status: ButlerCaseStatus;
  statusChangedAt?: string;
  aiSource: 'ai' | 'rule' | 'fallback';
  createdAt: string;
  runAt: string;
}

export interface ButlerGroupItem {
  mailId: number;
  accountEmail: string;
  subject: string;
  from: string;
}

// 一括承認グループ(不可逆な削除は必ずここを通す)
export interface ButlerGroup {
  id: string;
  kind: 'spam_delete' | 'noise_list';
  label: string;
  reason: string;
  accountEmail: string;
  items: ButlerGroupItem[];
  status: 'pending' | 'approved' | 'rejected' | 'failed';
  error?: string;
  createdAt: string;
}

export interface ButlerStats {
  candidates: number;
  cases: number;
  p1: number;
  p2: number;
  p3: number;
  noise: number;
  spam: number;
  drafts: number;
  aiCalls: number;
  durationMs: number;
}

// 学習ルール(先生の訂正で育つ)
export interface ButlerSenderRule {
  tier: 'vip' | 'noise';
  note?: string;
  updatedAt: string;
}
export interface ButlerRules {
  senders: Record<string, ButlerSenderRule>;  // address(lowercase) → rule
  domains: Record<string, ButlerSenderRule>;  // domain(lowercase) → rule
}

// 承認アクション(UI → main)
export interface ButlerApproval {
  mailId: number;
  accountEmail: string;
  kind: 'delete' | 'send';
  approved: boolean;     // true=実行 / false=破棄(却下)
}

// === IPC API ===
export interface ElectronAPI {
  getMails: (accountEmail: string, daysBack: number) => Promise<MailItem[]>;
  getEvents: (accountEmail: string, daysForward: number) => Promise<CalendarEvent[]>;
  getTasks: (accountEmail: string) => Promise<TaskItem[]>;
  getFolders: (accountEmail: string) => Promise<FolderItem[]>;
  searchMails: (keyword: string, accountEmail: string, daysBack: number) => Promise<MailItem[]>;
  getFolderMails: (folderId: number, accountEmail: string, daysBack?: number) => Promise<MailItem[]>;
  extractActions: (mails: MailItem[], useAI: boolean, apiKey: string) => Promise<ActionItem[]>;
  getAccounts: () => Promise<AccountConfig[]>;
  getSettings: () => Promise<AppSettings>;
  saveSettings: (settings: AppSettings) => Promise<void>;
  triageEmails: (mails: MailItem[], apiKey: string, operationId?: string) => Promise<TriageResult[]>;
  extractTodos: (threadMessages: ThreadMessage[], apiKey: string, operationId?: string) => Promise<TodoItem[]>;
  getThreadMessages: (mailId: number, accountEmail: string) => Promise<ThreadMessage[]>;
  loadProjectContext: (folderPath: string) => Promise<ProjectContext>;
  listProjectFolders: (basePath: string) => Promise<string[]>;
  startHistoricalAudit: (params: AuditParams, operationId?: string) => Promise<AuditResult>;
  cancelOperation: (operationId: string) => Promise<void>;
  onAuditProgress: (callback: (progress: AuditScanProgress) => void) => () => void;
  runClaudeAnalysis: (prompt: string, options?: AnalysisOptions) => Promise<Proposal>;
  getProposals: () => Promise<Proposal[]>;
  deleteProposal: (id: string) => Promise<void>;
  onClaudeProgress: (callback: (progress: { status: string; message: string; logEntry?: AnalysisLogEntry }) => void) => () => void;
  getSkills: () => Promise<SkillSummary[]>;
  getSkillContent: (skillName: string) => Promise<string>;
  saveSkillContent: (skillName: string, content: string) => Promise<void>;
  // Investigation
  getInvestigations: () => Promise<InvestigationRequest[]>;
  saveInvestigation: (inv: InvestigationRequest) => Promise<void>;
  deleteInvestigation: (id: string) => Promise<void>;
  // TODO CRUD
  loadTodos: (accountEmail: string) => Promise<TodoItem[]>;
  saveTodo: (todo: TodoItem) => Promise<void>;
  deleteTodo: (todoId: string, accountEmail: string) => Promise<void>;
  updateTodo: (todo: TodoItem) => Promise<void>;
  // Mail Notes
  getNotes: () => Promise<MailNote[]>;
  getNote: (noteId: string) => Promise<MailNote | null>;
  saveNote: (note: MailNote) => Promise<void>;
  deleteNote: (noteId: string) => Promise<void>;
  // Export
  exportAnalysis: (content: string, filename: string) => Promise<{ success: boolean; path?: string; error?: string }>;
  // Claude Code launcher
  openClaudeCode: () => Promise<void>;
  // PTY (Chat)
  ptyCreate: () => Promise<void>;
  ptyWrite: (data: string) => Promise<void>;
  ptyResize: (cols: number, rows: number) => Promise<void>;
  ptyDestroy: () => Promise<void>;
  onPtyData: (callback: (data: string) => void) => () => void;
  // Junk detection
  detectJunkEmails: (mails: MailItem[], apiKey: string) => Promise<JunkClassification[]>;
  // IMAP operations
  moveToTrash: (mailIds: number[], accountEmail: string) => Promise<MoveToTrashResult[]>;
  testImapConnection: (credentials: ImapCredentials) => Promise<{ success: boolean; error?: string }>;
  listImapFolders: (credentials: ImapCredentials) => Promise<string[]>;
  // Update
  getAppVersion: () => Promise<string>;
  checkForUpdates: () => Promise<{
    hasUpdate: boolean;
    currentVersion?: string;
    latestVersion?: string;
    releaseUrl?: string;
    releaseNotes?: string;
    downloadUrl?: string | null;
    downloadSize?: number | null;
    error?: string;
  }>;
  openExternalUrl: (url: string) => Promise<void>;
  downloadAndInstallUpdate: (downloadUrl: string) => Promise<{ success: boolean; path?: string; error?: string }>;
  onUpdateDownloadProgress: (callback: (progress: { downloaded: number; total: number; percent: number; stage?: string }) => void) => () => void;
  onUpdateAvailable: (callback: (info: {
    hasUpdate: boolean;
    currentVersion?: string;
    latestVersion?: string;
    releaseNotes?: string;
    downloadUrl?: string | null;
    downloadSize?: number | null;
  }) => void) => () => void;
  onUpdateInstallProgress: (callback: (progress: { phase: string; percent: number; message: string }) => void) => () => void;
  // Calendar BrowserView
  calendarShow: (url: string, bounds: { x: number; y: number; width: number; height: number }) => Promise<void>;
  calendarHide: () => Promise<void>;
  calendarSetBounds: (bounds: { x: number; y: number; width: number; height: number }) => Promise<void>;
  // Setup
  checkEmClientInstalled: () => Promise<boolean>;
  // Selected mail context (for Claude Code integration)
  setSelectedMailContext: (mail: MailItem | null) => Promise<void>;
  getSelectedMailContext: () => Promise<MailItem | null>;
  // Reply draft generation
  generateReplyDraft: (params: {
    threadMessages: ThreadMessage[];
    mail: MailItem;
    instruction?: string;
    existingDraft?: string;
  }) => Promise<{ status: string; draft: string; error?: string }>;
  openMailCompose: (params: { to: string; subject: string; body: string; cc?: string }) => Promise<void>;
  // Open specific mail in eM Client
  openMailInEmClient: (params: { subject: string; fromAddress?: string }) => Promise<{ success: boolean; error?: string; searchOpened?: boolean }>;
  // AI auto-tagging
  autoTagMails: (params: {
    mails: { id: number; subject: string; preview: string; from: string }[];
    existingTags: Record<number, string[]>;
  }) => Promise<Record<number, string[]>>;
  // Night Butler (自動パイプライン)
  runButlerPipeline: (params?: { force?: boolean }) => Promise<NightlyDigest>;
  getLatestDigest: () => Promise<NightlyDigest | null>;
  approveButlerItem: (approval: ButlerApproval) => Promise<{ status: string; error?: string }>;
  onDigestUpdated: (callback: (digest: NightlyDigest) => void) => () => void;
  // Night Butler v2(案件ベース)
  approveButlerGroup: (params: { groupId: string; approved: boolean }) => Promise<{ status: string; moved?: number; error?: string }>;
  updateButlerCase: (params: { caseId: string; status: ButlerCaseStatus }) => Promise<{ status: string; error?: string }>;
  setButlerSenderRule: (params: { address: string; tier: 'vip' | 'noise' | null; note?: string }) => Promise<ButlerRules>;
  getButlerRules: () => Promise<ButlerRules>;
  generateCaseDraft: (params: { caseId: string; instruction?: string }) => Promise<{ status: string; draft?: string; error?: string }>;
  onButlerProgress: (callback: (progress: { stage: string; message: string; done?: number; total?: number }) => void) => () => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
