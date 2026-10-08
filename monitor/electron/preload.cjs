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
  triageEmails: (mails, apiKey, operationId) =>
    ipcRenderer.invoke('triageEmails', mails, apiKey, operationId),
  extractTodos: (threadMessages, apiKey, operationId) =>
    ipcRenderer.invoke('extractTodos', threadMessages, apiKey, operationId),
  getThreadMessages: (mailId, accountEmail) =>
    ipcRenderer.invoke('getThreadMessages', mailId, accountEmail),
  loadProjectContext: (folderPath) =>
    ipcRenderer.invoke('loadProjectContext', folderPath),
  listProjectFolders: (basePath) =>
    ipcRenderer.invoke('listProjectFolders', basePath),
  startHistoricalAudit: (params, operationId) =>
    ipcRenderer.invoke('startHistoricalAudit', params, operationId),
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
  ptyCreate: (params) =>
    ipcRenderer.invoke('pty:create', params),
  ptyWrite: (id, data) =>
    ipcRenderer.invoke('pty:write', id, data),
  ptyResize: (id, cols, rows) =>
    ipcRenderer.invoke('pty:resize', id, cols, rows),
  ptyDestroy: (id) =>
    ipcRenderer.invoke('pty:destroy', id),
  ptyList: () =>
    ipcRenderer.invoke('pty:list'),
  onPtyData: (callback) => {
    const handler = (_event, payload) => callback(payload.id, payload.data);
    ipcRenderer.on('pty:data', handler);
    return () => ipcRenderer.removeListener('pty:data', handler);
  },
  onPtyExit: (callback) => {
    const handler = (_event, payload) => callback(payload.id, payload.code);
    ipcRenderer.on('pty:exit', handler);
    return () => ipcRenderer.removeListener('pty:exit', handler);
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
  // Night Butler (自動パイプライン)
  runButlerPipeline: (params) =>
    ipcRenderer.invoke('runButlerPipeline', params),
  getLatestDigest: () =>
    ipcRenderer.invoke('getLatestDigest'),
  approveButlerItem: (approval) =>
    ipcRenderer.invoke('approveButlerItem', approval),
  onDigestUpdated: (callback) => {
    const handler = (_event, digest) => callback(digest);
    ipcRenderer.on('digestUpdated', handler);
    return () => ipcRenderer.removeListener('digestUpdated', handler);
  },
  // Night Butler v2
  approveButlerGroup: (params) =>
    ipcRenderer.invoke('approveButlerGroup', params),
  updateButlerCase: (params) =>
    ipcRenderer.invoke('updateButlerCase', params),
  setButlerSenderRule: (params) =>
    ipcRenderer.invoke('setButlerSenderRule', params),
  getButlerRules: () =>
    ipcRenderer.invoke('getButlerRules'),
  generateCaseDraft: (params) =>
    ipcRenderer.invoke('generateCaseDraft', params),
  onButlerProgress: (callback) => {
    const handler = (_event, progress) => callback(progress);
    ipcRenderer.on('butlerProgress', handler);
    return () => ipcRenderer.removeListener('butlerProgress', handler);
  },
  // 相棒 v3
  partnerGetState: () => ipcRenderer.invoke('partner:getState'),
  partnerRunNow: () => ipcRenderer.invoke('partner:runNow'),
  partnerSend: (params) => ipcRenderer.invoke('partner:send', params),
  partnerCancelSend: (params) => ipcRenderer.invoke('partner:cancelSend', params),
  partnerSendNow: (params) => ipcRenderer.invoke('partner:sendNow', params),
  partnerAnswerDecision: (params) => ipcRenderer.invoke('partner:answerDecision', params),
  partnerSaveDraft: (params) => ipcRenderer.invoke('partner:saveDraft', params),
  partnerFollowUpAction: (params) => ipcRenderer.invoke('partner:followUpAction', params),
  partnerUndoTidy: (params) => ipcRenderer.invoke('partner:undoTidy', params),
  partnerDiscoverAccounts: () => ipcRenderer.invoke('partner:discoverAccounts'),
  partnerTestConnection: (params) => ipcRenderer.invoke('partner:testConnection', params),
  partnerGetProfile: () => ipcRenderer.invoke('partner:getProfile'),
  partnerSaveProfile: (content) => ipcRenderer.invoke('partner:saveProfile', content),
  partnerHandoffPrepare: (params) => ipcRenderer.invoke('partner:handoffPrepare', params),
  partnerHandoffOpen: (params) => ipcRenderer.invoke('partner:handoffOpen', params),
  partnerPickFolder: (params) => ipcRenderer.invoke('partner:pickFolder', params),
  partnerDraftToEmClient: (params) => ipcRenderer.invoke('partner:draftToEmClient', params),
  partnerAddToCalendar: (params) => ipcRenderer.invoke('partner:addToCalendar', params),
  partnerHandoffCopy: (params) => ipcRenderer.invoke('partner:handoffCopy', params),
  partnerRemoveFromCalendar: (params) => ipcRenderer.invoke('partner:removeFromCalendar', params),
  googleStatus: () => ipcRenderer.invoke('google:status'),
  googleConnect: (params) => ipcRenderer.invoke('google:connect', params),
  googleDisconnect: () => ipcRenderer.invoke('google:disconnect'),
  googleCalendars: () => ipcRenderer.invoke('google:calendars'),
  googleSetCalendar: (calendarId) => ipcRenderer.invoke('google:setCalendar', calendarId),
  partnerCalendarCopy: (params) => ipcRenderer.invoke('partner:calendarCopy', params),
  onPartnerState: (callback) => {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on('partner:state', handler);
    return () => ipcRenderer.removeListener('partner:state', handler);
  },
};

contextBridge.exposeInMainWorld('electronAPI', api);
