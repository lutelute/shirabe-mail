import type { ViewType } from '../../types';

// =====================================================================
// 最上部のバー(44px)。titleBarStyle: hiddenInset の信号機ボタンの横に置き、
// 全体をウィンドウのドラッグ領域にする。
// =====================================================================

const TITLES: Record<ViewType, string> = {
  today: '今日',
  shirabe: '見通し',
  mail: 'メール',
  calendar: 'カレンダー',
  task: 'タスク',
  search: '検索',
  triage: 'トリアージ',
  todo: 'To-Do',
  project: 'プロジェクト',
  audit: '監査',
  proposal: '提案',
  chat: 'ターミナル',
  terminal: 'ターミナル',
  junk: 'ゴミメール',
  settings: '設定',
};

interface HeaderBarProps {
  activeView: ViewType;
  loading?: boolean;
  error?: string | null;
  onRefresh?: () => void;
}

export default function HeaderBar({ activeView, loading, error, onRefresh }: HeaderBarProps) {
  return (
    <header className="app-drag h-11 flex-shrink-0 flex items-center bg-paper border-b border-hairline select-none" style={{ paddingLeft: 80 }}>
      <div className="flex items-center gap-2.5">
        <span className="w-6 h-6 rounded-[7px] bg-primary text-primary-ink flex items-center justify-center text-[13px] font-semibold leading-none">調</span>
        <span className="text-[13px] text-ink-2">{TITLES[activeView] ?? ''}</span>
      </div>
      <div className="ml-auto flex items-center gap-2 pr-4">
        {loading && (
          <span className="flex items-center gap-1.5 text-ink-3 text-[11.5px]">
            <span className="w-3 h-3 border-2 border-hairline-2 border-t-primary rounded-full animate-spin" />
            読み込み中
          </span>
        )}
        {error && <span className="text-danger text-[11.5px] truncate max-w-xs">{error}</span>}
        {onRefresh && (
          <button onClick={onRefresh} disabled={loading} className="app-no-drag h-7 px-2.5 text-[11.5px] rounded-md border border-hairline bg-card text-ink-2 hover:text-ink disabled:opacity-40">更新</button>
        )}
      </div>
    </header>
  );
}
