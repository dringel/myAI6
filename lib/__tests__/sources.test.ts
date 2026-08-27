import { describe, it, expect } from "vitest";
import {
  searchResultsToChunks,
  getSourcesFromChunks,
  getContextFromSources,
  aggregateSourcesFromChunks,
  buildContextFromOrderedChunks,
} from "@/lib/sources";
import { Chunk } from "@/types/data";

const makeChunk = (overrides: Partial<Chunk> = {}): Chunk => ({
  pre_context: "",
  text: "Sample text",
  post_context: "",
  chunk_type: "text",
  source_url: "https://example.com/source",
  source_description: "Test Source",
  source_name: "test-source",
  order: 0,
  ...overrides,
});

describe("searchResultsToChunks", () => {
  it("returns empty array for null/undefined results", () => {
    expect(searchResultsToChunks(null)).toEqual([]);
    expect(searchResultsToChunks(undefined)).toEqual([]);
  });

  it("handles results with result.hits format", () => {
    const results = {
      result: {
        hits: [
          {
            fields: {
              text: "Hello world",
              source_url: "https://example.com",
              source_description: "Test",
              source_name: "test",
              chunk_type: "text",
            },
          },
        ],
      },
    };
    const chunks = searchResultsToChunks(results);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe("Hello world");
  });

  it("handles results with records format", () => {
    const results = {
      records: [
        {
          fields: {
            text: "Record text",
            source_url: "https://example.com",
            source_description: "Test",
            source_name: "test",
            chunk_type: "text",
          },
        },
      ],
    };
    const chunks = searchResultsToChunks(results);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe("Record text");
  });

  it("handles results with matches format", () => {
    const results = {
      matches: [
        {
          metadata: {
            text: "Match text",
            source_url: "https://example.com",
            source_description: "Test",
            source_name: "test",
            chunk_type: "text",
          },
        },
      ],
    };
    const chunks = searchResultsToChunks(results);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe("Match text");
  });

  it("forces http URLs to https", () => {
    const results = {
      records: [
        {
          fields: {
            text: "test",
            source_url: "http://example.com",
            source_description: "Test",
            source_name: "test",
            chunk_type: "text",
          },
        },
      ],
    };
    const chunks = searchResultsToChunks(results);
    expect(chunks[0].source_url).toBe("https://example.com");
  });

  it("filters out invalid records", () => {
    const results = {
      records: [
        { fields: { text: "valid", source_url: "https://example.com", source_description: "Test", source_name: "test", chunk_type: "text" } },
        { fields: {} }, // missing required fields — will be filtered by Zod
      ],
    };
    const chunks = searchResultsToChunks(results);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });
});

describe("aggregateSourcesFromChunks", () => {
  it("groups chunks by source URL and description", () => {
    const chunks = [
      makeChunk({ source_url: "https://a.com", source_description: "A", order: 1 }),
      makeChunk({ source_url: "https://a.com", source_description: "A", order: 2 }),
      makeChunk({ source_url: "https://b.com", source_description: "B", order: 1 }),
    ];
    const sources = aggregateSourcesFromChunks(chunks);
    expect(sources).toHaveLength(2);
    expect(sources[0].chunks).toHaveLength(2);
    expect(sources[1].chunks).toHaveLength(1);
  });
});

describe("getSourcesFromChunks", () => {
  it("sorts chunks within each source by order", () => {
    const chunks = [
      makeChunk({ order: 3, text: "third" }),
      makeChunk({ order: 1, text: "first" }),
      makeChunk({ order: 2, text: "second" }),
    ];
    const sources = getSourcesFromChunks(chunks);
    expect(sources).toHaveLength(1);
    expect(sources[0].chunks[0].text).toBe("first");
    expect(sources[0].chunks[1].text).toBe("second");
    expect(sources[0].chunks[2].text).toBe("third");
  });
});

describe("buildContextFromOrderedChunks", () => {
  it("returns empty string for no chunks", () => {
    expect(buildContextFromOrderedChunks([], 1, "")).toBe("");
  });

  it("appends citation link to text chunks", () => {
    const chunks = [makeChunk({ text: "Hello" })];
    const result = buildContextFromOrderedChunks(chunks, 1, "https://example.com/source");
    expect(result).toContain("Hello [1](https://example.com/source)");
  });

  it("renders image chunks as markdown images", () => {
    const chunks = [
      makeChunk({ chunk_type: "image", text: "diagram", source_url: "https://example.com/img.png" }),
    ];
    const result = buildContextFromOrderedChunks(chunks, 1, "https://example.com/img.png");
    expect(result).toContain("![diagram](https://example.com/img.png)");
  });

  it("renders figure chunks with label and image", () => {
    const chunks = [
      makeChunk({ chunk_type: "figure", text: "A bar chart showing revenue", image_url: "https://example.com/fig.png" }),
    ];
    const result = buildContextFromOrderedChunks(chunks, 1, "https://example.com");
    expect(result).toContain("**Figure:** A bar chart showing revenue");
    expect(result).toContain("![Figure](https://example.com/fig.png)");
  });

  it("renders table chunks with label and image", () => {
    const chunks = [
      makeChunk({ chunk_type: "table", text: "Quarterly results", image_url: "https://example.com/table.png" }),
    ];
    const result = buildContextFromOrderedChunks(chunks, 1, "https://example.com");
    expect(result).toContain("**Table:** Quarterly results");
    expect(result).toContain("![Table](https://example.com/table.png)");
  });

  it("renders code chunks as code blocks with citation", () => {
    const chunks = [
      makeChunk({ chunk_type: "code", text: "print('hello')" }),
    ];
    const result = buildContextFromOrderedChunks(chunks, 1, "https://example.com");
    expect(result).toContain("```\nprint('hello')\n```");
    expect(result).toContain("[1](https://example.com)");
  });

  it("renders code_output with image", () => {
    const chunks = [
      makeChunk({ chunk_type: "code_output", text: "Scatter plot", image_url: "https://example.com/plot.png" }),
    ];
    const result = buildContextFromOrderedChunks(chunks, 1, "https://example.com");
    expect(result).toContain("**Output:**");
    expect(result).toContain("![Scatter plot](https://example.com/plot.png)");
  });

  it("includes ready-to-embed slide image for text chunks with image_url", () => {
    const chunks = [
      makeChunk({ text: "Slide content", image_url: "https://example.com/slide.png", page_number: 5 }),
    ];
    const result = buildContextFromOrderedChunks(chunks, 1, "https://example.com");
    expect(result).toContain("Slide content");
    expect(result).toContain("**Slide 5:** ![Slide 5](https://example.com/slide.png)");
  });
});

describe("getContextFromSources", () => {
  it("generates numbered source excerpts", () => {
    const sources = getSourcesFromChunks([
      makeChunk({ source_url: "https://a.com", source_description: "Source A", source_name: "a" }),
      makeChunk({ source_url: "https://b.com", source_description: "Source B", source_name: "b" }),
    ]);
    const context = getContextFromSources(sources);
    expect(context).toContain("Source 1");
    expect(context).toContain("Source 2");
    expect(context).toContain("https://a.com");
    expect(context).toContain("https://b.com");
  });
});

describe("parent-child fields", () => {
  it("uses parent_content as text when available", () => {
    const results = {
      result: {
        hits: [
          {
            fields: {
              content: "Short child text",
              parent_content: "Full parent context with much more detail about the topic",
              parent_id: "p_123",
              source_url: "https://example.com",
              source_description: "Test",
              source_name: "test",
              chunk_type: "text",
            },
          },
        ],
      },
    };
    const chunks = searchResultsToChunks(results);
    expect(chunks).toHaveLength(1);
    // parent_content should be used as text
    expect(chunks[0].text).toBe("Full parent context with much more detail about the topic");
    expect(chunks[0].parent_id).toBe("p_123");
    expect(chunks[0].parent_content).toBe("Full parent context with much more detail about the topic");
  });

  it("falls back to content when no parent_content", () => {
    const results = {
      result: {
        hits: [
          {
            fields: {
              content: "Child content only",
              parent_id: "p_456",
              source_url: "https://example.com",
              source_description: "Test",
              source_name: "test",
              chunk_type: "text",
            },
          },
        ],
      },
    };
    const chunks = searchResultsToChunks(results);
    expect(chunks[0].text).toBe("Child content only");
  });

  it("parses page_numbers JSON array to page_number", () => {
    const results = {
      result: {
        hits: [
          {
            fields: {
              text: "test",
              page_numbers: "[3, 4]",
              source_url: "https://example.com",
              source_description: "Test",
              source_name: "test",
              chunk_type: "text",
            },
          },
        ],
      },
    };
    const chunks = searchResultsToChunks(results);
    expect(chunks[0].page_number).toBe(3);
  });

  it("includes context_breadcrumb in text chunk rendering", () => {
    const chunks = [
      makeChunk({ text: "Content here", context_breadcrumb: "Chapter 1 > Introduction" }),
    ];
    const result = buildContextFromOrderedChunks(chunks, 1, "https://example.com");
    expect(result).toContain("### Chapter 1 > Introduction");
    expect(result).toContain("Content here");
  });

  it("preserves enrichment fields (summary, keywords, description)", () => {
    const results = {
      result: {
        hits: [
          {
            fields: {
              text: "test",
              summary: "A brief summary",
              keywords: '["ai", "ml"]',
              description: "Meta description",
              context_breadcrumb: "Section > Subsection",
              source_url: "https://example.com",
              source_description: "Test",
              source_name: "test",
              chunk_type: "text",
            },
          },
        ],
      },
    };
    const chunks = searchResultsToChunks(results);
    expect(chunks[0].summary).toBe("A brief summary");
    expect(chunks[0].keywords).toBe('["ai", "ml"]');
    expect(chunks[0].description).toBe("Meta description");
    expect(chunks[0].context_breadcrumb).toBe("Section > Subsection");
  });
});
