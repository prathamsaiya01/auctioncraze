/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}'
  ],
  theme: {
    extend: {
      colors: {
        stadium: {
          canvas: '#060A14',
          surface: '#0C1322',
          card: '#131D33',
          elevated: '#1A2744',
          border: 'rgba(148, 163, 184, 0.16)',
          text: '#F8FAFC',
          muted: '#94A3B8'
        },
        gold: {
          300: '#FCE79C',
          400: '#F5D061',
          500: '#D4AF37',
          600: '#A8841E',
          900: '#3D2E08'
        },
        electric: {
          400: '#38BDF8',
          500: '#2563EB',
          600: '#1D4ED8'
        },
        signal: {
          sold: '#10B981',
          unsold: '#EF4444',
          warn: '#F59E0B'
        }
      },
      fontFamily: {
        display: ['var(--font-display)', 'sans-serif'],
        sans: ['var(--font-sans)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'monospace']
      },
      boxShadow: {
        'gold-glow': '0 0 28px -6px rgba(212, 175, 55, 0.45)',
        'electric-glow': '0 0 24px -6px rgba(56, 189, 248, 0.35)',
        'stage': '0 24px 60px -15px rgba(0, 0, 0, 0.7)'
      }
    }
  },
  plugins: []
};
