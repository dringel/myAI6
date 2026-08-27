import { UIMessage } from "ai";
import {
  DEFAULT_VENDOR,
  DEFAULT_MODEL_ID,
  DEFAULT_MODE,
  DEFAULT_THINKING_LEVEL,
  STRONG_REASONING_LENGTH_THRESHOLD,
  CHAT_THINKING_LEVEL,
} from "@/config";
import {
  thinkingBudget,
  openaiReasoningEffort,
  anthropicThinkingOptions,
  Vendor,
  Mode,
  ThinkingLevel,
} from "@/lib/ai/model-registry";

export type RouteResult = {
  vendor: Vendor;
  modelId: string;
  mode: Mode;
  thinkingLevel: ThinkingLevel;
};

// Loosely typed: the anthropic thinking shape differs by model generation
// (budgetTokens on Haiku 4.5, adaptive on 4.6+/5-family, omitted on Fable).
export type RouteProviderOptions = {
  anthropic?: Record<string, any>;
  openai?: {
    reasoningSummary: "auto";
    reasoningEffort: ReturnType<typeof openaiReasoningEffort>;
    parallelToolCalls: false;
  };
};

export function getLatestUserText(messages: UIMessage[]): string {
  const latestUserMessage = messages.filter((m) => m.role === "user").pop();
  if (!latestUserMessage) return "";

  return latestUserMessage.parts
    .filter((p) => p.type === "text")
    .map((p: any) => ("text" in p ? p.text : ""))
    .join("")
    .trim();
}

/**
 * SERVER-SIDE ROUTING ONLY
 * End users cannot control vendor/model/mode.
 * Default must be Anthropic.
 */
export function routeRequest(messages: UIMessage[]): RouteResult {
  let vendor: Vendor = DEFAULT_VENDOR;
  let modelId: string = DEFAULT_MODEL_ID;
  let mode: Mode = DEFAULT_MODE;
  let thinkingLevel: ThinkingLevel = DEFAULT_THINKING_LEVEL;

  const latestText = getLatestUserText(messages).toLowerCase();

  // Only escalate for clearly multi-step / proof / debugging style tasks.
  const strongReasoningCue =
    /\b(prove|derive|show\s+your\s+work|step[- ]by[- ]step|formal\s+proof|debug\s+this|trace\s+execution|time\s+complexity|space\s+complexity|edge\s+cases?)\b/.test(
      latestText
    ) ||
    (latestText.length > STRONG_REASONING_LENGTH_THRESHOLD &&
      /\b(code|algorithm|proof|equation|math|bug|stack\s*trace|complexity)\b/.test(
        latestText
      ));

  if (strongReasoningCue) {
    mode = "reasoning";
    thinkingLevel = "high";
  }

  return { vendor, modelId, mode, thinkingLevel };
}

export function buildProviderOptions(
  vendor: Vendor,
  mode: Mode,
  thinkingLevel: ThinkingLevel,
  modelId: string = DEFAULT_MODEL_ID
): RouteProviderOptions {
  const providerOptions: RouteProviderOptions = {};

  if (vendor === "anthropic") {
    // Thinking config depends on model generation (see anthropicThinkingOptions):
    // Haiku 4.5 gets a token budget; newer models get adaptive; Fable omits it.
    const budgetTokens = mode === "reasoning"
      ? thinkingBudget(thinkingLevel)
      : thinkingBudget(CHAT_THINKING_LEVEL);
    const thinkingOpts = anthropicThinkingOptions(modelId, budgetTokens);
    if (Object.keys(thinkingOpts).length > 0) {
      providerOptions.anthropic = thinkingOpts;
    }
  }

  if (vendor === "openai") {
    providerOptions.openai = {
      reasoningSummary: "auto",
      reasoningEffort: openaiReasoningEffort(thinkingLevel),
      parallelToolCalls: false,
    };
  }

  return providerOptions;
}
