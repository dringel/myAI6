import { tool } from "ai";
import { z } from "zod";
import { searchPinecone } from "@/lib/pinecone";
import { KB_SCOPE } from "@/config";
import { kbKey } from "@/lib/citations";
import type { UISource } from "@/types/data";

/**
 * Builds the knowledge base search tool. `collect` receives a structured
 * UISource for each source used, so the code-rendered Sources box is populated
 * independently of the model's markdown. The tool still returns the scaffolded
 * `<results>` text to the model for citation.
 */
export function createVectorDatabaseSearch(
  collect: (s: UISource, content?: string) => void
) {
  return tool({
    description:
      `Search the knowledge base for indexed content. ${KB_SCOPE} ` +
      `Simply provide a search query — do NOT specify source_name or chunk_type unless you have a specific reason. ` +
      `The search uses semantic similarity, so phrase your query as a natural language question or statement.`,
    inputSchema: z.object({
      query: z.string().describe(
        "Natural language search query. Example: 'What is the M4 framework for market structure mapping?'"
      ),
      source_name: z.string().optional().describe(
        "Optional filter by source document name. Leave empty to search all documents."
      ),
      chunk_type: z.enum(["text", "image", "figure", "table", "code", "code_output"]).optional().describe(
        "Optional filter by content type. Leave empty to search all types."
      ),
    }),

    execute: async ({ query, source_name, chunk_type }) => {
      const { text, sources } = await searchPinecone(query, {
        source_name,
        chunk_type,
      });

      for (const s of sources) {
        collect(
          {
            kind: "kb",
            title: (s.source_description || s.source_name || "Knowledge base source").trim(),
            // URL-less KB sources get a kb: citation key so the model can cite
            // them and they appear in the Sources box as unlinked entries.
            url: s.source_url || kbKey(s.source_name || s.source_description),
            site: s.source_name || "Knowledge base",
          },
          // Text the model saw for this source, for citation claim verification.
          [s.source_description, ...s.chunks.map((c) => [c.text, c.description, c.table_markdown].filter(Boolean).join("\n"))].join("\n")
        );
      }

      return text;
    },
  });
}
