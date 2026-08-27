"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  CheckCircle2,
  FileSearch,
  Loader2,
  Paperclip,
  Sparkles,
  UserPlus,
} from "lucide-react";
import { AppShell } from "@/components/chat/app-shell";
import { AuthModal } from "@/components/auth/auth-modal";
import { Button } from "@/components/ui/button";
import { useSession } from "@/lib/auth";
import { ACCEPT_ATTR, MAX_EXTRACTED_CHARS, readAttachment } from "@/lib/attachments";
import { CONVERSATIONS_CHANGED } from "@/lib/types";
import { cn } from "@/lib/utils";

const GUIDE_STEPS = [
  {
    title: "Attach or paste",
    body: "PDF, DOCX, or plain text -- upload a file or paste the text directly.",
  },
  {
    title: "Fine-tune, or don't",
    body: "Use the defaults, or set your own chunk size, overlap and vector dimension.",
  },
  {
    title: "Ask anything",
    body: "Ask as many questions as you want -- each answer is pulled from what your document actually says.",
  },
];

/** The guide shown before the indexing form -- what RAG is and how this page uses it. */
function RagGuide({ onStart }: { onStart: () => void }) {
  return (
    <div className="flex w-full flex-1 flex-col items-center justify-center max-w-2xl mx-auto px-4 py-8 gap-6 animate-in fade-in zoom-in-95 duration-300">
      <div className="text-center space-y-1.5">
        <div className="mx-auto grid size-12 place-items-center rounded-2xl bg-primary/15 text-primary ring-1 ring-primary/30 shadow-xs">
          <FileSearch className="size-6" />
        </div>
        <h1 className="font-display text-xl sm:text-2xl font-bold tracking-tight text-foreground">
          Inbuilt RAG
        </h1>
        <p className="text-xs sm:text-sm text-muted-foreground max-w-md mx-auto leading-relaxed">
          Ask questions grounded in your own documents -- not just what the model already knows.
        </p>
      </div>

      <div className="w-full rounded-2xl border border-border bg-surface p-5 space-y-4">
        <div className="space-y-1.5">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            What is RAG?
          </p>
          <p className="text-[13px] text-muted-foreground leading-relaxed">
            Retrieval-Augmented Generation. Instead of pasting a whole document into the
            conversation, it&apos;s split into pieces and converted into searchable vectors. When
            you ask a question, only the relevant pieces are pulled in for the AI to read -- so
            answers stay grounded in what your document actually says, instead of the model
            guessing.
          </p>
        </div>

        <div className="h-px bg-border" />

        <div className="space-y-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            How it works
          </p>
          {GUIDE_STEPS.map((step, i) => (
            <div key={step.title} className="flex items-start gap-3">
              <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-primary/15 text-[11px] font-bold text-primary">
                {i + 1}
              </span>
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-foreground">{step.title}</p>
                <p className="text-[12px] text-muted-foreground leading-relaxed">{step.body}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      <Button
        onClick={onStart}
        className="w-full max-w-xs justify-center gap-2 py-2.5 text-sm font-medium cursor-pointer"
      >
        <Sparkles className="size-4" /> Start Building
      </Button>
    </div>
  );
}

// Mirrors server/rag.py's own defaults and whitelist -- kept here only to
// pre-fill and label the advanced fields, not as validation. The server
// clamps everything again itself (see clamp_chunking / clamp_dimension),
// since a request body is not a trusted source of truth.
const DEFAULT_CHUNK_SIZE = 2800;
const DEFAULT_CHUNK_OVERLAP = 400;
const DEFAULT_DIMENSION = 1024;
const VALID_DIMENSIONS = [256, 512, 1024, 2048] as const;

/** Shell for the two states that stop before the form: signed out, or spent. */
function Gate({
  icon,
  title,
  body,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  body: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex w-full flex-1 flex-col items-center justify-center max-w-md mx-auto px-4 py-8 gap-5 text-center animate-in fade-in zoom-in-95 duration-300">
      <div className="grid size-12 place-items-center rounded-2xl bg-primary/15 text-primary ring-1 ring-primary/30 shadow-xs">
        {icon}
      </div>
      <div className="space-y-1.5">
        <h1 className="font-display text-xl sm:text-2xl font-bold tracking-tight text-foreground">
          {title}
        </h1>
        <p className="text-[13px] text-muted-foreground leading-relaxed">{body}</p>
      </div>
      {action}
    </div>
  );
}

// Mirrors rag.estimate_seconds. Voyage's free tier allows 10,000 tokens a
// minute, so anything past the first window's worth has to wait one out --
// which makes indexing a long document a minutes-long operation rather than a
// seconds-long one. Worth saying before someone presses the button and watches
// a spinner for two minutes wondering if it hung.
const CHARS_PER_TOKEN = 4;
const TOKEN_BUDGET_PER_MINUTE = 6_000;
// What one request can survive: the route's own maxDuration (see
// /api/documents/ingest). Past this the wait outlives the request itself, so
// the document has to be split by hand instead.
const MAX_INDEX_SECONDS = 300;

function estimateSeconds(text: string) {
  const tokens = Math.floor(text.length / CHARS_PER_TOKEN) + 1;
  const windows = Math.max(0, Math.ceil(tokens / TOKEN_BUDGET_PER_MINUTE) - 1);
  return windows * 60 + 15;
}

function describeWait(seconds: number) {
  if (seconds < 60) return "under a minute";
  return `about ${Math.round(seconds / 60)} minute${seconds >= 90 ? "s" : ""}`;
}

const inputClass =
  "w-full rounded-xl border border-border bg-surface px-3.5 py-2 text-sm text-foreground placeholder:text-muted-foreground/60 outline-none focus:border-primary/40 focus:ring-1 focus:ring-primary disabled:opacity-50";

/**
 * A dedicated, two-phase entry point for document RAG, rather than making
 * people find the attach button mid-chat and paste something long enough to
 * trigger it.
 *
 * Phase 1 (this page): attach or paste (left card), then optionally fine-tune
 * chunking and embedding (right card, opened by "Next"), then index -- no
 * question yet. Phase 2 starts once /api/documents/ingest returns a
 * conversation id: the normal chat view opens on it (server/main.py already
 * left a confirmation message there), and questions get asked -- as many as
 * wanted -- the ordinary way. Splitting it like this means indexing (which
 * can take several seconds waiting for Atlas' search index to catch up, see
 * rag._wait_until_searchable) finishes and is confirmed before anyone is
 * typing a question against it.
 */
function DocumentIndexer() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [reading, setReading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // The right card only opens once the left one has something valid in it --
  // see next() below.
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [useDefaults, setUseDefaults] = useState(true);
  const [chunkSize, setChunkSize] = useState(DEFAULT_CHUNK_SIZE);
  const [chunkOverlap, setChunkOverlap] = useState(DEFAULT_CHUNK_OVERLAP);
  const [dimension, setDimension] = useState<number>(DEFAULT_DIMENSION);

  const [indexing, setIndexing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const waitSeconds = estimateSeconds(text);
  const tooLong = waitSeconds > MAX_INDEX_SECONDS;

  async function handleFile(list: FileList | null) {
    const file = list?.[0];
    if (!file) return;
    setError(null);
    setReading(true);
    try {
      const attachment = await readAttachment(file);
      setText(attachment.text);
      if (!name.trim()) setName(attachment.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read that file.");
    } finally {
      setReading(false);
    }
  }

  function next() {
    if (!text.trim()) {
      setError("Paste the document text first.");
      return;
    }
    // Vercel hard-caps a Function's request body at 4.5MB (see attachments.ts's
    // MAX_EXTRACTED_CHARS) -- worth catching here, before a request that would
    // otherwise fail server-side with a 413 the user cannot act on.
    if (text.length > MAX_EXTRACTED_CHARS) {
      setError(
        `That's ${Math.round(text.length / 1_000_000)}M characters -- too long to send in one go. Split it into smaller parts.`,
      );
      return;
    }
    setError(null);
    setAdvancedOpen(true);
  }

  async function submit() {
    setError(null);
    setIndexing(true);

    try {
      const res = await fetch("/api/documents/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim() || "document.txt",
          text,
          ...(useDefaults ? {} : { chunk_size: chunkSize, chunk_overlap: chunkOverlap, dimension }),
        }),
      });
      const data = (await res.json().catch(() => null)) as
        | { conversation_id?: string; error?: string }
        | null;

      if (!res.ok || !data?.conversation_id) {
        setError(data?.error || "Could not index that document.");
        setIndexing(false);
        return;
      }

      // /documents/ingest doesn't go through useChat, which is what normally
      // fires this -- without it the sidebar's Inbuilt RAG list would not
      // pick up the new conversation until something else happened to.
      window.dispatchEvent(new Event(CONVERSATIONS_CHANGED));
      router.push(`/?c=${data.conversation_id}`);
    } catch {
      setError("Network error. Please try again.");
      setIndexing(false);
    }
  }

  return (
    <div className="flex w-full flex-1 flex-col items-center px-4 py-8 gap-5 animate-in fade-in zoom-in-95 duration-300">
      <div className="text-center space-y-1.5">
        <div className="mx-auto grid size-12 place-items-center rounded-2xl bg-primary/15 text-primary ring-1 ring-primary/30 shadow-xs">
          <FileSearch className="size-6" />
        </div>
        <h1 className="font-display text-xl sm:text-2xl font-bold tracking-tight text-foreground">
          Index a Document
        </h1>
        <p className="text-xs sm:text-sm text-muted-foreground max-w-md mx-auto leading-relaxed">
          Attach a file or paste text, fine-tune it if you want, then index -- questions come after.
        </p>
      </div>

      <div className="w-full max-w-4xl grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
        {/* Left card -- the document itself */}
        <div className="rounded-2xl border border-border bg-surface p-5 space-y-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            1. Document
          </p>

          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Document name (optional)"
            disabled={advancedOpen}
            className={inputClass}
          />

          <div className="flex items-center gap-2.5">
            <input
              ref={fileRef}
              type="file"
              accept={ACCEPT_ATTR}
              className="hidden"
              onChange={(e) => {
                handleFile(e.target.files);
                e.target.value = ""; // let the same file be picked again
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => fileRef.current?.click()}
              disabled={advancedOpen || reading}
              className="gap-2 text-xs cursor-pointer"
            >
              {reading ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Paperclip className="size-3.5" />
              )}
              {reading ? "Reading file..." : "Attach a file"}
            </Button>
            <span className="text-[11px] text-muted-foreground">PDF, DOCX, or text</span>
          </div>

          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Paste the document text here..."
            rows={10}
            disabled={advancedOpen || reading}
            className={cn(inputClass, "resize-none py-3")}
          />

          {!advancedOpen && (
            <>
              {error && <p className="text-xs text-destructive">{error}</p>}
              <Button
                onClick={next}
                disabled={reading || !text.trim()}
                className="w-full justify-center gap-2 py-2.5 text-sm font-medium cursor-pointer"
              >
                Next <ArrowRight className="size-4" />
              </Button>
            </>
          )}
        </div>

        {/* Right card -- indexing settings, opens once the left one is ready */}
        {advancedOpen ? (
          <div className="rounded-2xl border border-border bg-surface p-5 space-y-4 animate-in fade-in slide-in-from-right-2 duration-200">
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                2. Settings
              </p>
              <button
                type="button"
                onClick={() => setAdvancedOpen(false)}
                disabled={indexing}
                className="text-[11px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer disabled:opacity-50"
              >
                &larr; Back
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setUseDefaults(true)}
                disabled={indexing}
                className={cn(
                  "rounded-lg border py-2 text-xs font-medium transition-colors cursor-pointer disabled:opacity-50",
                  useDefaults
                    ? "border-primary/50 bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:text-foreground",
                )}
              >
                Use Default
              </button>
              <button
                type="button"
                onClick={() => setUseDefaults(false)}
                disabled={indexing}
                className={cn(
                  "rounded-lg border py-2 text-xs font-medium transition-colors cursor-pointer disabled:opacity-50",
                  !useDefaults
                    ? "border-primary/50 bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:text-foreground",
                )}
              >
                Customize
              </button>
            </div>

            {useDefaults ? (
              <p className="text-[12px] text-muted-foreground leading-relaxed">
                Chunk size {DEFAULT_CHUNK_SIZE} characters, {DEFAULT_CHUNK_OVERLAP} overlap,{" "}
                {DEFAULT_DIMENSION}-dimension vectors -- balanced settings that work well for most
                documents.
              </p>
            ) : (
              <div className="space-y-3 animate-in fade-in duration-150">
                <div className="space-y-1">
                  <label className="text-[11.5px] font-medium text-muted-foreground">
                    Chunk size (characters)
                  </label>
                  <input
                    type="number"
                    min={200}
                    max={8000}
                    value={chunkSize}
                    disabled={indexing}
                    onChange={(e) => setChunkSize(Number(e.target.value))}
                    className={inputClass}
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[11.5px] font-medium text-muted-foreground">
                    Chunk overlap (characters)
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={Math.floor(chunkSize / 2)}
                    value={chunkOverlap}
                    disabled={indexing}
                    onChange={(e) => setChunkOverlap(Number(e.target.value))}
                    className={inputClass}
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[11.5px] font-medium text-muted-foreground">
                    Vector dimension
                  </label>
                  <select
                    value={dimension}
                    disabled={indexing}
                    onChange={(e) => setDimension(Number(e.target.value))}
                    className={inputClass}
                  >
                    {VALID_DIMENSIONS.map((d) => (
                      <option key={d} value={d}>
                        {d}
                        {d === DEFAULT_DIMENSION ? " (default)" : ""}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            <div className="h-px bg-border" />

            {tooLong ? (
              <p className="text-[12px] text-destructive leading-relaxed">
                This document needs {describeWait(waitSeconds)} to embed, which is longer than one
                request can stay open. Split it into smaller parts and index them separately.
              </p>
            ) : (
              <p className="text-[12px] text-muted-foreground leading-relaxed">
                Takes {describeWait(waitSeconds)}. The free embedding tier is rate limited per
                minute, so longer documents are indexed in batches -- leave the tab open.
              </p>
            )}

            {error && <p className="text-xs text-destructive">{error}</p>}

            <Button
              onClick={submit}
              disabled={indexing || tooLong}
              className="w-full justify-center gap-2 py-2.5 text-sm font-medium cursor-pointer"
            >
              {indexing ? (
                <>
                  <Loader2 className="size-4 animate-spin" /> Indexing, {describeWait(waitSeconds)}
                  ...
                </>
              ) : (
                <>
                  <Sparkles className="size-4" /> Start Indexing
                </>
              )}
            </Button>
          </div>
        ) : (
          <div className="hidden lg:flex rounded-2xl border border-dashed border-border p-5 h-full min-h-[200px] items-center justify-center text-center">
            <p className="text-[12px] text-muted-foreground max-w-40">
              Fill in your document, then click Next to fine-tune indexing settings.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Inbuilt RAG is gated twice before the form is reachable.
 *
 * Signing in is required because an indexed document is stored against an
 * account -- a guest owns nothing (see store._owner), so there would be
 * nowhere to put the chunks and no conversation to come back to. And each
 * account gets exactly one document, for the lifetime of the account: deleting
 * the conversation does not hand the allowance back, which is why this reads a
 * flag on the user rather than counting live RAG conversations.
 *
 * Both gates are cosmetic. /documents/ingest re-checks each one itself, and is
 * the only thing that actually decides.
 */
export default function DocumentsPage() {
  const [started, setStarted] = useState(false);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const { user, loading } = useSession();

  if (loading) {
    return (
      <AppShell>
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      </AppShell>
    );
  }

  if (!user) {
    return (
      <AppShell>
        <Gate
          icon={<UserPlus className="size-6" />}
          title="Sign in to use Inbuilt RAG"
          body="An indexed document is stored against your account, so this one needs you signed in. Creating an account is free and takes a moment."
          action={
            <Button
              onClick={() => setAuthModalOpen(true)}
              className="gap-2 px-5 py-2.5 text-sm font-medium cursor-pointer"
            >
              <Sparkles className="size-4 text-amber-300" /> Create Free Account / Log In
            </Button>
          }
        />
        <AuthModal open={authModalOpen} onClose={() => setAuthModalOpen(false)} />
      </AppShell>
    );
  }

  if (user.ragUsed) {
    return (
      <AppShell>
        <Gate
          icon={<CheckCircle2 className="size-6" />}
          title="You have used your document"
          body="Inbuilt RAG is limited to one indexed document per account. Open it from the Inbuilt RAG list in the sidebar to keep asking questions -- deleting it does not free the slot up."
        />
      </AppShell>
    );
  }

  return (
    <AppShell>
      {started ? <DocumentIndexer /> : <RagGuide onStart={() => setStarted(true)} />}
    </AppShell>
  );
}
