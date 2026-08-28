/**
 * What this browser has already used of its guest allowance.
 *
 * The chat and voice pages count the turns they can see in their own message
 * list, which is correct for the current page load and wrong after a reload --
 * the list starts empty while the server-side tally (see lib/guest.ts) does
 * not. This is what they seed that count from, so the banner appears at the
 * right time instead of handing out a fresh allowance on every refresh.
 *
 * Signed-in callers get zeros: the allowance does not apply to them, and their
 * plan and credits are reported by /api/auth/me instead.
 */

import { guestUsage } from "@/lib/guest";
import { sessionEmailOr503 } from "@/lib/route-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await sessionEmailOr503();
  if (session.email) {
    return Response.json({ signedIn: true, chat: 0, voice: 0 });
  }

  const [chat, voice] = await Promise.all([guestUsage("chat"), guestUsage("voice")]);
  return Response.json(
    { signedIn: false, chat: chat.used, voice: voice.used },
    { headers: { "Cache-Control": "no-store" } },
  );
}
