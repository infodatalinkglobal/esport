'use client';

/**
 * Keeps a page fresh without the player touching anything.
 *
 * The group standings page is required to auto-refresh every 60 seconds, so it
 * mounts this component once. It calls `router.refresh()`, which re-runs the
 * server component and streams the new HTML in — no full page reload, and the
 * player keeps their scroll position.
 *
 * Module 3 reuses the same component on the bracket page.
 */

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';

/** Props for {@link AutoRefresh}. */
interface AutoRefreshProps {
  /** Seconds between refreshes (default 60, as required by the brief). */
  intervalSeconds?: number;
}

/**
 * Invisible component that refreshes the current route on a timer.
 *
 * @param props.intervalSeconds How often to refresh, in seconds.
 */
export default function AutoRefresh({ intervalSeconds = 60 }: AutoRefreshProps) {
  const router = useRouter();

  // Keep the latest router in a ref so the interval is only created once.
  const routerRef = useRef(router);
  routerRef.current = router;

  useEffect(() => {
    const timer = window.setInterval(() => {
      // Skip refreshing while the tab is in the background: saves the player's
      // mobile data and avoids pointless re-renders.
      if (document.visibilityState === 'visible') {
        routerRef.current.refresh();
      }
    }, intervalSeconds * 1000);

    return () => window.clearInterval(timer);
  }, [intervalSeconds]);

  return null;
}
