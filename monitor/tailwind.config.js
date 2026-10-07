/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Hiragino Sans', 'Hiragino Kaku Gothic ProN', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'system-ui', 'sans-serif'],
      },
      screens: {
        wide: '1180px',
      },
      boxShadow: {
        card: 'var(--shadow)',
      },
      colors: {
        // 意味トークン
        paper: 'var(--paper)',
        card: { DEFAULT: 'var(--card)', 2: 'var(--card-2)' },
        ink: { DEFAULT: 'var(--ink)', 2: 'var(--ink-2)', 3: 'var(--ink-3)' },
        hairline: { DEFAULT: 'var(--hairline)', 2: 'var(--hairline-2)' },
        primary: { DEFAULT: 'var(--primary)', hover: 'var(--primary-hover)', ink: 'var(--primary-ink)', soft: 'var(--primary-soft)' },
        danger: { DEFAULT: 'var(--danger)', soft: 'var(--danger-soft)' },
        warn: { DEFAULT: 'var(--warn)', soft: 'var(--warn-soft)' },
        ok: { DEFAULT: 'var(--ok)', soft: 'var(--ok-soft)' },
        // 互換(旧ビュー)
        surface: {
          50:  'var(--surface-50)',
          100: 'var(--surface-100)',
          200: 'var(--surface-200)',
          300: 'var(--surface-300)',
          400: 'var(--surface-400)',
          500: 'var(--surface-500)',
          600: 'var(--surface-600)',
          700: 'var(--surface-700)',
          800: 'var(--surface-800)',
          900: 'var(--surface-900)',
          950: 'var(--surface-950)',
        },
        accent: {
          50:  'var(--accent-50)',
          100: 'var(--accent-100)',
          200: 'var(--accent-200)',
          300: 'var(--accent-300)',
          400: 'var(--accent-400)',
          500: 'var(--accent-500)',
          600: 'var(--accent-600)',
          700: 'var(--accent-700)',
        },
      },
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
  ],
};
