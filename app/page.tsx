"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import * as z from "zod";

import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, UIMessage } from "ai";
import {
  ArrowUp,
  Download,
  FileText,
  PanelLeft,
  Plus,
  Square,
} from "lucide-react";
import { ThinkingIndicator } from "@/components/ai-elements/thinking-indicator";
import { MessageWall } from "@/components/messages/message-wall";
import { ChatHeader, ChatHeaderBlock } from "@/app/parts/chat-header";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useEffect, useState, useRef, useCallback } from "react";
import { AI_NAME, CLEAR_CHAT_TEXT, OWNER_NAME, WELCOME_MESSAGE, COMPACTION_ENABLED, COMPACTION_TOKEN_THRESHOLD, COMPACTION_SHOW_CONTEXT_MEMORY, MAX_MESSAGE_TEXT_LENGTH } from "@/config";
import Image from "next/image";
import Link from "next/link";
import { ConversationSidebar } from "@/components/conversation-sidebar";
import {
  createConversation,
  loadConversationData,
  saveConversationData,
  migrateFromLegacyStorage,
  listConversations,
  loadCompactedSummary,
  saveCompactedSummary,
  loadFeedback,
} from "@/lib/storage";

const formSchema = z.object({
  message: z
    .string()
    .min(1, "Message cannot be empty.")
    // Same limit the server enforces (config.ts), so the form never accepts
    // a message the API would reject.
    .max(MAX_MESSAGE_TEXT_LENGTH, `Message must be at most ${MAX_MESSAGE_TEXT_LENGTH} characters.`),
});

export default function Chat() {
  const [isClient, setIsClient] = useState(false);
  const [durations, setDurations] = useState<Record<string, number>>({});
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showContextMemory, setShowContextMemory] = useState(false);
  const welcomeMessageShownRef = useRef<boolean>(false);

  // Compaction state: stored summary persists across requests
  const summaryRef = useRef<{ summary: string; summarizedUpTo: number; signature: string } | null>(null);
  const activeConvIdRef = useRef<string | null>(null);

  // Keep ref in sync with state
  useEffect(() => {
    activeConvIdRef.current = activeConvId;
  }, [activeConvId]);

  // Load stored summary when conversation changes
  useEffect(() => {
    if (isClient && activeConvId) {
      const stored = loadCompactedSummary(activeConvId);
      summaryRef.current = stored;
    }
  }, [isClient, activeConvId]);

  const { messages, sendMessage, status, stop, setMessages } = useChat({
    transport: new DefaultChatTransport({
      api: "/api/chat",
      fetch: async (url, options) => {
        // Inject compaction summary via headers (body modification doesn't work with SDK)
        const headers = new Headers(options?.headers);
        if (summaryRef.current) {
          headers.set("X-Compacted-Summary", btoa(unescape(encodeURIComponent(summaryRef.current.summary))));
          headers.set("X-Compacted-UpTo", String(summaryRef.current.summarizedUpTo));
          headers.set("X-Compacted-Signature", summaryRef.current.signature);
          // Debug: console.log(`COMPACTION: sending ${summaryRef.current.summary.length} chars, upTo: ${summaryRef.current.summarizedUpTo}`);
        }
        // Send feedback ratings for compaction quality
        if (activeConvIdRef.current) {
          const fb = loadFeedback(activeConvIdRef.current);
          if (Object.keys(fb).length > 0) {
            headers.set("X-Feedback", btoa(JSON.stringify(fb)));
          }
        }
        const response = await fetch(url, { ...options, headers });

        // Read updated summary from response headers
        const newSummaryB64 = response.headers.get("X-Compacted-Summary");
        const newUpTo = response.headers.get("X-Compacted-UpTo");
        const newSignature = response.headers.get("X-Compacted-Signature");
        // Debug: console.log(`COMPACTION: received summary=${!!newSummaryB64}, upTo=${newUpTo}`);
        if (newSummaryB64 && newUpTo && newSignature && activeConvIdRef.current) {
          try {
            const summary = decodeURIComponent(escape(atob(newSummaryB64)));
            const summarizedUpTo = parseInt(newUpTo, 10);
            summaryRef.current = { summary, summarizedUpTo, signature: newSignature };
            saveCompactedSummary(activeConvIdRef.current, summary, summarizedUpTo, newSignature);
            // Debug: console.log(`COMPACTION: saved ${summary.length} chars, upTo: ${summarizedUpTo}`);
          } catch (e) {
            console.warn("Compaction save failed:", e);
          }
        }

        return response;
      },
    }),
    experimental_throttle: 50,
    onError(error) {
      toast.error(error.message || "Something went wrong. Please try again.");
    },
  });

  // Initialize: migrate legacy storage, load or create conversation
  useEffect(() => {
    setIsClient(true);

    // Migrate from old single-chat format if present
    const migratedId = migrateFromLegacyStorage();

    const convs = listConversations();
    let convId: string;

    if (migratedId) {
      convId = migratedId;
    } else if (convs.length > 0) {
      convId = convs[0].id; // most recent
    } else {
      const newConv = createConversation();
      convId = newConv.id;
    }

    setActiveConvId(convId);
    const data = loadConversationData(convId);
    setMessages(data.messages);
    setDurations(data.durations);

    // Show welcome message if this is a fresh conversation
    if (data.messages.length === 0 && !welcomeMessageShownRef.current) {
      const welcomeMessage: UIMessage = {
        id: `welcome-${Date.now()}`,
        role: "assistant",
        parts: [{ type: "text", text: WELCOME_MESSAGE }],
      };
      setMessages([welcomeMessage]);
      saveConversationData(convId, {
        messages: [welcomeMessage],
        durations: {},
      });
      welcomeMessageShownRef.current = true;
    }
  }, []);

  // Persist messages whenever they change (preserving compaction fields)
  useEffect(() => {
    if (isClient && activeConvId) {
      const existing = loadConversationData(activeConvId);
      saveConversationData(activeConvId, {
        messages,
        durations,
        ...(existing.compactedSummary ? { compactedSummary: existing.compactedSummary } : {}),
        ...(existing.summarizedUpTo !== undefined ? { summarizedUpTo: existing.summarizedUpTo } : {}),
        ...(existing.compactedSignature ? { compactedSignature: existing.compactedSignature } : {}),
      });
    }
  }, [durations, messages, isClient, activeConvId]);

  // Compaction notification is handled by the model in its response text
  // (server instructs the model to include a notice when compaction occurs)

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: { message: "" },
  });

  function onSubmit(data: z.infer<typeof formSchema>) {
    // Include stored summary in the request body for stateful compaction
    const s = summaryRef.current;
    sendMessage({
      text: data.message,
      body: s ? { compactedSummary: s.summary, summarizedUpTo: s.summarizedUpTo } : undefined,
    } as any);
    form.reset();
  }

  function switchConversation(id: string) {
    setActiveConvId(id);
    const data = loadConversationData(id);
    setMessages(data.messages);
    setDurations(data.durations);
    welcomeMessageShownRef.current = true;
  }

  function newChat() {
    const conv = createConversation();
    setActiveConvId(conv.id);
    setDurations({});
    welcomeMessageShownRef.current = false;

    const welcomeMessage: UIMessage = {
      id: `welcome-${Date.now()}`,
      role: "assistant",
      parts: [{ type: "text", text: WELCOME_MESSAGE }],
    };
    setMessages([welcomeMessage]);
    saveConversationData(conv.id, {
      messages: [welcomeMessage],
      durations: {},
    });
    welcomeMessageShownRef.current = true;
    toast.success("New chat started");
  }

  function exportChat() {
    if (messages.length === 0) {
      toast.error("No messages to export");
      return;
    }

    const markdown = messages
      .map((msg) => {
        const role = msg.role === "user" ? "You" : AI_NAME;
        const text = msg.parts
          .filter((p) => p.type === "text")
          .map((p: any) => p.text)
          .join("\n");
        return `### ${role}\n\n${text}`;
      })
      .join("\n\n---\n\n");

    const blob = new Blob([markdown], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${AI_NAME}-chat-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Chat exported");
  }

  // Keyboard shortcuts
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey;

      if (isMod && e.key === "k") {
        e.preventDefault();
        newChat();
      }

      if (
        e.key === "Escape" &&
        (status === "streaming" || status === "submitted")
      ) {
        e.preventDefault();
        stop();
      }

      if (isMod && e.key === "b") {
        e.preventDefault();
        setSidebarOpen((prev) => !prev);
      }
    },
    [status, stop]
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  return (
    <div className="flex h-screen font-sans dark:bg-black">
      {/* Sidebar — overlay on mobile (<md), inline on desktop */}
      {isClient && sidebarOpen && (
        <>
          {/* Mobile backdrop */}
          <div
            className="fixed inset-0 z-40 bg-black/40 md:hidden"
            onClick={() => setSidebarOpen(false)}
            aria-hidden="true"
          />
          <div className="fixed inset-y-0 left-0 z-50 md:static md:z-auto">
            <ConversationSidebar
              key={`sidebar-${activeConvId}-${messages.length}`}
              activeId={activeConvId}
              onSelect={(id) => {
                switchConversation(id);
                if (typeof window !== "undefined" && !window.matchMedia("(min-width: 768px)").matches) setSidebarOpen(false);
              }}
              onNew={() => {
                newChat();
                if (typeof window !== "undefined" && !window.matchMedia("(min-width: 768px)").matches) setSidebarOpen(false);
              }}
              onClose={() => setSidebarOpen(false)}
            />
          </div>
        </>
      )}

      <main className="relative h-screen flex-1 min-w-0">
        <div className={`fixed top-0 right-0 z-50 pb-16 pointer-events-none ${sidebarOpen ? 'left-0 md:left-64' : 'left-0'}`}>
          <ChatHeader>
            <ChatHeaderBlock>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => setSidebarOpen((prev) => !prev)}
                aria-label="Toggle sidebar"
              >
                <PanelLeft className="size-4" />
              </Button>
            </ChatHeaderBlock>
            <ChatHeaderBlock className="justify-center items-center" />

            <ChatHeaderBlock className="justify-end gap-2">
              {/* Context Memory dropdown (toggle via COMPACTION_SHOW_CONTEXT_MEMORY in config) */}
              {(() => {
                if (!COMPACTION_SHOW_CONTEXT_MEMORY) return null;
                const cs = activeConvId ? loadCompactedSummary(activeConvId) : null;
                if (!cs) return null;
                return (
                  <div className="relative">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setShowContextMemory(!showContextMemory)}
                      aria-label="Context Memory"
                      className="h-8 w-8"
                      title={`Context Memory (${cs.summarizedUpTo} messages summarized)`}
                    >
                      <FileText className="size-4" />
                    </Button>
                    {showContextMemory && (
                      <div className="absolute right-0 top-10 z-50 w-80 max-h-64 overflow-y-auto rounded-md border bg-background p-3 shadow-lg">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-xs font-medium">Context Memory</span>
                          <span className="text-[10px] text-muted-foreground">{cs.summarizedUpTo} messages summarized</span>
                        </div>
                        <p className="text-xs text-muted-foreground whitespace-pre-wrap leading-relaxed">
                          {cs.summary}
                        </p>
                      </div>
                    )}
                  </div>
                );
              })()}
              <Button
                variant="ghost"
                size="icon"
                onClick={exportChat}
                aria-label="Export chat"
                className="h-8 w-8"
              >
                <Download className="size-4" />
              </Button>
              <Button variant="outline" size="sm" onClick={newChat} aria-label="New chat">
                <Plus className="size-4" />
                {CLEAR_CHAT_TEXT}
              </Button>
            </ChatHeaderBlock>
          </ChatHeader>
        </div>

        <div className="h-screen w-full overflow-y-auto px-3 sm:px-5 py-4 pt-[88px] pb-[170px]">
          <div className="flex min-h-full flex-col items-center justify-end">
            {isClient && (
              <>
                <MessageWall
                  messages={messages}
                  status={status}
                  durations={durations}
                  conversationId={activeConvId ?? undefined}
                  onDurationChange={(k, d) =>
                    setDurations((prev) => ({
                      ...prev,
                      [k]: d,
                    }))
                  }
                />
                {status === "submitted" && (
                  <div className="max-w-3xl w-full">
                    <ThinkingIndicator isCompacting={(() => {
                      if (!COMPACTION_ENABLED || messages.length <= 4) return false;
                      let chars = 0;
                      for (const msg of messages) {
                        for (const part of msg.parts) {
                          const p = part as any;
                          chars += p.type === "text" ? (p.text?.length ?? 0) : JSON.stringify(p).length;
                        }
                      }
                      return Math.ceil(chars / 4) >= COMPACTION_TOKEN_THRESHOLD;
                    })()} />
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        <div className="fixed bottom-0 left-0 right-0 z-50 overflow-visible bg-linear-to-t from-background via-background/60 to-transparent pt-6 pb-3">
          <div className="relative mx-auto max-w-3xl px-3 sm:px-5">
            <div className="message-fade-overlay" />

            <form onSubmit={form.handleSubmit(onSubmit)}>
              <FieldGroup>
                <Controller
                  name="message"
                  control={form.control}
                  render={({ field, fieldState }) => (
                    <Field data-invalid={fieldState.invalid}>
                      <FieldLabel className="sr-only">Message</FieldLabel>

                      <div className="relative">
                        {/* Multi-line input: Enter sends, Shift+Enter inserts a
                            newline. Grows with content (field-sizing) up to
                            max-h, then scrolls. */}
                        <Textarea
                          {...field}
                          rows={1}
                          className="min-h-14 max-h-48 resize-none overflow-y-auto rounded-[20px] bg-card pl-5 pr-14 py-[18px] leading-5"
                          placeholder="Type your message here... (Shift+Enter for a new line)"
                          disabled={status === "streaming"}
                          aria-invalid={fieldState.invalid}
                          autoComplete="off"
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.shiftKey) {
                              e.preventDefault();
                              form.handleSubmit(onSubmit)();
                            }
                          }}
                        />

                        {(status === "ready" || status === "error") && (
                          <Button
                            className="absolute bottom-2.5 right-3 rounded-full"
                            type="submit"
                            disabled={!field.value?.trim()}
                            size="icon"
                          >
                            <ArrowUp className="size-4" />
                          </Button>
                        )}

                        {(status === "streaming" ||
                          status === "submitted") && (
                          <Button
                            className="absolute bottom-2.5 right-3 rounded-full"
                            size="icon"
                            type="button"
                            onClick={() => stop()}
                          >
                            <Square className="size-4" />
                          </Button>
                        )}
                      </div>
                    </Field>
                  )}
                />
              </FieldGroup>
            </form>

            <div className="mt-2 text-center text-xs text-muted-foreground">
              &copy; {new Date().getFullYear()} {OWNER_NAME}{" "}
              <Link href="/terms" className="underline">
                Terms of Use
              </Link>{" "}
              Powered by{" "}
              <Link href="https://www.ringel.ai" className="underline">
                ringel.AI
              </Link>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
