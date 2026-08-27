"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronDown,
  HelpCircle,
  Loader2,
  Sparkles,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { refreshCurrentUser, useSession } from "@/lib/auth";
import { showToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

const FAQS = [
  {
    q: "How do the 50 free chat credits work?",
    a: "When you activate the Free Plan after logging in or registering, you receive 50 prompt credits instantly. Each message or prompt sent to SIMP AI consumes 1 credit.",
  },
  {
    q: "What happens when I reach 0 credits?",
    a: "Chatting will pause once your free quota is reached.",
  },
];

export default function PlansPage() {
  const router = useRouter();
  const { user, loading } = useSession();
  const [activatingFree, setActivatingFree] = useState(false);
  const [openFaq, setOpenFaq] = useState<number | null>(0);

  const currentPlan = user?.plan || "none";
  const currentCredits = user?.credits ?? 0;

  async function handleActivateFree() {
    if (!user) {
      showToast("Please log in to activate your Free Plan.", "info");
      return;
    }

    setActivatingFree(true);
    try {
      const res = await fetch("/api/auth/activate-free-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: user.email }),
      });
      const data = await res.json().catch(() => null);

      if (res.ok) {
        await refreshCurrentUser();
        showToast("Free Plan activated! 50 credits granted.", "success");
        router.push("/");
      } else {
        showToast(data?.error || "Failed to activate Free Plan.", "error");
      }
    } catch {
      showToast("Network error. Please try again.", "error");
    } finally {
      setActivatingFree(false);
    }
  }

  return (
    <div className="relative min-h-screen w-full bg-background text-foreground selection:bg-primary/20">
      {/* Background Lighting */}
      <div className="pointer-events-none absolute -top-40 right-1/4 -z-10 size-[600px] rounded-full bg-gradient-to-tr from-primary/20 via-indigo-500/10 to-purple-500/10 blur-3xl opacity-60 animate-pulse duration-1000" />
      <div className="pointer-events-none absolute bottom-10 left-10 -z-10 size-[500px] rounded-full bg-primary/10 blur-3xl" />

      {/* Header */}
      <header className="sticky top-0 z-30 flex h-16 w-full items-center justify-between border-b border-border bg-sidebar/80 px-6 sm:px-10 backdrop-blur-md">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            asChild
            className="gap-2 text-muted-foreground hover:text-foreground cursor-pointer"
          >
            <Link href="/">
              <ArrowLeft className="size-4" /> Back to Workspace
            </Link>
          </Button>
        </div>

        <div className="flex items-center gap-2">
          {user ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1 text-xs text-muted-foreground">
              <Zap className="size-3 text-primary" />
              {currentPlan === "paid" ? (
                <span className="font-semibold text-emerald-400">Pro Unlimited</span>
              ) : currentPlan === "free" ? (
                <span className="font-semibold text-foreground">{currentCredits} / 50 Credits</span>
              ) : (
                <span>No Active Plan</span>
              )}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">Guest Visitor</span>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-12 sm:px-8 space-y-12">
        {/* Banner Section */}
        <div className="text-center space-y-3 max-w-2xl mx-auto animate-in fade-in duration-300">
          <div className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3.5 py-1 text-xs font-semibold text-primary">
            <Sparkles className="size-3.5" /> Free to Get Started
          </div>
          <h1 className="text-3xl sm:text-5xl font-bold font-display tracking-tight text-foreground">
            Simple, Transparent Pricing
          </h1>
          <p className="text-sm sm:text-base text-muted-foreground leading-relaxed">
            Start with 50 free AI credits -- chat, real-time web tool calling, and more.
          </p>
        </div>

        {/* Pricing Card */}
        <div className="max-w-md mx-auto">
          {/* Free Starter Card */}
          <div className="relative flex flex-col justify-between rounded-3xl border border-border bg-sidebar/90 p-8 space-y-6 shadow-md transition-all hover:border-primary/40">
            {currentPlan === "free" && (
              <span className="absolute -top-3.5 right-6 rounded-full bg-emerald-600 px-3 py-1 text-xs font-bold uppercase tracking-wider text-white shadow-md flex items-center gap-1">
                <CheckCircle2 className="size-3.5" /> Current Active Plan
              </span>
            )}
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                  Free Plan
                </span>
                <Zap className="size-5 text-emerald-400" />
              </div>
              <h2 className="text-2xl font-bold text-foreground">Free Starter</h2>
              <div className="flex items-baseline gap-1">
                <span className="text-4xl font-extrabold tracking-tight text-foreground">₹0</span>
                <span className="text-sm text-muted-foreground">/ 50 Free Credits</span>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Perfect for exploring SIMP AI. Get 50 free credits upon activation after login or registration.
              </p>

              <div className="border-t border-border pt-4 space-y-3">
                <p className="text-xs font-semibold uppercase tracking-wider text-foreground">
                  Included Features:
                </p>
                <ul className="space-y-2.5 text-xs text-muted-foreground">
                  <li className="flex items-center gap-2 font-medium text-foreground">
                    <Check className="size-4 text-emerald-400 shrink-0" />
                    <span>50 Total AI Chat Message turns</span>
                  </li>
                  <li className="flex items-center gap-2">
                    <Check className="size-4 text-emerald-400 shrink-0" />
                    <span>Real-Time Web Search &amp; Tool Calling</span>
                  </li>
                  <li className="flex items-center gap-2">
                    <Check className="size-4 text-emerald-400 shrink-0" />
                    <span>Secure Cloud Thread History &amp; Sync</span>
                  </li>
                </ul>
              </div>
            </div>

            <Button
              type="button"
              onClick={handleActivateFree}
              disabled={activatingFree || currentPlan === "free" || currentPlan === "paid" || loading}
              variant="outline"
              className={cn(
                "w-full justify-center gap-2 py-3 text-xs font-semibold cursor-pointer",
                (currentPlan === "free" || currentPlan === "paid") &&
                  "border-emerald-500/50 bg-emerald-500/10 text-emerald-400 opacity-100 cursor-default",
              )}
            >
              {activatingFree ? (
                <>
                  <Loader2 className="size-4 animate-spin" /> Activating...
                </>
              ) : currentPlan === "free" || currentPlan === "paid" ? (
                <>
                  <CheckCircle2 className="size-4 text-emerald-400" /> Current Plan Active ({currentCredits} Credits Left)
                </>
              ) : (
                <>
                  <Zap className="size-4 text-emerald-400" /> Activate Free 50 Credits
                </>
              )}
            </Button>
          </div>
        </div>

        {/* FAQ Accordion Section */}
        <div className="space-y-4 max-w-4xl mx-auto pt-4">
          <div className="text-center space-y-1 mb-6">
            <h3 className="text-xl font-bold font-display text-foreground flex items-center justify-center gap-2">
              <HelpCircle className="size-5 text-primary" /> Frequently Asked Questions
            </h3>
            <p className="text-xs text-muted-foreground">
              Click any question below to view answers about credits and plans.
            </p>
          </div>

          <div className="space-y-3">
            {FAQS.map((faq, index) => {
              const isOpen = openFaq === index;
              return (
                <div
                  key={faq.q}
                  className="rounded-2xl border border-border bg-sidebar/90 overflow-hidden transition-all duration-300 shadow-xs hover:border-primary/40"
                >
                  <button
                    type="button"
                    onClick={() => setOpenFaq(isOpen ? null : index)}
                    className="flex w-full items-center justify-between p-4.5 text-left font-medium text-xs sm:text-sm text-foreground hover:bg-elevated/50 transition-colors cursor-pointer"
                    aria-expanded={isOpen}
                  >
                    <span className="font-semibold">{faq.q}</span>
                    <ChevronDown
                      className={cn(
                        "size-4 text-muted-foreground transition-transform duration-300 ease-in-out shrink-0 ml-3",
                        isOpen && "rotate-180 text-primary",
                      )}
                    />
                  </button>

                  <div
                    className={cn(
                      "grid transition-[grid-template-rows,opacity,padding] duration-300 ease-in-out border-t border-border/40 bg-surface/40",
                      isOpen
                        ? "grid-rows-[1fr] opacity-100 py-3.5 px-4.5"
                        : "grid-rows-[0fr] opacity-0 py-0 px-4.5 border-t-transparent",
                    )}
                  >
                    <div className="overflow-hidden text-xs text-muted-foreground leading-relaxed">
                      {faq.a}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </main>
    </div>
  );
}
