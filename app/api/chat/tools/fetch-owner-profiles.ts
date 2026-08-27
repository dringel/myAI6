import { tool } from "ai";
import { z } from "zod";
import {
  OWNER_NAME,
  OWNER_PROFILE_SOURCES,
  OWNER_PROFILE_MAX_CHARACTERS,
} from "@/config";
import {
  getExa,
  domainOf,
  formatWebResults,
  type WebResult,
} from "./web-search";
import type { UISource } from "@/types/data";

/**
 * Builds the owner-profile fetch tool: pulls the owner's official profile
 * pages (config: OWNER_PROFILE_SOURCES) directly via Exa's contents API with
 * live crawling, instead of searching within those domains — profile sites
 * (Google Scholar, LinkedIn, ResearchGate) are crawl-hostile and thinly
 * indexed, so searching them often misses recent entries. Direct fetch gets
 * the live page when possible. Pages that cannot be fetched are reported as
 * unavailable so the model falls back to a broad webSearch.
 */
export function createFetchOwnerProfiles(
  collect: (s: UISource, content?: string) => void
) {
  return tool({
    description:
      `Fetch the LIVE content of ${OWNER_NAME}'s official profile pages ` +
      `(${OWNER_PROFILE_SOURCES.map((s) => s.name).join(", ")}). ` +
      `Use this FIRST for questions about his recent activity, current role, or latest publications. ` +
      `If a profile comes back unavailable or lacks the needed detail, follow up with a broad webSearch ` +
      `(journal sites, SSRN, university pages) — do NOT restrict that fallback to the profile domains.`,
    inputSchema: z.object({}),

    execute: async () => {
      try {
        const urls = OWNER_PROFILE_SOURCES.map((s) => s.url);
        const response = (await getExa().getContents(urls, {
          text: { maxCharacters: OWNER_PROFILE_MAX_CHARACTERS },
          livecrawl: "preferred",
        } as any)) as any; // cast: exa-js types lag behind API features

        const byUrl = new Map<string, any>();
        for (const r of response?.results || []) {
          if (r?.url) byUrl.set(r.url.replace(/\/+$/, ""), r);
        }

        const results: WebResult[] = [];
        const unavailable: string[] = [];
        for (const profile of OWNER_PROFILE_SOURCES) {
          const r = byUrl.get(profile.url.replace(/\/+$/, ""));
          const text: string = r?.text || "";
          if (text.trim()) {
            results.push({
              title: r?.title || `${profile.name} profile of ${OWNER_NAME}`,
              url: profile.url,
              source: domainOf(profile.url),
              content: text.slice(0, OWNER_PROFILE_MAX_CHARACTERS),
              publishedDate: "",
            });
            collect(
              {
                kind: "web",
                title: r?.title || `${profile.name} profile of ${OWNER_NAME}`,
                url: profile.url,
                site: domainOf(profile.url),
              },
              `${r?.title || profile.name}\n${text.slice(0, OWNER_PROFILE_MAX_CHARACTERS)}`
            );
          } else {
            unavailable.push(profile.name);
          }
        }

        let output = formatWebResults(results, "");
        if (unavailable.length > 0) {
          output += `\n\nNOTE: These profiles could not be fetched right now: ${unavailable.join(", ")}. For information they would have covered, use a broad webSearch (journal sites, SSRN, university pages) WITHOUT restricting includeDomains.`;
        }
        return output;
      } catch (error) {
        console.error("Error fetching owner profiles:", error);
        return "<web-results>\nProfile pages are temporarily unavailable. Use a broad webSearch instead and do not fabricate URLs.\n</web-results>";
      }
    },
  });
}
