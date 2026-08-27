/**
 * Document indexing proxy -- the two-phase entry point behind /documents.
 *
 * Same arrangement as /api/chat: the browser only ever talks to its own
 * origin, and the agent's Voyage key never leaves the server. Unlike /chat,
 * this does not run stream_chat or answer anything -- it only chunks,
 * embeds and stores, then hands back the conversation id to open.
 */

import { AGENT_DOWN, AGENT_URL, agentAuth, userHeader } from "@/lib/agent";
import { sessionEmailOr503 } from "@/lib/route-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Minutes, not seconds, and deliberately so. Voyage's free tier allows 10,000
// tokens a minute, and a document worth more than that can only be embedded by
// pacing its chunks across several minute-long windows (see rag.embed's
// batching). A PDF chapter is ~13,000 tokens, so two windows -- around 90s --
// is an ordinary case here, not a pathological one. 300 is the ceiling Vercel
// allows and roughly what fetch's own 300s header timeout would permit anyway;
// /documents warns before submitting anything estimated to run past it.
export const maxDuration = 300;

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const session = await sessionEmailOr503();
  if (session.response) return session.response;

  if (!session.email) {
    return Response.json({ error: "Sign in to index a document." }, { status: 401 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${AGENT_URL}/documents/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...agentAuth(),
        ...userHeader(session.email),
      },
      body: JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    return Response.json({ error: AGENT_DOWN }, { status: 502 });
  }

  if (!upstream.ok) {
    const detail = (await upstream.json().catch(() => null)) as { detail?: string } | null;
    return Response.json(
      { error: detail?.detail ?? `Indexing failed (${upstream.status}).` },
      { status: upstream.status },
    );
  }

  return new Response(upstream.body, {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
