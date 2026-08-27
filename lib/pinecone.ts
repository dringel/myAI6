import { Pinecone } from "@pinecone-database/pinecone";
import {
  PINECONE_TOP_K,
  PINECONE_MIN_SCORE,
  PINECONE_INDEX_NAME,
  PINECONE_USE_PARENT_CHILD,
  PINECONE_NS_CHILDREN,
  PINECONE_NS_PARENTS,
  PINECONE_NS_PROPOSITIONS,
  PINECONE_PROP_BOOST,
  PINECONE_PROP_K,
  PINECONE_VISUAL_TOP_K,
  PINECONE_VISUALS_PER_SOURCE,
  PINECONE_CACHE_TTL_MS,
} from "@/config";
import {
  searchResultsToChunks,
  getSourcesFromChunks,
  getContextFromSources,
} from "@/lib/sources";
import { TTLCache } from "@/lib/cache";
import type { Chunk, Source } from "@/types/data";

export interface PineconeSearchResult {
  /** Scaffolded `<results>` context string given to the model. */
  text: string;
  /** Structured sources for the code-rendered Sources box. */
  sources: Source[];
}

const searchCache = new TTLCache<PineconeSearchResult>(PINECONE_CACHE_TTL_MS);

// Lazy initialization: the client is only created on first search, so importing
// this module never crashes when PINECONE_API_KEY is absent (e.g. ENABLE_VECTOR_SEARCH=false).
let _index: ReturnType<Pinecone["Index"]> | null = null;

function pineconeIndex() {
  if (!_index) {
    const apiKey = process.env.PINECONE_API_KEY;
    if (!apiKey) {
      throw new Error(
        "PINECONE_API_KEY is not set. Vector search is unavailable."
      );
    }
    _index = new Pinecone({ apiKey }).Index(PINECONE_INDEX_NAME);
  }
  return _index;
}

type PineconeFilters = {
  source_name?: string;
  chunk_type?: Chunk["chunk_type"];
};

// --- Legacy single-namespace search (backward compat) ---

async function searchLegacy(
  query: string,
  opts: PineconeFilters
): Promise<Chunk[]> {
  const filter: Record<string, any> = {};
  if (opts.source_name) filter.source_name = { $eq: opts.source_name };
  if (opts.chunk_type) filter.chunk_type = { $eq: opts.chunk_type };

  const results = await pineconeIndex().namespace("default").searchRecords({
    query: {
      inputs: { text: query },
      topK: PINECONE_TOP_K,
      ...(Object.keys(filter).length ? { filter } : {}),
    },
    fields: [
      "text",
      "pre_context",
      "post_context",
      "source_url",
      "image_url",
      "source_description",
      "source_type",
      "source_name",
      "chunk_type",
      "order",
      "page_number",
    ],
  });

  filterByScore(results);
  const chunks = searchResultsToChunks(results);
  return deduplicateLegacy(chunks);
}

// --- Parent-child multi-namespace search ---

async function searchParentChild(
  query: string,
  opts: PineconeFilters
): Promise<Chunk[]> {
  const filter: Record<string, any> = {};
  if (opts.source_name) filter.source_name = { $eq: opts.source_name };
  if (opts.chunk_type) filter.chunk_type = { $eq: opts.chunk_type };

  // 1. Search children namespace (no parent_content — fetched separately)
  const childResults = await pineconeIndex()
    .namespace(PINECONE_NS_CHILDREN)
    .searchRecords({
      query: {
        inputs: { text: query },
        topK: PINECONE_TOP_K,
        ...(Object.keys(filter).length ? { filter } : {}),
      },
      fields: [
        "text",
        "parent_id",
        "chunk_type",
        "source_url",
        "source_name",
        "source_description",
        "source_type",
        "image_url",
        "page_numbers",
        "order",
        "summary",
        "keywords",
        "context_breadcrumb",
        "description",
        "figure_caption",
        "table_markdown",
      ],
    });

  filterByScore(childResults);

  // 2. Search propositions namespace for score boosting
  const propScoreBoosts = new Map<string, number>();
  try {
    const propResults = await pineconeIndex()
      .namespace(PINECONE_NS_PROPOSITIONS)
      .searchRecords({
        query: {
          inputs: { text: query },
          topK: PINECONE_PROP_K,
        },
        fields: ["source_child_id", "content"],
      });

    const propRes = propResults as any;
    const propHits =
      propResults?.result?.hits ??
      propRes?.records ??
      propRes?.matches ??
      [];
    if (Array.isArray(propHits)) {
      for (const h of propHits) {
        const hit = h as any;
        const childId =
          hit?.fields?.source_child_id ??
          hit?.metadata?.source_child_id ??
          "";
        const score = (hit._score ?? hit.score ?? 0) * PINECONE_PROP_BOOST;
        if (childId) {
          propScoreBoosts.set(
            childId,
            (propScoreBoosts.get(childId) ?? 0) + score
          );
        }
      }
    }
  } catch (e) {
    // Propositions namespace may not exist yet — that's fine
    console.warn("Proposition search failed (non-fatal):", e);
  }

  // 3. Parse children results and boost scores
  const childRes = childResults as any;
  const childHits =
    childResults?.result?.hits ??
    childRes?.records ??
    childRes?.matches ??
    [];

  // Apply proposition score boosts to child hits
  if (Array.isArray(childHits)) {
    for (const h of childHits) {
      const hit = h as any;
      const id = hit.id ?? hit._id ?? "";
      const boost = propScoreBoosts.get(id) ?? 0;
      if (boost > 0) {
        if (hit._score !== undefined) hit._score += boost;
        else if (hit.score !== undefined) hit.score += boost;
      }
    }
    // Re-sort by boosted score
    childHits.sort(
      (a: any, b: any) =>
        (b._score ?? b.score ?? 0) - (a._score ?? a.score ?? 0)
    );
  }

  const chunks = searchResultsToChunks(childResults);

  // 4. Deduplicate by parent_id (keep highest-scoring child per parent)
  const byParent = new Map<string, Chunk>();
  const noParent: Chunk[] = [];

  for (const c of chunks) {
    // Figures, tables, code, code_output are always kept
    if (["figure", "table", "code", "code_output"].includes(c.chunk_type)) {
      noParent.push(c);
      continue;
    }

    const pid = c.parent_id;
    if (pid) {
      if (!byParent.has(pid)) {
        byParent.set(pid, c);
      }
      // First seen = highest score (already sorted)
    } else {
      // No parent_id — legacy record or standalone
      noParent.push(c);
    }
  }

  const dedupedChunks = [...Array.from(byParent.values()), ...noParent];

  // 5. Fetch the figure/table chunks of every retrieved source.
  // Text chunks reference figures ("see Figure 3") whose visual chunks rarely
  // score into the semantic top_k, and one lucky figure in the results must
  // NOT suppress the rest — the model can only show or discuss figures whose
  // URLs it actually sees. Merge ALL of each source's visuals (bounded by
  // PINECONE_VISUALS_PER_SOURCE) and let the prompt rules pick what to embed.
  const sourceNames = new Set(dedupedChunks.map(c => c.source_name).filter(Boolean));

  if (sourceNames.size > 0) {
    try {
      for (const sourceName of sourceNames) {
        // Filter to visual chunks SERVER-SIDE so every topK slot is a figure/table
        // (client-side filtering let text chunks crowd out most visuals), and rank
        // them by the USER'S query so the cap keeps the visuals relevant to what
        // was asked — not just whichever figures appear first in the document.
        const visualResults = await pineconeIndex()
          .namespace(PINECONE_NS_CHILDREN)
          .searchRecords({
            query: {
              inputs: { text: query },
              topK: PINECONE_VISUAL_TOP_K,
              filter: {
                source_name: { $eq: sourceName },
                chunk_type: { $in: ["figure", "table"] },
              },
            },
            fields: [
              "text", "parent_id", "chunk_type", "source_url",
              "source_name", "source_description", "source_type",
              "image_url", "page_numbers", "order", "summary",
              "keywords", "context_breadcrumb", "description",
              "figure_caption", "table_markdown",
            ],
          });
        // Results arrive relevance-ranked; keep the top N most relevant...
        const existingIds = new Set(dedupedChunks.map(c =>
          `${c.chunk_type}::${c.source_name}::${c.order}`
        ));
        const selected = searchResultsToChunks(visualResults)
          .filter(c => ["figure", "table"].includes(c.chunk_type))
          .filter(c => !existingIds.has(`${c.chunk_type}::${c.source_name}::${c.order}`))
          .slice(0, PINECONE_VISUALS_PER_SOURCE);
        // ...then present the selected ones in document order, so "Figure 2"
        // style references line up for the model.
        selected.sort((a, b) => a.order - b.order);
        for (const vc of selected) {
          dedupedChunks.push(vc);
          existingIds.add(`${vc.chunk_type}::${vc.source_name}::${vc.order}`);
        }
      }
    } catch (e) {
      console.warn("Visual chunk enrichment failed (non-fatal):", e);
    }
  }

  // 6. Fetch parent records to get parent_content (richer context)
  const parentIds = Array.from(byParent.keys()).filter(Boolean);
  if (parentIds.length > 0) {
    try {
      const parentResponse = await pineconeIndex()
        .namespace(PINECONE_NS_PARENTS)
        .fetch(parentIds);

      const parentRecords = parentResponse?.records ?? {};
      for (const chunk of dedupedChunks) {
        if (chunk.parent_id && parentRecords[chunk.parent_id]) {
          const parentRecord = parentRecords[chunk.parent_id] as any;
          const parentContent =
            parentRecord?.metadata?.content ??
            parentRecord?.fields?.content ??
            parentRecord?.metadata?.text ??
            parentRecord?.fields?.text ??
            "";
          if (parentContent) {
            chunk.parent_content = parentContent;
            // Update chunk.text to use richer parent content for LLM context
            // (text was set from child's own content since parent_content wasn't in search results)
            if (chunk.chunk_type === "text") {
              chunk.text = parentContent;
            }
          }
        }
      }
    } catch (e) {
      // Parent fetch failed — child text still works as fallback
      console.warn("Parent fetch failed (non-fatal):", e);
    }
  }

  return dedupedChunks;
}

// --- Shared helpers ---

function filterByScore(results: any): void {
  const res = results as any;
  const rawRecords =
    results?.result?.hits ?? res?.records ?? res?.matches ?? [];
  if (Array.isArray(rawRecords)) {
    const filtered = rawRecords.filter(
      (r: any) => (r._score ?? r.score ?? 1) >= PINECONE_MIN_SCORE
    );
    if (results?.result?.hits) results.result.hits = filtered;
    else if (res?.records) res.records = filtered;
    else if (res?.matches) res.matches = filtered;
  }
}

function deduplicateLegacy(chunks: Chunk[]): Chunk[] {
  const deduped = new Map<string, Chunk>();

  for (const c of chunks) {
    if (["figure", "table", "code", "code_output"].includes(c.chunk_type)) {
      deduped.set(`${c.chunk_type}::${c.source_name}::${c.order}`, c);
      continue;
    }

    const key = `${c.source_name ?? ""}::${c.order ?? ""}`;
    const prev = deduped.get(key);

    if (!prev) {
      deduped.set(key, c);
      continue;
    }

    if (prev.chunk_type !== "text" && c.chunk_type === "text") {
      deduped.set(key, c);
    }
  }

  return Array.from(deduped.values());
}

// --- Public API ---

export async function searchPinecone(
  query: string,
  opts: PineconeFilters = {}
): Promise<PineconeSearchResult> {
  const cacheKey = `${query}::${opts.source_name ?? ""}::${opts.chunk_type ?? ""}`;
  const cached = searchCache.get(cacheKey);
  if (cached) return cached;

  const chunks = PINECONE_USE_PARENT_CHILD
    ? await searchParentChild(query, opts)
    : await searchLegacy(query, opts);

  const sources = getSourcesFromChunks(chunks);
  const context = getContextFromSources(sources);

  const result: PineconeSearchResult = {
    text: `<results>\n${context}\n</results>`,
    sources,
  };
  searchCache.set(cacheKey, result);
  return result;
}
