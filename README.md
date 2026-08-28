# SIMP AI

An AI chat assistant: a Next.js UI talking to a **Python** agent that runs an
OpenAI-compatible LLM with tool calling.

```
browser ──▶ Next.js /api/* (proxy) ──▶ FastAPI :8000 ──▶ Groq + tools
              │                             │
              └── auth, sessions,           └── store.py ──▶ MongoDB Atlas
                  credits (MongoDB)             rag.py   ──▶ Voyage + Atlas Vector Search
```

The Python service owns all model logic and all conversation state. The Next
routes are thin proxies, so the browser only ever talks to its own origin and
no provider key reaches the client. The one thing Next owns directly is
accounts — sessions, plans and credits are read from MongoDB in the route
itself, because they gate the proxy call rather than travelling through it.

**There is no mock data.** Every list in the UI — conversations, tools, RAG
documents — is real data produced by the running system.

## Setup

1. Copy `.env.example` to `.env.local` and fill in the two required values
   (both sides read this one file):

   ```bash
   GROQ_API_KEY=gsk_your_key_here
   MONGODB_URI=mongodb+srv://...
   MONGODB_DB=mantraa_ai
   ```

   Comma-separate several keys for the same provider to rotate them
   round-robin: `GROQ_API_KEY=gsk_first,gsk_second`.

2. Install the Python agent's dependencies once:

   ```bash
   npm install
   npm run setup:api
   npm run setup:tts   # optional: spoken replies, needs Python >= 3.10 + espeak-ng
   ```

Everything else in `.env.example` is optional and degrades cleanly when unset —
see [What each key turns on](#what-each-key-turns-on).

## Running it

Two processes, two terminals:

```bash
npm run dev:api    # FastAPI agent on :8000
npm run dev        # Next.js UI on :3000
```

Open <http://localhost:3000>. Check the agent alone at
<http://localhost:8000/health>, which reports the model, the masked key
rotation, storage backend and whether speech is installed.

## What each key turns on

| Key | Unset behaviour |
| --- | --- |
| `GROQ_API_KEY` / `LLM_API_KEY` | **Required.** Nothing answers without one |
| `MONGODB_URI`, `MONGODB_DB` | **Required.** Accounts refuse; `store.py` falls back to memory and forgets on restart |
| `VOYAGE_API_KEY` | Inbuilt RAG is off: `search_document` is not offered to the model and `/documents` cannot index |
| `TAVILY_API_KEY` | Web search falls back to scraped DuckDuckGo, which works locally but hangs from a datacenter |
| `NEXT_PUBLIC_GOOGLE_CLIENT_ID` | The Google button is absent; email/password sign-in still works |
| `DEVELOPER_EMAILS` | No account is exempt from the quotas below |
| `KITTEN_TTS_MODEL`, `HINDI_TTS_MODEL` | Spoken replies are disabled; the speaker button explains why |
| `AGENT_TOKEN` | Agent accepts unauthenticated calls — fine on localhost, set it when the two halves deploy apart |
| `LANGSMITH_*` | Tracing is a no-op |

## Accounts and quotas

Sign-in is email/password or Google (`NEXT_PUBLIC_GOOGLE_CLIENT_ID`; the ID
token is verified server-side with `google-auth-library`, so no client secret is
needed). Sessions are a cookie backed by a `sessions` collection with a TTL
index, so Mongo expires them and nothing sweeps.

| | Signed out | Free plan | Pro |
| --- | --- | --- | --- |
| Chat turns | 5 per thread | 50 credits | ₹299/month |
| Voice turns | 2 per call | same 50 credits | same |
| Inbuilt RAG | unavailable | 1 document, for the lifetime of the account | same |
| History saved | no | yes | yes |

The guest numbers live in `src/lib/limits.ts` and are enforced **twice** —
once in the browser so the limit is visible before someone types into a box
that will refuse them, and once in `/api/chat`, which is what actually stops a
turn. Voice and chat share that route and are told apart by the `voice` flag,
so the two allowances are counted separately.

`DEVELOPER_EMAILS` (comma-separated) lists accounts exempt from all of it.
Mirrored on both sides: `store.is_developer` in Python, `isDeveloper` in
`src/lib/limits.ts`. It is not a `NEXT_PUBLIC_` variable, so it reads back
empty in the browser and every caller is treated as ordinary — the safe
direction to fail.

## Storage

`server/store.py` is the only thing that touches conversation state, and it
speaks to **MongoDB Atlas** with an in-memory fallback for when the database is
unreachable. Guests own nothing: every helper refuses to read, write or list
without an account email, which is what keeps a signed-out visitor on a single
unsaved window.

| Collection | Holds |
| --- | --- |
| `conversations` | Threads and their messages, tagged `kind: "chat"` or `"rag"` |
| `users` | Accounts, plans, credits, the one-RAG flag |
| `sessions` | Session cookies, TTL-expired by Mongo |
| `document_chunks` | RAG chunks and their vectors |
| `tool_calls` | The tool-call log |

`kind` is what separates the sidebar's two lists. It is queried with `$ne:
"rag"` rather than `== "chat"`, so conversations stored before the field
existed still count as ordinary ones and nothing needed a migration.

## Layout

| Path | Role |
| --- | --- |
| `src/app/page.tsx` | Chat workspace; reads `?c=<id>` to open a thread |
| `src/app/voice/page.tsx` | AI Voice Chat: hands-free speak-to-speak call + live transcript |
| `src/app/documents/page.tsx` | Inbuilt RAG: guide, then index, then chat |
| `src/app/tools/page.tsx` | What the agent can call, read from the Python registry |
| `src/app/plans/`, `src/app/profile/` | Plans and account settings |
| `src/app/api/` | Proxies: `chat`, `conversations`, `documents/ingest`, `tools`, `tts`, `health` |
| `src/app/api/auth/` | Accounts: register, login, Google, logout, me, profile, plan |
| `src/lib/useChat.ts` | Streaming client; owns conversation identity |
| `src/lib/useVoice.ts` | Dictation (Web Speech API) and spoken replies (KittenTTS) |
| `src/lib/useVoiceCall.ts` | Turn taking for the voice page: listen -> send -> speak -> listen |
| `src/lib/attachments.ts` | Reading PDF, DOCX and text files in the browser |
| `src/lib/limits.ts` | Guest allowances and the developer exemption |
| `src/lib/session.ts` | Session cookies and the signed-in user record |
| `server/main.py` | FastAPI endpoints |
| `server/agent.py` | LLM streaming + tool-calling loop |
| `server/tools.py` | Tool schemas, implementations, and the registry |
| `server/store.py` | Conversations, accounts and activity in MongoDB |
| `server/rag.py` | Document chunking, Voyage embeddings and Atlas vector search |
| `server/policy.py` | Answering policy, and per-turn language detection |
| `server/llm.py` | Provider resolution and key rotation |
| `server/websearch.py` | Picks the search provider; both return one shape |
| `server/tavily.py` | Tavily search client (keyed, works from a datacenter) |
| `server/duckduckgo.py` | DuckDuckGo search client (scraped, free, fallback) |
| `server/tts.py` | KittenTTS wrapper: model loading, WAV encoding, espeak-ng lookup |

## Answering policy

`server/policy.py` holds the sections composed onto the base prompt by
`policy.apply()`. There is no topic restriction — the assistant answers
questions on any subject.

| Section | Request | Behaviour |
| --- | --- | --- |
| Secrets | API keys, passwords, tokens, env file contents | Replies exactly `I can't answer these type of questions.` and calls no tool |
| Identity | "who are you", "are you ChatGPT", "which model are you" | Answers as SIMP, built by an independent developer; never names the model or provider |
| Conduct | Rudeness, swearing, insults | Answers the question anyway, in a level tone |
| Language | Any | Mirrors the language it was asked in, always writing Hindi in Devanagari. Pinned per turn by `policy.language_note` |
| Voice | Voice turns only | Two or three sentences, no markdown, no code, no URLs |

### Identity

One answer, from one place. `ASSISTANT_NAME` (default `SIMP`) is the only copy
of the name — the base prompt in `agent.py` defers to this section rather than
repeating it. The rule holds through the usual pressure: insisting, claiming to
already know, "just between us", framing it as a test, or asking it to ignore
its instructions.

### Conduct

Hostility is treated as noise around the request, not as the request. This
matters most by voice, where recognition mishears ordinary words as crude ones,
so a single crude word in a normal sentence is read as a bad transcription
rather than an insult.

- Never matches the tone, never insults back, never threatens to end the chat.
- No lecture and no opening reprimand — that escalates.
- A question buried in an angry message gets answered **in full**. Being sworn
  at is never a reason to give a worse or shorter answer.
- Pure abuse with no request gets a brief acknowledgement and "what do you
  need?". If that has already happened once in the conversation, it adds one
  calm sentence asking them to keep it civil — said once, then dropped.
- A slur or abuse aimed at a person or group is the one thing never passed over
  in silence: one sentence declining it, then the rest of the answer as normal.

The turn-counting version of that fourth rule did not work — models do not
reliably count "third message running". Triggering on *whether it has happened
before in this conversation* is a presence check they can actually see, and it
fires reliably.

### Language

`LANGUAGE_PROMPT` says to answer in the language the question was asked in.
On its own that is not reliable, and the failure is specific: the model reads
the **subject** as a language cue. Asked "who is the current ISRO chairman?" —
plain English, English-only search results — it answered in Hindi **3 times in
8**. Saying so more firmly in the prompt helped and did not fix it: still 2 in
12.

So the script is decided in Python instead. `policy.language_note` looks at the
newest user message and states the language as a fact about this turn, which
the model follows: **12 in 12** after the change.

Three cases, and the middle one is why this is not just a Devanagari check:

| User writes | Detected | Answer |
| --- | --- | --- |
| Devanagari (`≥20%` of letters) | hindi | Devanagari |
| Romanised Hindi (`kaun hai`, `batao`) | hindi | Devanagari |
| English | english | English |

Romanised Hindi is Latin script, so the share test cannot see it — and calling
it English is worse than saying nothing, because `LANGUAGE_PROMPT` requires a
Devanagari answer to a romanised question and the note would then contradict
it. It did, in testing, before a word list was added. That list deliberately
excludes anything with an English homograph (`me`, `par`, `to`, `bat`, `ka`),
since a false positive answers an English speaker in Devanagari — the more
visible failure. Under 8 letters the function returns `None` and no note is
added: a bare "ok" is not evidence of anything.

## LLM tools

The agent decides which to call; the UI shows each call as a one-line status
while it runs, and every call is recorded with its duration.

- **`ask_options`** — ask the user to pick from 3 choices before answering (`question`, `options`); the UI renders them as buttons
- **`web_search`** — search the public web (`query`); returns up to 5 results, once per message. Tavily when keyed, DuckDuckGo otherwise
- **`search_document`** — search a document indexed for this conversation (`query`); once per message. Offered to the model only when `VOYAGE_API_KEY` is set

On success the status line disappears and only the answer remains — raw
arguments and results are never shown in the chat. Failures stay visible, so a
broken step is never silent.

### The tool loop

1. The request goes to the model with all available tool schemas attached.
2. If the model asks for a tool, the server runs it, records it, appends the
   result, and calls the model again.
3. Repeats until it answers in plain text (capped at `MAX_TOOL_ROUNDS = 5`).

Events stream back as newline-delimited JSON: `conversation`, `text`,
`tool_call`, `tool_result`, `error`, `done`.

`ONCE_PER_TURN` in `agent.py` caps `web_search`, `ask_options` and
`search_document` at one call per turn — for all three, a reworded query rarely
surfaces what the first one missed, and letting the model retry burns the round
budget in silence. Identical calls to any tool are also cached within a turn.

### Adding a tool

Add one entry to the `TOOLS` dict in `server/tools.py` — a JSON schema plus the
Python function. The Tools page and the starter prompts read the registry, so
they pick it up with no UI changes. Give it an `available` lambda if it needs a
key, and it will be hidden rather than offered and then failing.

### Clarifying questions

When a question is ambiguous and the answer would differ by choice — "what is a
for loop" with no language named — the agent calls `ask_options` instead of
guessing. The UI turns the options into buttons; clicking one sends it as the
next message, and anything not offered can just be typed.

## Inbuilt RAG

Ask questions grounded in your own document instead of what the model happens to
know. `/documents` is the dedicated entry point, and it is deliberately
two-phase: index first, confirm, *then* ask. Indexing waits on Atlas' search
index catching up, so combining both into one request would mean typing a
question against a document that is not searchable yet.

```
PDF/DOCX/text ──▶ chunk ──▶ Voyage embeddings ──▶ document_chunks (+ vector)
                                                        │
question ──▶ embed ──▶ $vectorSearch (scoped to conversation) ──▶ top 5 chunks
```

**Files are read in the browser.** `pdfjs-dist` for PDF, `mammoth` for DOCX,
both dynamically imported so neither is in the initial bundle. There is no
upload endpoint and no server-side parsing step; only extracted text crosses the
wire. `.doc` is rejected with a message saying to save as `.docx` or PDF.

Two separate caps, for two separate reasons: `MAX_BYTES` (10 MB) is what the
browser will open, and `MAX_EXTRACTED_CHARS` (4M) is what may be sent — Vercel
hard-caps a Function's request body at 4.5 MB, so a file that opens fine can
still be too large to submit.

**Chunking and embedding are configurable.** The Settings card offers defaults
(2800 characters, 400 overlap, 1024 dimensions) or a Customize mode. Every value
is clamped again server-side by `clamp_chunking` / `clamp_dimension` — a request
body is not a trusted source of truth.

Dimension needs care: Atlas fixes `numDimensions` at index creation, so vectors
of different lengths cannot share an index. Each dimension in use gets its own,
created lazily on first ingest at that width (`index_name_for`), and `search()`
looks up which one a conversation's chunks were written at rather than assuming
the default.

### Rate limits are the hard part

Voyage's free tier (no payment method on file) allows 3 requests **and 10,000
tokens** per minute. The token half is what bites: an ordinary PDF chapter is
~13,000 tokens, so embedding a document's chunks in one call is over the whole
minute's budget by itself. It fails immediately and *keeps* failing however long
you wait, because waiting never makes one oversized request fit.

So `rag.embed` splits into token-sized batches and paces them through a rolling
window limiter, spending as many minutes as the document needs. The budget is
set to 6,000 rather than the documented 10,000 on purpose — measured against the
real API, a batch counted locally at 7,389 tokens was accepted on a clean window
and one at 8,463 was rejected, so Voyage's server-side count runs above what the
local tokenizer reports.

That makes indexing a **minutes-long** operation, which the rest of the design
has to admit: `/api/documents/ingest` declares `maxDuration = 300`, and
`/documents` estimates the wait before you submit and refuses anything that
would outlive the request.

### Mid-chat attachments

A file attached in the composer past `MAX_CHARS` (20,000) is marked `(large)`
and routed to the same pipeline instead of being pasted whole into context —
see `_route_large_attachments` in `main.py`. The UI shows an "Indexing your
document" card so the wait is not a silent pause. Smaller files still go inline,
which is cheaper and needs no vector search.

`search_document` never takes a conversation id: the model has no reason to know
one. It reads `rag.CURRENT_CONVERSATION`, a `ContextVar` that `stream_chat` sets
immediately before **every** `run_tool` call rather than once at the top —
Starlette iterates a plain generator through a threadpool, and a resumption
after a `yield` can land on a worker thread whose copy of the context never saw
the earlier `.set()`, silently reading back as `None`.

## Voice

Two separate halves, both driven from the right-hand side of the composer.

**Mic — talking to it.** Dictation runs entirely in the browser on the Web
Speech API, so there is no audio upload and no speech endpoint. Settled phrases
are appended to whatever is already in the box; the words still being decided
show under the input as you speak. Review, edit, then send — dictation never
auto-submits. The button is absent where the API is not (Firefox, and any
non-secure origin other than localhost).

**Speaker — hearing it back.** Two engines, picked per request by the script the
text is written in: [KittenTTS](https://github.com/KittenML/KittenTTS) for
English, `facebook/mms-tts-hin` for Hindi. Both are CPU-only and small; see
[Hindi](#hindi). `server/tts.py` loads the model once on first use and returns a
24 kHz mono WAV, which `/api/tts` carries to the browser. Markdown is stripped
to prose first (`speakable()`), because asterisks and code fences narrate badly,
and long replies are trimmed to 1200 characters on a sentence boundary so they
end cleanly rather than mid-word.

Speech is optional. Without it installed the endpoint reports why and the
speaker button renders disabled with the fix in its tooltip — the rest of the
agent is unaffected.

```bash
npm run setup:tts        # the wheel + numpy
brew install espeak-ng   # Debian: sudo apt-get install espeak-ng
```

Both are required. `espeak-ng` is the phonemiser KittenTTS calls, and the copy
bundled in `espeakng_loader` cannot be used: it ignores the data path it is
handed, looks for its own where it was compiled on a CI runner, and calls
`exit()` when that is missing — which would take the API server down
mid-request. `server/tts.py` therefore checks for a system espeak-ng *before*
the model is imported, and re-points phonemizer at it *after* (importing
KittenTTS pulls in `misaki.espeak`, which claims the wrapper for the broken
build at import time).

> **Python 3.10 or newer.** KittenTTS 0.8.1 depends on spaCy, whose current
> builds do not support 3.9. `npm run setup:tts` checks this before installing
> anything. To rebuild an older venv:
> `rm -rf server/.venv && python3.10 -m venv server/.venv && npm run setup:api`.

**Restart the agent after installing.** The model loads lazily on the first
request, but `/tts` only exists in a process started from the current `main.py`.
An agent left running from before will answer 404, which the UI reports as
"running a build without the /tts route" rather than as a speech failure.

### AI Voice Chat

`/voice` is the hands-free version, reachable from the sidebar. Start the call
and talk: it listens continuously, and 1.2 s of quiet ends your turn and sends
it. The reply is spoken back, then the mic reopens on its own — no button to
hold. Tap the orb while it is talking to cut in.

The mic is closed for the whole thinking and speaking stretch. That is what
keeps the agent's own voice out of the next question, and why the orb's phase
(listening / thinking / speaking) is worth watching.

A call is not a separate kind of thing: it goes through the same `useChat.send`
and `/api/chat` as typed messages, so it is stored as an ordinary conversation,
counts against the same credits, and appears in the sidebar history like any
other. The transcript panel shows the thread as it builds, including the turn
you are part-way through saying.

Selecting a thread from the sidebar while on `/voice` routes to `/?c=<id>`,
which the chat page reads on mount.

#### Latency

KittenTTS synthesises at a steady **~3x faster than realtime** on CPU — one
second of compute per three seconds of audio. That single number drives the
whole design:

| Stage | Cost |
| --- | --- |
| Silence detection (`SILENCE_MS`) | 1.2s, fixed |
| Model reply | ~0.8s |
| First audio chunk | ~2s |
| **Total, to first sound** | **~4s** |

Two things get it there, and removing either puts it back to ~36s:

**Replies are pipelined, not synthesised whole.** `speechChunks()` splits the
answer into clips and `useSpeech` requests the next while the current one plays.
Because synthesis outruns playback 3:1 the queue never runs dry, so only the
*first* clip is ever waited on in silence — which is why it is deliberately the
smallest, and why an over-long opening sentence gets broken at a clause boundary
rather than setting the whole turn's wait on its own.

**Spoken replies are written for the ear.** A voice turn sets `voice: true`,
which adds `VOICE_PROMPT`: two or three sentences, no markdown, no code, no
URLs. The same question answered for the screen ran 1087 characters — 99 seconds
of talking; answered for the ear it is 273, or 25 seconds. Markdown is the worst
of it, since it is all stripped by `speakable()` before synthesis and so costs
generation time for nothing.

`SILENCE_MS` in `useVoiceCall.ts` is the one knob left worth touching. Lowering
it shortens every turn, at the risk of cutting people off mid-sentence.

#### Hindi

KittenTTS is English-only and cannot be configured otherwise — its phonemiser is
pinned to `en-us` and its token vocabulary contains no Devanagari. Feeding it
Hindi does not fail loudly; it mispronounces the text *and* speaks espeak's
language-switch markers aloud:

```
आप कैसे हैं?  → phonemes:    (hi)ˌaːp kˈɛːseː hɛ̃(en-us)?
              → model hears: hiˌaːp kˈɛːseː hɛenus?
```

So Hindi goes to a second engine, `facebook/mms-tts-hin` — a 36M VITS checkpoint
at 16 kHz that takes Devanagari directly, needs no romanisation step, and
synthesises around 5x faster than realtime, comfortably inside the latency
budget above.

`tts.is_hindi()` routes on the *share* of Devanagari letters, not their mere
presence: one Hindi word inside an English sentence is not worth switching for,
because the Hindi model would mispronounce the English around it. The client
sends one request per clip, so a reply that changes language part-way is routed
clip by clip.

`LANGUAGE_PROMPT` makes the agent answer in whatever language it was asked in,
**always writing Hindi in Devanagari** — including when the question arrived
romanised. That is a correctness requirement, not a style one: `aap kaise hain`
routes to the English engine and comes out wrong, where `आप कैसे हैं` routes to
Hindi and comes out right.

Speech *input* has no auto-detect — the Web Speech API takes one language per
session and will not guess. There is still nothing to set, because the language
is **derived from the conversation** rather than chosen:

`useVoiceCall` reads back through the thread for the last assistant reply
`detectLanguage()` has an opinion about, and listens in that. This works because
`LANGUAGE_PROMPT` makes the agent mirror whatever language it was addressed in,
so its reply is direct evidence of what the user is speaking.

It closes the loop even when the first turn is misheard. A recogniser set to
English hears Hindi as rough romanised text — but the *model* reads that
perfectly well and answers in Devanagari, so the next turn is listened for in
Hindi. One turn to settle, then it stays right, and it switches back just as
readily when the conversation returns to English. The browser's own
`navigator.languages` seeds the first turn, so a Hindi-reading visitor is
usually understood immediately.

`detectLanguage()` returns null rather than guess when there is too little to go
on — under ten letters, so a bare "ok" or a code fragment cannot flip the
microphone for the rest of the conversation — and the caller keeps looking
further back. `hi-IN` also covers the English words Hindi speakers mix in, so it
is the right setting for Hinglish rather than a strictly-Hindi one.

> **Not the best Hindi available.** [AI4Bharat's Indic-Parler-TTS](https://huggingface.co/ai4bharat/indic-parler-tts)
> is better — trained in India on 1806 h of Indian speakers, MOS 4.5 — but at
> 0.9B parameters it needs a GPU. MMS is the only Hindi model in KittenTTS's
> weight class, which is why it wins here.

Voice and model are set by `KITTEN_TTS_VOICE` and `KITTEN_TTS_MODEL` — see
`.env.example`. The eight voices are Bella, Jasper, Luna, Bruno, Rosie, Hugo,
Kiki and Leo; `GET /api/tts` lists them alongside whether speech is available.

## Web search

Two providers behind one `web_search` tool, picked in `server/websearch.py`.
Neither `tools.py` nor the agent nor the Sources panel knows which one ran —
both return the same `[{title, url, snippet}]`.

**Tavily runs first whenever `TAVILY_API_KEY` is set.** The obvious arrangement
is the other way round — free scraping first, spend the metered quota only when
it fails — and it is wrong here. DuckDuckGo does not fail fast from a
datacenter; it *hangs*, and `duckduckgo.py` spends its whole 20s budget
discovering that. Trying it first would put 20 dead seconds in front of every
production search, out of a 60s request that still has to write an answer.

**DuckDuckGo is the fallback**, and with no key configured it is the only
provider — which is what keeps a fresh clone working with nothing to sign up
for. `server/duckduckgo.py` reads DuckDuckGo's `lite` HTML endpoint, falling
back to the classic `html` one. No key, no third-party search package;
`httpx` already ships with the OpenAI SDK.

Quota is not what decides the order: `web_search` is capped at one call per
turn, so Tavily's 1,000 free searches a month are 1,000 conversations.

### "Latest" needs dated results, not just fresh ones

Asked for "the latest news about the nepal flood", the agent answered about the
**September 2024** floods — while the flood in question was three days old.

The search was not the problem; the shape of its results was. Tavily's default
topic returns snippets with **no publication date**, and that result set mixed
articles from 2000, 2015, 2019, 2024 and 2025. With nothing in front of it
saying which was current, the model fell back on what it already believed —
and for "Nepal flood" what it believes is 2024.

`topic="news"` fixes both halves at once: results come back dated *and* ranked
by recency, and `published_date` is passed through as `published` so the date
reaches the model. It is not unconditional, because news **forces** recency:
asked about the 2015 Nepal earthquake with `topic="news"`, Tavily returns this
week's headlines instead of the event.

**The model decides, not a keyword list.** `web_search` takes a `recent`
boolean and the schema explains when to set it; the model already read the
question and already decided a search was needed at all. The first attempt here
*was* a regex — `latest|news|today|current|...` — and it is kept only as a
backstop for when the model says nothing, because it does not scale and cannot
be grown to:

| Query | Regex | Model |
| --- | --- | --- |
| `nepal flood ki taaza khabar batao` | ✗ | `recent: true` |
| `नेपाल बाढ़ की ताज़ा खबर क्या है?` | ✗ | `recent: true` |
| `abhi nepal me kya ho raha hai` | ✗ | `recent: true` |
| `aaj sensex kitna hai` | ✗ | `recent: true` |
| `who won the last cricket match` | ✗ | `recent: true` |
| `How many died in the 2015 Nepal earthquake?` | ✗ | `recent: false` |

The regex found **0 of 7** on that set — it is English-only, and the app is
not. Every Hindi, Hinglish and keyword-free English phrasing slipped past it,
which is the general shape of the problem: a word list only ever covers the
phrasings someone thought to add.

DuckDuckGo has no dated-results equivalent, which is one more reason it is the
fallback rather than the primary.

### The whole search must fit in one budget

`duckduckgo.py` enforces a wall-clock `TOTAL_BUDGET_SECONDS` (20s) across every
attempt, every endpoint, the instant-answer fallback and the sleeps between
them. This is not a nicety.

`/api/chat` declares `maxDuration = 60`, and the model still has to generate an
answer *after* the tool returns. Overrunning that is strictly worse than
failing: the function is killed mid-stream, so the turn ends with no
`tool_result`, no `error` and no `done` — the user watches the tool start and
then nothing, with nothing in the UI to say why.

That is not hypothetical. The budget used to be arithmetic rather than a
deadline — 3 attempts × 2 endpoints × 15s + backoff = 96s, against a 60s
request — and in production it failed exactly that way. A deadline is checked
against the clock instead of trusted, so adding an endpoint or an attempt later
cannot quietly reintroduce the overrun.

DuckDuckGo has no free official search API and rate-limits by IP, answering with
an HTTP 202 anti-bot page when it thinks you are a script. The client detects
that specifically, retries with backoff, and then raises `SearchUnavailable`
rather than returning an empty list — so the assistant reports the failure
instead of quietly answering from memory. Sponsored rows are filtered out.

**Five results per search** (`MAX_WEB_RESULTS` in `tools.py`). This was 1, and
one result was not enough to answer with: the model would read the single hit,
decide it had not found the answer, and search again — but `ONCE_PER_TURN` then
handed it a refusal, which it did not accept either. It spent every remaining
round rewording the query and the turn ended on "Stopped after too many tool
calls", in silence, 15–40s later. Five results cost the same one HTTP round trip
and let the first search actually answer.

If searches start failing, you are being rate-limited; wait a few minutes. For
heavy use, swap in a keyed search API — only `duckduckgo.py` would change.

## Tracing (optional)

Turns can be traced to [LangSmith](https://smith.langchain.com). Add to
`.env.local`:

```bash
LANGSMITH_TRACING=true
LANGSMITH_API_KEY=lsv2_your_key_here
LANGSMITH_PROJECT=Chat-app
```

Restart the agent and each turn appears as a tree:

```
SIMP turn (chain)
├── openai/gpt-oss-120b (llm)   one span per tool round
├── web_search (tool)
└── openai/gpt-oss-120b (llm)
```

`server/tracing.py` is the whole integration. Without the flag and key every
call in it is a no-op, and any LangSmith failure is swallowed — tracing can slow
a turn down but never break one.

## Deploying

See [DEPLOY.md](DEPLOY.md). The short version: the Python agent goes to Render,
the Next app to Vercel, they share `MONGODB_URI` and a matching `AGENT_TOKEN`,
and document indexing needs a Vercel plan that allows functions longer than 60
seconds.
