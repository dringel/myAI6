// lib/ai/model-registry.ts
import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import { fireworks } from "@ai-sdk/fireworks";
import {
  THINKING_BUDGET_LOW,
  THINKING_BUDGET_MEDIUM,
  THINKING_BUDGET_HIGH,
  UTILITY_VENDOR,
  UTILITY_MODEL_ID,
} from "@/config";

export type Vendor = "anthropic" | "openai" | "fireworks";
export type Mode = "chat" | "reasoning";
export type ThinkingLevel = "off" | "low" | "medium" | "high";

// Model catalog (verified August 2026). Modes: "chat", "reasoning", or "both".
// Deliberately limited to cost-appropriate chatbot tiers — premium models
// (Claude Fable/Opus, GPT-5.6 Sol, "pro" variants) are excluded: their cost
// per request makes no sense for a public-facing chatbot.
// Default is and should remain Anthropic + Haiku (see DEFAULT_* in config.ts).
// Anthropic: models newer than Haiku 4.5 use adaptive thinking (see anthropicThinkingOptions).
// Fireworks: IDs require the full "accounts/fireworks/models/" prefix; new open-source
// models ship to Fireworks within days — check fireworks.ai for the current catalog.
export const MODEL_OPTIONS: Record<
  Vendor,
  { id: string; label: string; mode: Mode | "both" }[]
> = {
  anthropic: [
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5 (default)", mode: "both" },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5", mode: "both" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", mode: "both" },
  ],

  openai: [
    { id: "gpt-5.6-luna", label: "GPT-5.6 Luna (economy)", mode: "both" },
    { id: "gpt-5.6-terra", label: "GPT-5.6 Terra (mid-tier)", mode: "both" },
    { id: "gpt-5.4-mini", label: "GPT-5.4 mini", mode: "both" },
  ],

  fireworks: [
    {
      id: "accounts/fireworks/models/deepseek-v4-pro",
      label: "DeepSeek V4 Pro (Fireworks)",
      mode: "chat",
    },
    {
      id: "accounts/fireworks/models/deepseek-r1",
      label: "DeepSeek R1 (Fireworks)",
      mode: "reasoning",
    },
    {
      id: "accounts/fireworks/models/kimi-k2p6",
      label: "Kimi K2.6 (Fireworks)",
      mode: "chat",
    },
  ],
};

// --- Anthropic thinking config by model generation ---
// Haiku 4.5 (and older): fixed thinking budget via budgetTokens.
// 4.6-family and 5-family (Sonnet 4.6, Opus 4.8, Sonnet 5, Opus 5): adaptive
//   thinking — budgetTokens is REJECTED (400) on these models.
// Fable 5 / Mythos 5: thinking always on — the parameter must be omitted entirely.
export function anthropicThinkingOptions(
  modelId: string,
  budgetTokens: number
): Record<string, any> {
  if (modelId.includes("fable") || modelId.includes("mythos")) {
    return {}; // always-on thinking; explicit config is rejected
  }
  if (/(opus-5|opus-4-[678]|sonnet-5|sonnet-4-6)/.test(modelId)) {
    return { thinking: { type: "adaptive" } };
  }
  return { thinking: { type: "enabled", budgetTokens } };
}

export function getModel(vendor: Vendor, modelId: string) {
  if (vendor === "anthropic") return anthropic(modelId);

  if (vendor === "openai") {
    return openai.responses(modelId);
  }

  if (vendor === "fireworks") {
    return fireworks(modelId);
  }

  return anthropic("claude-sonnet-4-6");
}

// --- Utility model (background tasks: moderation classifier, compaction summaries) ---
// Resolved from UTILITY_VENDOR + UTILITY_MODEL_ID in config.ts, so background
// LLM work follows the configured vendor instead of being hardwired to Anthropic.

export function getUtilityModel() {
  return getModel(UTILITY_VENDOR, UTILITY_MODEL_ID);
}

// Provider options that make the utility model fast: no extended thinking /
// minimal reasoning, regardless of vendor.
export function utilityProviderOptions(): Record<string, Record<string, any>> {
  if (UTILITY_VENDOR === "anthropic") {
    // Fable/Mythos: thinking cannot be disabled — omit the parameter entirely
    if (UTILITY_MODEL_ID.includes("fable") || UTILITY_MODEL_ID.includes("mythos")) {
      return {};
    }
    return { anthropic: { thinking: { type: "disabled" } } };
  }
  if (UTILITY_VENDOR === "openai") {
    return { openai: { reasoningEffort: "minimal" } };
  }
  return {};
}

export function thinkingBudget(level: ThinkingLevel) {
  switch (level) {
    case "low":
      return THINKING_BUDGET_LOW;
    case "medium":
      return THINKING_BUDGET_MEDIUM;
    case "high":
      return THINKING_BUDGET_HIGH;
    default:
      return 0;
  }
}

export function openaiReasoningEffort(level: ThinkingLevel) {
  switch (level) {
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "off":
    default:
      return "minimal";
  }
}
