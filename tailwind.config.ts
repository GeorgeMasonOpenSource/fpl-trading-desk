import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Trading-desk palette. Generic, club-inspired blocks live in the component layer.
        bg: {
          DEFAULT: '#0A0C10',
          raised: '#11141B',
          card: '#151922',
          inset: '#0D1016'
        },
        line: {
          DEFAULT: '#1F2532',
          strong: '#2A3140'
        },
        ink: {
          DEFAULT: '#E6EAF2',
          muted: '#8A93A6',
          dim: '#5B6478'
        },
        accent: {
          green: '#34D399',
          amber: '#FBBF24',
          red: '#F87171',
          blue: '#60A5FA',
          violet: '#A78BFA',
          teal: '#2DD4BF'
        }
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'Inter', 'sans-serif']
      },
      borderRadius: {
        card: '14px'
      }
    }
  },
  plugins: []
};

export default config;
