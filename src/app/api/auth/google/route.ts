import { NextResponse } from "next/server";
import { OAuth2Client } from "google-auth-library";
import { DB_UNREACHABLE, dbErrorMessage, getDb } from "@/lib/mongodb";
import { startSession } from "@/lib/session";

/** Matches registerUser's grant so Google sign-up isn't worse than email sign-up. */
const FREE_PLAN_CREDITS = 50;

const client = new OAuth2Client(process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID);

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const credential = body?.credential;
  if (!credential || typeof credential !== "string") {
    return NextResponse.json({ error: "Missing Google credential." }, { status: 400 });
  }

  let email: string;
  let name: string;
  let picture: string;
  try {
    const ticket = await client.verifyIdToken({
      idToken: credential,
      audience: process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload?.email) throw new Error("No email in Google token.");
    email = payload.email.toLowerCase();
    name = payload.name ?? "";
    picture = payload.picture ?? "";
  } catch (err) {
    console.error("[Auth Google] Token verification failed:", err);
    return NextResponse.json({ error: "Could not verify Google sign-in." }, { status: 401 });
  }

  let db;
  try {
    db = await getDb();
  } catch (err) {
    console.error("[Auth Google] Database unavailable:", err);
    return NextResponse.json({ error: dbErrorMessage(err) }, { status: 503 });
  }

  try {
    const users = db.collection("users");
    const existing = await users.findOne({ email });

    if (!existing) {
      const createdAt = new Date().toISOString();
      await users.insertOne({
        email,
        name,
        avatarImage: picture,
        createdAt,
        plan: "free",
        credits: FREE_PLAN_CREDITS,
        planActivatedAt: createdAt,
        authProvider: "google",
      });
    }

    await startSession(email);

    const user = existing ?? { email, name, avatar: "", avatarImage: picture };
    console.log("[Auth Google] Signed in:", email);
    return NextResponse.json({
      status: "ok",
      user: {
        email: user.email,
        name: user.name || name || "",
        avatar: user.avatar || "",
        avatarImage: user.avatarImage || picture || "",
      },
    });
  } catch (err) {
    console.error("[Auth Google] Write failed:", err);
    return NextResponse.json({ error: DB_UNREACHABLE }, { status: 503 });
  }
}
