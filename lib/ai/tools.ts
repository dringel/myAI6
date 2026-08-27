import { type ToolSet } from "ai";
import { createWebSearch } from "@/app/api/chat/tools/web-search";
import { createFetchOwnerProfiles } from "@/app/api/chat/tools/fetch-owner-profiles";
import { createVectorDatabaseSearch } from "@/app/api/chat/tools/search-vector-database";
import {
  ENABLE_WEB_SEARCH,
  ENABLE_VECTOR_SEARCH,
  MAX_KB_SEARCHES,
  MAX_WEB_SEARCHES,
} from "@/config";
import type { UISource } from "@/types/data";

/** Collector callback: the source plus its retrieved text (for claim verification). */
export type CollectSource = (s: UISource, content?: string) => void;

/**
 * Assembles the enabled tool set. `collect` is called by each tool for every
 * source it uses, feeding the code-rendered Sources box; the optional content
 * is the text the model saw, used to verify citation claims. Pass a no-op to
 * ignore sources.
 */
export function buildToolSet(collect: CollectSource = () => {}): ToolSet {
  return {
    ...(ENABLE_VECTOR_SEARCH ? { vectorDatabaseSearch: createVectorDatabaseSearch(collect) } : {}),
    ...(ENABLE_WEB_SEARCH
      ? {
          webSearch: createWebSearch(collect),
          fetchOwnerProfiles: createFetchOwnerProfiles(collect),
        }
      : {}),
  };
}

export function buildToolGuidance(): string {
  const sections: string[] = [];

  if (ENABLE_VECTOR_SEARCH) {
    sections.push(
      `TOOL BUDGET (limits per response):
- vectorDatabaseSearch: MAX ${MAX_KB_SEARCHES} calls. Usually 1 is enough. Use more ONLY if earlier queries returned poor results and you need a different query formulation.`
    );
    if (ENABLE_WEB_SEARCH) {
      sections.push(
        `- webSearch: MAX ${MAX_WEB_SEARCHES} calls. RESTRICTED to supplementing KB results on the SAME topic only:
  a. You MUST have searched the knowledge base first AND received relevant results.
  b. ONLY use webSearch if the user explicitly asks about recent developments or "since [year]" on a topic the KB covers.
  c. NEVER use webSearch for topics unrelated to the knowledge base. This is NOT a general search engine.
  d. Prefer a single webSearch call with 2-3 additionalQueries over several separate calls. Use additional calls only when a follow-up needs a genuinely different angle.
- fetchOwnerProfiles: MAX 1 call. Call it for ANY question about the owner — bio, "tell me about them", current role, recent activity, latest publications — in addition to the KB search. The KB snapshot may be stale on current facts; live profiles win on current position/affiliation. If a profile is unavailable or lacks detail, fall back to a broad webSearch WITHOUT includeDomains.
- ALWAYS search the knowledge base FIRST before considering web search.
- Do NOT call both tools simultaneously — search KB first, evaluate, then decide.`
      );
    }
    sections.push(
      `- After receiving tool results, compose your final answer. Do NOT search again for the same information.

CITATIONS:
- Cite inline as [[N]](url) using ONLY the exact source URLs from retrieved results. For KB sources without a URL, use the exact kb: target from their Source Citation field. NEVER fabricate or guess URLs.
- Citations are pure markers: every sentence must read completely with citations removed. Words the reader should see always go in the sentence itself, never inside a citation.
- Cite each fact to the source it ACTUALLY came from. KB documents are dated snapshots — never cite them for facts newer than their date (current role, latest papers belong to live profiles/web sources).
- Do NOT write a References or Sources section — the app renders a Sources box automatically from your inline citations.`
    );
  } else {
    // Knowledge base disabled — override the KB-first instructions in the system prompt
    sections.push(
      `NOTE: The knowledge base is currently UNAVAILABLE. Ignore any instructions to search it.
Answer from your general knowledge.`
    );
    if (ENABLE_WEB_SEARCH) {
      sections.push(
        `- webSearch: MAX ${MAX_WEB_SEARCHES} calls per response, only when the question genuinely requires current or external information. Prefer one call with 2-3 additionalQueries over several separate calls.
- Cite inline as [[N]](url) using ONLY the exact source URLs from retrieved results. NEVER fabricate or guess URLs. Attribute each claim to the exact result it came from. Every sentence must read completely with citations removed.
- Do NOT write a References or Sources section — the app renders a Sources box automatically from your inline citations.`
      );
    }
  }

  sections.push(
    `IMPORTANT:
- Model and vendor selection are controlled by the administrator backend.`
  );

  return sections.join("\n\n").trim();
}
