import { proxyJson, userHeader } from "@/lib/agent";
import { sessionEmailOr503 } from "@/lib/route-session";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = await sessionEmailOr503();
  if (session.response) return session.response;

  // "chat" (default) is Recent Chat; "rag" is the list the sidebar shows
  // under Inbuilt RAG -- see store.list_conversations.
  const kind = new URL(req.url).searchParams.get("kind") === "rag" ? "rag" : "chat";
  return proxyJson(`/conversations?kind=${kind}`, { headers: userHeader(session.email) });
}
