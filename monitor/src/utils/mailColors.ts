/**
 * Sender domain-based color coding for mail list.
 * Hashes the domain to pick a consistent, visually distinct color from a curated palette.
 *
 * Design principles:
 * - Colors are chosen for good readability on dark backgrounds (#1a1a2e etc.)
 * - Background mode uses a softer, desaturated variant (computed from base color)
 * - Text mode uses full saturation for legibility
 * - Adjacent colors in the palette are maximally distinct (hue-spread)
 */

// Curated palette: 12 colors with maximum hue separation, tuned for dark UI
const DOMAIN_COLORS = [
  '#60a5fa', // sky blue
  '#34d399', // emerald
  '#a78bfa', // violet
  '#fbbf24', // amber
  '#f87171', // red
  '#22d3ee', // cyan
  '#fb923c', // orange
  '#e879f9', // fuchsia
  '#2dd4bf', // teal
  '#c084fc', // purple
  '#4ade80', // green
  '#f472b6', // pink
];

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

/** Returns a consistent color hex for the given email address based on its domain. */
export function getSenderColor(address?: string): string {
  if (!address) return 'transparent';
  const domain = address.split('@')[1] || address;
  return DOMAIN_COLORS[hashString(domain) % DOMAIN_COLORS.length];
}

/**
 * Returns a subtle background color string for background mode.
 * Uses the sender color at very low opacity for a soft tint.
 */
export function getSenderBgStyle(address?: string): { backgroundColor: string; borderLeftColor: string } {
  const color = getSenderColor(address);
  if (color === 'transparent') return { backgroundColor: 'transparent', borderLeftColor: 'transparent' };
  return {
    backgroundColor: color + '12',  // ~7% opacity
    borderLeftColor: color,
  };
}

/** Returns a CSS class for account-based background tinting. */
export function getAccountTint(accountEmail: string, allAccounts: string[]): string {
  if (allAccounts.length <= 1) return '';
  const idx = allAccounts.indexOf(accountEmail);
  const tints = [
    'bg-blue-500/3',
    'bg-emerald-500/3',
    'bg-violet-500/3',
    'bg-amber-500/3',
  ];
  return tints[idx % tints.length] || '';
}
