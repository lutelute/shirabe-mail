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
  triageEmails: (mails: any[], apiKey: string) =>
    ipcRenderer.invoke('triageEmails', mails, apiKey),
  extractTodos: (threadMessages: any[], apiKey: string) =>
    ipcRenderer.invoke('extractTodos', threadMessages, apiKey),
  getThreadMessages: (mailId: number, accountEmail: string) =>
    ipcRenderer.invoke('getThreadMessages', mailId, accountEmail),
  loadProjectContext: (folderPath: string) =>
    ipcRenderer.invoke('loadProjectContext', folderPath),
  listProjectFolders: (basePath: string) =>
    ipcRenderer.invoke('listProjectFolders', basePath),
  startHistoricalAudit: (params: any) =>
    ipcRenderer.invoke('startHistoricalAudit', params),
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
  // PTY (Chat)
  ptyCreate: () =>
    ipcRenderer.invoke('pty:create'),
  ptyWrite: (data: string) =>
    ipcRenderer.invoke('pty:write', data),
  ptyResize: (cols: number, rows: number) =>
    ipcRenderer.invoke('pty:resize', cols, rows),
  ptyDestroy: () =>
    ipcRenderer.invoke('pty:destroy'),
  onPtyData: (callback: (data: string) => void) => {
    const handler = (_event: any, data: string) => callback(data);
    ipcRenderer.on('pty:data', handler);
    return () => ipcRenderer.removeListener('pty:data', handler);
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
