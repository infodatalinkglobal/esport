/**
 * The player site's chrome — top bar, content column and footer.
 *
 * Every player-facing page (landing, groups, bracket, submit result, My
 * Matches, payment callbacks, champions) renders inside this layout; the admin
 * dashboard does not (it has its own full-width chrome in app/admin).
 */

import Link from 'next/link';
import { whatsappLink } from '@/lib/format';

/**
 * @param props.children The player page being rendered.
 */
export default function SiteLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <header className="sticky top-0 z-40 border-b border-white/10 bg-slate-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-2 px-4 py-2">
          <Link
            href="/"
            className="flex min-h-tap items-center whitespace-nowrap text-sm font-bold tracking-tight sm:text-base"
          >
            DLS <span className="ml-1 text-pitch-400">Tournament GH</span>
          </Link>

          <nav aria-label="Main navigation">
            <ul className="flex items-center">
              {/* My Matches: the player's personal fixtures/results view. */}
              <li>
                <Link
                  href="/my-matches"
                  className="flex min-h-tap items-center rounded-lg px-2 text-sm font-medium text-slate-300 active:bg-white/5 sm:px-3"
                >
                  My Matches
                </Link>
              </li>
              <li>
                <Link
                  href="/submit-result"
                  className="flex min-h-tap items-center rounded-lg px-2 text-sm font-medium text-slate-300 active:bg-white/5 sm:px-3"
                >
                  Submit Result
                </Link>
              </li>
            </ul>
          </nav>
        </div>
      </header>

      <main id="main" className="mx-auto max-w-3xl px-4 pb-8 pt-4">
        {children}
      </main>

      {/* Footer: WhatsApp contact link, plus the organizer's own way in. */}
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

          {/* Quiet link to the organizer's own dashboard (Module 4). */}
          <p className="mt-3 text-xs text-slate-600">
            <Link
              href="/admin"
              className="rounded underline decoration-white/20 underline-offset-4 hover:text-slate-400"
            >
              Organizer login
            </Link>
          </p>
        </div>
      </footer>
    </>
  );
}
