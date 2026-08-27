import { Chunk, Source, chunkSchema } from "@/types/data";
import { kbKey } from "@/lib/citations";

function forceHttps(url: string): string {
  if (!url) return "";
  return url.startsWith("http://") ? url.replace("http://", "https://") : url;
}

export function getSourceKey(source_url: string, source_description: string): string {
  const safeUrl = forceHttps(source_url);
  return `${safeUrl}|||${source_description}`;
}

export function aggregateSourcesFromChunks(chunks: Chunk[]): Source[] {
  const sourceMap = new Map<string, Source>();

  chunks.forEach((chunk) => {
    const safeChunkUrl = forceHttps(chunk.source_url);
    const key = getSourceKey(safeChunkUrl, chunk.source_description);

    if (!sourceMap.has(key)) {
      sourceMap.set(key, {
        chunks: [],
        source_url: safeChunkUrl,
        source_description: chunk.source_description,
        source_name: chunk.source_name,
      });
    }

    chunk.source_url = safeChunkUrl;
    sourceMap.get(key)!.chunks.push(chunk);
  });

  return Array.from(sourceMap.values());
}

export function sortChunksInSourceByOrder(source: Source): Source {
  source.chunks.sort((a, b) => a.order - b.order);
  return source;
}

export function getSourcesFromChunks(chunks: Chunk[]): Source[] {
  const sources = aggregateSourcesFromChunks(chunks);
  return sources.map((source) => sortChunksInSourceByOrder(source));
}

export function buildContextFromOrderedChunks(chunks: Chunk[], citationNumber: number, sourceUrl: string): string {
  if (chunks.length === 0) return "";

  const citationLink = sourceUrl ? `[${citationNumber}](${sourceUrl})` : `[${citationNumber}]`;

  return chunks
    .map((chunk) => {
      const imgUrl = chunk.image_url || "";

      switch (chunk.chunk_type) {
        case "image": {
          // Standalone image — always embed
          const url = imgUrl || chunk.source_url;
          const alt = chunk.text || chunk.source_description;
          return `![${alt}](${url})`;
        }

        case "figure": {
          // Extracted figure — always embed with description
          const desc = chunk.text || chunk.source_description;
          if (imgUrl) return `**Figure:** ${desc}\n![Figure](${imgUrl})`;
          return `**Figure:** ${desc} ${citationLink}`;
        }

        case "table": {
          // Extracted table — include markdown table for LLM + image for display
          const desc = chunk.description || chunk.text || chunk.source_description;
          const md = chunk.table_markdown;
          const img = imgUrl ? `\n![Table](${imgUrl})` : "";
          if (md) return `**Table:** ${desc}\n\n${md}${img} ${citationLink}`;
          return `**Table:** ${desc}${img} ${citationLink}`;
        }

        case "code": {
          // Code cell — format as code block with citation
          return `\`\`\`\n${chunk.text}\n\`\`\` ${citationLink}`;
        }

        case "code_output": {
          // Code output — embed image if available, otherwise show text
          if (imgUrl) {
            const desc = chunk.text || "Output";
            return `**Output:**\n![${desc}](${imgUrl})`;
          }
          return `**Output:**\n${chunk.text}`;
        }

        case "text":
        default: {
          // Text chunk — include text with citation
          const breadcrumb = chunk.context_breadcrumb ? `### ${chunk.context_breadcrumb}\n` : "";
          const textPart = `${breadcrumb}${chunk.text} ${citationLink}`;
          // If image_url is set (e.g., slide image), provide ready-to-use embed syntax
          if (imgUrl) {
            const slideLabel = chunk.page_number ? `Slide ${chunk.page_number}` : "Slide";
            return `${textPart}\n**${slideLabel}:** ![${slideLabel}](${imgUrl})`;
          }
          return textPart;
        }
      }
    })
    .join("\n\n")
    .trim();
}

export function getContextFromSource(source: Source, citationNumber: number): string {
  const safeUrl = forceHttps(source.source_url);

  return `
<excerpt-from-source>
# Source ${citationNumber}
## Source Name
${source.source_name}
## Source Description
${source.source_description}
## Source Citation
${safeUrl ? `[${citationNumber}](${safeUrl})` : `[${citationNumber}](${kbKey(source.source_name || source.source_description)}) — this source has no public URL. Cite it inline with EXACTLY this target, e.g. [[N]](${kbKey(source.source_name || source.source_description)}). NEVER substitute placeholder text as a link target.`}
## Excerpt from Source
${buildContextFromOrderedChunks(source.chunks, citationNumber, safeUrl)}
</excerpt-from-source>
`;
}

export function getContextFromSources(sources: Source[]): string {
  return sources
    .map((source, index) => getContextFromSource(source, index + 1))
    .join("\n\n\n");
}

export function searchResultsToChunks(results: any): Chunk[] {
  let records: any[] = [];

  if (Array.isArray(results)) {
    records = results;
  } else if (results?.result?.hits && Array.isArray(results.result.hits)) {
    records = results.result.hits;
  } else if (results?.records && Array.isArray(results.records)) {
    records = results.records;
  } else if (results?.matches && Array.isArray(results.matches)) {
    records = results.matches;
  } else if (results?.data && Array.isArray(results.data)) {
    records = results.data;
  } else {
    console.warn("searchResultsToChunks - Invalid results structure:", results);
    return [];
  }

  return records
    .map((record: any) => {
      const fields = record.fields || record.values || record.data || {};
      const metadata = record.metadata || {};

      const imageUrl = fields.image_url || metadata.image_url || "";

      // Parent-child fields (from semantic pipeline)
      const parentContent = fields.parent_content || metadata.parent_content || "";
      const parentId = fields.parent_id || metadata.parent_id || "";
      const content = fields.content || metadata.content || "";

      // Use parent_content as text if available (richer ~3000 char context),
      // falling back to content (child text), then legacy text fields
      const textValue =
        parentContent ||
        content ||
        fields.chunk_text ||
        fields.text ||
        metadata.chunk_text ||
        metadata.text ||
        record.text ||
        "";

      // Parse page_numbers (JSON array) → page_number (first element)
      let pageNumber: number | undefined;
      if (fields.page_number !== undefined || metadata.page_number !== undefined) {
        pageNumber = fields.page_number ?? metadata.page_number;
      } else {
        const pnRaw = fields.page_numbers || metadata.page_numbers;
        if (pnRaw) {
          try {
            const arr = typeof pnRaw === "string" ? JSON.parse(pnRaw) : pnRaw;
            if (Array.isArray(arr) && arr.length > 0) pageNumber = arr[0];
          } catch { /* ignore */ }
        }
      }

      const chunkData = {
        pre_context: fields.pre_context || metadata.pre_context || "",
        text: textValue,
        post_context: fields.post_context || metadata.post_context || "",
        chunk_type: (fields.chunk_type || metadata.chunk_type || "text") as Chunk["chunk_type"],
        source_url: forceHttps(fields.source_url || metadata.source_url || ""),
        ...(imageUrl ? { image_url: forceHttps(imageUrl) } : {}),
        source_description: fields.source_description || metadata.source_description || "",
        source_name: fields.source_name || metadata.source_name || "",
        order:
          fields.order !== undefined
            ? fields.order
            : metadata.order !== undefined
              ? metadata.order
              : 0,
        ...(pageNumber !== undefined ? { page_number: pageNumber } : {}),
        // Parent-child enrichment fields
        ...(parentId ? { parent_id: parentId } : {}),
        ...(parentContent ? { parent_content: parentContent } : {}),
        ...(fields.summary || metadata.summary ? { summary: fields.summary || metadata.summary } : {}),
        ...(fields.keywords || metadata.keywords ? { keywords: fields.keywords || metadata.keywords } : {}),
        ...(fields.context_breadcrumb || metadata.context_breadcrumb
          ? { context_breadcrumb: fields.context_breadcrumb || metadata.context_breadcrumb }
          : {}),
        ...(fields.description || metadata.description ? { description: fields.description || metadata.description } : {}),
        ...(fields.table_markdown || metadata.table_markdown ? { table_markdown: fields.table_markdown || metadata.table_markdown } : {}),
      };

      try {
        return chunkSchema.parse(chunkData);
      } catch {
        return null;
      }
    })
    .filter((chunk: Chunk | null): chunk is Chunk => chunk !== null);
}
