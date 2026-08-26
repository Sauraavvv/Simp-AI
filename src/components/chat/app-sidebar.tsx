"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  AudioLines,
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  Image as ImageIcon,
  MessageSquare,
  Plus,
  Trash2,
  Video as VideoIcon,
  Wrench,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ProfileAvatarMenu } from "@/components/auth/profile-avatar-menu";
import { AuthModal } from "@/components/auth/auth-modal";
import { showToast } from "@/components/ui/toast";
import { AUTH_CHANGED_EVENT, useSession } from "@/lib/auth";
import { useTheme } from "@/lib/theme";
import {
  ACTIVE_CONVERSATION_CHANGED,
  CONVERSATIONS_CHANGED,
  SELECT_CONVERSATION,
  type Conversation,
} from "@/lib/types";
import { cn } from "@/lib/utils";

/** Bucket a conversation by how long ago it was last touched. */
function groupOf(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days < 1) return "Today";
  if (days < 2) return "Yesterday";
  if (days < 7) return "Previous 7 Days";
  return "Older";
}

const GROUP_ORDER = ["Today", "Yesterday", "Previous 7 Days", "Older"];

/** Main top navigation links in the sidebar. */
const MAIN_SECTIONS = [
  { href: "/voice", label: "AI Voice Chat", icon: AudioLines },
] as const;

function cleanTitle(rawTitle: string): string {
  if (!rawTitle) return "New Conversation";
  let cleaned = rawTitle
    .replace(/===ATTACHMENT_START:[\s\S]*?===/g, "")
    .replace(/===ATTACHMENT_END===/g, "")
    .replace(/【.*?】/g, "")
    .replace(/^#+\s*/, "")
    .replace(/^\*\*|\*\*$/g, "")
    .trim();

  cleaned = cleaned.replace(/\s+/g, " ");

  if (!cleaned) return "Attachment File";

  if (cleaned.length > 38) {
    cleaned = cleaned.slice(0, 38).trim() + "...";
  }

  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

const CACHED_CONVERSATIONS_KEY = "simp_cached_conversations";

function getStoredConversations(): Conversation[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(CACHED_CONVERSATIONS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function setStoredConversations(conversations: Conversation[]) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(CACHED_CONVERSATIONS_KEY, JSON.stringify(conversations));
  } catch {
    // Ignore storage quota errors
  }
}

export function AppSidebar({
  collapsed,
  onToggle,
  onItemClick,
}: {
  collapsed: boolean;
  onToggle: () => void;
  onItemClick?: () => void;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [mounted, setMounted] = useState(false);
  const pathname = usePathname();
  const router = useRouter();
  const onChatPage = pathname === "/";

  const isToolsActive = pathname.startsWith("/tools");
  const [userToggledTools, setUserToggledTools] = useState<boolean | null>(null);

  // Synchronous state resolution: stays open smoothly on /tools/* routes with zero transition flicker
  const toolsOpen = userToggledTools !== null ? userToggledTools : isToolsActive;

  useEffect(() => {
    setMounted(true);
    setConversations(getStoredConversations());
  }, []);

  const { user, loading: sessionLoading } = useSession();
  const { resolvedTheme } = useTheme();
  const signedIn = Boolean(user);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authTab, setAuthTab] = useState<"login" | "register">("login");

  function selectThread(id: string | null) {
    setActiveId(id);
    onItemClick?.();
    if (onChatPage) {
      window.dispatchEvent(new CustomEvent(SELECT_CONVERSATION, { detail: { id } }));
    } else {
      router.push(id ? `/?c=${encodeURIComponent(id)}` : "/");
    }
  }

  const load = useCallback(
    () =>
      fetch("/api/conversations", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((data: { conversations?: Conversation[] } | null) => {
          if (data?.conversations) {
            setConversations(data.conversations);
            setStoredConversations(data.conversations);
          }
        })
        .catch(() => {}),
    [],
  );

  useEffect(() => {
    if (!signedIn) return;
    load();
    window.addEventListener(CONVERSATIONS_CHANGED, load);
    return () => window.removeEventListener(CONVERSATIONS_CHANGED, load);
  }, [load, signedIn]);

  useEffect(() => {
    function onAuthChange() {
      setActiveId(null);
      setConversations([]);
      if (typeof window !== "undefined") {
        localStorage.removeItem(CACHED_CONVERSATIONS_KEY);
      }
    }
    window.addEventListener(AUTH_CHANGED_EVENT, onAuthChange);
    return () => window.removeEventListener(AUTH_CHANGED_EVENT, onAuthChange);
  }, []);

  // The chat page assigns a conversation id itself -- on the first message of a
  // new chat, or when opened via a `?c=` link -- neither of which goes through
  // selectThread() below. This is how the sidebar learns to highlight it.
  useEffect(() => {
    function onActiveChanged(e: Event) {
      const id = (e as CustomEvent<{ id: string }>).detail?.id;
      if (id) setActiveId(id);
    }
    window.addEventListener(ACTIVE_CONVERSATION_CHANGED, onActiveChanged);
    return () => window.removeEventListener(ACTIVE_CONVERSATION_CHANGED, onActiveChanged);
  }, []);

  async function remove(id: string) {
    try {
      const res = await fetch(`/api/conversations/${id}`, { method: "DELETE" });
      if (res.ok) {
        if (id === activeId) selectThread(null);
        setConversations((prev) => {
          const next = prev.filter((c) => c.id !== id);
          setStoredConversations(next);
          return next;
        });
        load();
        showToast("Conversation deleted successfully", "success");
      } else {
        showToast("Failed to delete conversation", "error");
      }
    } catch {
      showToast("Error deleting conversation", "error");
    }
  }

  return (
    <aside
      className="flex h-full w-full flex-col bg-sidebar text-sidebar-foreground overflow-hidden"
    >
      <div className="flex items-center justify-between px-3.5 py-3">
        {collapsed ? (
          <Button
            variant="ghost"
            size="icon"
            onClick={onToggle}
            aria-label="Expand sidebar"
            className="mx-auto size-8 text-sidebar-foreground hover:bg-sidebar-accent"
            title="Expand sidebar"
          >
            <ChevronsRight className="size-4" />
          </Button>
        ) : (
          <>
            <div className="flex items-center gap-2 min-w-0">
              <img
                src={resolvedTheme === "dark" ? "/simp-icon-dark.png" : "/simp-icon-light.png"}
                alt=""
                className="size-9 shrink-0 rounded-lg object-cover"
              />
              <img
                src={resolvedTheme === "dark" ? "/simp-logo-dark.png" : "/simp-logo.png"}
                alt="Simp AI"
                className="h-9 w-auto object-contain"
              />
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={onToggle}
              aria-label="Collapse sidebar"
              className="size-7 text-sidebar-foreground hover:bg-sidebar-accent shrink-0"
              title="Collapse sidebar"
            >
              <ChevronsLeft className="size-4" />
            </Button>
          </>
        )}
      </div>

      {mounted && !sessionLoading && signedIn && collapsed && (
        <div className="px-3 pb-2">
          <Button
            variant="secondary"
            onClick={() => selectThread(null)}
            className={cn(
              "w-full justify-center gap-2 border px-0 text-sm cursor-pointer transition-colors",
              activeId === null
                ? "border-primary/40 bg-sidebar-accent text-sidebar-accent-foreground"
                : "border-border bg-elevated/70 hover:bg-elevated",
            )}
            title="New Conversation"
          >
            <Plus className="size-4 text-primary" />
          </Button>
        </div>
      )}

      {collapsed && (
        <nav className="space-y-0.5 px-3 pb-2">
          {MAIN_SECTIONS.map((section) => {
            const current = pathname === section.href;
            return (
              <Link
                key={section.href}
                href={section.href}
                onClick={() => onItemClick?.()}
                title={section.label}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "flex items-center justify-center gap-2 rounded-md px-0 py-2 text-sm transition-colors",
                  current
                    ? "bg-sidebar-accent text-sidebar-accent-foreground font-semibold"
                    : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
                )}
              >
                <section.icon className={cn("size-4 shrink-0", current && "text-primary")} />
              </Link>
            );
          })}

          <button
            type="button"
            onClick={() => {
              onToggle();
              setUserToggledTools(true);
            }}
            title="All Tools"
            className={cn(
              "flex w-full items-center justify-center gap-2 rounded-md px-0 py-2 text-sm transition-colors cursor-pointer select-none",
              isToolsActive
                ? "bg-sidebar-accent/50 text-sidebar-accent-foreground font-medium"
                : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
            )}
          >
            <Wrench className={cn("size-4 shrink-0", isToolsActive && "text-primary")} />
          </button>
        </nav>
      )}

      {!collapsed && (
        <div className="mx-3 mt-1 mb-3 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-sidebar-border bg-elevated/40">
          {mounted && !sessionLoading && signedIn && (
            <div className="shrink-0 border-b border-sidebar-border/60 p-2">
              <Button
                variant="secondary"
                onClick={() => selectThread(null)}
                className={cn(
                  "w-full justify-start gap-2 border-0 text-sm cursor-pointer transition-colors",
                  activeId === null
                    ? "bg-sidebar-accent text-sidebar-accent-foreground font-semibold hover:bg-sidebar-accent"
                    : "bg-sidebar hover:bg-sidebar-accent",
                )}
              >
                <Plus className="size-4 text-primary" />
                New Conversation
              </Button>
            </div>
          )}

          <nav className="shrink-0 space-y-0.5 p-2 border-b border-sidebar-border/60">
            {MAIN_SECTIONS.map((section) => {
              const current = pathname === section.href;
              return (
                <Link
                  key={section.href}
                  href={section.href}
                  onClick={() => onItemClick?.()}
                  aria-current={current ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2.5 py-2 text-sm transition-colors",
                    current
                      ? "bg-sidebar-accent text-sidebar-accent-foreground font-semibold"
                      : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
                  )}
                >
                  <section.icon className={cn("size-4 shrink-0", current && "text-primary")} />
                  {section.label}
                </Link>
              );
            })}

            {/* All Tools Accordion Header */}
            <div>
              <button
                type="button"
                onClick={() => setUserToggledTools(!toolsOpen)}
                className={cn(
                  "flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-2 text-sm transition-colors cursor-pointer select-none",
                  isToolsActive
                    ? "bg-sidebar-accent/50 text-sidebar-accent-foreground font-medium"
                    : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
                )}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <Wrench className={cn("size-4 shrink-0", isToolsActive && "text-primary")} />
                  <span>All Tools</span>
                </div>
                <ChevronDown
                  className={cn(
                    "size-3.5 text-muted-foreground/70 transition-transform duration-300 ease-in-out shrink-0",
                    toolsOpen && "rotate-180 text-primary",
                  )}
                />
              </button>

              {/* Smooth Dropdown Content */}
              <div
                className={cn(
                  "grid transition-[grid-template-rows,opacity] duration-300 ease-in-out pl-3.5 border-l border-sidebar-border/60 ml-4.5 my-1",
                  toolsOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0 overflow-hidden pointer-events-none",
                )}
              >
                <div className="overflow-hidden space-y-0.5 pt-0.5">
                  <Link
                    href="/tools/image"
                    onClick={() => onItemClick?.()}
                    className={cn(
                      "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs transition-colors",
                      pathname === "/tools/image"
                        ? "bg-sidebar-accent text-primary font-semibold"
                        : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
                    )}
                  >
                    <ImageIcon className="size-3.5 shrink-0 opacity-70" />
                    <span>Image Generator</span>
                  </Link>
                  <Link
                    href="/tools/video"
                    onClick={() => onItemClick?.()}
                    className={cn(
                      "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs transition-colors",
                      pathname === "/tools/video"
                        ? "bg-sidebar-accent text-primary font-semibold"
                        : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
                    )}
                  >
                    <VideoIcon className="size-3.5 shrink-0 opacity-70" />
                    <span>Video Generator</span>
                  </Link>
                </div>
              </div>
            </div>
          </nav>

          {mounted && !sessionLoading && !signedIn && (
            <div className="min-h-0 flex-1 overflow-y-auto p-2.5 space-y-1">
              <p className="flex items-center gap-1.5 text-[11.5px] font-semibold text-foreground">
                <MessageSquare className="size-3 text-primary shrink-0" />
                Guest Chat (Unsaved)
              </p>
              <p className="text-[11px] leading-snug text-muted-foreground">
                Temporary window.{" "}
                <button
                  type="button"
                  onClick={() => {
                    setAuthTab("login");
                    setAuthModalOpen(true);
                  }}
                  className="font-medium text-primary hover:text-primary/80 transition-colors no-underline cursor-pointer"
                >
                  Log in / Register
                </button>{" "}
                to save history &amp; unlock 50 free credits.
              </p>

              <AuthModal
                open={authModalOpen}
                onClose={() => setAuthModalOpen(false)}
                initialTab={authTab}
              />
            </div>
          )}

          {mounted && !sessionLoading && signedIn && (
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              <p className="px-2.5 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                Recent Chat
              </p>
              {conversations.length === 0 ? (
                <p className="px-2.5 py-2 text-[12px] text-muted-foreground/70">
                  No conversations yet. Ask something to start one.
                </p>
              ) : (
                GROUP_ORDER.map((group) => {
                  const rows = conversations.filter((c) => groupOf(c.updated_at) === group);
                  if (!rows.length) return null;
                  return (
                    <div key={group} className="mb-4">
                      <p className="px-2.5 pb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
                        {group}
                      </p>
                      <div className="space-y-0.5">
                        {rows.map((c) => (
                          <div
                            key={c.id}
                            className={cn(
                              "group flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                              c.id === activeId && "bg-sidebar-accent text-sidebar-accent-foreground",
                            )}
                          >
                            <MessageSquare className="size-3.5 shrink-0 opacity-70" />
                            <button
                              onClick={() => selectThread(c.id)}
                              className="min-w-0 flex-1 truncate text-left cursor-pointer"
                              title={cleanTitle(c.title)}
                            >
                              {cleanTitle(c.title)}
                            </button>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                remove(c.id);
                              }}
                              className="opacity-0 transition-opacity group-hover:opacity-100 rounded-md p-1 text-muted-foreground hover:bg-destructive/15 hover:text-destructive cursor-pointer"
                              title="Delete conversation"
                              aria-label={`Delete ${cleanTitle(c.title)}`}
                            >
                              <Trash2 className="size-3.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          )}

          <div className="shrink-0 border-t border-sidebar-border/60">
            <ProfileAvatarMenu collapsed={false} onNavigate={onItemClick ?? onToggle} />
          </div>
        </div>
      )}

      {collapsed && (
        <div className="mt-auto px-3 pb-3">
          <ProfileAvatarMenu collapsed onNavigate={onItemClick ?? onToggle} />
        </div>
      )}
    </aside>
  );
}
