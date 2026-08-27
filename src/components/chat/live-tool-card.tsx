"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Globe, Loader2 } from "lucide-react";
import type { ToolEvent } from "@/lib/types";

/** What each tool is doing, shown while it runs. */
const RUNNING_VERB: Record<string, string> = {
  web_search: "Searching the web",
  ask_options: "Preparing options",
  search_document: "Searching the document",
  // Can take up to ~20s -- see rag._wait_until_searchable -- so this is worth
  // naming explicitly rather than falling back to a generic "Working".
  index_document: "Indexing your document",
};

/** Cycles "" → "." → ".." → "..." so the label reads as live activity. */
function Ellipsis() {
  const [step, setStep] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setStep((s) => (s + 1) % 4), 400);
    return () => clearInterval(id);
  }, []);

  // Fixed width so the text beside it doesn't jitter as dots come and go.
  return <span className="inline-block w-3 text-left">{".".repeat(step)}</span>;
}

/** A tool result is a failure when the payload is an {"error": ...} object. */
function isFailure(result: string): boolean {
  try {
    const parsed = JSON.parse(result) as Record<string, unknown>;
    return typeof parsed === "object" && parsed !== null && "error" in parsed;
  } catch {
    return false;
  }
}

/** Pull the message out of an {"error": ...} payload. */
function errorText(result: string): string {
  try {
    const parsed = JSON.parse(result) as { error?: unknown };
    return String(parsed.error ?? "That step failed.");
  } catch {
    return "That step failed.";
  }
}

/**
 * Transient status for one tool call.
 *
 * While the tool runs it shows what the agent is doing; once it succeeds it
 * disappears and the answer speaks for itself. Failures stay visible, otherwise
 * the assistant would appear to answer normally after a step silently broke.
 * The full arguments and results of every call are on the Activity page.
 */
export function LiveToolCard({
  tool,
  onOpenSources,
}: {
  tool: ToolEvent;
  /** web_search succeeded -- opens the Sources panel instead of showing nothing. */
  onOpenSources?: () => void;
}) {
  const running = tool.result === undefined;

  if (running) {
    return (
      <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
        <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
        <span>
          {RUNNING_VERB[tool.name] ?? "Working"}
          <Ellipsis />
        </span>
      </p>
    );
  }

  if (isFailure(tool.result!)) {
    return (
      <p className="flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/[0.07] px-3 py-2 text-[12.5px] text-destructive">
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
        <span>{errorText(tool.result!)}</span>
      </p>
    );
  }

  if (tool.name === "web_search" && onOpenSources) {
    const count = (() => {
      try {
        const parsed = JSON.parse(tool.result!) as { results?: unknown[] };
        return parsed.results?.length ?? 0;
      } catch {
        return 0;
      }
    })();

    if (count > 0) {
      return (
        <button
          type="button"
          onClick={onOpenSources}
          className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1 text-[12px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground cursor-pointer"
        >
          <Globe className="size-3.5 text-primary shrink-0" />
          {count} {count === 1 ? "source" : "sources"}
        </button>
      );
    }
  }

  // Succeeded -- nothing else to show; the answer follows.
  return null;
}
