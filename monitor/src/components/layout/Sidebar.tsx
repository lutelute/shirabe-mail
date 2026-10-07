import { useEffect, useRef, useState } from 'react';
import type { ViewType } from '../../types';
import { groupQueue } from '../partner/partnerUi';

// =====================================================================
// アイコンレール(56px): 今日 / メール / カレンダー / 検索 / 見通し / ツール / 設定 / Claude Code
// =====================================================================

interface SidebarProps {
  activeView: ViewType;
  onNavigate: (view: ViewType) => void;
}

interface NavItem { view: ViewType; label: string; icon: JSX.Element }

const svg = (d: string, extra?: string) => (
  <svg className="w-[18px] h-[18px]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d={d} />
    {extra && <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d={extra} />}
  </svg>
);

const I = {
  today: svg('M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z'),
  mail: svg('M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z'),
  calendar: svg('M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z'),
  search: svg('M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z'),
  outlook: svg('M3 5.25A2.25 2.25 0 015.25 3h13.5A2.25 2.25 0 0121 5.25v13.5A2.25 2.25 0 0118.75 21H5.25A2.25 2.25 0 013 18.75V5.25zM3 9h18M9 9v12M15 9v12'),
  tools: svg('M11.42 15.17L17.25 21A2.652 2.652 0 0021 17.25l-5.877-5.877M11.42 15.17l2.496-3.03c.317-.384.74-.626 1.208-.766M11.42 15.17l-4.655 5.653a2.548 2.548 0 11-3.586-3.586l6.837-5.63m5.108-.233c.55-.164 1.163-.188 1.743-.14a4.5 4.5 0 004.486-6.336l-3.276 3.277a3.004 3.004 0 01-2.25-2.25l3.276-3.276a4.5 4.5 0 00-6.336 4.486c.091 1.076-.071 2.264-.904 2.95l-.102.085m-1.745 1.437L5.909 7.5H4.5L2.25 3.75l1.5-1.5L7.5 4.5v1.409l4.26 4.26m-1.745 1.437l1.745-1.437m6.615 8.206L15.75 15.75M4.867 19.125h.008v.008h-.008v-.008z'),
  settings: svg('M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z', 'M15 12a3 3 0 11-6 0 3 3 0 016 0z'),
  claude: svg('M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0021 18V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v12a2.25 2.25 0 002.25 2.25z'),
  task: svg('M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2'),
  triage: svg('M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4'),
  todo: svg('M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4'),
  project: svg('M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z'),
  audit: svg('M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z'),
  proposal: svg('M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z'),
  junk: svg('M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16'),
  chat: svg('M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z'),
};

const MAIN: NavItem[] = [
  { view: 'today', label: '今日', icon: I.today },
  { view: 'mail', label: 'メール', icon: I.mail },
  { view: 'calendar', label: 'カレンダー', icon: I.calendar },
  { view: 'search', label: '検索', icon: I.search },
  { view: 'shirabe', label: '見通し  ⌘2', icon: I.outlook },
];
const TOOLS: NavItem[] = [
  { view: 'task', label: 'タスク', icon: I.task },
  { view: 'triage', label: 'トリアージ', icon: I.triage },
  { view: 'todo', label: 'To-Do', icon: I.todo },
  { view: 'project', label: 'プロジェクト', icon: I.project },
  { view: 'audit', label: '監査', icon: I.audit },
  { view: 'proposal', label: '提案', icon: I.proposal },
  { view: 'junk', label: 'ゴミメール', icon: I.junk },
  { view: 'chat', label: 'Chat', icon: I.chat },
];

function RailButton({ active, label, icon, onClick, badge }: { active: boolean; label: string; icon: JSX.Element; onClick: () => void; badge?: number }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      className={`rail-item app-no-drag relative w-10 h-10 rounded-lg flex items-center justify-center transition-colors ${
        active ? 'bg-primary-soft text-primary' : 'text-ink-2 hover:bg-card-2 hover:text-ink'
      }`}
    >
      {icon}
      {badge !== undefined && badge > 0 && (
        <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-danger text-white text-[10px] leading-4 text-center tnum font-medium">{badge > 99 ? '99+' : badge}</span>
      )}
      <span className="rail-tip absolute left-12 top-1/2 -translate-y-1/2 z-40 px-2 py-1 rounded bg-ink text-paper text-[11px] whitespace-nowrap shadow-card">{label}</span>
    </button>
  );
}

export default function Sidebar({ activeView, onNavigate }: SidebarProps) {
  const [pending, setPending] = useState(0);
  const [toolsOpen, setToolsOpen] = useState(false);
  const popRef = useRef<HTMLDivElement | null>(null);
  const toolActive = TOOLS.some((t) => t.view === activeView);

  // 「今日」の未処理件数(決める+送る+やる)
  useEffect(() => {
    let alive = true;
    window.electronAPI.partnerGetState().then((s) => { if (alive) setPending(groupQueue(s).pending); }).catch(() => undefined);
    const un = window.electronAPI.onPartnerState((s) => { if (alive) setPending(groupQueue(s).pending); });
    return () => { alive = false; un(); };
  }, []);

  useEffect(() => {
    if (!toolsOpen) return;
    const onDown = (e: MouseEvent) => { if (popRef.current && !popRef.current.contains(e.target as Node)) setToolsOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setToolsOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [toolsOpen]);

  return (
    <nav className="w-14 flex-shrink-0 bg-paper border-r border-hairline flex flex-col items-center py-2 gap-1 relative">
      {MAIN.map((item) => (
        <RailButton key={item.view} active={activeView === item.view} label={item.label} icon={item.icon} onClick={() => onNavigate(item.view)} badge={item.view === 'today' ? pending : undefined} />
      ))}
      <div className="w-6 border-t border-hairline my-1" />
      <div ref={popRef} className="relative">
        <RailButton active={toolActive || toolsOpen} label="ツール" icon={I.tools} onClick={() => setToolsOpen((v) => !v)} />
        {toolsOpen && (
          <div className="absolute left-12 top-0 z-50 w-44 bg-card border border-hairline rounded-lg shadow-card p-1">
            <div className="px-2.5 pt-1.5 pb-1 text-[10.5px] text-ink-3 tracking-wide">ツール</div>
            {TOOLS.map((t) => (
              <button
                key={t.view}
                onClick={() => { onNavigate(t.view); setToolsOpen(false); }}
                className={`w-full flex items-center gap-2.5 px-2.5 h-8 rounded-md text-[12.5px] text-left transition-colors ${activeView === t.view ? 'bg-primary-soft text-primary' : 'text-ink-2 hover:bg-card-2 hover:text-ink'}`}
              >
                <span className="text-ink-3">{t.icon}</span>
                <span>{t.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="flex-1" />
      <RailButton active={false} label="Claude Code (Terminal)" icon={I.claude} onClick={() => { window.electronAPI.openClaudeCode(); }} />
      <RailButton active={activeView === 'settings'} label="設定  ⌘," icon={I.settings} onClick={() => onNavigate('settings')} />
    </nav>
  );
}
