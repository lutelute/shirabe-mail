// =====================================================================
// 相棒 clawd くん — 先生の AI_usage(clawdくんのおこづかい帳)と同じカニ型のドット絵。手紙をせっせとさばく。
//   インライン SVG + CSS keyframes(index.css の .mascot-*)。外部画像なし。
//   mode: idle(呼吸・まばたき) / working(手紙を箱へ・体が揺れる) / done(ぴょん) / error(首をかしげる)
// =====================================================================

export type MascotMode = 'idle' | 'working' | 'done' | 'error';

export interface MascotProps {
  mode: MascotMode;
  stage?: string;          // collect / classify / draft / brief / tidy / watch …
  message?: string;        // 吹き出し
  done?: number;
  total?: number;
  size?: number;           // 描画幅(px)。既定 72
  bubble?: boolean;        // 吹き出しを出す(既定 true)
  className?: string;
}

const BOXES: Array<{ x: number; fill: string }> = [
  { x: 84, fill: 'var(--primary)' },
  { x: 94, fill: 'var(--danger)' },
  { x: 104, fill: 'var(--ink-3)' },
];

function stageKind(stage?: string): 'collect' | 'classify' | 'draft' | 'brief' {
  if (stage === 'collect' || stage === 'tidy') return 'collect';
  if (stage === 'draft') return 'draft';
  if (stage === 'brief' || stage === 'watch') return 'brief';
  return 'classify';
}

export default function Mascot({ mode, stage, message, done, total, size = 72, bubble = true, className = '' }: MascotProps) {
  const kind = stageKind(stage);
  const working = mode === 'working';
  const bodyAnim = mode === 'working' ? 'mascot-sway' : mode === 'done' ? 'mascot-spin' : mode === 'error' ? 'mascot-tilt' : 'mascot-bob';
  const showBar = working && !!total && total > 0;
  const pct = showBar ? Math.min(100, Math.round(((done ?? 0) / (total as number)) * 100)) : 0;
  const text = message ?? (mode === 'working' ? '働いています…' : mode === 'done' ? '済みました' : mode === 'error' ? 'うまくいきませんでした' : '');

  return (
    <div className={`mascot relative flex flex-col items-center ${className}`} style={{ width: size }} aria-hidden="true">
      {bubble && text && (
        <div
          className="absolute -top-2 left-full ml-1 z-10 max-w-[180px] px-2 py-1 rounded-md border border-hairline bg-paper text-[11px] leading-snug text-ink-2 whitespace-nowrap shadow-card"
          style={{ transform: 'translateY(-50%)' }}
        >
          <span className="absolute -left-[5px] top-1/2 -translate-y-1/2 w-2 h-2 rotate-45 border-l border-b border-hairline bg-paper" />
          {mode === 'error' ? `? ${text}` : text}
        </div>
      )}
      <svg width={size} height={size} viewBox="0 0 120 120" fill="none" className="block overflow-visible">
        {/* 机 */}
        <line x1="6" y1="98" x2="114" y2="98" stroke="var(--mascot-line)" strokeWidth="1.5" strokeLinecap="round" opacity="0.6" />
        <line x1="14" y1="98" x2="12" y2="112" stroke="var(--mascot-line)" strokeWidth="1.2" strokeLinecap="round" opacity="0.4" />
        <line x1="106" y1="98" x2="108" y2="112" stroke="var(--mascot-line)" strokeWidth="1.2" strokeLinecap="round" opacity="0.4" />

        {/* 手紙の山(左) */}
        <g>
          <rect x="14" y="90" width="22" height="7" rx="1" fill="#fff" stroke="var(--mascot-line)" strokeWidth="1" />
          <rect x="16" y="86" width="22" height="7" rx="1" fill="#fff" stroke="var(--mascot-line)" strokeWidth="1" />
          <rect x="18" y="82" width="22" height="7" rx="1" fill="#fff" stroke="var(--mascot-line)" strokeWidth="1" />
          <path d="M18 82l11 4 11-4" stroke="var(--mascot-line)" strokeWidth="1" />
        </g>

        {/* 仕分け箱(右): 藍 / 朱 / 灰 */}
        {BOXES.map((b) => (
          <g key={b.x}>
            <rect x={b.x} y="88" width="9" height="9" rx="1" fill={b.fill} opacity="0.85" />
            <rect x={b.x - 1} y="86" width="11" height="3" rx="0.8" fill={b.fill} />
          </g>
        ))}

        {/* 集める: 上から手紙が山へ落ちる */}
        {working && kind === 'collect' && (
          <g>
            <rect className="mascot-letter-drop" x="20" y="78" width="18" height="6" rx="1" fill="#fff" stroke="var(--mascot-line)" strokeWidth="1" />
            <rect className="mascot-letter-drop d2" x="22" y="78" width="18" height="6" rx="1" fill="#fff" stroke="var(--mascot-line)" strokeWidth="1" />
            <rect className="mascot-letter-drop d3" x="18" y="78" width="18" height="6" rx="1" fill="#fff" stroke="var(--mascot-line)" strokeWidth="1" />
          </g>
        )}

        {/* 体: clawd くん(先生の AI_usage と同じドット絵。15×9 セル、1 セル 5px) */}
        <g className={bodyAnim}>
          <rect x="37" y="99" width="45" height="2" fill="var(--ink)" opacity="0.12" />
          <g shapeRendering="crispEdges">
            <rect x="32" y="53" width="55" height="5" fill="#D68263" />
            <rect x="32" y="58" width="55" height="5" fill="#D68263" />
            <rect x="32" y="63" width="10" height="5" fill="#D68263" />
            <rect x="42" y="63" width="5" height="5" fill="#000000" className="mascot-wink" />
            <rect x="47" y="63" width="25" height="5" fill="#D68263" />
            <rect x="72" y="63" width="5" height="5" fill="#000000" className="mascot-wink" />
            <rect x="77" y="63" width="10" height="5" fill="#D68263" />
            <rect x="22" y="68" width="20" height="5" fill="#D68263" />
            <rect x="42" y="68" width="5" height="5" fill="#000000" />
            <rect x="47" y="68" width="25" height="5" fill="#D68263" />
            <rect x="72" y="68" width="5" height="5" fill="#000000" />
            <rect x="77" y="68" width="20" height="5" fill="#D68263" />
            <rect x="22" y="73" width="75" height="5" fill="#D68263" />
            <rect x="32" y="78" width="55" height="5" fill="#D68263" />
            <rect x="32" y="83" width="55" height="5" fill="#D68263" />
            <rect x="37" y="88" width="5" height="5" fill="#D68263" />
            <rect x="47" y="88" width="5" height="5" fill="#D68263" />
            <rect x="67" y="88" width="5" height="5" fill="#D68263" />
            <rect x="77" y="88" width="5" height="5" fill="#D68263" />
            <rect x="37" y="93" width="5" height="5" fill="#D68263" />
            <rect x="47" y="93" width="5" height="5" fill="#D68263" />
            <rect x="67" y="93" width="5" height="5" fill="#D68263" />
            <rect x="77" y="93" width="5" height="5" fill="#D68263" />
          </g>
          {/* 手紙を 1 枚持つ(idle) */}
          {!working && mode !== 'error' && (
            <g transform="translate(6 70)">
              <rect x="0" y="0" width="18" height="11" rx="1" fill="#fff" stroke="var(--mascot-line)" strokeWidth="1" />
              <path d="M0 0l9 5.5 9-5.5" stroke="var(--mascot-line)" strokeWidth="1" />
            </g>
          )}
          {/* 働いているときは手紙が手元を行き来する */}
          {working && (
            <g className="mascot-claw-l" transform="translate(6 70)">
              <rect x="0" y="0" width="18" height="11" rx="1" fill="#fff" stroke="var(--mascot-line)" strokeWidth="1" />
            </g>
          )}
        </g>

        {/* 振り分け: 手紙が山からはさみを経て箱へ */}
        {working && kind === 'classify' && (
          <g className="mascot-letter-fly">
            <rect x="24" y="84" width="16" height="9" rx="1" fill="#fff" stroke="var(--mascot-line)" strokeWidth="1" />
            <path d="M24 84l8 4 8-4" stroke="var(--mascot-line)" strokeWidth="1" />
          </g>
        )}

        {/* 下書き: 手前の手紙にペンで線を書く */}
        {working && kind === 'draft' && (
          <g>
            <rect x="46" y="86" width="30" height="12" rx="1" fill="#fff" stroke="var(--mascot-line)" strokeWidth="1" />
            <line x1="50" y1="91" x2="66" y2="91" stroke="var(--ink-3)" strokeWidth="1" />
            <line x1="50" y1="94" x2="60" y2="94" stroke="var(--ink-3)" strokeWidth="1" />
            <g className="mascot-pen">
              <line x1="70" y1="78" x2="76" y2="92" stroke="var(--primary)" strokeWidth="2.2" strokeLinecap="round" />
              <circle cx="76" cy="92" r="1.2" fill="var(--ink)" />
            </g>
          </g>
        )}

        {/* まとめる: 帳面に書く */}
        {working && kind === 'brief' && (
          <g>
            <rect x="44" y="84" width="34" height="14" rx="1.5" fill="var(--card)" stroke="var(--primary)" strokeWidth="1.2" />
            <line x1="61" y1="84" x2="61" y2="98" stroke="var(--primary)" strokeWidth="1" opacity="0.5" />
            <line x1="48" y1="89" x2="58" y2="89" stroke="var(--ink-3)" strokeWidth="1" />
            <line x1="48" y1="93" x2="56" y2="93" stroke="var(--ink-3)" strokeWidth="1" />
            <g className="mascot-pen">
              <line x1="66" y1="78" x2="72" y2="92" stroke="var(--primary)" strokeWidth="2.2" strokeLinecap="round" />
            </g>
          </g>
        )}
      </svg>
      {showBar && (
        <div className="w-full h-1 rounded-full bg-hairline overflow-hidden -mt-1">
          <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}
