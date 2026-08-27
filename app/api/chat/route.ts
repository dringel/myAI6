import {
  streamText,
  UIMessage,
  convertToModelMessages,
  stepCountIs,
  createUIMessageStream,
  createUIMessageStreamResponse,
} from "ai";
import "@/lib/env";
import { SYSTEM_PROMPT } from "@/prompts";
import { isContentFlagged } from "@/lib/moderation";
import {
  MODERATION_FAIL_POLICY,
  MAX_STEPS,
  MAX_MESSAGES,
  MAX_MESSAGE_TEXT_LENGTH,
  MAX_OUTPUT_TOKENS,
  COMPACTION_MAX_SUMMARY_CHARS,
} from "@/config";
import { signSummary, verifySummary } from "@/lib/summary-signature";
import { getModel } from "@/lib/ai/model-registry";
import {
  routeRequest,
  getLatestUserText,
  buildProviderOptions,
} from "@/lib/ai/routing";
import { buildToolSet, buildToolGuidance } from "@/lib/ai/tools";
import { compactMessages } from "@/lib/compaction";
import {
  normUrl,
  rewriteCitations,
  hostnameOf,
  quoteAppearsIn,
  claimSupported,
} from "@/lib/citations";
import { uiSourceSchema, type UISource } from "@/types/data";

// Next.js requires segment config to be a static literal (not imported).
// Keep in sync with VERCEL_MAX_DURATION in config.ts and Vercel Pro plan settings.
export const maxDuration = 120;

function jsonError(message: string, status: number) {
  return Response.json({ error: message }, { status });
}


function createPlainTextResponse(message: string) {
  const stream = createUIMessageStream({
    execute({ writer }) {
      const textId = "server-message";
      writer.write({ type: "start" });
      writer.write({ type: "text-start", id: textId });
      writer.write({ type: "text-delta", id: textId, delta: message });
      writer.write({ type: "text-end", id: textId });
      writer.write({ type: "finish" });
    },
  });
  return createUIMessageStreamResponse({ stream });
}

export async function POST(req: Request) {
  // --- Parse and validate request body ---
  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonError("Invalid JSON in request body.", 400);
  }

  const messages: UIMessage[] = body.messages ?? [];

  // Read compaction summary from request headers (client sends via headers, not body).
  // The summary enters the model context as trusted history, so it is only
  // accepted with a valid server-issued HMAC (X-Compacted-Signature) and
  // within the server's own size cap. Anything else is ignored and the
  // server recompacts from the full message history.
  const summaryB64 = req.headers.get("X-Compacted-Summary");
  const upToStr = req.headers.get("X-Compacted-UpTo");
  const summarySignature = req.headers.get("X-Compacted-Signature");
  let storedSummary: string | undefined;
  let summarizedUpTo: number | undefined;
  if (summaryB64 && upToStr) {
    try {
      const summary = decodeURIComponent(escape(atob(summaryB64)));
      const upTo = parseInt(upToStr, 10);
      if (
        summary.length <= COMPACTION_MAX_SUMMARY_CHARS &&
        Number.isInteger(upTo) &&
        upTo >= 0 &&
        verifySummary(summary, upTo, summarySignature)
      ) {
        storedSummary = summary;
        summarizedUpTo = upTo;
      } else if (process.env.NODE_ENV === "development") {
        console.warn("COMPACTION: rejected client summary (bad signature or size)");
      }
    } catch {
      // Invalid base64 — ignore
    }
  }
  // Read feedback ratings from client
  let feedback: Record<string, "up" | "down"> | undefined;
  const feedbackB64 = req.headers.get("X-Feedback");
  if (feedbackB64) {
    try { feedback = JSON.parse(atob(feedbackB64)); } catch { /* ignore */ }
  }
  if (process.env.NODE_ENV === "development") {
    console.log(`COMPACTION SERVER: storedSummary: ${storedSummary ? storedSummary.length + ' chars' : 'none'}, summarizedUpTo: ${summarizedUpTo ?? 'none'}, feedback: ${feedback ? Object.keys(feedback).length + ' ratings' : 'none'}`);
  }

  if (!Array.isArray(messages)) {
    return jsonError("'messages' must be an array.", 400);
  }

  if (messages.length > MAX_MESSAGES) {
    return jsonError(
      `Too many messages (max ${MAX_MESSAGES}). Please start a new conversation.`,
      400
    );
  }

  const latestText = getLatestUserText(messages);
  if (latestText.length > MAX_MESSAGE_TEXT_LENGTH) {
    return jsonError(
      `Message too long (max ${MAX_MESSAGE_TEXT_LENGTH} characters).`,
      400
    );
  }

  // --- Route request ---
  const { vendor, modelId, mode, thinkingLevel } = routeRequest(messages);
  // Routing logged at debug level only
  if (process.env.NODE_ENV === "development") {
    console.debug("AI ROUTING:", { vendor, modelId, mode, thinkingLevel });
  }

  // --- Build model, tools, and provider options ---
  // Request-scoped collector: the search tools push structured sources here, so
  // the client can render a deterministic Sources box (a `data-sources` stream
  // part) independent of the model's markdown. Deduped by url (or title if none).
  const collectedSources: UISource[] = [];
  const seenSourceKeys = new Set<string>();
  // Retrieved text per source URL/key, for verifying citation claims.
  const contentByUrl = new Map<string, string>();
  const collectSource = (s: UISource, content?: string) => {
    // Dedup by URL across kinds (one URL must never appear twice in the panel);
    // sources without a URL dedup by kind+title.
    const key = s.url ? s.url.toLowerCase() : `${s.kind}|${s.title}`;
    if (content && s.url) {
      const norm = normUrl(s.url);
      contentByUrl.set(norm, (contentByUrl.get(norm) || "") + "\n" + content);
    }
    if (seenSourceKeys.has(key)) return;
    seenSourceKeys.add(key);
    collectedSources.push(s);
  };

  // Sources from earlier turns' Sources boxes (data-sources parts in the
  // incoming history). In follow-up turns the model legitimately cites URLs it
  // learned earlier without re-searching; this lookup restores their full
  // titles instead of falling back to a bare hostname. Client-supplied, so
  // each entry is schema-validated before use.
  const priorSourcesByUrl = new Map<string, UISource>();
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const part of msg.parts ?? []) {
      const p = part as { type?: string; data?: unknown };
      if (p.type === "data-sources" && Array.isArray(p.data)) {
        for (const raw of p.data) {
          const parsed = uiSourceSchema.safeParse(raw);
          if (parsed.success && parsed.data.url) {
            priorSourcesByUrl.set(normUrl(parsed.data.url), parsed.data);
          }
        }
      }
    }
  }

  const model = getModel(vendor, modelId);
  const tools = buildToolSet(collectSource);
  const toolGuidance = buildToolGuidance();
  const providerOptions = buildProviderOptions(vendor, mode, thinkingLevel, modelId);

  // --- Run moderation + compaction in parallel (saves ~3-5s) ---
  const [moderationResult, compactionResult] = await Promise.all([
    latestText ? isContentFlagged(latestText) : Promise.resolve({ flagged: false, skipped: false, denialMessage: "" }),
    compactMessages(messages, storedSummary, summarizedUpTo, feedback),
  ]);

  // --- Check moderation result ---
  if (moderationResult.flagged) {
    return createPlainTextResponse(
      moderationResult.denialMessage ||
        "Your message violates our guidelines. I can't answer that."
    );
  }
  if (moderationResult.skipped && MODERATION_FAIL_POLICY === "closed") {
    console.warn("Moderation unavailable; blocking per MODERATION_FAIL_POLICY=closed");
    return jsonError("Content moderation is temporarily unavailable. Please try again shortly.", 503);
  }

  // --- Convert messages ---
  let modelMessages;
  try {
    modelMessages = await convertToModelMessages(compactionResult.messages);
  } catch (error) {
    console.error("convertToModelMessages failed:", error);
    return jsonError(
      "Could not process the message format. Please retry or simplify your last message.",
      400
    );
  }

  // --- Stream response ---
  try {
    const systemPrompt = compactionResult.compacted
      ? SYSTEM_PROMPT + "\n\n" + toolGuidance +
        "\n\n[Note: Earlier conversation context is provided as a summary. Continue naturally.]"
      : SYSTEM_PROMPT + "\n\n" + toolGuidance;

    // Wrap streamText in a UI message stream so we can append a structured
    // `data-sources` part once the model (and all its tool steps) finish.
    const stream = createUIMessageStream({
      execute: ({ writer }) => {
        const result = streamText({
          model,
          system: systemPrompt,
          messages: modelMessages,
          tools,
          stopWhen: stepCountIs(MAX_STEPS),
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          providerOptions,
          onFinish: ({ steps }) => {
            // The Sources box is the single reference list, built FROM the
            // text by the SAME canonicalization the client applies at render
            // time (lib/citations.ts): citations are renumbered sequentially
            // by first appearance, so box numbers are always 1..K with no gaps
            // and always match the inline numbers. Uncited sources never
            // appear; sources without a URL are attributed in prose.
            const answerText = steps.map((s) => s.text).join("\n");
            const { orderedUrls, citations } = rewriteCitations(answerText);
            if (orderedUrls.length === 0 && collectedSources.length > 0) {
              // Sources were retrieved but the model cited none of them in a
              // recognized format — surfaced in logs so it is diagnosable.
              console.warn(
                `CITATIONS: model cited no URLs (${collectedSources.length} sources retrieved)`
              );
            }
            const byUrl = new Map<string, UISource>();
            for (const s of collectedSources) {
              if (s.url) byUrl.set(normUrl(s.url), s);
            }
            // Verification (green check when true): a citation is verified
            // when a quote the model attached matches the retrieved source
            // text, or when the sentence preceding the citation (the claim) is
            // supported by that text via significant-word containment. Both
            // checks are deterministic; when nothing can be checked the state
            // stays undefined (no marker either way).
            const isVerified = (
              url: string,
              quotes: string[],
              claims: string[]
            ): boolean | undefined => {
              const content = contentByUrl.get(normUrl(url));
              if (!content) return undefined;
              if (quotes.some((q) => quoteAppearsIn(q, content))) return true;
              if (claims.some((c) => claimSupported(c, content))) return true;
              return quotes.length > 0 || claims.length > 0 ? false : undefined;
            };

            const citedSources: UISource[] = citations.map(({ url, quotes, claims }, i) => {
              const source = byUrl.get(normUrl(url));
              if (source)
                return { ...source, number: i + 1, verified: isVerified(url, quotes, claims) };
              // Cited from earlier conversation turns: reuse that turn's
              // source entry (full title/kind). No retrieved text this turn,
              // so verification is not possible — no check mark.
              const prior = priorSourcesByUrl.get(normUrl(url));
              if (prior) {
                return {
                  kind: prior.kind,
                  title: prior.title,
                  url: prior.url,
                  site: prior.site,
                  ...(prior.publishedDate ? { publishedDate: prior.publishedDate } : {}),
                  number: i + 1,
                };
              }
              if (url.startsWith("kb:")) {
                // kb: citation whose source was not collected this turn (e.g.
                // model reused a key from earlier context). List it unlinked.
                return {
                  kind: "kb" as const,
                  title: url.slice(3).replace(/-/g, " "),
                  url: "",
                  site: "Knowledge base",
                  number: i + 1,
                };
              }
              // Cited URL that no search retrieved (e.g. a profile URL the
              // model knows from its instructions). Still listed, so the box
              // mirrors the text exactly.
              return {
                kind: "web" as const,
                title: hostnameOf(url) || url,
                url,
                site: "",
                number: i + 1,
              };
            });

            // Retrieved sources the model linked as PLAIN markdown links
            // (rather than numbered citations) are still used sources — list
            // them after the numbered ones so web sources never silently
            // disappear from the box.
            const numberedUrls = new Set(orderedUrls.map((u) => normUrl(u)));
            const lowerAnswer = answerText.toLowerCase();
            for (const s of collectedSources) {
              if (!s.url) continue;
              const norm = normUrl(s.url);
              if (numberedUrls.has(norm)) continue;
              if (lowerAnswer.includes(norm)) {
                // Plain-linked (not a numbered citation): nothing to verify,
                // so no badge either way.
                citedSources.push({ ...s, number: citedSources.length + 1 });
                numberedUrls.add(norm);
              }
            }
            if (citedSources.length > 0) {
              writer.write({
                type: "data-sources",
                id: "sources",
                data: citedSources,
              });
            }
          },
        });
        writer.merge(result.toUIMessageStream({ sendReasoning: true }));
      },
      onError: (error) => {
        console.error("streamText failed:", error);
        return "The model provider returned an error. Please try again.";
      },
    });

    const response = createUIMessageStreamResponse({ stream });

    // Return updated summary for client to store
    if (compactionResult.newSummary) {
      const newUpTo = compactionResult.newSummarizedUpTo ?? 0;
      const encoded = Buffer.from(compactionResult.newSummary).toString("base64");
      response.headers.set("X-Compacted-Summary", encoded);
      response.headers.set("X-Compacted-UpTo", String(newUpTo));
      // Signature the client must return with this summary (see verify above)
      response.headers.set(
        "X-Compacted-Signature",
        signSummary(compactionResult.newSummary, newUpTo)
      );
      // Expose headers to client-side fetch
      response.headers.set(
        "Access-Control-Expose-Headers",
        "X-Compacted-Summary, X-Compacted-UpTo, X-Compacted-Signature"
      );
    }

    return response;
  } catch (error) {
    console.error("streamText failed:", error);
    return jsonError(
      "The model provider returned an error. Please try again.",
      502
    );
  }
}
