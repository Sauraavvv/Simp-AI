"use client";

import { Suspense, useState, type ReactNode } from "react";
import { Menu } from "lucide-react";
import { AppSidebar } from "@/components/chat/app-sidebar";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

export function AppShell({
  children,
  rightPanel,
  rightPanelOpen = false,
  onRightPanelClose,
}: {
  children: ReactNode;
  /** Renders the right-side panel's content; receives a close handler. Omit to hide the panel entirely. */
  rightPanel?: (onClose: () => void) => ReactNode;
  /** Whether the panel is open. Opening it is triggered from inside `children`
   *  (e.g. a "Sources" chip on a message) -- there is no header toggle here. */
  rightPanelOpen?: boolean;
  onRightPanelClose?: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);

  return (
    <div className="flex h-screen w-full overflow-hidden bg-sidebar">
      <div
        className={cn(
          "hidden bg-sidebar transition-[width] duration-300 ease-in-out lg:block shrink-0 overflow-hidden",
          collapsed ? "w-[68px]" : "w-[280px]",
        )}
      >
        <Suspense fallback={null}>
          <AppSidebar collapsed={collapsed} onToggle={() => setCollapsed((v) => !v)} />
        </Suspense>
      </div>

      <Sheet open={mobileNav} onOpenChange={setMobileNav}>
        <SheetContent side="left" showCloseButton={false} className="w-[72vw] max-w-[300px] border-sidebar-border p-0">
          <Suspense fallback={null}>
            <AppSidebar collapsed={false} onToggle={() => setMobileNav(false)} onItemClick={() => setMobileNav(false)} />
          </Suspense>
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between pl-0 pr-3 py-2">
          <div className="flex items-center gap-2 lg:hidden">
            <Button variant="ghost" size="icon" onClick={() => setMobileNav(true)} aria-label="Open navigation">
              <Menu className="size-4" />
            </Button>
            <span className="font-display text-sm font-semibold">SIMP AI</span>
          </div>
        </div>
        <div
          className={cn(
            "ml-0 mb-3 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-elevated",
            // The panel's own left margin already makes the gap when it's open --
            // adding this too would double it versus the sidebar's single-margin gap.
            rightPanel && rightPanelOpen ? "mr-0" : "mr-3",
          )}
        >
          {children}
        </div>
      </div>

      {rightPanel && (
        <aside
          className={cn(
            "h-full shrink-0 overflow-hidden transition-[width,opacity] duration-300 ease-in-out",
            rightPanelOpen ? "w-[300px] opacity-100" : "w-0 opacity-0",
          )}
        >
          <div className="flex h-full w-[300px] flex-col">
            <div className="pl-0 pr-3 py-2" />
            <div className="ml-3 mr-3 mb-3 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-elevated">
              {rightPanel(() => onRightPanelClose?.())}
            </div>
          </div>
        </aside>
      )}
    </div>
  );
}
