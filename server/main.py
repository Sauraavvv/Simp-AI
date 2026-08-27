"""FastAPI wrapper around the agent.

Run it with:  uvicorn main:app --reload --port 8000   (from this directory)

The Next.js routes under /api proxy to this service, so the browser never talks
to it directly and the LLM key never leaves the server.

State lives in store.py -- in memory, for now. Every endpoint below returns real
data produced by the running system; there are no fixtures.
"""

import os
import re
import threading
from pathlib import Path
from typing import List, Optional

# pyrefly: ignore [missing-import]
from dotenv import load_dotenv
# pyrefly: ignore [missing-import]
from fastapi import FastAPI, Header, HTTPException, Request
# pyrefly: ignore [missing-import]
from fastapi.responses import JSONResponse, Response, StreamingResponse
# pyrefly: ignore [missing-import]
from pydantic import BaseModel, Field

# Locally the key lives in the Next.js .env.local one directory up -- one key,
# one place. Deployed (Render), the platform sets real environment variables and
# neither file exists; load_dotenv is a no-op then, and never overwrites what is
# already in the environment.
load_dotenv(Path(__file__).resolve().parent.parent / ".env.local")
load_dotenv(Path(__file__).resolve().parent / ".env")

import llm  # noqa: E402
import rag  # noqa: E402
import store  # noqa: E402
import tts  # noqa: E402
from agent import stream_chat  # noqa: E402  (needs env loaded first)
from tools import registry  # noqa: E402

app = FastAPI(title="SIMP AI agent", version="1.0.0")


# Loading the speech models takes about five seconds each, and lazily that cost
# lands on the first person to speak. Doing it here spends it before anyone is
# waiting. On a thread because it must not hold up the port opening, and behind
# a switch because a memory-tight host is better off paying it per request.
if os.environ.get("TTS_PREWARM", "on").strip().lower() not in {"off", "false", "0", "no"}:

    @app.on_event("startup")
    def _warm_speech() -> None:
        threading.Thread(target=tts.warm, name="tts-warm", daemon=True).start()


# Shared secret between the Next.js proxy and this service.
#
# It matters once the two halves are deployed apart: this host is then reachable
# from the open internet, and `x-user-email` below is trusted as given -- so
# without a gate anyone could name someone else's account and read their
# conversations. Unset (local dev, both halves on one machine) the check is
# inert, so nothing about running locally changes.
AGENT_TOKEN = os.environ.get("AGENT_TOKEN", "").strip()

# Reachable without the token, so Render's health check and a quick curl work.
OPEN_PATHS = {"/health", "/docs", "/openapi.json"}


@app.middleware("http")
async def require_agent_token(request: Request, call_next):
    if AGENT_TOKEN and request.url.path not in OPEN_PATHS:
        if request.headers.get("x-agent-token", "") != AGENT_TOKEN:
            return JSONResponse({"detail": "Unauthorized"}, status_code=401)
    return await call_next(request)


class Message(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    messages: List[Message] = Field(..., min_length=1)
    conversation_id: Optional[str] = None
    # Set by the voice page: the reply will be heard, not read.
    voice: bool = False


# Who the request belongs to. Sent by the Next.js proxy as `x-user-email`, empty
# for a signed-out visitor -- see store._owner for what that buys a guest.
UserEmail = Optional[str]


class AuthRequest(BaseModel):
    email: str
    password_hash: str


class SpeechRequest(BaseModel):
    text: str = Field(..., min_length=1)
    voice: Optional[str] = None
    speed: float = Field(default=1.0, ge=0.5, le=2.0)


class ProfileUpdateRequest(BaseModel):
    email: str
    name: Optional[str] = None
    avatar: Optional[str] = None
    avatarImage: Optional[str] = None
    current_password: Optional[str] = None
    new_password: Optional[str] = None


class DocumentIngestRequest(BaseModel):
    name: str = Field(..., min_length=1)
    text: str = Field(..., min_length=1)
    # The /documents "advanced settings" card -- None on each means "use
    # default settings", which rag.ingest applies via clamp_chunking /
    # clamp_dimension. Bounds beyond that (chunk size, dimension whitelist)
    # are enforced there too, not trusted from the request alone.
    chunk_size: Optional[int] = None
    chunk_overlap: Optional[int] = None
    dimension: Optional[int] = None


@app.get("/health")
def health():
    """Cheap readiness probe -- also tells you whether the key was picked up."""
    provider = llm.describe()
    keys = llm.rotating_keys()
    return {
        "status": "ok",
        "model": provider.model,
        "provider": provider.name,
        "base_url": provider.base_url,
        "key_loaded": bool(keys),
        # Masked, so the rotation is visible without printing a usable secret.
        "keys": [llm.fingerprint(key) for key in keys],
        "storage": store.status(),
        "auth_required": bool(AGENT_TOKEN),
        "speech": tts.status(),
    }


@app.post("/auth/register")
def register_user(req: AuthRequest):
    ok = store.register_user(req.email, req.password_hash)
    if not ok:
        raise HTTPException(status_code=400, detail="User already exists or registration failed")
    return {"status": "ok", "email": req.email}


@app.post("/auth/login")
def login_user(req: AuthRequest):
    user = store.login_user(req.email, req.password_hash)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid email or password")
    return {"status": "ok", "user": user}


@app.post("/auth/update-profile")
def update_profile(req: ProfileUpdateRequest):
    if req.current_password:
        existing = store.login_user(req.email, req.current_password)
        if not existing:
            raise HTTPException(status_code=400, detail="Current password is incorrect.")
    
    updated = store.update_user_profile(
        req.email,
        name=req.name,
        avatar=req.avatar,
        avatarImage=req.avatarImage,
        new_password=req.new_password,
    )
    return {"status": "ok", "user": updated}


@app.get("/tools")
def tools():
    """The agent's real capabilities, straight from the tool registry."""
    provider = llm.describe()
    return {"model": provider.model, "provider": provider.name, "tools": registry()}


@app.get("/tts/voices")
def tts_voices():
    """Whether spoken replies are available, and in which voices."""
    return tts.status()


@app.post("/tts")
def tts_speak(req: SpeechRequest):
    """Render text to a WAV with KittenTTS.

    Declared `def`, not `async def`, on purpose: FastAPI runs it in a threadpool,
    so a CPU synthesis never blocks the event loop the chat stream is riding on.
    """
    try:
        audio = tts.synthesize(req.text, req.voice, req.speed)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except tts.TTSUnavailable as exc:
        # 503, not 500: the agent is fine, this one optional dependency is not.
        raise HTTPException(status_code=503, detail=str(exc))

    return Response(
        content=audio,
        media_type="audio/wav",
        headers={"Cache-Control": "no-store"},
    )


@app.get("/conversations")
def conversations(kind: str = "chat", x_user_email: UserEmail = Header(default=None)):
    """kind="chat" (default) is Recent Chat; kind="rag" is the list the
    sidebar shows under Inbuilt RAG -- see store.list_conversations."""
    return {"conversations": store.list_conversations(x_user_email, kind=kind)}


@app.get("/conversations/{conversation_id}")
def conversation(conversation_id: str, x_user_email: UserEmail = Header(default=None)):
    found = store.get_conversation(conversation_id, x_user_email)
    if found is None:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return found


@app.delete("/conversations/{conversation_id}")
def remove_conversation(
    conversation_id: str, x_user_email: UserEmail = Header(default=None)
):
    if not store.delete_conversation(conversation_id, x_user_email):
        raise HTTPException(status_code=404, detail="Conversation not found")
    return {"deleted": conversation_id}


@app.post("/documents/ingest")
def documents_ingest(req: DocumentIngestRequest, x_user_email: UserEmail = Header(default=None)):
    """Index a document on its own, before any question is asked.

    The two-phase entry point behind /documents: attach or paste, index,
    *then* the conversation opens and questions get asked in the normal chat
    view -- as opposed to attaching one mid-chat, where indexing happens as a
    side effect of sending the first message (see _route_large_attachments
    below). Both land in the same place: rag.ingest, the same tables, the
    same search_document tool.
    """
    if not x_user_email:
        raise HTTPException(status_code=401, detail="Sign in to index a document.")

    # One document per account, for the lifetime of the account -- claimed
    # before any work is done so two simultaneous ingests cannot both get
    # through. Released again below if the indexing itself fails, so a rate
    # limit or an Atlas outage does not spend someone's only allowance.
    if not store.claim_rag_slot(x_user_email):
        raise HTTPException(
            status_code=409,
            detail=(
                "You have already used your one document. Inbuilt RAG is limited to a "
                "single indexed document per account, and deleting the conversation "
                "does not free it up."
            ),
        )

    conversation_id = store.create_conversation(req.name, x_user_email, kind="rag")
    if conversation_id is None:
        store.release_rag_slot(x_user_email)
        raise HTTPException(status_code=401, detail="Sign in to index a document.")

    try:
        result = rag.ingest(
            conversation_id,
            req.name,
            req.text,
            chunk_size=req.chunk_size,
            chunk_overlap=req.chunk_overlap,
            dimension=req.dimension,
        )
    except ValueError as exc:
        # An out-of-range "advanced setting" -- e.g. a dimension Voyage does
        # not support -- is the caller's mistake to fix, not a 502.
        store.release_rag_slot(x_user_email)
        store.delete_conversation(conversation_id, x_user_email)
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        store.release_rag_slot(x_user_email)
        store.delete_conversation(conversation_id, x_user_email)
        raise HTTPException(status_code=502, detail=rag.friendly_error(exc))

    # So the conversation is not simply empty the moment it opens -- this is
    # the first thing there is to see before any question has been asked.
    note = (
        f'Document "{result["name"]}" is indexed and ready ({result["chunks"]} '
        "chunks). Ask me anything about it."
    )
    store.append_message(conversation_id, "assistant", note)

    return {
        "conversation_id": conversation_id,
        "name": result["name"],
        "chunks": result["chunks"],
        "chunk_size": result["chunk_size"],
        "chunk_overlap": result["chunk_overlap"],
        "dimension": result["dimension"],
    }


# Matches one ===ATTACHMENT_START:name===...===ATTACHMENT_END=== block built by
# src/lib/attachments.ts's buildMessage -- see _route_large_attachments below.
_ATTACHMENT_BLOCK = re.compile(
    r"===ATTACHMENT_START:(.+?)===\n(.*?)\n===ATTACHMENT_END===", re.DOTALL
)
# Cheap presence check, so /chat can decide whether to show an "indexing your
# document" tool card before paying for the regex substitution + the ingest
# (embedding, storing, waiting for the index) it may trigger.
_HAS_LARGE_ATTACHMENT = re.compile(r"===ATTACHMENT_START:.+\(large\)===")


def _route_large_attachments(content: str, conversation_id: Optional[str]) -> str:
    """A "(large)" attachment (see attachments.ts's MAX_CHARS) is indexed for
    retrieval instead of pasted whole into the model's context.

    Guests keep the old behaviour -- inline, unindexed -- since there is no
    conversation id to scope chunks to, and nothing durable to index them
    into once the tab closes anyway.
    """

    def replace(match: "re.Match[str]") -> str:
        header, body = match.group(1), match.group(2)
        if not conversation_id or not header.rstrip().endswith("(large)"):
            return match.group(0)

        name = re.sub(r"\s*\(large\)$", "", header).strip()
        try:
            result = rag.ingest(conversation_id, name, body)
            note = (
                "[This document was indexed for search ({} chunks). Call "
                "search_document to read the relevant part before answering "
                "questions about it.]"
            ).format(result["chunks"])
        except Exception as exc:
            note = f"[Could not index this document: {rag.friendly_error(exc)}]"

        return f"===ATTACHMENT_START:{name} (indexed)===\n{note}\n===ATTACHMENT_END==="

    return _ATTACHMENT_BLOCK.sub(replace, content)


@app.post("/chat")
def chat(req: ChatRequest, x_user_email: UserEmail = Header(default=None)):
    history = [{"role": m.role, "content": m.content} for m in req.messages]

    # Signed in: start a conversation on the first turn, then keep appending to
    # it. Signed out: conversation_id stays None, so nothing below writes to the
    # database and the turn lives only in the browser tab that asked for it.
    conversation_id = req.conversation_id
    if conversation_id and store.get_conversation(conversation_id, x_user_email) is None:
        conversation_id = None
    if conversation_id is None:
        conversation_id = store.create_conversation(history[0]["content"], x_user_email)

    def events():
        # Tell the client which conversation this turn belongs to (null for guests).
        yield '{"type": "conversation", "id": %s}\n' % (
            '"%s"' % conversation_id if conversation_id else "null"
        )

        # Large attachments are indexed here, before either the model or the
        # database sees the raw text -- see rag.py. Wrapped in a synthetic
        # tool call/result pair so the UI shows an "indexing" card instead of
        # sitting on a blank screen: ingest plus the wait for the Atlas index
        # to catch up (rag._wait_until_searchable) can take several seconds,
        # and that would otherwise all happen before the first byte of this
        # response goes out.
        content = history[-1]["content"]
        if conversation_id and _HAS_LARGE_ATTACHMENT.search(content):
            yield '{"type": "tool_call", "name": "index_document", "args": "{}"}\n'
            content = _route_large_attachments(content, conversation_id)
            yield '{"type": "tool_result", "name": "index_document", "result": "{}"}\n'
        history[-1]["content"] = content

        store.append_message(conversation_id, "user", content)

        for chunk in stream_chat(history, conversation_id, req.voice):
            yield chunk

    return StreamingResponse(
        events(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache, no-transform"},
    )
