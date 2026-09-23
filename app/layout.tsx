/**
 * Root layout — the shell every page renders inside.
 *
 * It provides only what Module 1 needs:
 * - mobile-first viewport settings
 * - a compact top bar with the platform name
 * - a footer whose only content is the WhatsApp contact link
 *
 * System fonts are used (see globals.css), so there are no external font
 * requests to slow the first paint down.
 */

import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import './globals.css';
import { whatsappLink } from '@/lib/format';

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

        <header className="sticky top-0 z-40 border-b border-white/10 bg-slate-950/90 backdrop-blur">
          <div className="mx-auto flex max-w-3xl items-center justify-between gap-2 px-4 py-2">
            <Link
              href="/"
              className="flex min-h-tap items-center text-base font-bold tracking-tight"
            >
              DLS <span className="ml-1 text-pitch-400">Tournament GH</span>
            </Link>

            {/* The hero section is the only navigation target in Module 1. */}
            <a
              href="#register"
              className="flex min-h-tap items-center rounded-lg px-3 text-sm font-medium text-slate-300 active:bg-white/5"
            >
              Register
            </a>
          </div>
        </header>

        <main id="main" className="mx-auto max-w-3xl px-4 pb-8 pt-4">
          {children}
        </main>

        {/* Footer: WhatsApp contact link only, as specified. */}
        <footer className="mt-6 border-t border-white/10 px-4 py-6 safe-bottom">
          <div className="mx-auto max-w-3xl text-center">
            <a
              href={whatsappLink(
                undefined,
                'Hi! I have a question about the DLS tournament.',
              )}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-tap items-center justify-center gap-2 rounded-xl border border-pitch-500/40 bg-pitch-500/10 px-4 py-3 text-base font-semibold text-pitch-400"
            >
              Contact organizer on WhatsApp
            </a>
          </div>
        </footer>
      </body>
    </html>
  );
}
