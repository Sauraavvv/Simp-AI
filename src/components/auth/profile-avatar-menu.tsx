"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ChevronUp, LogIn, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AuthModal } from "./auth-modal";
import { PlanActivationModal } from "./plan-activation-modal";
import { logout, useSession } from "@/lib/auth";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

function formatEmail(email: string, maxLen: number = 12): string {
  if (!email) return "";
  if (email.length <= maxLen) return email;
  return email.slice(0, maxLen) + "...";
}

export function ProfileAvatarMenu({ collapsed, onNavigate }: { collapsed?: boolean; onNavigate?: () => void }) {
  const { user, loading } = useSession();
  const { resolvedTheme, setTheme } = useTheme();
  const [modalOpen, setModalOpen] = useState(false);
  const [planModalOpen, setPlanModalOpen] = useState(false);
  const [initialTab, setInitialTab] = useState<"login" | "register">("login");
  const [expanded, setExpanded] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Auto open plan activation modal if logged in user has no active plan
  useEffect(() => {
    if (user && (user.plan === "none" || !user.plan)) {
      setPlanModalOpen(true);
    }
  }, [user]);

  // Floats above the trigger row like a popover -- close it on any click outside.
  useEffect(() => {
    if (!expanded) return;
    function onPointerDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setExpanded(false);
      }
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [expanded]);

  if (loading) {
    return (
      <div className={cn("p-2 flex items-center gap-2.5", collapsed && "justify-center p-1")}>
        <div className="size-8 shrink-0 rounded-full bg-elevated animate-pulse" />
        {!collapsed && (
          <div className="space-y-1.5 flex-1 min-w-0">
            <div className="h-3 w-20 rounded-md bg-elevated animate-pulse" />
            <div className="h-2.5 w-14 rounded-md bg-elevated/70 animate-pulse" />
          </div>
        )}
      </div>
    );
  }

  if (!user) {
    return (
      <>
        <div className="p-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setInitialTab("login");
              setModalOpen(true);
            }}
            className={cn(
              "w-full justify-start gap-2 border-border bg-surface text-xs font-medium hover:bg-elevated hover:text-foreground cursor-pointer",
              collapsed && "justify-center px-0",
            )}
            title="Login / Register"
          >
            <LogIn className="size-3.5 text-primary shrink-0" />
            {!collapsed && <span>Login / Register</span>}
          </Button>
        </div>

        <AuthModal
          open={modalOpen}
          onClose={() => setModalOpen(false)}
          initialTab={initialTab}
        />
      </>
    );
  }

  const initial =
    user.name && user.name.trim()
      ? user.name.trim()[0].toUpperCase()
      : user.email
      ? user.email[0].toUpperCase()
      : "U";
  const displayName =
    user.name && user.name.trim() ? user.name.trim() : formatEmail(user.email, 12);
  const avatarGradient = user.avatar || "from-primary to-indigo-500";
  const currentPlan = user.plan || "none";
  const credits = typeof user.credits === "number" ? user.credits : 0;

  function closeAndNavigate() {
    setExpanded(false);
    onNavigate?.();
  }

  return (
    <>
      <div ref={containerRef} className="relative p-2">
        <button
          type="button"
          onClick={() => !collapsed && setExpanded((v) => !v)}
          className={cn(
            "flex w-full items-center gap-3 rounded-xl p-2 text-left transition-colors hover:bg-sidebar-accent group focus:outline-hidden cursor-pointer",
            collapsed && "justify-center p-1",
          )}
          title={user.email}
          aria-expanded={expanded}
        >
          <div
            className={cn(
              "grid size-10 shrink-0 place-items-center rounded-full text-white font-semibold text-sm shadow-xs ring-2 ring-primary/20 overflow-hidden bg-gradient-to-tr",
              avatarGradient,
            )}
          >
            {user.avatarImage ? (
              <img src={user.avatarImage} alt="Avatar" className="size-full object-cover" />
            ) : (
              initial
            )}
          </div>
          {!collapsed && (
            <>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-sidebar-foreground">
                  {displayName}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {currentPlan === "paid"
                    ? "Pro Unlimited Plan"
                    : currentPlan === "free"
                    ? `${credits} credits remaining`
                    : "No Active Plan"}
                </p>
              </div>
              <ChevronUp
                className={cn(
                  "size-4 text-muted-foreground/70 shrink-0 transition-transform duration-300 ease-in-out",
                  expanded && "rotate-180",
                )}
              />
            </>
          )}
        </button>

        {!collapsed && expanded && (
          <div className="absolute inset-x-2 bottom-full z-50 mb-2 space-y-0.5 rounded-xl border border-border bg-popover p-1.5 shadow-xl animate-in fade-in zoom-in-95 slide-in-from-bottom-2 duration-150">
            <Link
              href="/profile"
              onClick={closeAndNavigate}
              className="flex items-center gap-2 rounded-md px-2.5 py-2.5 text-sm text-popover-foreground hover:bg-accent transition-colors cursor-pointer"
            >
              Edit Profile
            </Link>
            <Link
              href="/plans"
              onClick={closeAndNavigate}
              className="flex items-center gap-2 rounded-md px-2.5 py-2.5 text-sm text-popover-foreground hover:bg-accent transition-colors cursor-pointer"
            >
              Pricing &amp; Plans
            </Link>

            <div className="h-px bg-border" />
            <div className="flex items-center justify-between px-2.5 py-2.5 text-sm text-popover-foreground">
              <span className="font-medium">Appearance</span>
              <button
                type="button"
                onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
                className="relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent bg-elevated transition-colors duration-200 ease-in-out focus:outline-hidden ring-1 ring-border"
                role="switch"
                aria-checked={resolvedTheme === "dark"}
                title={resolvedTheme === "dark" ? "Switch to Light Mode" : "Switch to Dark Mode"}
              >
                <span
                  className={cn(
                    "pointer-events-none inline-block size-4 rounded-full bg-primary shadow-xs ring-0 transition duration-200 ease-in-out flex items-center justify-center text-[9px] text-white",
                    resolvedTheme === "dark" ? "translate-x-4" : "translate-x-0",
                  )}
                >
                  {resolvedTheme === "dark" ? (
                    <Moon className="size-2.5 text-white" />
                  ) : (
                    <Sun className="size-2.5 text-white" />
                  )}
                </span>
              </button>
            </div>

            <div className="h-px bg-border" />
            <button
              type="button"
              onClick={() => {
                setExpanded(false);
                logout();
              }}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-2.5 text-sm text-destructive hover:bg-destructive/10 transition-colors cursor-pointer"
            >
              Logout
            </button>
          </div>
        )}
      </div>

      <AuthModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        initialTab="login"
      />

      <PlanActivationModal
        open={planModalOpen}
        onClose={() => setPlanModalOpen(false)}
      />
    </>
  );
}
