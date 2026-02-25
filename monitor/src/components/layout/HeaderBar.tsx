interface HeaderBarProps {
  loading?: boolean;
  error?: string | null;
  onRefresh?: () => void;
}

export default function HeaderBar({ loading, error, onRefresh }: HeaderBarProps) {
  return (
    <header className="flex items-center justify-between px-4 py-2 bg-surface-900 border-b border-surface-700/50 flex-shrink-0">
      <div className="flex items-center gap-2">
        <div className="w-2 h-2 rounded-full bg-accent-400" />
        <h1 className="text-sm font-semibold text-surface-200 tracking-wide">調</h1>
      </div>
      <div className="flex items-center gap-2">
        {loading && (
          <div className="flex items-center gap-1.5 text-surface-400 text-xs">
            <div className="w-3 h-3 border-2 border-accent-500/30 border-t-accent-500 rounded-full animate-spin" />
            <span>読み込み中</span>
          </div>
        )}
        {error && (
          <span className="text-red-400 text-xs truncate max-w-xs">{error}</span>
        )}
        {onRefresh && (
          <button
            onClick={onRefresh}
            disabled={loading}
            className="px-2.5 py-1 text-xs bg-surface-800 hover:bg-surface-700 text-surface-300 rounded transition-colors disabled:opacity-40"
          >
            更新
          </button>
        )}
      </div>
    </header>
  );
}
