// === 見通しの部品(partner/* に依存しない自前の小物) ===
import { useEffect, useState } from 'react';

export function useMediaQuery(query: string): boolean {
  const [ok, setOk] = useState(() => (typeof window !== 'undefined' ? window.matchMedia(query).matches : true));
  useEffect(() => {
    const mq = window.matchMedia(query);
    const fn = () => setOk(mq.matches);
    fn();
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, [query]);
  return ok;
}

export function useToast(): { toast: string | null; flash: (m: string) => void } {
  const [toast, setToast] = useState<string | null>(null);
  const flash = (m: string) => {
    setToast(m);
    window.setTimeout(() => setToast((cur) => (cur === m ? null : cur)), 3200);
  };
  return { toast, flash };
}

export function SummaryChip({ label, n, tone, onClick }: { label: string; n: number; tone: 'danger' | 'primary' | 'ink'; onClick?: () => void }) {
  if (n <= 0) return null;
  const cls = tone === 'danger' ? 'bg-danger-soft text-danger border-danger/30' : tone === 'primary' ? 'bg-primary-soft text-primary border-primary/30' : 'bg-card-2 text-ink-2 border-hairline';
  return (
    <button onClick={onClick} className={`h-6 px-2 rounded-md border text-[11.5px] flex items-center gap-1 ${cls} ${onClick ? 'hover:opacity-80' : 'cursor-default'}`}>
      <span>{label}</span>
      <span className="tnum font-medium">{n}</span>
    </button>
  );
}

/** 線画アイコン(1.5px) */
const svg = (d: string, cls = 'w-3.5 h-3.5') => (
  <svg className={cls} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d={d} /></svg>
);
export const OIcon = {
  grid: svg('M3 5.25A2.25 2.25 0 015.25 3h13.5A2.25 2.25 0 0121 5.25v13.5A2.25 2.25 0 0118.75 21H5.25A2.25 2.25 0 013 18.75V5.25zM3 9h18M9 9v12M15 9v12'),
  send: svg('M4.5 12h15m0 0l-6-6m6 6l-6 6'),
  plus: svg('M12 4.5v15m7.5-7.5h-15'),
  refresh: svg('M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182'),
};

/** 行頭の印: 藍の四角 = 予定 / 朱の中抜き = 未登録 / 朱の丸 = 期限 / 墨の丸 = タスク / 藍の矢印 = 送信 */
export function Mark({ kind }: { kind: 'calendar' | 'missing' | 'deadline' | 'task' | 'send' }) {
  switch (kind) {
    case 'calendar': return <span className="inline-block w-2.5 h-2.5 rounded-[2px] bg-primary flex-shrink-0" />;
    case 'missing': return <span className="inline-block w-2.5 h-2.5 rounded-[2px] border-[1.5px] border-danger flex-shrink-0" />;
    case 'deadline': return <span className="inline-block w-2.5 h-2.5 rounded-full bg-danger flex-shrink-0" />;
    case 'task': return <span className="inline-block w-2.5 h-2.5 rounded-full bg-ink-3 flex-shrink-0" />;
    case 'send': return <span className="text-primary flex-shrink-0">{OIcon.send}</span>;
  }
}

export function Card({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="bg-card border border-hairline rounded-lg shadow-card">
      <header className="flex items-center justify-between px-3.5 h-9 border-b border-hairline">
        <h3 className="text-[12.5px] font-semibold text-ink">{title}</h3>
        {aside}
      </header>
      <div className="px-3.5 py-2.5">{children}</div>
    </section>
  );
}
