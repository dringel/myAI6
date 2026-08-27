import { UIMessage } from "ai";
import { nanoid } from "nanoid";

export type Conversation = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
};

type ConversationData = {
  messages: UIMessage[];
  durations: Record<string, number>;
  /** Stored summary from conversation compaction */
  compactedSummary?: string;
  /** Number of messages that were summarized (messages before this index are in the summary) */
  summarizedUpTo?: number;
  /** Server-issued HMAC over the summary; sent back so the server accepts it */
  compactedSignature?: string;
  /** Feedback ratings per message ID: "up" or "down" */
  feedback?: Record<string, "up" | "down">;
};

const INDEX_KEY = "chat-conversations";
const DATA_PREFIX = "chat-data-";

function getIndex(): Conversation[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(INDEX_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveIndex(conversations: Conversation[]) {
  if (typeof window === "undefined") return;
  localStorage.setItem(INDEX_KEY, JSON.stringify(conversations));
}

export function listConversations(): Conversation[] {
  return getIndex().sort((a, b) => b.updatedAt - a.updatedAt);
}

export function createConversation(title?: string): Conversation {
  const conv: Conversation = {
    id: nanoid(),
    title: title || "New Chat",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const index = getIndex();
  index.push(conv);
  saveIndex(index);
  saveConversationData(conv.id, { messages: [], durations: {} });
  return conv;
}

export function deleteConversation(id: string) {
  const index = getIndex().filter((c) => c.id !== id);
  saveIndex(index);
  if (typeof window !== "undefined") {
    localStorage.removeItem(DATA_PREFIX + id);
  }
}

export function updateConversationTitle(id: string, title: string) {
  const index = getIndex();
  const conv = index.find((c) => c.id === id);
  if (conv) {
    conv.title = title;
    saveIndex(index);
  }
}

export function loadConversationData(id: string): ConversationData {
  if (typeof window === "undefined") return { messages: [], durations: {} };
  try {
    const raw = localStorage.getItem(DATA_PREFIX + id);
    if (!raw) return { messages: [], durations: {} };
    const parsed = JSON.parse(raw);
    return {
      messages: parsed.messages || [],
      durations: parsed.durations || {},
      // Preserve compaction and feedback fields
      ...(parsed.compactedSummary ? { compactedSummary: parsed.compactedSummary } : {}),
      ...(parsed.summarizedUpTo !== undefined ? { summarizedUpTo: parsed.summarizedUpTo } : {}),
      ...(parsed.compactedSignature ? { compactedSignature: parsed.compactedSignature } : {}),
      ...(parsed.feedback ? { feedback: parsed.feedback } : {}),
    };
  } catch {
    return { messages: [], durations: {} };
  }
}

export function saveConversationData(
  id: string,
  data: ConversationData
) {
  if (typeof window === "undefined") return;
  localStorage.setItem(DATA_PREFIX + id, JSON.stringify(data));

  // Update the updatedAt timestamp
  const index = getIndex();
  const conv = index.find((c) => c.id === id);
  if (conv) {
    conv.updatedAt = Date.now();
    // Auto-title from first user message if still "New Chat"
    if (conv.title === "New Chat" && data.messages.length > 0) {
      const firstUserMsg = data.messages.find((m) => m.role === "user");
      if (firstUserMsg) {
        const text = firstUserMsg.parts
          .filter((p) => p.type === "text")
          .map((p: any) => p.text)
          .join(" ")
          .trim();
        if (text) {
          conv.title = text.slice(0, 50) + (text.length > 50 ? "..." : "");
        }
      }
    }
    saveIndex(index);
  }
}

/** Save compacted summary for a conversation */
export function saveCompactedSummary(
  id: string,
  summary: string,
  summarizedUpTo: number,
  signature: string
) {
  const data = loadConversationData(id);
  data.compactedSummary = summary;
  data.summarizedUpTo = summarizedUpTo;
  data.compactedSignature = signature;
  saveConversationData(id, data);
}

/** Load compacted summary for a conversation */
export function loadCompactedSummary(id: string): {
  summary: string;
  summarizedUpTo: number;
  signature: string;
} | null {
  const data = loadConversationData(id);
  if (
    data.compactedSummary &&
    data.summarizedUpTo !== undefined &&
    data.compactedSignature
  ) {
    return {
      summary: data.compactedSummary,
      summarizedUpTo: data.summarizedUpTo,
      signature: data.compactedSignature,
    };
  }
  return null;
}

/** Save feedback rating for a message */
export function saveFeedback(conversationId: string, messageId: string, rating: "up" | "down") {
  const data = loadConversationData(conversationId);
  data.feedback = data.feedback || {};
  data.feedback[messageId] = rating;
  saveConversationData(conversationId, data);
}

/** Load all feedback for a conversation */
export function loadFeedback(conversationId: string): Record<string, "up" | "down"> {
  const data = loadConversationData(conversationId);
  return data.feedback || {};
}

// Migration: move old single-chat format to multi-thread
export function migrateFromLegacyStorage(): string | null {
  if (typeof window === "undefined") return null;

  const legacyKey = "chat-messages";
  const raw = localStorage.getItem(legacyKey);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    const messages = parsed.messages || [];
    const durations = parsed.durations || {};

    if (messages.length === 0) {
      localStorage.removeItem(legacyKey);
      return null;
    }

    const conv = createConversation();
    saveConversationData(conv.id, { messages, durations });
    localStorage.removeItem(legacyKey);
    return conv.id;
  } catch {
    localStorage.removeItem(legacyKey);
    return null;
  }
}
