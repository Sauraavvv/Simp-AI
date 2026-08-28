"use client";

import { useEffect, useState } from "react";

/**
 * Turns this browser had already used before the page loaded.
 *
 * A page counting only its own message list is right until someone reloads,
 * at which point the list is empty and the allowance looks untouched. The
 * server-side tally (lib/guest.ts) is what actually decides, so this seeds the
 * page's count from it and the page adds whatever it has sent since.
 *
 * Starts at null rather than 0 so callers can tell "not known yet" from
 * "nothing used" and avoid flashing the limit banner before the answer
 * arrives. Failing to reach the endpoint leaves it null: the route refuses the
 * turn regardless, so a wrong banner is the worse outcome to guess at.
 */
export function useGuestUsage(kind: "chat" | "voice", enabled: boolean): number | null {
  const [used, setUsed] = useState<number | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    fetch("/api/guest", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { signedIn?: boolean; chat?: number; voice?: number } | null) => {
        if (!live || !data || data.signedIn) return;
        setUsed(kind === "voice" ? (data.voice ?? 0) : (data.chat ?? 0));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [kind, enabled]);

  // Derived rather than cleared in the effect: signing in mid-session should
  // drop the seed immediately, and setting state from an effect body to do
  // that would just queue an extra render to reach the same answer.
  return enabled ? used : null;
}
