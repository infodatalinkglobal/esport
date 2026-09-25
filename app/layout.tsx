/**
 * Root layout — the shell every page renders inside.
 *
 * It is deliberately minimal: html, body, global styles, the skip link. The
 * player-facing chrome (top bar, footer) lives in `app/(site)/layout.tsx`, and
 * the admin dashboard brings its own chrome in `app/admin/layout.tsx` — so the
 * two halves of the app never render inside each other's navigation.
 *
 * System fonts are used (see globals.css), so there are no external font
 * requests to slow the first paint down.
 */

import type { Metadata, Viewport } from 'next';
import './globals.css';

/** Metadata used by browsers, tabs and link previews. */
export const metadata: Metadata = {
  title: {
    default: 'DLS Tournament GH 🎮 — Ghana’s #1 DLS Tournament Platform',
    template: '%s | DLS Tournament GH',
  },
  description:
    'Join Ghanaian Dream League Soccer tournaments. Pay your GH₵10 entry fee with MoMo, get drawn into groups, and fight your way to the Grand Final.',
  applicationName: 'DLS Tournament GH',
};

/** Mobile-first viewport settings (375px screens are the primary target). */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#020617',
};

/**
 * The application shell.
 *
 * @param props.children The page being rendered.
 */
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        {/* Skip link: lets keyboard and screen-reader users jump straight to
            the content instead of tabbing through the header on every page. */}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-lg focus:bg-pitch-500 focus:px-4 focus:py-2 focus:text-slate-950"
        >
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
