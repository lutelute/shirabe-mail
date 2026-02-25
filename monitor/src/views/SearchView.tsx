import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAppContext } from '../context/AppContext';
import { useSearchData } from '../hooks/useSearchData';
import { useFolderData } from '../hooks/useFolderData';
import type { MailItem, FolderItem } from '../types';
import AccountSelector from '../components/AccountSelector';
import LoadingSkeleton from '../components/shared/LoadingSkeleton';
import EmptyState from '../components/shared/EmptyState';
import { formatDate } from '../utils/date';

type SearchMode = 'keyword' | 'folder';

export default function SearchView() {
  const { selectedAccounts, accounts, settings } = useAppContext();
  const { results, loading: searchLoading, error: searchError, search, clearResults } = useSearchData();
  const { folders, folderMails, loading: folderLoading, error: folderError, fetchFolders, fetchFolderMails } = useFolderData();

  const [mode, setMode] = useState<SearchMode>('keyword');
  const [keyword, setKeyword] = useState('');
  const [searchAccount, setSearchAccount] = useState('all');
  const [selectedFolder, setSelectedFolder] = useState<FolderItem | null>(null);
  const [selectedMail, setSelectedMail] = useState<MailItem | null>(null);

  useEffect(() => {
    if (mode === 'folder' && selectedAccounts.length > 0) {
      fetchFolders(selectedAccounts.map((a) => a.email));
    }
  }, [mode, selectedAccounts, fetchFolders]);

  const handleSearch = useCallback(() => {
    if (!keyword.trim()) return;
    const accountEmail = searchAccount === 'all' ? selectedAccounts[0]?.email ?? '' : searchAccount;
    search(keyword, accountEmail, settings.mailDaysBack);
  }, [keyword, searchAccount, selectedAccounts, settings.mailDaysBack, search]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSearch();
  }, [handleSearch]);

  const handleSelectFolder = useCallback((folder: FolderItem) => {
    setSelectedFolder(folder);
    setSelectedMail(null);
    // Determine account for this folder
    const accountEmail = selectedAccounts[0]?.email ?? '';
    fetchFolderMails(folder.id, accountEmail);
  }, [selectedAccounts, fetchFolderMails]);

  const displayMails = mode === 'keyword' ? results : folderMails;
  const loading = mode === 'keyword' ? searchLoading : folderLoading;
  const error = mode === 'keyword' ? searchError : folderError;

  // Build folder tree structure
  const folderTree = useMemo(() => {
    const roots: FolderItem[] = [];
    const childMap = new Map<number, FolderItem[]>();
    for (const f of folders) {
      if (!f.parentFolderId) {
        roots.push(f);
      } else {
        const children = childMap.get(f.parentFolderId) ?? [];
        children.push(f);
        childMap.set(f.parentFolderId, children);
      }
    }
    return { roots, childMap };
  }, [folders]);

  const renderFolderItem = useCallback((folder: FolderItem, depth: number): JSX.Element => {
    const isSelected = selectedFolder?.id === folder.id;
    const children = folderTree.childMap.get(folder.id) ?? [];
    return (
      <div key={folder.id}>
        <div
          onClick={() => handleSelectFolder(folder)}
          className={`flex items-center gap-1.5 py-1.5 px-2 cursor-pointer transition-colors text-sm ${
            isSelected ? 'bg-blue-500/20 text-blue-400' : 'text-surface-300 hover:bg-surface-800'
          }`}
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
        >
          <svg className="w-4 h-4 text-yellow-600 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
            <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
          </svg>
          <span className="truncate">{folder.name}</span>
        </div>
        {children.map((child) => renderFolderItem(child, depth + 1))}
      </div>
    );
  }, [selectedFolder, folderTree.childMap, handleSelectFolder]);

  return (
    <div className="flex h-full">
      {/* Left panel */}
      <div className="w-3/5 flex flex-col border-r border-surface-700">
        <div className="p-3 border-b border-surface-700">
          <div className="flex items-center gap-2 mb-2">
            <h2 className="text-base font-semibold">検索</h2>
            <div className="flex items-center gap-1 ml-auto">
              <button
                onClick={() => { setMode('keyword'); clearResults(); }}
                className={`px-2 py-0.5 text-xs rounded transition-colors ${mode === 'keyword' ? 'bg-blue-500/20 text-blue-400' : 'text-surface-400 hover:text-surface-300'}`}
              >
                キーワード
              </button>
              <button
                onClick={() => { setMode('folder'); setSelectedMail(null); }}
                className={`px-2 py-0.5 text-xs rounded transition-colors ${mode === 'folder' ? 'bg-blue-500/20 text-blue-400' : 'text-surface-400 hover:text-surface-300'}`}
              >
                フォルダ
              </button>
            </div>
          </div>

          {mode === 'keyword' && (
            <>
              <div className="flex items-center gap-1.5 mb-2">
                <input
                  type="text"
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="キーワードを入力..."
                  className="flex-1 bg-surface-800 border border-surface-600 rounded px-2 py-1 text-sm text-white placeholder-surface-500 focus:outline-none focus:border-blue-500"
                />
                <button
                  onClick={handleSearch}
                  disabled={loading || !keyword.trim()}
                  className="px-3 py-1 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors disabled:opacity-50"
                >
                  検索
                </button>
              </div>
              <AccountSelector accounts={accounts} selected={searchAccount} onSelect={setSearchAccount} />
            </>
          )}
        </div>

        {error && <div className="px-3 py-2 text-xs text-red-400 bg-red-500/10">{error}</div>}

        <div className="flex-1 overflow-y-auto">
          {mode === 'folder' ? (
            folderLoading ? (
              <LoadingSkeleton rows={8} />
            ) : folders.length === 0 ? (
              <EmptyState title="フォルダがありません" />
            ) : (
              <div className="py-1">
                {folderTree.roots.map((f) => renderFolderItem(f, 0))}
              </div>
            )
          ) : loading ? (
            <LoadingSkeleton rows={8} />
          ) : displayMails.length === 0 ? (
            <EmptyState title={keyword ? '結果が見つかりません' : 'キーワードを入力して検索'} />
          ) : (
            displayMails.map((mail) => (
              <div
                key={`${mail.accountEmail}-${mail.id}`}
                onClick={() => setSelectedMail(mail)}
                className={`px-3 py-2 border-b border-surface-700 cursor-pointer transition-colors ${
                  selectedMail?.id === mail.id ? 'bg-surface-600 border-l-2 border-l-blue-500' : 'hover:bg-surface-700'
                }`}
              >
                <div className="flex items-center gap-2 mb-0.5">
                  <span className={`text-sm truncate flex-1 ${mail.isRead ? 'text-surface-300' : 'text-white font-semibold'}`}>
                    {mail.subject || '(件名なし)'}
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs text-surface-400">
                  <span className="truncate mr-2">{mail.from ? mail.from.displayName || mail.from.address : '不明'}</span>
                  <span className="flex-shrink-0">{formatDate(mail.date)}</span>
                </div>
                {mail.preview && <p className="text-xs text-surface-500 mt-1 line-clamp-1">{mail.preview}</p>}
              </div>
            ))
          )}
        </div>
      </div>

      {/* Right panel: detail */}
      <div className="w-2/5 flex flex-col">
        {selectedMail ? (
          <div className="flex flex-col h-full">
            <div className="p-3 border-b border-surface-700">
              <h3 className="text-sm font-semibold text-white mb-1">{selectedMail.subject || '(件名なし)'}</h3>
              <div className="flex items-center gap-2 text-xs text-surface-400">
                <span>{selectedMail.from ? selectedMail.from.displayName || selectedMail.from.address : '不明'}</span>
                <span className="flex-shrink-0">{formatDate(selectedMail.date)}</span>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-3">
              {selectedMail.to && selectedMail.to.length > 0 && (
                <div className="mb-3 text-xs text-surface-400">
                  <span className="font-medium text-surface-300">To: </span>
                  {selectedMail.to.map((addr) => addr.displayName || addr.address).join(', ')}
                </div>
              )}
              {selectedMail.folderName && (
                <div className="mb-3 text-xs text-surface-400">
                  <span className="font-medium text-surface-300">フォルダ: </span>{selectedMail.folderName}
                </div>
              )}
              {selectedMail.preview && (
                <div className="text-sm text-surface-300 whitespace-pre-wrap leading-relaxed">{selectedMail.preview}</div>
              )}
            </div>
          </div>
        ) : (
          <EmptyState title={mode === 'folder' && selectedFolder ? 'メールを選択してください' : '検索結果からメールを選択'} />
        )}
      </div>
    </div>
  );
}
