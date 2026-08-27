/**
 * HMAC signing for the compaction summary round-trip.
 *
 * The server generates conversation summaries and the client stores and
 * returns them on later requests (X-Compacted-Summary header). Without a
 * signature, that header is a forgeable injection channel: any client could
 * send arbitrary text that enters the model context framed as trusted
 * conversation history, bypassing moderation (which only checks the latest
 * user message). Signing lets clients round-trip summaries but not forge or
 * edit them.
 *
 * The MAC covers both the summary text and summarizedUpTo, so neither can be
 * altered independently. Server-only module — never import from client code.
 */

import { createHmac, createHash, timingSafeEqual } from "crypto";

// Dedicated secret if set; otherwise derived (via SHA-256, never used raw)
// from the Anthropic API key, which the server always has. Rotating either
// secret invalidates outstanding signatures — harmless, since an invalid
// signature just makes the server ignore the summary and recompact from the
// full message history.
function getKey(): Buffer {
  const secret =
    process.env.SUMMARY_HMAC_SECRET || process.env.ANTHROPIC_API_KEY || "";
  return createHash("sha256").update(`summary-hmac:${secret}`).digest();
}

export function signSummary(summary: string, summarizedUpTo: number): string {
  return createHmac("sha256", getKey())
    .update(`${summarizedUpTo}\n${summary}`)
    .digest("hex");
}

export function verifySummary(
  summary: string,
  summarizedUpTo: number,
  signature: string | null
): boolean {
  if (!signature) return false;
  const expected = signSummary(summary, summarizedUpTo);
  const got = Buffer.from(signature, "utf8");
  const want = Buffer.from(expected, "utf8");
  if (got.length !== want.length) return false;
  return timingSafeEqual(got, want);
}
