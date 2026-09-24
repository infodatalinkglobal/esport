'use client';

/**
 * Keeps the homepage's live player count current in a tab the player already
 * has open.
 *
 * The homepage reads fresh data on every server render (force-dynamic), so
 * `router.refresh()` re-runs the server component and streams in the new
 * player count without a full page reload — scroll position and any half-filled
 * registration form survive, because the client components are not remounted.
 *
 * It refreshes:
 * 1. immediately when the tab regains focus or becomes visible again (the
 *    player has just come back from paying, from another app, or from a
 *    locked phone);
 * 2. every 5 seconds while the tab is visible, so a second open tab picks up
 *    a new registration within seconds of it being paid.
 *
 * Refreshes while the tab is hidden are skipped: they would only waste the
 * player's mobile data for nobody.
 */

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';

/** Props for {@link HomeAutoRefresh}. */
interface HomeAutoRefreshProps {
  /** Seconds between polls while the tab is visible (default 5). */
  pollSeconds?: number;
}

/**
 * Invisible component that keeps an open homepage fresh.
 *
 * @param props.pollSeconds How often to poll, in seconds (default 5).
 */
export default function HomeAutoRefresh({
  pollSeconds = 5,
}: HomeAutoRefreshProps) {
  const router = useRouter();

  // Keep the latest router in a ref so the effect is only set up once.
  const routerRef = useRef(router);
  routerRef.current = router;

  useEffect(() => {
    // Coalescing the focus, visibility and timer callbacks: coming back to a
    // tab fires both `focus` and `visibilitychange` within the same instant,
    // and one refresh is enough for that.
    const cooldownMs = 1000;
    let lastRefreshAt = 0;

    const refresh = () => {
      // Skip refreshing while the tab is in the background: saves the
      // player's mobile data and avoids pointless re-renders.
      if (document.visibilityState !== 'visible') return;

      const now = Date.now();
      if (now - lastRefreshAt < cooldownMs) return;
      lastRefreshAt = now;

      routerRef.current.refresh();
    };

    const timer = window.setInterval(refresh, pollSeconds * 1000);

    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [pollSeconds]);

  return null;
}
