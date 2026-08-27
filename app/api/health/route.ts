import { timingSafeEqual } from "crypto";
import {
  PINECONE_INDEX_NAME,
  ENABLE_VECTOR_SEARCH,
  MODERATION_PROVIDER,
  DEFAULT_VENDOR,
  UTILITY_VENDOR,
} from "@/config";

// Detailed checks reveal the dependency stack and probe Pinecone on every
// hit, so they are gated: allowed in development, or in production only with
// HEALTH_CHECK_TOKEN set and presented as "Authorization: Bearer <token>".
// Everyone else gets a bare liveness response with no dependency probing.
function isAuthorized(req: Request): boolean {
  if (process.env.NODE_ENV === "development") return true;
  const token = process.env.HEALTH_CHECK_TOKEN;
  if (!token) return false;
  const header = req.headers.get("authorization") || "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(token, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return Response.json({ status: "ok" });
  }

  const checks: Record<string, string> = {};

  // Pinecone: only checked when the knowledge base is enabled
  if (!ENABLE_VECTOR_SEARCH) {
    checks.pinecone = "disabled";
  } else if (process.env.PINECONE_API_KEY) {
    try {
      const { Pinecone } = await import("@pinecone-database/pinecone");
      const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
      const index = pc.Index(PINECONE_INDEX_NAME);
      await index.describeIndexStats();
      checks.pinecone = "ok";
    } catch {
      checks.pinecone = "error";
    }
  } else {
    checks.pinecone = "missing";
  }

  // Anthropic key: always required (chat model, compaction, anthropic moderation)
  checks.anthropic = process.env.ANTHROPIC_API_KEY ? "configured" : "missing";

  // OpenAI key: only required for OpenAI chat models, OpenAI moderation,
  // or an OpenAI utility model (moderation classifier / compaction)
  const openaiRequired =
    (DEFAULT_VENDOR as string) === "openai" ||
    MODERATION_PROVIDER === "openai" ||
    UTILITY_VENDOR === "openai";
  checks.openai = process.env.OPENAI_API_KEY
    ? "configured"
    : openaiRequired
      ? "missing"
      : "not_required";

  const allOk =
    !Object.values(checks).includes("error") &&
    !Object.values(checks).includes("missing");

  return Response.json(
    {
      status: allOk ? "healthy" : "degraded",
      version: process.env.npm_package_version ?? "0.1.0",
      checks,
    },
    { status: allOk ? 200 : 503 }
  );
}
