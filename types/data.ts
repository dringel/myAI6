import { z } from "zod";

export const uploadedDocumentSchema = z.object({
    id: z.string(),
    title: z.string(),
    created_at: z.string(),
    content: z.string(),
});
export type UploadedDocument = z.infer<typeof uploadedDocumentSchema>;

export const chunkSchema = z.object({
    pre_context: z.string(),
    text: z.string(),
    post_context: z.string(),
    chunk_type: z.enum(["text", "image", "figure", "table", "code", "code_output"]),
    source_url: z.string(),
    image_url: z.string().optional(),
    source_description: z.string(),
    source_name: z.string(),
    order: z.number(),
    page_number: z.number().optional(),
    // Parent-child fields (from semantic chunking pipeline)
    parent_id: z.string().optional(),
    parent_content: z.string().optional(),
    summary: z.string().optional(),
    keywords: z.string().optional(),
    context_breadcrumb: z.string().optional(),
    description: z.string().optional(),
    table_markdown: z.string().optional(),
});
export type Chunk = z.infer<typeof chunkSchema>;

export const sourceSchema = z.object({
    chunks: z.array(chunkSchema),
    source_url: z.string(),
    source_description: z.string(),
    source_name: z.string(),
});
export type Source = z.infer<typeof sourceSchema>;

// Structured source shown in the code-rendered Sources box. Emitted by the
// search tools as a `data-sources` stream part, independent of the model's
// markdown, so the box is deterministic and cannot be omitted by the model.
export const uiSourceSchema = z.object({
    kind: z.enum(["kb", "web"]),
    title: z.string(),
    url: z.string(), // may be "" for knowledge base sources without a public URL
    site: z.string(), // web: domain; kb: source name / "Knowledge base"
    publishedDate: z.string().optional(),
    // Citation number parsed from the model's inline [[N]](url) citations —
    // the box displays exactly this number, so text and box cannot disagree.
    number: z.number().optional(),
    // Claim verification result: true when the sentence preceding a citation
    // (or a legacy in-citation quote) is supported by the retrieved source
    // text. Rendered as a green check in the Sources box; undefined = nothing
    // could be checked (no marker).
    verified: z.boolean().optional(),
});
export type UISource = z.infer<typeof uiSourceSchema>;