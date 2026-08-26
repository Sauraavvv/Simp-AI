"use client";

import { Globe, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

export type Source = {
  title: string;
  url: string;
  snippet?: string;
};

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Right-side citation list for the current conversation's web searches -- the
 *  Google AI Mode style: a scrollable box of source cards next to the chat,
 *  rather than results buried in the tool log. */
export function SourcesPanel({ sources, onClose }: { sources: Source[]; onClose?: () => void }) {
  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex items-center justify-between px-4 py-3.5">
        <p className="font-display text-sm font-semibold">
          Sources{sources.length > 0 && <span className="ml-1.5 text-muted-foreground">({sources.length})</span>}
        </p>
        {onClose && (
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground"
            onClick={onClose}
            aria-label="Close sources panel"
          >
            <X className="size-4" />
          </Button>
        )}
      </div>
      <Separator />

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {sources.length === 0 ? (
          <p className="px-1 text-[12px] text-muted-foreground">
            Sources appear here once the assistant searches the web for an answer.
          </p>
        ) : (
          <div className="space-y-2">
            {sources.map((s, i) => (
              <a
                key={s.url + i}
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                className="block rounded-xl border border-border bg-surface p-3 transition-colors hover:border-border-strong hover:bg-elevated"
              >
                <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Globe className="size-3 shrink-0 text-primary" />
                  <span className="truncate">{domainOf(s.url)}</span>
                </div>
                <p className="mt-1 line-clamp-2 text-[13px] font-medium text-foreground">
                  {s.title}
                </p>
                {s.snippet && (
                  <p className="mt-1 line-clamp-2 text-[11.5px] text-muted-foreground">
                    {s.snippet}
                  </p>
                )}
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
