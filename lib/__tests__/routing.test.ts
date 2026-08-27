import { describe, it, expect } from "vitest";
import { routeRequest, getLatestUserText, buildProviderOptions } from "@/lib/ai/routing";
import { UIMessage } from "ai";

function makeMessages(text: string): UIMessage[] {
  return [
    {
      id: "1",
      role: "user",
      parts: [{ type: "text", text }],
    },
  ];
}

describe("getLatestUserText", () => {
  it("extracts text from latest user message", () => {
    const messages: UIMessage[] = [
      { id: "1", role: "user", parts: [{ type: "text", text: "first" }] },
      { id: "2", role: "assistant", parts: [{ type: "text", text: "reply" }] },
      { id: "3", role: "user", parts: [{ type: "text", text: "second" }] },
    ];
    expect(getLatestUserText(messages)).toBe("second");
  });

  it("returns empty string when no user messages", () => {
    const messages: UIMessage[] = [
      { id: "1", role: "assistant", parts: [{ type: "text", text: "hi" }] },
    ];
    expect(getLatestUserText(messages)).toBe("");
  });

  it("returns empty string for empty array", () => {
    expect(getLatestUserText([])).toBe("");
  });
});

describe("routeRequest", () => {
  it("defaults to chat mode for simple queries", () => {
    const result = routeRequest(makeMessages("What is the weather?"));
    expect(result.mode).toBe("chat");
    expect(result.vendor).toBe("anthropic");
  });

  it("escalates to reasoning for proof-style queries", () => {
    const result = routeRequest(makeMessages("prove that this algorithm is O(n log n)"));
    expect(result.mode).toBe("reasoning");
    expect(result.thinkingLevel).toBe("high");
  });

  it("escalates to reasoning for debug queries", () => {
    const result = routeRequest(makeMessages("debug this function for edge cases"));
    expect(result.mode).toBe("reasoning");
  });

  it("escalates to reasoning for step-by-step queries", () => {
    const result = routeRequest(makeMessages("Show your work for this calculation"));
    expect(result.mode).toBe("reasoning");
  });

  it("does not escalate for general questions", () => {
    const result = routeRequest(makeMessages("Tell me about machine learning"));
    expect(result.mode).toBe("chat");
  });
});

describe("buildProviderOptions", () => {
  it("enables thinking for anthropic reasoning mode", () => {
    const opts = buildProviderOptions("anthropic", "reasoning", "high");
    expect(opts.anthropic?.thinking.type).toBe("enabled");
    expect(opts.anthropic?.thinking.budgetTokens).toBe(15000);
  });

  it("enables low thinking budget for anthropic chat mode", () => {
    const opts = buildProviderOptions("anthropic", "chat", "medium");
    expect(opts.anthropic?.thinking.type).toBe("enabled");
    expect(opts.anthropic?.thinking.budgetTokens).toBe(2000);
  });

  it("sets reasoning effort for openai", () => {
    const opts = buildProviderOptions("openai", "chat", "medium");
    expect(opts.openai?.reasoningEffort).toBe("medium");
  });

  it("returns empty options for fireworks", () => {
    const opts = buildProviderOptions("fireworks", "chat", "medium");
    expect(opts.anthropic).toBeUndefined();
    expect(opts.openai).toBeUndefined();
  });
});
