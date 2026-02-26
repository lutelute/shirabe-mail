const { contextBridge, ipcRenderer } = require('electron');

const api = {
  getMails: (accountEmail, daysBack) =>
    ipcRenderer.invoke('getMails', accountEmail, daysBack),
  getEvents: (accountEmail, daysForward) =>
    ipcRenderer.invoke('getEvents', accountEmail, daysForward),
  getTasks: (accountEmail) =>
    ipcRenderer.invoke('getTasks', accountEmail),
  getFolders: (accountEmail) =>
    ipcRenderer.invoke('getFolders', accountEmail),
  searchMails: (keyword, accountEmail, daysBack) =>
    ipcRenderer.invoke('searchMails', keyword, accountEmail, daysBack),
  getFolderMails: (folderId, accountEmail, daysBack) =>
    ipcRenderer.invoke('getFolderMails', folderId, accountEmail, daysBack),
  extractActions: (mails, useAI, apiKey) =>
    ipcRenderer.invoke('extractActions', mails, useAI, apiKey),
  getAccounts: () =>
    ipcRenderer.invoke('getAccounts'),
  getSettings: () =>
    ipcRenderer.invoke('getSettings'),
  saveSettings: (settings) =>
    ipcRenderer.invoke('saveSettings', settings),
  triageEmails: (mails, apiKey) =>
    ipcRenderer.invoke('triageEmails', mails, apiKey),
  extractTodos: (threadMessages, apiKey) =>
    ipcRenderer.invoke('extractTodos', threadMessages, apiKey),
  getThreadMessages: (mailId, accountEmail) =>
    ipcRenderer.invoke('getThreadMessages', mailId, accountEmail),
  loadProjectContext: (folderPath) =>
    ipcRenderer.invoke('loadProjectContext', folderPath),
  listProjectFolders: (basePath) =>
    ipcRenderer.invoke('listProjectFolders', basePath),
  startHistoricalAudit: (params) =>
    ipcRenderer.invoke('startHistoricalAudit', params),
  cancelOperation: (operationId) =>
    ipcRenderer.invoke('cancelOperation', operationId),
  onAuditProgress: (callback) => {
    const handler = (_event, progress) => callback(progress);
    ipcRenderer.on('auditProgress', handler);
    return () => ipcRenderer.removeListener('auditProgress', handler);
  },
  runClaudeAnalysis: (prompt, options) =>
    ipcRenderer.invoke('runClaudeAnalysis', prompt, options),
  getProposals: () =>
    ipcRenderer.invoke('getProposals'),
  deleteProposal: (id) =>
    ipcRenderer.invoke('deleteProposal', id),
  onClaudeProgress: (callback) => {
    const handler = (_event, progress) => callback(progress);
    ipcRenderer.on('claudeProgress', handler);
    return () => ipcRenderer.removeListener('claudeProgress', handler);
  },
  getSkills: () =>
    ipcRenderer.invoke('getSkills'),
  getSkillContent: (skillName) =>
    ipcRenderer.invoke('getSkillContent', skillName),
  saveSkillContent: (skillName, content) =>
    ipcRenderer.invoke('saveSkillContent', skillName, content),
  // Investigation
  getInvestigations: () =>
    ipcRenderer.invoke('getInvestigations'),
  saveInvestigation: (inv) =>
    ipcRenderer.invoke('saveInvestigation', inv),
  deleteInvestigation: (id) =>
    ipcRenderer.invoke('deleteInvestigation', id),
  // TODO CRUD
  loadTodos: (accountEmail) =>
    ipcRenderer.invoke('loadTodos', accountEmail),
  saveTodo: (todo) =>
    ipcRenderer.invoke('saveTodo', todo),
  deleteTodo: (todoId, accountEmail) =>
    ipcRenderer.invoke('deleteTodo', todoId, accountEmail),
  updateTodo: (todo) =>
    ipcRenderer.invoke('updateTodo', todo),
  // Mail Notes
  getNotes: () =>
    ipcRenderer.invoke('getNotes'),
  getNote: (noteId) =>
    ipcRenderer.invoke('getNote', noteId),
  saveNote: (note) =>
    ipcRenderer.invoke('saveNote', note),
  deleteNote: (noteId) =>
    ipcRenderer.invoke('deleteNote', noteId),
  // Export
  exportAnalysis: (content, filename) =>
    ipcRenderer.invoke('exportAnalysis', content, filename),
  // Claude Code launcher
  openClaudeCode: () =>
    ipcRenderer.invoke('openClaudeCode'),
  // PTY (Chat)
  ptyCreate: () =>
    ipcRenderer.invoke('pty:create'),
  ptyWrite: (data) =>
    ipcRenderer.invoke('pty:write', data),
  ptyResize: (cols, rows) =>
    ipcRenderer.invoke('pty:resize', cols, rows),
  ptyDestroy: () =>
    ipcRenderer.invoke('pty:destroy'),
  onPtyData: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('pty:data', handler);
    return () => ipcRenderer.removeListener('pty:data', handler);
  },
  // Junk detection
  detectJunkEmails: (mails, apiKey) =>
    ipcRenderer.invoke('detectJunkEmails', mails, apiKey),
  // IMAP operations
  moveToTrash: (mailIds, accountEmail) =>
    ipcRenderer.invoke('moveToTrash', mailIds, accountEmail),
  testImapConnection: (credentials) =>
    ipcRenderer.invoke('testImapConnection', credentials),
  listImapFolders: (credentials) =>
    ipcRenderer.invoke('listImapFolders', credentials),
  // Update
  getAppVersion: () =>
    ipcRenderer.invoke('getAppVersion'),
  checkForUpdates: () =>
    ipcRenderer.invoke('checkForUpdates'),
  openExternalUrl: (url) =>
    ipcRenderer.invoke('openExternalUrl', url),
  downloadAndInstallUpdate: (downloadUrl) =>
    ipcRenderer.invoke('downloadAndInstallUpdate', downloadUrl),
  onUpdateDownloadProgress: (callback) => {
    const handler = (_event, progress) => callback(progress);
    ipcRenderer.on('updateDownloadProgress', handler);
    return () => ipcRenderer.removeListener('updateDownloadProgress', handler);
  },
  onUpdateAvailable: (callback) => {
    const handler = (_event, info) => callback(info);
    ipcRenderer.on('updateAvailable', handler);
    return () => ipcRenderer.removeListener('updateAvailable', handler);
  },
  onUpdateInstallProgress: (callback) => {
    const handler = (_event, progress) => callback(progress);
    ipcRenderer.on('updateInstallProgress', handler);
    return () => ipcRenderer.removeListener('updateInstallProgress', handler);
  },
  // Calendar BrowserView
  calendarShow: (url, bounds) =>
    ipcRenderer.invoke('calendar:show', url, bounds),
  calendarHide: () =>
    ipcRenderer.invoke('calendar:hide'),
  calendarSetBounds: (bounds) =>
    ipcRenderer.invoke('calendar:setBounds', bounds),
  // Setup
  checkEmClientInstalled: () =>
    ipcRenderer.invoke('checkEmClientInstalled'),
  // Selected mail context (for Claude Code integration)
  setSelectedMailContext: (mail) =>
    ipcRenderer.invoke('setSelectedMailContext', mail),
  getSelectedMailContext: () =>
    ipcRenderer.invoke('getSelectedMailContext'),
  // Reply draft generation
  generateReplyDraft: (params) =>
    ipcRenderer.invoke('generateReplyDraft', params),
  openMailCompose: (params) =>
    ipcRenderer.invoke('openMailCompose', params),
  // Open specific mail in eM Client (AppleScript search)
  openMailInEmClient: (params) =>
    ipcRenderer.invoke('openMailInEmClient', params),
  // AI auto-tagging
  autoTagMails: (params) =>
    ipcRenderer.invoke('autoTagMails', params),
};

contextBridge.exposeInMainWorld('electronAPI', api);
