"use client";

import { useEffect, useState } from "react";
import { FileSearch, Globe, ListChecks, Wrench } from "lucide-react";
import { AppShell } from "@/components/chat/app-shell";
import type { ToolInfo } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * The tools hub -- what the agent can reach for on its own mid-conversation.
 *
 * Read from the Python registry rather than listed here, so it cannot drift
 * from what the agent can actually do.
 */

const AGENT_ICONS: Record<string, typeof Globe> = {
  web_search: Globe,
  ask_options: ListChecks,
  search_document: FileSearch,
};

function Tools() {
  const [agentTools, setAgentTools] = useState<ToolInfo[]>([]);
  const [model, setModel] = useState<string>("");

  useEffect(() => {
    fetch("/api/tools", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { model?: string; tools?: ToolInfo[] } | null) => {
        if (!data) return;
        setAgentTools(data.tools ?? []);
        setModel(data.model ?? "");
      })
      // Agent offline -- the list stays empty rather than showing a stale one.
      .catch(() => {});
  }, []);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:py-8 space-y-8">
        <header className="space-y-2">
          <div className="flex items-center gap-2.5">
            <div className="grid size-9 place-items-center rounded-xl bg-primary/12 text-primary ring-1 ring-primary/25">
              <Wrench className="size-4.5" />
            </div>
            <h1 className="font-display text-xl sm:text-2xl font-bold tracking-tight">AI Tools</h1>
          </div>
          <p className="text-[13px] text-muted-foreground">
            These run on their own while you chat -- just ask, and the agent decides which one
            the question needs.
          </p>
        </header>

        {agentTools.length > 0 && (
          <section className="space-y-2.5">
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
                Called automatically in chat
              </p>
              {model && <p className="truncate text-[11px] text-muted-foreground/60">{model}</p>}
            </div>
            <div className="divide-y divide-border rounded-2xl border border-border bg-surface/40">
              {agentTools.map((tool) => {
                const Icon = AGENT_ICONS[tool.name] ?? Wrench;
                return (
                  <div key={tool.name} className="flex gap-3 p-3.5">
                    <Icon
                      className={cn(
                        "mt-0.5 size-4 shrink-0",
                        tool.available === false ? "text-muted-foreground/40" : "text-primary",
                      )}
                    />
                    <div className="min-w-0 space-y-1">
                      <p className="flex items-center gap-2 font-mono text-[12.5px] text-foreground">
                        {tool.name}
                        {/* Configured off, not broken -- the agent genuinely
                            cannot call it, so the list says why. */}
                        {tool.available === false && (
                          <span className="rounded-full border border-border bg-background px-1.5 py-0.5 font-sans text-[10px] uppercase tracking-wider text-muted-foreground/70">
                            needs a key
                          </span>
                        )}
                      </p>
                      <p className="text-[12.5px] leading-snug text-muted-foreground">
                        {tool.description}
                      </p>
                      <p className="text-[11px] text-muted-foreground/60">Reads {tool.reads}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

export default function ToolsPage() {
  return (
    <AppShell>
      <Tools />
    </AppShell>
  );
}
