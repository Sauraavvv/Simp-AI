"use client";

import { useTheme } from "@/lib/theme";

export function UserMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[92%] sm:max-w-[80%] space-y-2 rounded-2xl rounded-br-xs border border-border bg-elevated px-3.5 py-2 sm:px-4 sm:py-2.5 text-xs sm:text-[14.5px] leading-relaxed whitespace-pre-wrap shadow-2xs">
        {children}
      </div>
    </div>
  );
}

export function AIMessage({ children }: { children: React.ReactNode }) {
  const { resolvedTheme } = useTheme();
  return (
    <div className="flex gap-0 sm:gap-3">
      <div className="hidden sm:block mt-0.5 size-7 shrink-0 overflow-hidden rounded-lg ring-1 ring-primary/25">
        <img
          src={resolvedTheme === "dark" ? "/simp-icon-dark.png" : "/simp-icon-light.png"}
          alt="SIMP AI"
          className="size-full object-cover"
        />
      </div>
      <div className="min-w-0 flex-1 space-y-3">{children}</div>
    </div>
  );
}
