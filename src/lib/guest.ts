/**
 * Guest allowances that survive a refresh.
 *
 * The first version counted the user messages in the request body, which does
 * not hold: the body is what the browser sends, so reloading sent a fresh,
 * empty history and the count started again.
 *
 * The second version moved the count into Mongo, keyed on an httpOnly cookie.
 * That fixed the refresh but bought nothing the cookie did not already give,
 * and cost a great deal: a guest turn touches the database nowhere else -- there
 * is no session to look up -- so it put a cold Atlas round trip in front of
 * every turn. Measured in production: 0.25s warm, 2.9s cold, all of it before
 * the agent had even been asked. In a voice call that silence is the whole of
 * what "slow" feels like.
 *
 * The count lives in the cookie itself now, httpOnly so page scripts cannot
 * touch it and signed with HMAC-SHA256 so a hand-edited one is not mistaken for
 * a real tally.
 *
 * Be clear about what that signature is and is not worth. An unreadable
 * signature means "start over", so editing the cookie gets someone a fresh
 * allowance -- but so does deleting it, and so did deleting the id the database
 * row was found by. Neither design can tell a tampered guest from a genuinely
 * new one, because the identifier is held by the client in both. The signature
 * buys tidiness, not security, and the database bought neither.
 *
 * So: this is a nudge to sign up, not a security boundary. A private window or
 * cleared site data starts a new guest and nothing short of demanding an
 * account can prevent that. Stopping a *refresh* from resetting the count is
 * the whole goal, and that it does.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { GUEST_CHAT_PROMPTS, GUEST_VOICE_TURNS } from "@/lib/limits";

export const GUEST_COOKIE = "simp_guest";

/** How long one guest's allowance lasts before it is forgotten entirely.
 *  Matches the session cookie, so a guest and an account age out together. */
const GUEST_DAYS = 30;

type Kind = "chat" | "voice";

const LIMIT: Record<Kind, number> = {
  chat: GUEST_CHAT_PROMPTS,
  voice: GUEST_VOICE_TURNS,
};

/**
 * The HMAC key. AGENT_TOKEN is the fallback because it is already required in
 * production and already secret, so this needs no new configuration to be
 * unforgeable there. Rotating either one resets every guest's allowance, which
 * is a fine thing to happen to a nudge.
 */
function secret(): string {
  return (process.env.GUEST_SECRET || process.env.AGENT_TOKEN || "").trim();
}

type Tally = { chat: number; voice: number; exp: number };

const EMPTY: Tally = { chat: 0, voice: 0, exp: 0 };

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

function encode(t: Tally): string {
  const payload = `${t.chat}.${t.voice}.${t.exp}`;
  return `${payload}.${sign(payload)}`;
}

/**
 * Read a tally back, or null if it was tampered with, truncated or has expired.
 * A null here means "start over", never "let them through": the caller charges
 * from zero, which is the same thing a brand new browser gets.
 */
function decode(raw: string | undefined): Tally | null {
  if (!raw) return null;

  const cut = raw.lastIndexOf(".");
  if (cut < 0) return null;

  const payload = raw.slice(0, cut);
  const mac = Buffer.from(raw.slice(cut + 1));
  const want = Buffer.from(sign(payload));
  // timingSafeEqual throws on a length mismatch, so that is checked first --
  // and a wrong length is already a wrong signature.
  if (mac.length !== want.length || !timingSafeEqual(mac, want)) return null;

  const [chat, voice, exp] = payload.split(".").map(Number);
  if (![chat, voice, exp].every(Number.isFinite)) return null;
  if (exp <= Date.now()) return null;

  return { chat, voice, exp };
}

export type GuestCharge = {
  /** False when this turn is over the allowance and must be refused. */
  allowed: boolean;
  /** Turns used *including* this one, for the message shown to the user. */
  used: number;
  limit: number;
};

async function write(jar: Awaited<ReturnType<typeof cookies>>, next: Tally) {
  jar.set(GUEST_COOKIE, encode(next), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: new Date(next.exp),
  });
}

/**
 * Count one guest turn and say whether it was within the allowance.
 *
 * Chat and voice are counted separately, because they are separate
 * allowances -- a spoken turn costs a round trip plus speech synthesis where a
 * typed one costs only the former.
 *
 * Two turns sent at the same instant would both read the same cookie and the
 * second would overwrite the first, so a guest could get one extra turn that
 * way. The UI sends turns one at a time and this is a nudge, not a gate, so
 * that is a fair trade for taking a database off the path -- but it is a real
 * difference from the atomic update this replaced, not an oversight.
 */
export async function chargeGuestTurn(kind: Kind): Promise<GuestCharge> {
  const limit = LIMIT[kind];

  try {
    const jar = await cookies();
    const current = decode(jar.get(GUEST_COOKIE)?.value) ?? EMPTY;

    // Capped so a guest who keeps trying does not grow the number forever;
    // one past the limit is all that has to be remembered to keep refusing.
    const used = Math.min(current[kind] + 1, limit + 1);
    await write(jar, { ...current, [kind]: used, exp: Date.now() + GUEST_DAYS * 86_400_000 });

    return { allowed: used <= limit, used, limit };
  } catch (err) {
    // Only reachable if the cookie store itself is unavailable. Metering is not
    // worth taking chat down for, the same call chargeCredit makes for
    // signed-in users.
    console.warn("[guest] usage check warning:", err);
    return { allowed: true, used: 0, limit };
  }
}

/** What this browser has used so far, without counting a turn against it. */
export async function guestUsage(kind: Kind): Promise<GuestCharge> {
  const limit = LIMIT[kind];
  try {
    const jar = await cookies();
    const used = (decode(jar.get(GUEST_COOKIE)?.value) ?? EMPTY)[kind];
    return { allowed: used < limit, used, limit };
  } catch (err) {
    console.warn("[guest] usage read warning:", err);
    return { allowed: true, used: 0, limit };
  }
}
