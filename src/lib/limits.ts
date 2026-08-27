/**
 * What a visitor gets before signing in, and who is exempt from all of it.
 *
 * These numbers are enforced twice on purpose: once in the browser, so the
 * limit is visible before someone types into a box that will refuse them, and
 * once in the route, because the browser copy is only a courtesy. Both read
 * from here so the two can never drift apart.
 */

/** User turns a signed-out visitor gets in one chat thread. */
export const GUEST_CHAT_PROMPTS = 5;

/** Spoken turns a signed-out visitor gets in one voice call. Lower than the
 *  written limit because a call turn costs a Groq round trip plus speech
 *  synthesis, where a typed one costs only the former. */
export const GUEST_VOICE_TURNS = 2;

/**
 * Accounts that bypass every quota here -- the developer's own, so the app can
 * be exercised end to end without burning the one-per-account allowances it
 * hands everyone else.
 *
 * Server-only: `DEVELOPER_EMAILS` is not a NEXT_PUBLIC variable, so this reads
 * back empty in the browser and every caller is treated as an ordinary
 * account. That is the safe direction to fail, and the reason nothing on the
 * client is allowed to decide this for itself.
 */
export function isDeveloper(email: string | null | undefined): boolean {
  if (!email) return false;
  const allowed = (process.env.DEVELOPER_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes(email.trim().toLowerCase());
}
