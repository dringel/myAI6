import { z } from "zod";

const envSchema = z.object({
  // Required: default vendor is Anthropic
  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required"),

  // Optional: only needed for OpenAI chat models or MODERATION_PROVIDER = "openai"
  OPENAI_API_KEY: z.string().optional(),

  // Optional: only needed if using Fireworks models
  FIREWORKS_API_KEY: z.string().optional(),

  // Optional: only needed if Pinecone vector search is used
  PINECONE_API_KEY: z.string().optional(),

  // Optional: only needed if web search is enabled
  EXA_API_KEY: z.string().optional(),

  // Optional: HMAC secret for signing compaction summaries
  // (falls back to a key derived from ANTHROPIC_API_KEY when unset)
  SUMMARY_HMAC_SECRET: z.string().optional(),

  // Optional: bearer token for detailed /api/health checks in production
  HEALTH_CHECK_TOKEN: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

function validateEnv(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const formatted = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    console.error(
      `\n❌ Missing or invalid environment variables:\n${formatted}\n\nSee env.template for required variables.\n`
    );
    throw new Error("Invalid environment variables");
  }

  return result.data;
}

export const env = validateEnv();
