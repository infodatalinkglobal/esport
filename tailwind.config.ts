import type { Config } from 'tailwindcss';

/**
 * Tailwind configuration.
 * Mobile-first by default: the base styles target a 375px Android screen and
 * larger breakpoints are added with `sm:`, `md:` ... only where genuinely useful.
 */
const config: Config = {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        // Brand palette: deep pitch-black background with a "pitch green" accent.
        pitch: {
          50: '#ecfdf5',
          400: '#34d399',
          500: '#10b981',
          600: '#059669',
        },
      },
      minHeight: {
        // Minimum tap target required by the mobile-first rules (48x48px).
        tap: '48px',
      },
      minWidth: {
        tap: '48px',
      },
    },
  },
  plugins: [],
};

export default config;
