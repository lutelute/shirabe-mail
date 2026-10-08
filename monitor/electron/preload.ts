/* eslint-disable @typescript-eslint/no-var-requires */
const { contextBridge, ipcRenderer } = require('electron');

const api = {
  getMails: (accountEmail: string, daysBack: number) =>
    ipcRenderer.invoke('getMails', accountEmail, daysBack),
  getEvents: (accountEmail: string, daysForward: number) =>
    ipcRenderer.invoke('getEvents', accountEmail, daysForward),
  getTasks: (accountEmail: string) =>
    ipcRenderer.invoke('getTasks', accountEmail),
  getFolders: (accountEmail: string) =>
    ipcRenderer.invoke('getFolders', accountEmail),
  searchMails: (keyword: string, accountEmail?: string, daysBack?: number) =>
    ipcRenderer.invoke('searchMails', keyword, accountEmail, daysBack),
  getFolderMails: (folderId: number, accountEmail: string, daysBack?: number) =>
    ipcRenderer.invoke('getFolderMails', folderId, accountEmail, daysBack),
  extractActions: (mails: any[], useAI: boolean, apiKey: string) =>
    ipcRenderer.invoke('extractActions', mails, useAI, apiKey),
  getAccounts: () =>
    ipcRenderer.invoke('getAccounts'),
  getSettings: () =>
    ipcRenderer.invoke('getSettings'),
  saveSettings: (settings: any) =>
    ipcRenderer.invoke('saveSettings', settings),
  triageEmails: (mails: any[], apiKey: string, operationId?: string) =>
    ipcRenderer.invoke('triageEmails', mails, apiKey, operationId),
  extractTodos: (threadMessages: any[], apiKey: string, operationId?: string) =>
    ipcRenderer.invoke('extractTodos', threadMessages, apiKey, operationId),
  getThreadMessages: (mailId: number, accountEmail: string) =>
    ipcRenderer.invoke('getThreadMessages', mailId, accountEmail),
  loadProjectContext: (folderPath: string) =>
    ipcRenderer.invoke('loadProjectContext', folderPath),
  listProjectFolders: (basePath: string) =>
    ipcRenderer.invoke('listProjectFolders', basePath),
  startHistoricalAudit: (params: any, operationId?: string) =>
    ipcRenderer.invoke('startHistoricalAudit', params, operationId),
  cancelOperation: (operationId: string) =>
    ipcRenderer.invoke('cancelOperation', operationId),
  onAuditProgress: (callback: (progress: any) => void) => {
    const handler = (_event: any, progress: any) => callback(progress);
    ipcRenderer.on('auditProgress', handler);
    return () => ipcRenderer.removeListener('auditProgress', handler);
  },
  runClaudeAnalysis: (prompt: string, options?: { mode?: string }) =>
    ipcRenderer.invoke('runClaudeAnalysis', prompt, options),
  getProposals: () =>
    ipcRenderer.invoke('getProposals'),
  deleteProposal: (id: string) =>
    ipcRenderer.invoke('deleteProposal', id),
  onClaudeProgress: (callback: (progress: any) => void) => {
    const handler = (_event: any, progress: any) => callback(progress);
    ipcRenderer.on('claudeProgress', handler);
    return () => ipcRenderer.removeListener('claudeProgress', handler);
  },
  getSkills: () =>
    ipcRenderer.invoke('getSkills'),
  getSkillContent: (skillName: string) =>
    ipcRenderer.invoke('getSkillContent', skillName),
  saveSkillContent: (skillName: string, content: string) =>
    ipcRenderer.invoke('saveSkillContent', skillName, content),
  // Investigation
  getInvestigations: () =>
    ipcRenderer.invoke('getInvestigations'),
  saveInvestigation: (inv: any) =>
    ipcRenderer.invoke('saveInvestigation', inv),
  deleteInvestigation: (id: string) =>
    ipcRenderer.invoke('deleteInvestigation', id),
  // TODO CRUD
  loadTodos: (accountEmail: string) =>
    ipcRenderer.invoke('loadTodos', accountEmail),
  saveTodo: (todo: any) =>
    ipcRenderer.invoke('saveTodo', todo),
  deleteTodo: (todoId: string, accountEmail: string) =>
    ipcRenderer.invoke('deleteTodo', todoId, accountEmail),
  updateTodo: (todo: any) =>
    ipcRenderer.invoke('updateTodo', todo),
  // Mail Notes
  getNotes: () =>
    ipcRenderer.invoke('getNotes'),
  getNote: (noteId: string) =>
    ipcRenderer.invoke('getNote', noteId),
  saveNote: (note: any) =>
    ipcRenderer.invoke('saveNote', note),
  deleteNote: (noteId: string) =>
    ipcRenderer.invoke('deleteNote', noteId),
  // Export
  exportAnalysis: (content: string, filename: string) =>
    ipcRenderer.invoke('exportAnalysis', content, filename),
  // Claude Code launcher
  openClaudeCode: () =>
    ipcRenderer.invoke('openClaudeCode'),
  // PTY(アプリ内ターミナル、複数セッション)
  ptyCreate: (params?: any) =>
    ipcRenderer.invoke('pty:create', params),
  ptyWrite: (id: string, data: string) =>
    ipcRenderer.invoke('pty:write', id, data),
  ptyResize: (id: string, cols: number, rows: number) =>
    ipcRenderer.invoke('pty:resize', id, cols, rows),
  ptyDestroy: (id: string) =>
    ipcRenderer.invoke('pty:destroy', id),
  ptyList: () =>
    ipcRenderer.invoke('pty:list'),
  onPtyData: (callback: (id: string, data: string) => void) => {
    const handler = (_event: any, payload: { id: string; data: string }) => callback(payload.id, payload.data);
    ipcRenderer.on('pty:data', handler);
    return () => ipcRenderer.removeListener('pty:data', handler);
  },
  onPtyExit: (callback: (id: string, code: number) => void) => {
    const handler = (_event: any, payload: { id: string; code: number }) => callback(payload.id, payload.code);
    ipcRenderer.on('pty:exit', handler);
    return () => ipcRenderer.removeListener('pty:exit', handler);
  },
  // Junk detection
  detectJunkEmails: (mails: any[], apiKey: string) =>
    ipcRenderer.invoke('detectJunkEmails', mails, apiKey),
  // IMAP operations
  moveToTrash: (mailIds: number[], accountEmail: string) =>
    ipcRenderer.invoke('moveToTrash', mailIds, accountEmail),
  testImapConnection: (credentials: any) =>
    ipcRenderer.invoke('testImapConnection', credentials),
  listImapFolders: (credentials: any) =>
    ipcRenderer.invoke('listImapFolders', credentials),
  // Update
  getAppVersion: () =>
    ipcRenderer.invoke('getAppVersion'),
  checkForUpdates: () =>
    ipcRenderer.invoke('checkForUpdates'),
  openExternalUrl: (url: string) =>
    ipcRenderer.invoke('openExternalUrl', url),
  downloadAndInstallUpdate: (downloadUrl: string) =>
    ipcRenderer.invoke('downloadAndInstallUpdate', downloadUrl),
  onUpdateDownloadProgress: (callback: (progress: { downloaded: number; total: number; percent: number; stage?: string }) => void) => {
    const handler = (_event: any, progress: any) => callback(progress);
    ipcRenderer.on('updateDownloadProgress', handler);
    return () => ipcRenderer.removeListener('updateDownloadProgress', handler);
  },
  // Calendar BrowserView
  calendarShow: (url: string, bounds: any) =>
    ipcRenderer.invoke('calendar:show', url, bounds),
  calendarHide: () =>
    ipcRenderer.invoke('calendar:hide'),
  calendarSetBounds: (bounds: any) =>
    ipcRenderer.invoke('calendar:setBounds', bounds),
  // Setup
  checkEmClientInstalled: () =>
    ipcRenderer.invoke('checkEmClientInstalled'),
  // Selected mail context (for Claude Code integration)
  setSelectedMailContext: (mail: any) =>
    ipcRenderer.invoke('setSelectedMailContext', mail),
  getSelectedMailContext: () =>
    ipcRenderer.invoke('getSelectedMailContext'),
  // Reply draft generation
  generateReplyDraft: (params: any) =>
    ipcRenderer.invoke('generateReplyDraft', params),
  openMailCompose: (params: any) =>
    ipcRenderer.invoke('openMailCompose', params),
  // Open specific mail in eM Client (AppleScript search)
  openMailInEmClient: (params: { subject: string; fromAddress?: string }) =>
    ipcRenderer.invoke('openMailInEmClient', params),
  // Auto-tag mails
  autoTagMails: (params: any) =>
    ipcRenderer.invoke('autoTagMails', params),
  // Night Butler (自動パイプライン)
  runButlerPipeline: (params?: { force?: boolean }) =>
    ipcRenderer.invoke('runButlerPipeline', params),
  getLatestDigest: () =>
    ipcRenderer.invoke('getLatestDigest'),
  approveButlerItem: (approval: any) =>
    ipcRenderer.invoke('approveButlerItem', approval),
  onDigestUpdated: (callback: (digest: any) => void) => {
    const handler = (_event: any, digest: any) => callback(digest);
    ipcRenderer.on('digestUpdated', handler);
    return () => ipcRenderer.removeListener('digestUpdated', handler);
  },
  // Night Butler v2(案件ベース)
  approveButlerGroup: (params: any) =>
    ipcRenderer.invoke('approveButlerGroup', params),
  updateButlerCase: (params: any) =>
    ipcRenderer.invoke('updateButlerCase', params),
  setButlerSenderRule: (params: any) =>
    ipcRenderer.invoke('setButlerSenderRule', params),
  getButlerRules: () =>
    ipcRenderer.invoke('getButlerRules'),
  generateCaseDraft: (params: any) =>
    ipcRenderer.invoke('generateCaseDraft', params),
  onButlerProgress: (callback: (progress: any) => void) => {
    const handler = (_event: any, progress: any) => callback(progress);
    ipcRenderer.on('butlerProgress', handler);
    return () => ipcRenderer.removeListener('butlerProgress', handler);
  },
  // 相棒 v3
  partnerGetState: () => ipcRenderer.invoke('partner:getState'),
  partnerRunNow: () => ipcRenderer.invoke('partner:runNow'),
  partnerSend: (params: any) => ipcRenderer.invoke('partner:send', params),
  partnerCancelSend: (params: any) => ipcRenderer.invoke('partner:cancelSend', params),
  partnerSendNow: (params: any) => ipcRenderer.invoke('partner:sendNow', params),
  partnerAnswerDecision: (params: any) => ipcRenderer.invoke('partner:answerDecision', params),
  partnerSaveDraft: (params: any) => ipcRenderer.invoke('partner:saveDraft', params),
  partnerFollowUpAction: (params: any) => ipcRenderer.invoke('partner:followUpAction', params),
  partnerUndoTidy: (params: any) => ipcRenderer.invoke('partner:undoTidy', params),
  partnerDiscoverAccounts: () => ipcRenderer.invoke('partner:discoverAccounts'),
  partnerTestConnection: (params: any) => ipcRenderer.invoke('partner:testConnection', params),
  partnerGetProfile: () => ipcRenderer.invoke('partner:getProfile'),
  partnerSaveProfile: (content: string) => ipcRenderer.invoke('partner:saveProfile', content),
  partnerHandoffPrepare: (params: any) => ipcRenderer.invoke('partner:handoffPrepare', params),
  partnerHandoffOpen: (params: any) => ipcRenderer.invoke('partner:handoffOpen', params),
  partnerPickFolder: (params: any) => ipcRenderer.invoke('partner:pickFolder', params),
  partnerDraftToEmClient: (params: any) => ipcRenderer.invoke('partner:draftToEmClient', params),
  partnerAddToCalendar: (params: any) => ipcRenderer.invoke('partner:addToCalendar', params),
  partnerHandoffCopy: (params: any) => ipcRenderer.invoke('partner:handoffCopy', params),
  partnerRemoveFromCalendar: (params: any) => ipcRenderer.invoke('partner:removeFromCalendar', params),
  googleStatus: () => ipcRenderer.invoke('google:status'),
  calendarTargets: () => ipcRenderer.invoke('calendar:targets'),
  calendarListViaClaude: () => ipcRenderer.invoke('calendar:listViaClaude'),
  googleConnect: (params: any) => ipcRenderer.invoke('google:connect', params),
  googleDisconnect: (email?: string) => ipcRenderer.invoke('google:disconnect', email),
  googleCalendars: (email: string) => ipcRenderer.invoke('google:calendars', email),
  googleSetCalendar: (email: string, calendarId: string) => ipcRenderer.invoke('google:setCalendar', email, calendarId),
  partnerCalendarCopy: (params: any) => ipcRenderer.invoke('partner:calendarCopy', params),
  onPartnerState: (callback: (state: any) => void) => {
    const handler = (_event: any, state: any) => callback(state);
    ipcRenderer.on('partner:state', handler);
    return () => ipcRenderer.removeListener('partner:state', handler);
  },
  // Update notification listeners
  onUpdateAvailable: (callback: (info: any) => void) => {
    const handler = (_event: any, info: any) => callback(info);
    ipcRenderer.on('updateAvailable', handler);
    return () => ipcRenderer.removeListener('updateAvailable', handler);
  },
  onUpdateInstallProgress: (callback: (progress: any) => void) => {
    const handler = (_event: any, progress: any) => callback(progress);
    ipcRenderer.on('updateInstallProgress', handler);
    return () => ipcRenderer.removeListener('updateInstallProgress', handler);
  },
};

contextBridge.exposeInMainWorld('electronAPI', api);
