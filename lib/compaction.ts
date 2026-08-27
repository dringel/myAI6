/**
 * Stateful conversation compaction with LLM summarization.
 *
 * Flow:
 * 1. Client stores summary in localStorage (via storage.ts)
 * 2. Client sends summary + summarizedUpTo in request body
 * 3. Server uses existing summary + only summarizes NEW messages (incremental, fast)
 * 4. Server returns updated summary in response headers
 * 5. Client saves the new summary
 */

import { UIMessage, generateText } from "ai";
import { getUtilityModel, utilityProviderOptions } from "@/lib/ai/model-registry";
import {
  COMPACTION_ENABLED,
  COMPACTION_TOKEN_THRESHOLD,
  COMPACTION_KEEP_RECENT,
  COMPACTION_CHARS_PER_TOKEN,
  COMPACTION_MAX_SUMMARY_WORDS,
  COMPACTION_MAX_SUMMARY_CHARS,
} from "@/config";

const isDev = process.env.NODE_ENV === "development";
function log(...args: any[]) { if (isDev) console.log(...args); }
function warn(...args: any[]) { console.warn(...args); }

function estimateTokens(messages: UIMessage[]): number {
  let chars = 0;
  for (const msg of messages) {
    for (const part of msg.parts) {
      const p = part as any;
      if (p.type === "text") chars += p.text?.length ?? 0;
      else if (p.type === "reasoning") chars += p.text?.length ?? 0;
      // data-* parts (e.g. data-sources) are UI-only: convertToModelMessages
      // drops them, so they cost no model tokens.
      else if (typeof p.type === "string" && p.type.startsWith("data-")) continue;
      else chars += JSON.stringify(p).length;
    }
  }
  return Math.ceil(chars / COMPACTION_CHARS_PER_TOKEN);
}

function messageText(msg: UIMessage): string {
  return msg.parts
    .filter((p) => p.type === "text")
    .map((p) => (p as any).text ?? "")
    .join(" ")
    .trim();
}

function extractSourceUrls(messages: UIMessage[]): string[] {
  const urls = new Set<string>();
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type?.startsWith("tool-")) {
        const resultStr = JSON.stringify((part as any).result ?? (part as any).output ?? "");
        const matches = resultStr.match(/https?:\/\/[^\s"',\])+]+/g);
        if (matches) {
          for (const url of matches) {
            if (!url.match(/\.(png|jpg|jpeg|gif|svg|webp)$/i)) urls.add(url);
          }
        }
      }
    }
  }
  return [...urls];
}

/** Fast extractive summary — no LLM, instant */
function createExtractiveSummary(messages: UIMessage[], existingSummary?: string): string {
  const lines = messages.map((m) => {
    const text = messageText(m);
    return text ? `${m.role === "user" ? "User" : "Assistant"}: ${text.slice(0, 250)}...` : "";
  }).filter(Boolean);

  const urls = extractSourceUrls(messages);
  let content = lines.join("\n");
  if (urls.length > 0) content += "\n\n[Sources]\n" + urls.map(u => `- ${u}`).join("\n");

  if (existingSummary) {
    const combined = `${existingSummary}\n\n${content}`;
    return combined.length > 4000 ? combined.slice(-4000) : combined;
  }
  return content;
}

/**
 * LLM-powered summarization that merges existing summary + new content into ONE bounded summary.
 * Naturally gives more weight to recent content while preserving key earlier facts.
 */
async function summarizeWithLLM(text: string, messageCount: number): Promise<string | null> {
  try {
    const capped = text.length > 20000 ? text.slice(0, 20000) + "\n...[truncated]" : text;
    const result = await generateText({
      model: getUtilityModel(),
      system:
        "You merge conversation context into a single comprehensive summary.\n" +
        `Stay under ${COMPACTION_MAX_SUMMARY_WORDS} words but use as many as needed to preserve important content.\n` +
        "Rules:\n" +
        "- The input has TWO parts: [Existing summary] and [New messages to incorporate]\n" +
        "- KEEP all key content from the existing summary — do NOT drop or replace it\n" +
        "- ADD new information from the new messages into the appropriate sections\n" +
        "- If new messages update or refine earlier points, integrate them (don't create duplicates)\n" +
        "- Use structured sections with headers and bullet points\n" +
        "- Preserve ALL source URLs, DOIs, and citation references exactly\n" +
        "- Preserve key decisions, recommendations, facts, and analysis\n" +
        "- Only compress content that is truly redundant or superseded by newer information\n" +
        "- Messages marked [IMPORTANT] should be preserved with more detail in the summary",
      prompt: `Merge this conversation context (${messageCount} messages total) into one unified summary under ${COMPACTION_MAX_SUMMARY_WORDS} words:\n\n${capped}`,
      providerOptions: utilityProviderOptions(),
    });
    let summary = result.text.trim();
    // Hard safety cap (shouldn't trigger if LLM follows word limit)
    if (summary.length > COMPACTION_MAX_SUMMARY_CHARS) {
      warn(`COMPACTION: Summary exceeded hard cap (${summary.length} chars), truncating`);
      summary = summary.slice(0, COMPACTION_MAX_SUMMARY_CHARS);
    }
    log(`COMPACTION: Summary generated (${summary.length} chars, ~${summary.split(/\s+/).length} words)`);
    return summary;
  } catch (error) {
    console.warn("LLM summarization failed:", error);
    return null;
  }
}

export type CompactionResult = {
  messages: UIMessage[];
  compacted: boolean;
  newSummary?: string;
  newSummarizedUpTo?: number;
  savedTokens?: number;
};

/**
 * Server-side compaction with stored summary from client.
 * Only summarizes messages NOT already covered by the stored summary.
 */
export async function compactMessages(
  messages: UIMessage[],
  storedSummary?: string,
  summarizedUpTo?: number,
  feedback?: Record<string, "up" | "down">,
): Promise<CompactionResult> {
  if (!COMPACTION_ENABLED) return { messages, compacted: false };

  if (storedSummary && summarizedUpTo && summarizedUpTo > 0) {
    // We have a stored summary. All messages from index 0..summarizedUpTo are in the summary.
    // Messages from summarizedUpTo onward are unsummarized and accumulating.
    const unsummarizedMessages = messages.slice(summarizedUpTo);
    const summaryTokens = Math.ceil(storedSummary.length / COMPACTION_CHARS_PER_TOKEN);
    const unsummarizedTokens = estimateTokens(unsummarizedMessages);
    const effectiveTokens = summaryTokens + unsummarizedTokens;

    log(`COMPACTION: summary=${summaryTokens}t + unsummarized=${unsummarizedTokens}t (${unsummarizedMessages.length} msgs) = ${effectiveTokens}t (threshold: ${COMPACTION_TOKEN_THRESHOLD})`);

    // Under threshold — send summary + all unsummarized messages (no LLM call, no compaction)
    if (effectiveTokens < COMPACTION_TOKEN_THRESHOLD) {
      log(`COMPACTION: Under threshold, passing summary + ${unsummarizedMessages.length} messages`);
      const summaryMsg: UIMessage = {
        id: "compaction-summary",
        role: "user",
        parts: [{ type: "text", text: `[Earlier conversation context]\n${storedSummary}` }],
      };
      const ackMsg: UIMessage = {
        id: "compaction-ack",
        role: "assistant",
        parts: [{ type: "text", text: "Understood." }],
      };
      const passthrough = [summaryMsg, ackMsg, ...unsummarizedMessages];
      // Compare against sending all original messages (what it would cost without any compaction)
      const withoutCompaction = estimateTokens(messages);
      const withCompaction = estimateTokens(passthrough);
      const savedTokens = withoutCompaction - withCompaction;
      log(`COMPACTION: Under threshold, reusing summary. Would be ${withoutCompaction}t without compaction, now ${withCompaction}t`);
      return { messages: passthrough, compacted: true, savedTokens };
    }

    // Over threshold — LLM re-summarize: merge existing summary + older unsummarized messages
    // Keep last COMPACTION_KEEP_RECENT messages as full messages
    const keepCount = Math.min(COMPACTION_KEEP_RECENT, unsummarizedMessages.length);
    const toSummarize = unsummarizedMessages.slice(0, -keepCount || undefined);
    const toKeep = keepCount > 0 ? unsummarizedMessages.slice(-keepCount) : [];

    log(`COMPACTION: Over threshold, LLM summarizing ${toSummarize.length} msgs, keeping ${toKeep.length}`);

    const newTranscript = toSummarize
      .filter(m => feedback?.[m.id] !== "down") // Skip messages user marked as unhelpful
      .map(m => {
        const text = messageText(m);
        if (!text) return "";
        const role = m.role === "user" ? "User" : "Assistant";
        if (feedback?.[m.id] === "up") return `${role} [IMPORTANT]: ${text.slice(0, 400)}`;
        return `${role}: ${text.slice(0, 400)}`;
      }).filter(Boolean).join("\n");

    const urls = extractSourceUrls(toSummarize);
    const urlSection = urls.length > 0 ? "\n[New sources]\n" + urls.map(u => `- ${u}`).join("\n") : "";

    const toMerge = `[Existing summary]\n${storedSummary}\n\n[New messages to incorporate]\n${newTranscript}${urlSection}`;

    const llmResult = await summarizeWithLLM(toMerge, summarizedUpTo + toSummarize.length);
    const updatedSummary = llmResult || createExtractiveSummary(toSummarize, storedSummary);
    const updatedUpTo = summarizedUpTo + toSummarize.length;

    const summaryMsg: UIMessage = {
      id: "compaction-summary",
      role: "user",
      parts: [{ type: "text", text: `[Earlier conversation context]\n${updatedSummary}` }],
    };
    const ackMsg: UIMessage = {
      id: "compaction-ack",
      role: "assistant",
      parts: [{ type: "text", text: "Understood." }],
    };

    const compacted = [summaryMsg, ackMsg, ...toKeep];
    const withoutCompaction = estimateTokens(messages);
    const withCompaction = estimateTokens(compacted);
    const savedTokens = withoutCompaction - withCompaction;
    log(`COMPACTION: Re-summarized → ${compacted.length} msgs (${withCompaction}t vs ${withoutCompaction}t without, ~${savedTokens} saved)`);

    return {
      messages: compacted,
      compacted: true,
      newSummary: updatedSummary,
      newSummarizedUpTo: updatedUpTo,
      savedTokens,
    };
  }

  // No stored summary — check if total tokens exceed threshold
  const estimatedTokens = estimateTokens(messages);
  log(`COMPACTION: No summary, ${messages.length} msgs, ~${estimatedTokens} tokens (threshold: ${COMPACTION_TOKEN_THRESHOLD})`);
  if (estimatedTokens < COMPACTION_TOKEN_THRESHOLD) return { messages, compacted: false };

  const keepCount = Math.min(COMPACTION_KEEP_RECENT, messages.length);
  if (messages.length <= keepCount) return { messages, compacted: false };

  const olderMessages = messages.slice(0, -keepCount);
  const recentMessages = messages.slice(-keepCount);

  // First-time compaction — summarize all older messages
  log(`COMPACTION: First-time summarization of ${olderMessages.length} messages`);
  const transcript = olderMessages
    .filter(m => feedback?.[m.id] !== "down") // Skip messages user marked as unhelpful
    .map(m => {
      const text = messageText(m);
      if (!text) return "";
      const role = m.role === "user" ? "User" : "Assistant";
      if (feedback?.[m.id] === "up") return `${role} [IMPORTANT]: ${text.slice(0, 400)}`;
      return `${role}: ${text.slice(0, 400)}`;
    }).filter(Boolean).join("\n");

  const urls = extractSourceUrls(olderMessages);
  const urlSection = urls.length > 0 ? "\n\n[Sources]\n" + urls.map(u => `- ${u}`).join("\n") : "";
  const fullTranscript = transcript + urlSection;

  const llmSummary = await summarizeWithLLM(fullTranscript, olderMessages.length);
  const summary = llmSummary || createExtractiveSummary(olderMessages);

  const summaryMsg: UIMessage = {
    id: "compaction-summary",
    role: "user",
    parts: [{ type: "text", text: `[Earlier conversation context]\n${summary}` }],
  };
  const ackMsg: UIMessage = {
    id: "compaction-ack",
    role: "assistant",
    parts: [{ type: "text", text: "Understood." }],
  };

  const compacted = [summaryMsg, ackMsg, ...recentMessages];
  const savedTokens = estimatedTokens - estimateTokens(compacted);
  log(`COMPACTION: ${messages.length} msgs → ${compacted.length} msgs (~${savedTokens} saved)`);

  return {
    messages: compacted,
    compacted: true,
    newSummary: summary,
    newSummarizedUpTo: messages.length - keepCount,
    savedTokens,
  };
}
