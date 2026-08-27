"""Document RAG: chunk, embed and retrieve.

A document attached past attachments.MAX_CHARS on the frontend is routed here
by main.py instead of being pasted whole into the model's context (see the
attachment-routing step in the /chat handler). It is:

  1. Split into overlapping chunks (langchain-text-splitters).
  2. Embedded with Voyage AI (voyage-4-lite -- see VOYAGE_MODEL below).
  3. Stored in MongoDB Atlas, one document per chunk, with the chunk's vector
     and the owning conversation_id.

Retrieval runs the same embedding on the user's question and asks Atlas
Vector Search for the nearest chunks, scoped to that conversation with a
$vectorSearch filter -- see search() below. The search_document tool in
tools.py is the only caller; the model decides when a lookup is worth it.

Chunk size, chunk overlap and embedding dimension all have defaults but are
overridable per document -- the "advanced settings" card behind /documents,
threaded through from main.py's DocumentIngestRequest. Dimension is the one
that needs care: Atlas Vector Search fixes numDimensions at index creation,
so each dimension in use gets its own index (see index_name_for / VALID_
DIMENSIONS), and search() looks up which one a conversation's chunks were
written at rather than assuming the default.

There is deliberately no in-memory fallback the way store.py has for
conversations: Atlas Vector Search is the only place this can run at all, so
a database that is unreachable is a real outage here, not a soft-fail --
see register/route.ts's own reasoning for the same call on accounts.
"""

import os
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from contextvars import ContextVar

# pyrefly: ignore [missing-import]
from dotenv import load_dotenv

env_path = Path(__file__).resolve().parent.parent / ".env.local"
load_dotenv(env_path)

VOYAGE_API_KEY = os.environ.get("VOYAGE_API_KEY", "").strip()
# Cheapest current Voyage model, 200M free tokens on signup -- see the
# conversation that picked this over voyage-4/voyage-4-large/multilingual-2.
VOYAGE_MODEL = os.environ.get("VOYAGE_MODEL", "voyage-4-lite").strip()

COLLECTION = "document_chunks"

# What Voyage's embed() actually accepts for output_dimension -- passing
# anything else 400s the request. Exposed as the "advanced" vector-dimension
# choice on /documents; DEFAULT_DIMENSION is what "use default settings" ends
# up calling ingest() with.
VALID_DIMENSIONS = [256, 512, 1024, 2048]
DEFAULT_DIMENSION = 1024

# ~700 tokens per chunk (roughly 4 chars/token) with a 100-token overlap, so a
# sentence that got split at a chunk boundary is still whole in its neighbour.
# The "advanced" chunk-size/overlap fields on /documents override these; kept
# to sane bounds by _clamp_chunking below rather than trusted outright, since
# they come from a request body.
DEFAULT_CHUNK_CHARS = 2800
DEFAULT_CHUNK_OVERLAP_CHARS = 400
MIN_CHUNK_CHARS = 200
MAX_CHUNK_CHARS = 8000

# ---------------------------------------------------------------------------
# Voyage's free tier (no payment method on file): 3 requests AND 10,000 tokens
# per minute. The token half is the one that bites. An ordinary PDF chapter is
# ~13,000 tokens, so embedding a document's chunks in a single call is over the
# whole minute's budget by itself -- it fails immediately and keeps failing no
# matter how long you wait, because waiting never makes one oversized request
# fit. embed() therefore splits into token-sized batches and paces them through
# _Throttle below, rather than handing Voyage the whole list at once.
# ---------------------------------------------------------------------------
REQUESTS_PER_MINUTE = 3
# Well under the documented 10,000, and deliberately. Measured against the real
# API, a batch counted locally at 7,389 tokens was accepted on a clean window
# and one at 8,463 was rejected -- so Voyage's server-side count runs above what
# count_tokens reports here, and the documented ceiling is not a number to aim
# at. Being conservative costs one extra batch, i.e. one more minute on a long
# document; being optimistic costs the whole ingest.
TOKEN_BUDGET_PER_MINUTE = 6_000
RATE_WINDOW_SECONDS = 60.0
# Used only to guess a duration and to fall back on if the local tokenizer is
# unavailable. Voyage's own tokenizer is what the batching actually counts with.
CHARS_PER_TOKEN = 4

# The conversation the current turn belongs to. search_document reads this
# rather than taking a conversation_id argument, because the model never sees
# or supplies one -- tool arguments come straight from its own JSON, and it
# has no reason to know which conversation it is in. See tools.run_tool,
# which calls every tool as fn(**args) with nothing else injected.
#
# agent.stream_chat sets this immediately before every run_tool call, not
# just once at the top of the function: Starlette iterates a plain generator
# via anyio's threadpool, and a resumption after a `yield` can land on a
# different worker thread whose copy of the context never saw an earlier
# .set() -- silently making this read back as None. Setting it again right
# next to the read, with no yield in between, is what actually makes it
# reliable.
CURRENT_CONVERSATION: ContextVar[Optional[str]] = ContextVar("rag_conversation_id", default=None)

_lock = threading.Lock()
_client = None
# Dimensions whose Atlas index is confirmed to exist -- see _ensure_index.
# A set, not a bool, because each dimension a user picks under "advanced
# settings" gets its own index (see the module docstring's note on why
# vectors of different lengths cannot share one).
_indexed_dimensions: set = set()


class RagUnavailable(Exception):
    """Raised when there is no way to embed or store a document right now."""


def friendly_error(exc: Exception) -> str:
    """A message worth showing someone, not Voyage's own.

    Voyage's RateLimitError text is long, quotes a dashboard URL and a
    pricing docs link -- accurate, but written for a developer reading logs,
    not for a chat bubble or an error toast. Everything else passes through
    unchanged (str(exc), falling back to the exception's type name if it has
    no message of its own).
    """
    # pyrefly: ignore [missing-import]
    from voyageai.error import RateLimitError

    if isinstance(exc, RateLimitError):
        return (
            "Voyage's free tier is rate limited to 10,000 tokens a minute and "
            "this document is still going over it. Wait a minute, then try "
            "again -- or index it in smaller pieces."
        )
    return str(exc) or type(exc).__name__


def index_name_for(dimension: int) -> str:
    return f"document_chunks_vector_index_{dimension}"


def clamp_chunking(chunk_size: Optional[int], chunk_overlap: Optional[int]) -> Tuple[int, int]:
    """Apply defaults and sane bounds to request-supplied chunk settings.

    Both come from a JSON body (the "advanced settings" card on /documents),
    so this is the one place that stands between a stray value -- overlap
    bigger than the chunk itself, a chunk size that would make thousands of
    tiny embeddings -- and langchain's splitter, which does not validate
    either.
    """
    size = DEFAULT_CHUNK_CHARS if chunk_size is None else chunk_size
    size = max(MIN_CHUNK_CHARS, min(MAX_CHUNK_CHARS, int(size)))

    overlap = DEFAULT_CHUNK_OVERLAP_CHARS if chunk_overlap is None else chunk_overlap
    # Half the chunk, not the whole thing -- an overlap equal to the chunk
    # size would repeat every chunk's entire content in its neighbour.
    overlap = max(0, min(size // 2, int(overlap)))

    return size, overlap


def clamp_dimension(dimension: Optional[int]) -> int:
    if dimension is None:
        return DEFAULT_DIMENSION
    if dimension not in VALID_DIMENSIONS:
        raise ValueError(
            f"{dimension} is not a vector dimension Voyage supports -- use one of {VALID_DIMENSIONS}."
        )
    return dimension


def _voyage_client():
    global _client
    if _client is None:
        if not VOYAGE_API_KEY:
            raise RagUnavailable("VOYAGE_API_KEY is not set.")
        # pyrefly: ignore [missing-import]
        import voyageai

        _client = voyageai.Client(api_key=VOYAGE_API_KEY)
    return _client


def chunk_text(text: str, chunk_size: int = DEFAULT_CHUNK_CHARS, chunk_overlap: int = DEFAULT_CHUNK_OVERLAP_CHARS) -> List[str]:
    # pyrefly: ignore [missing-import]
    from langchain_text_splitters import RecursiveCharacterTextSplitter

    splitter = RecursiveCharacterTextSplitter(
        chunk_size=chunk_size,
        chunk_overlap=chunk_overlap,
        separators=["\n\n", "\n", ". ", " ", ""],
    )
    pieces = splitter.split_text(text)
    return [p.strip() for p in pieces if p.strip()]


class _Throttle:
    """A rolling-window limiter over both of Voyage's free-tier ceilings.

    Keeps the (timestamp, tokens) of every request made in the last minute and
    blocks a new one until it fits under both REQUESTS_PER_MINUTE and
    TOKEN_BUDGET_PER_MINUTE. Sleeping here is the point, not a fallback: a
    document larger than one minute's token budget can only be embedded by
    spreading it across several minutes, so the alternative to waiting is
    failing.
    """

    def __init__(self) -> None:
        self._calls: List[Tuple[float, int]] = []
        self._guard = threading.Lock()

    def reserve(self, tokens: int) -> None:
        while True:
            with self._guard:
                now = time.monotonic()
                self._calls = [c for c in self._calls if now - c[0] < RATE_WINDOW_SECONDS]
                spent = sum(n for _, n in self._calls)
                fits = (
                    len(self._calls) < REQUESTS_PER_MINUTE
                    and spent + tokens <= TOKEN_BUDGET_PER_MINUTE
                )
                # A single batch over the whole budget can never fit, so let it
                # through alone rather than spinning here forever. Batching
                # keeps this from happening; Voyage rejecting it is still a
                # better outcome than a request that never returns.
                if fits or not self._calls:
                    self._calls.append((now, tokens))
                    return
                oldest = min(t for t, _ in self._calls)
                delay = RATE_WINDOW_SECONDS - (now - oldest) + 0.5
            time.sleep(max(delay, 0.5))


_throttle = _Throttle()


def _count_tokens(client, texts: List[str]) -> int:
    """Voyage's own token count for `texts`, or a character-based estimate.

    count_tokens runs the model's tokenizer locally (it downloads it from the
    HF hub once and caches it), so this costs no request against the rate
    limit -- but it does need that download to have happened, hence the
    fallback rather than letting an offline first run break indexing.
    """
    try:
        return int(client.count_tokens(texts, model=VOYAGE_MODEL))
    except Exception:
        return sum(len(t) for t in texts) // CHARS_PER_TOKEN + 1


def _batch_by_tokens(client, texts: List[str]) -> List[List[str]]:
    """Group `texts` into runs that each stay inside one minute's token budget.

    Greedy rather than balanced on purpose: fewer, fuller batches means fewer
    minute-long waits between them, and the last batch being short costs
    nothing.
    """
    batches: List[List[str]] = []
    current: List[str] = []
    current_tokens = 0

    for text in texts:
        tokens = _count_tokens(client, [text])
        if current and current_tokens + tokens > TOKEN_BUDGET_PER_MINUTE:
            batches.append(current)
            current, current_tokens = [], 0
        current.append(text)
        current_tokens += tokens

    if current:
        batches.append(current)
    return batches


def estimate_seconds(text: str) -> int:
    """Roughly how long embedding `text` will take under the free tier.

    Everything past the first minute's worth of tokens has to wait out a
    window, so this is really "how many rate-limit windows does this need" --
    used to warn someone before they start, not to schedule anything.
    """
    tokens = len(text) // CHARS_PER_TOKEN + 1
    windows = max(0, -(-tokens // TOKEN_BUDGET_PER_MINUTE) - 1)
    return int(windows * RATE_WINDOW_SECONDS + 15)


def embed(texts: List[str], input_type: str, dimension: int = DEFAULT_DIMENSION) -> List[List[float]]:
    """input_type is "document" for chunks going into the index, "query" for a
    search -- Voyage tunes the embedding differently for each, and mixing them
    up quietly makes retrieval worse rather than raising an error.

    Sent in rate-limit-sized batches (see _batch_by_tokens / _Throttle), so a
    document worth more than one minute of free-tier tokens takes minutes
    rather than failing. A query, being one short string, is always a single
    batch and only ever waits if an ingest is in flight beside it.
    """
    client = _voyage_client()
    batches = _batch_by_tokens(client, texts)

    vectors: List[List[float]] = []
    for i, batch in enumerate(batches):
        _throttle.reserve(_count_tokens(client, batch))
        if len(batches) > 1:
            print(f"[RAG] embedding batch {i + 1}/{len(batches)} ({len(batch)} chunks)")
        result = client.embed(
            batch,
            model=VOYAGE_MODEL,
            input_type=input_type,
            output_dimension=dimension,
        )
        vectors.extend(result.embeddings)
    return vectors


def _db():
    # store's own connection is the single source of truth for how to reach
    # Atlas; this just borrows it rather than opening a second client.
    import store

    db = store.get_db_or_none()
    if db is None:
        raise RagUnavailable(
            "The database is unreachable, so there is nowhere to index this "
            "document. Storage error: {}".format(store.status().get("error"))
        )
    return db


def _ensure_index(db, dimension: int) -> None:
    """Create the Atlas Vector Search index for this dimension, lazily, on
    first ingest at that dimension.

    One index per dimension, not one shared index: Atlas Vector Search
    declares numDimensions once at index creation, and a chunk whose vector
    is a different length either fails to index or never matches a query --
    so voyage-4-lite at the default 1024 and someone's "advanced settings"
    512 cannot share a name.

    Index builds are asynchronous on Atlas' side -- this does not wait for it
    to finish, so a search run in the first minute or so after the very first
    document indexed at a given dimension may come back empty rather than
    error. It self-heals once the build completes; nothing here needs to
    poll for it (ingest's own wait, below, is a separate, shorter concern:
    whether *this* insert has propagated, not whether the index exists yet).
    """
    if dimension in _indexed_dimensions:
        return

    name = index_name_for(dimension)
    collection = db[COLLECTION]
    try:
        existing = {idx.get("name") for idx in collection.list_search_indexes()}
        if name not in existing:
            # pyrefly: ignore [missing-import]
            from pymongo.operations import SearchIndexModel

            collection.create_search_index(
                model=SearchIndexModel(
                    definition={
                        "fields": [
                            {
                                "type": "vector",
                                "path": "embedding",
                                "numDimensions": dimension,
                                "similarity": "cosine",
                            },
                            {"type": "filter", "path": "conversation_id"},
                        ]
                    },
                    name=name,
                    type="vectorSearch",
                )
            )
            print(f"[RAG] Creating Atlas Vector Search index '{name}' (builds in the background)")
        _indexed_dimensions.add(dimension)
    except Exception as err:
        # Index management needs a plan that supports it (M10+ historically,
        # though current Atlas allows it on shared tiers too) -- surfacing
        # this once in the log beats a silent, permanently empty index.
        print(f"[RAG] Vector index warning: {err}")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def ingest(
    conversation_id: str,
    name: str,
    text: str,
    chunk_size: Optional[int] = None,
    chunk_overlap: Optional[int] = None,
    dimension: Optional[int] = None,
) -> Dict[str, Any]:
    """Chunk, embed and store one document. Returns {"name", "chunks"}.

    chunk_size, chunk_overlap and dimension are the "advanced settings" on
    /documents -- None (the "use default settings" case) picks the ordinary
    defaults; anything else is clamped to sane bounds by clamp_chunking /
    clamp_dimension rather than trusted outright, since a request body set
    them.
    """
    text = str(text or "").strip()
    if not text:
        raise ValueError("Nothing to index -- the document was empty.")

    chunk_size, chunk_overlap = clamp_chunking(chunk_size, chunk_overlap)
    dimension = clamp_dimension(dimension)

    chunks = chunk_text(text, chunk_size=chunk_size, chunk_overlap=chunk_overlap)
    if not chunks:
        raise ValueError("Could not split this document into any chunks.")

    vectors = embed(chunks, input_type="document", dimension=dimension)

    db = _db()
    now = _now()
    docs = [
        {
            "id": uuid.uuid4().hex[:16],
            "conversation_id": conversation_id,
            "name": name,
            "chunk_index": i,
            "text": chunk,
            "embedding": vector,
            "dimension": dimension,
            "created_at": now,
        }
        for i, (chunk, vector) in enumerate(zip(chunks, vectors))
    ]
    # Index creation needs the collection to already exist -- Atlas errors on
    # a namespace it has never seen a document for -- so this runs after the
    # insert, not before it.
    db[COLLECTION].insert_many(docs)
    _ensure_index(db, dimension)
    _wait_until_searchable(db, conversation_id, {d["id"] for d in docs}, vectors[0], dimension)

    return {
        "name": name,
        "chunks": len(docs),
        "chunk_size": chunk_size,
        "chunk_overlap": chunk_overlap,
        "dimension": dimension,
    }


def _wait_until_searchable(
    db,
    conversation_id: str,
    new_ids: set,
    probe_vector: List[float],
    dimension: int,
    timeout: float = 20.0,
) -> None:
    """Block briefly until every chunk just inserted is actually findable.

    Atlas Vector Search indexes update asynchronously, and not all at once: a
    batch insert can show up in $vectorSearch a few chunks at a time rather
    than atomically, so checking only the first chunk (this used to) can pass
    while the chunk that actually answers the user's question is still
    invisible. This instead searches broadly enough to plausibly surface the
    whole batch (see numCandidates below) and waits for every id from this
    insert to appear in the results, not just one.

    Without this, the very first question about a document attached moments
    ago could come back from search_document with zero, or incomplete,
    results -- in the same turn the agent is told to call it in and cannot
    retry (search_document is capped once per turn).

    Polls with one chunk's own embedding -- guaranteed a near match for any
    semantically related chunk in a small, single-document candidate pool --
    rather than a second Voyage call, since the free tier's rate limit (3
    requests/minute without a payment method on file) has no room to spare.
    Gives up silently on timeout: search_document then reports whatever
    fraction is visible, or zero, like any other search.
    """
    deadline = time.monotonic() + timeout
    # Generous relative to a single document's chunk count so an ANN search
    # over this conversation's small candidate pool surfaces the whole batch,
    # not just the chunks nearest the probe vector.
    candidates = max(200, len(new_ids) * 20)
    pipeline = [
        {
            "$vectorSearch": {
                "index": index_name_for(dimension),
                "path": "embedding",
                "queryVector": probe_vector,
                "numCandidates": candidates,
                "limit": candidates,
                "filter": {"conversation_id": conversation_id},
            }
        },
        {"$project": {"_id": 0, "id": 1}},
    ]
    while time.monotonic() < deadline:
        try:
            found = {d["id"] for d in db[COLLECTION].aggregate(pipeline)}
            if new_ids <= found:
                return
        except Exception:
            pass  # the index may not exist yet on the very first document ever
        time.sleep(0.5)


# Cast a slightly wider net than the final answer needs, per Atlas' own
# guidance that numCandidates should be well above limit for ANN recall.
NUM_CANDIDATES = 100


def search(query: str, top_k: int = 5) -> List[Dict[str, Any]]:
    """The most relevant chunks for `query`, scoped to the current turn's
    conversation (see CURRENT_CONVERSATION). Empty list if nothing is indexed
    yet, the query is empty, or the vector index is still building."""
    conversation_id = CURRENT_CONVERSATION.get()
    query = str(query or "").strip()
    if not conversation_id or not query:
        return []

    db = _db()

    # Which index to query, and at what width to embed the question -- set by
    # whatever dimension this conversation's document was ingested at (see
    # ingest's "advanced settings"), not a fixed constant. One find_one, not
    # a second Voyage call: cheap next to the embed below, and the free
    # tier's rate limit (3 requests/minute without a payment method) has no
    # spare room for it.
    sample = db[COLLECTION].find_one({"conversation_id": conversation_id}, {"dimension": 1})
    if sample is None:
        return []  # nothing indexed for this conversation yet
    dimension = sample.get("dimension", DEFAULT_DIMENSION)

    [vector] = embed([query], input_type="query", dimension=dimension)

    pipeline = [
        {
            "$vectorSearch": {
                "index": index_name_for(dimension),
                "path": "embedding",
                "queryVector": vector,
                "numCandidates": NUM_CANDIDATES,
                "limit": top_k,
                "filter": {"conversation_id": conversation_id},
            }
        },
        {
            "$project": {
                "_id": 0,
                "name": 1,
                "text": 1,
                "chunk_index": 1,
                "score": {"$meta": "vectorSearchScore"},
            }
        },
    ]

    try:
        return list(db[COLLECTION].aggregate(pipeline))
    except Exception as err:
        print(f"[RAG] search error: {err}")
        return []
