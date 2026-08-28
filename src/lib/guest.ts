/**
 * Guest allowances that survive a refresh.
 *
 * The first version of this counted the user messages in the request body,
 * which does not hold: the body is what the browser sends, so reloading the
 * page sends a fresh, empty history and the count starts again. Both the
 * browser check and the route check read the same client-supplied number, so
 * "enforced twice" was really enforced once, on the honour system.
 *
 * The count lives here instead -- server-side, in Mongo, keyed on an httpOnly
 * cookie the browser cannot read or edit. A reload now keeps the tally.
 *
 * This is a nudge to sign up, not a security boundary, and it is worth being
 * plain about the difference: a private window or cleared site data starts a
 * new guest, and nothing short of demanding an account can prevent that.
 * Stopping a refresh from resetting the count is the whole goal.
 */

import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { getDb } from "@/lib/mongodb";
import { GUEST_CHAT_PROMPTS, GUEST_VOICE_TURNS } from "@/lib/limits";

export const GUEST_COOKIE = "simp_guest";

/** How long one guest's allowance lasts before it is forgotten entirely.
 *  Matches the session cookie, so a guest and an account age out together. */
const GUEST_DAYS = 30;

const COLLECTION = "guest_usage";

type Kind = "chat" | "voice";

const LIMIT: Record<Kind, number> = {
  chat: GUEST_CHAT_PROMPTS,
  voice: GUEST_VOICE_TURNS,
};

let indexed: Promise<void> | null = null;

async function collection() {
  const db = await getDb();
  // Mongo expires the rows on `expiresAt`, so nothing has to sweep them.
  indexed ??= db
    .collection(COLLECTION)
    .createIndexes([
      { key: { id: 1 }, unique: true },
      { key: { expiresAt: 1 }, expireAfterSeconds: 0 },
    ])
    .then(() => undefined)
    .catch((err) => {
      indexed = null; // let a later request try again
      throw err;
    });
  await indexed;
  return db.collection(COLLECTION);
}

/**
 * This browser's guest id, minting one if it has none.
 *
 * httpOnly so page scripts cannot read or forge it, and `lax` so it survives
 * ordinary navigation. Set here rather than in middleware because this is the
 * only place that needs it, and a guest who never chats never gets a cookie.
 */
async function guestId(): Promise<string> {
  const jar = await cookies();
  const existing = jar.get(GUEST_COOKIE)?.value;
  if (existing) return existing;

  const id = randomBytes(16).toString("hex");
  jar.set(GUEST_COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: new Date(Date.now() + GUEST_DAYS * 86_400_000),
  });
  return id;
}

export type GuestCharge = {
  /** False when this turn is over the allowance and must be refused. */
  allowed: boolean;
  /** Turns used *including* this one, for the message shown to the user. */
  used: number;
  limit: number;
};

/**
 * Count one guest turn and say whether it was within the allowance.
 *
 * Chat and voice are counted separately, because they are separate
 * allowances -- a spoken turn costs a round trip plus speech synthesis where a
 * typed one costs only the former.
 *
 * One atomic findOneAndUpdate rather than a read then a write: two turns sent
 * at once would otherwise both read the old count and both be allowed.
 *
 * A database that cannot be reached allows the turn. Metering is not worth
 * taking chat down for, which is the same call `chargeCredit` makes for
 * signed-in users.
 */
export async function chargeGuestTurn(kind: Kind): Promise<GuestCharge> {
  const limit = LIMIT[kind];

  try {
    const id = await guestId();
    const rows = await collection();
    const field = kind === "voice" ? "voice" : "chat";

    const row = await rows.findOneAndUpdate(
      { id },
      {
        $inc: { [field]: 1 },
        $set: { expiresAt: new Date(Date.now() + GUEST_DAYS * 86_400_000) },
        $setOnInsert: { id, createdAt: new Date() },
      },
      { upsert: true, returnDocument: "after" },
    );

    const used = typeof row?.[field] === "number" ? (row[field] as number) : 1;
    return { allowed: used <= limit, used, limit };
  } catch (err) {
    console.warn("[guest] usage check warning:", err);
    return { allowed: true, used: 0, limit };
  }
}

/** What this browser has used so far, without counting a turn against it. */
export async function guestUsage(kind: Kind): Promise<GuestCharge> {
  const limit = LIMIT[kind];
  try {
    const jar = await cookies();
    const id = jar.get(GUEST_COOKIE)?.value;
    if (!id) return { allowed: true, used: 0, limit };

    const rows = await collection();
    const row = await rows.findOne({ id });
    const field = kind === "voice" ? "voice" : "chat";
    const used = typeof row?.[field] === "number" ? (row[field] as number) : 0;
    return { allowed: used < limit, used, limit };
  } catch (err) {
    console.warn("[guest] usage read warning:", err);
    return { allowed: true, used: 0, limit };
  }
}
