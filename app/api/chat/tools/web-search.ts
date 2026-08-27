import { tool } from 'ai';
import { z } from 'zod';
import Exa from 'exa-js';
import {
  EXA_NUM_RESULTS,
  EXA_SEARCH_TYPE,
  EXA_MAX_CHARACTERS,
  EXA_SYSTEM_PROMPT,
  EXA_LIVECRAWL,
  OWNER_PROFILE_DOMAINS,
} from '@/config';
import type { UISource } from '@/types/data';

// Lazy singleton: instantiating Exa at module load makes `next build` fail on
// machines without EXA_API_KEY (build-time page-data collection imports this
// module). The client is only created on first actual search.
let exaClient: Exa | null = null;
export function getExa(): Exa {
  if (!exaClient) exaClient = new Exa(process.env.EXA_API_KEY);
  return exaClient;
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export interface WebResult {
  title: string;
  url: string;
  source: string;
  content: string;
  publishedDate: string;
}

// Formats web results with the same citation scaffolding the knowledge base uses
// (see lib/sources.ts), so the model cites and links them in its References
// section the same way. Each source carries an explicit URL and a ready-to-use
// markdown link; the domain is kept distinct so facts are attributed to the exact
// site they came from.
export function formatWebResults(results: WebResult[], synthesis: string): string {
  if (results.length === 0 && !synthesis) {
    return "<web-results>\nNo relevant web results found.\n</web-results>";
  }

  const blocks = results.map((r, i) =>
    [
      `# Web Source ${i + 1}`,
      `## Title`,
      r.title || "(untitled)",
      `## Site`,
      r.source || "(unknown)",
      `## Reference Link (cite using this exact URL)`,
      `[${r.title || r.source || r.url}](${r.url})`,
      `## Published`,
      r.publishedDate || "(date unknown)",
      `## Excerpt`,
      r.content || "(no excerpt)",
    ].join("\n")
  );

  if (synthesis) {
    blocks.push(
      `# Web Synthesis (overview only — no single URL; cite the individual Web Sources above for each claim)\n${synthesis}`
    );
  }

  return `<web-results>\n${blocks.join("\n\n")}\n</web-results>`;
}

/**
 * Builds the web search tool. `collect` receives a structured UISource for each
 * result used, so the code-rendered Sources box is populated independently of
 * the model's markdown. The tool still returns the scaffolded `<web-results>`
 * text to the model for citation.
 */
export function createWebSearch(collect: (s: UISource, content?: string) => void) {
  return tool({
  description:
    'Search the web for information related to the knowledge base scope. ' +
    'Use AFTER vectorDatabaseSearch. Good uses: recent developments, external perspectives, citations, author profiles, related work. ' +
    'CRITICAL: Do NOT search for specific framework/paper names. Instead, search for the UNDERLYING CONCEPTS and METHODS. ' +
    'Use additionalQueries to cover 2-3 different angles with different terminology. ' +
    `For the LATEST on the owner, prefer the fetchOwnerProfiles tool first; use this tool for broad follow-ups WITHOUT includeDomains. ` +
    `Only set includeDomains (e.g. ${OWNER_PROFILE_DOMAINS.join(', ')}) when the user explicitly asks about one specific site.`,
  inputSchema: z.object({
    query: z.string().min(1).describe(
      'Primary search query using BROAD conceptual terms, NOT specific framework names. ' +
      'Describe the PROBLEM DOMAIN and METHODS, not the name of a specific approach.'
    ),
    additionalQueries: z.array(z.string()).optional().describe(
      '2-3 alternative queries using DIFFERENT terminology for the same topic. ' +
      'Each should use different synonyms, related methods, or application domains to maximize coverage.'
    ),
    includeDomains: z.array(z.string()).optional().describe(
      'Restrict results to these domains (e.g. ["linkedin.com","orcid.org"]). ' +
      'Use for profile/recency lookups about a specific person to avoid stale or unrelated pages.'
    ),
  }),
  execute: async ({ query, additionalQueries, includeDomains }) => {
    try {
      const response = await getExa().search(query, {
        type: EXA_SEARCH_TYPE,
        numResults: EXA_NUM_RESULTS,
        livecrawl: EXA_LIVECRAWL,
        ...(additionalQueries?.length ? { additionalQueries } : {}),
        ...(includeDomains?.length ? { includeDomains } : {}),
        systemPrompt: EXA_SYSTEM_PROMPT,
        contents: {
          text: { maxCharacters: EXA_MAX_CHARACTERS },
        },
      } as any); // cast needed: exa-js types lag behind API features

      const res = response as any;

      // A web source is only citable if it has a URL — drop the rest so the model
      // never surfaces an unlinkable web finding.
      const results: WebResult[] = (res.results || [])
        .filter((result: any) => result.url)
        .map((result: any) => ({
          title: result.title || '',
          url: result.url as string,
          source: domainOf(result.url),
          content: result.text?.slice(0, EXA_MAX_CHARACTERS) || '',
          publishedDate: result.publishedDate || '',
        }));

      // Deep search may return a synthesized overview (no single URL of its own)
      // plus grounding references. The grounding entries ARE citable sources —
      // without them a synthesis-heavy deep result leaves the model nothing to
      // cite. Merge them in, deduped against the regular results by URL.
      const synthesis = res.output?.content
        ? (typeof res.output.content === 'string'
            ? res.output.content
            : JSON.stringify(res.output.content))
        : '';

      const seenUrls = new Set(results.map((r) => r.url.toLowerCase().replace(/\/+$/, '')));
      for (const g of res.output?.grounding || []) {
        const gUrl: string = typeof g === 'string' ? g : g?.url || '';
        if (!gUrl) continue;
        const key = gUrl.toLowerCase().replace(/\/+$/, '');
        if (seenUrls.has(key)) continue;
        seenUrls.add(key);
        results.push({
          title: (typeof g === 'object' && (g?.title as string)) || domainOf(gUrl) || gUrl,
          url: gUrl,
          source: domainOf(gUrl),
          content: (typeof g === 'object' && (g?.text as string)?.slice(0, EXA_MAX_CHARACTERS)) || '',
          publishedDate: (typeof g === 'object' && (g?.publishedDate as string)) || '',
        });
      }

      for (const r of results) {
        collect(
          {
            kind: 'web',
            title: r.title || r.source || r.url,
            url: r.url,
            site: r.source,
            ...(r.publishedDate ? { publishedDate: r.publishedDate } : {}),
          },
          `${r.title}\n${r.content}`
        );
      }

      return formatWebResults(results, synthesis);
    } catch (error) {
      console.error('Error searching the web:', error);
      return '<web-results>\nWeb search is temporarily unavailable. Answer from other sources and do not fabricate URLs.\n</web-results>';
    }
  },
  });
}
