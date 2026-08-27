# myAI6

**A modular RAG chatbot built with Next.js 16, Vercel AI SDK v6, and Pinecone.**

myAI6 is a retrieval-augmented generation (RAG) chatbot template: it answers questions about its owner using an indexed knowledge base, optional web search, and multi-vendor LLM support. The assistant's name, owner, and knowledge-base scope are all configured in `config.ts` — make it yours. It features a parent-child chunking architecture, academic-style citations, content moderation, and a dynamic UI with animated processing indicators.

Template created by [Daniel M. Ringel](https://www.ringel.ai). Please acknowledge use of any or all of this code.

---

## Quickstart

### 1. Clone and install

```bash
git clone https://github.com/dringel/myAI6.git
cd myAI6
npm install
```

### 2. Set environment variables

Copy the template and fill in your keys:

```bash
cp env.template .env.local
```

**Required:**

| Variable | Source | Purpose |
|----------|--------|---------|
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) | Default LLM (Claude) + moderation + compaction |

**Optional keys:**

| Variable | Source | Purpose |
|----------|--------|---------|
| `OPENAI_API_KEY` | [platform.openai.com](https://platform.openai.com/api-keys) | OpenAI chat models or `MODERATION_PROVIDER=openai` |
| `PINECONE_API_KEY` | [app.pinecone.io](https://app.pinecone.io) | Knowledge base (vector search) |
| `EXA_API_KEY` | [dashboard.exa.ai](https://dashboard.exa.ai) | Web search |
| `FIREWORKS_API_KEY` | [fireworks.ai](https://fireworks.ai) | Alternative LLM provider |

> Unused optional keys are harmless — nothing reads them unless you switch to that vendor in `config.ts` (or set `MODERATION_PROVIDER=openai`). Keeping them set makes future vendor switches a pure config change.

**Optional feature switches** (no key needed — just set the value):

| Variable | Values | What it does when you change it |
|----------|--------|--------------------------------|
| `ENABLE_VECTOR_SEARCH` | `true` (default) / `false` | `false` disconnects the knowledge base — the bot stops searching Pinecone and answers from general knowledge |
| `ENABLE_WEB_SEARCH` | `true` (default) / `false` | `false` disables web search |
| `MODERATION_PROVIDER` | `llm` (default) / `openai` / `off` | Which service safety-checks user messages: `llm` = fast LLM classifier on the utility model, `openai` = OpenAI moderation API, `off` = none |

**Optional security variables** (generate values with `openssl rand -hex 32`):

| Variable | Default | What it does |
|----------|---------|--------------|
| `SUMMARY_HMAC_SECRET` | derived from `ANTHROPIC_API_KEY` | Secret for signing compaction summaries so clients cannot forge them (see [Security](#security)) |
| `HEALTH_CHECK_TOKEN` | unset | Unlocks detailed `/api/health` checks in production via `Authorization: Bearer <token>`; without it, production health checks return only `{"status":"ok"}` |

If a switch is not set at all, its default applies. See [Changing Settings in Vercel](#changing-settings-in-vercel) for a click-by-click guide.

### 3. Run locally

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### 4. Deploy to Vercel

Push to GitHub. Connect the repo in [vercel.com](https://vercel.com). Add the same environment variables in Vercel project settings. Every push to `main` triggers a deployment.

### 5. Add content to the knowledge base

Open the Jupyter notebook `RAGloader/RAG_loader_pipeline.ipynb` and follow the pipeline to ingest documents into Pinecone. See [Knowledge Base Pipeline](#knowledge-base-pipeline) below.

---

## Architecture

```
User Question
    |
    v
[Content Moderation] ── blocked ──> denial message
    |
    | passed
    v
[LLM + Tools]
    |
    |── vectorDatabaseSearch ──> Pinecone (children + propositions + parents)
    |── webSearch ────────────> Exa API (broad conceptual queries)
    |── fetchOwnerProfiles ───> Exa contents API (live owner profile pages)
    |
    v
[Streaming Response with Citations + Sources box]
```

### Request Flow

1. User sends a message via the chat UI (`app/page.tsx`)
2. `POST /api/chat` validates input (message count, length, rate limit, compaction-summary signature)
3. Moderation checks the message (LLM classifier on the utility model by default; configurable via `MODERATION_PROVIDER`)
4. The LLM (default: Claude Haiku 4.5) processes the message with available tools
5. Tool priority: knowledge base first; web search to supplement; live profile fetch (`fetchOwnerProfiles`) first for latest-info-on-owner questions
6. Response streams back with inline `[[N]](url)` citations; citations are canonicalized at render time and the cited sources stream as a `data-sources` part rendered as the Sources box

### Three-Namespace Retrieval

The knowledge base uses a parent-child architecture across three Pinecone namespaces:

| Namespace | Content | Purpose |
|-----------|---------|---------|
| `children` | Small chunks (~500 chars) with keywords, summaries | Searched for relevance (`PINECONE_TOP_K`, default 20) |
| `propositions` | Atomic factual statements | Score boosting for children (`PINECONE_PROP_K`, default 15) |
| `parents` | Rich context chunks (~3000 chars) | Fetched on demand by parent_id |

**Retrieval flow:**
1. Search children namespace (semantic similarity)
2. Search propositions namespace (boost matching children by `PINECONE_PROP_BOOST` × score, default 0.5)
3. Re-rank children by boosted score
4. Deduplicate: keep one child per parent
5. Fetch parent records for richer context
6. Filter by minimum score threshold (`PINECONE_MIN_SCORE`, default 0.1)

This avoids storing parent content redundantly on every child, reducing storage and token costs.

---

## Knowledge Base Pipeline

The knowledge base is built by the Jupyter notebook `RAGloader/RAG_loader_pipeline.ipynb` (with its classes and functions in `RAGloader/myAI5_RAG.py`):

### Pipeline Stages

1. **Structural Parsing** (Unstructured jobs API, hi-res layout analysis)
   - Extracts elements, images, and section hierarchy; tables stay intact
   - Removes page furniture (running headers, page numbers, rotated margin watermarks) that pollutes chunks

2. **Formula & Figure Repair** (vision model)
   - Display equations are transcribed to LaTeX (`$$…$$`) instead of garbled OCR text — the chatbot renders them as typeset math
   - Figures are re-rendered from the PDF regions, fixing crops that cut off side labels

3. **Parent-Child Splitting**
   - Parents: ~3000 character context windows
   - Children: ~500 character focused chunks with parent_id linkage

4. **LLM Enrichment** (KeyBERT + LLM; enrichment and vision models are configured per role, with adaptive-reasoning effort presets)
   - Keywords, summaries, hypothetical questions per child
   - Context breadcrumbs from document section hierarchy

5. **Proposition Decomposition** (Dense X Retrieval)
   - Breaks each child into atomic factual statements
   - Stored in propositions namespace for fine-grained matching

6. **Image Processing & Hosting** — figures/tables/slides described by the vision model, tables converted to markdown, images uploaded to **Cloudinary** (default, free) or a self-hosted SFTP server; post-processing varies by content type (see table below)

Per document, `source_url` takes one of three values: `""` (cited by name only, no link), an existing page (DOI/SSRN — usually best), or `"upload"` (the document file itself is uploaded to the image host and linked). The notebook's maintenance section also provides index utilities: statistics, source listing, deletion with verification, a full index audit with orphan cleanup, and Pinecone backup/restore.

### Supported Content Types

| Type | Parsing | Post-processing |
|------|---------|-----------------|
| `text_doc` | Unstructured jobs API (hi-res) | None (standard text) |
| `research_paper` | Unstructured jobs API (hi-res), extracts figures/tables | Figures/tables saved as PNG, uploaded to the image host (Cloudinary by default), described by the vision model. Tables converted to markdown by the vision model (handles merged headers, rotated tables) |
| `presentation` | Unstructured jobs API (hi-res), skips individual figure extraction | Full slides rendered as PNGs via PyMuPDF, uploaded to the image host (Cloudinary by default), linked to children by page number |
| `slides+text` | Unstructured jobs API (hi-res), skips individual figure extraction (like presentation) | Full pages rendered as PNGs and linked to text chunks by page number. Text is primary content; slide images are supplementary hints shown when relevant. Use for transcripts, annotated decks, or PDFs with both narrative text and slides |
| `standalone_image` | Skips Unstructured entirely. Reads image file as base64, creates single figure chunk | Saves as PNG, uploads to the image host (Cloudinary by default), vision-model description becomes the chunk content |
| `standalone_table` | Skips Unstructured. CSV/TSV: parsed to markdown table directly. Image: reads as base64 | Image tables: image-host upload + vision-model description + table-to-markdown conversion. CSV tables: LLM text description of the markdown content |
| `notebook` | Skips Unstructured. Parses `.ipynb` JSON directly. Markdown cells become text chunks, code cells become code chunks, image outputs become code_output chunks with base64 | Code output images: saved as PNG, uploaded to the image host (Cloudinary by default), described by the vision model |

### Document Configuration

Each document is configured with a `DocumentConfig`:

```python
doc_config = DocumentConfig(
    source_name="Doe_2026_Example_Paper",
    source_description="Doe (2026) An Example Research Paper, Journal of Examples",
    source_url="https://doi.org/10.0000/example",
    content_type="research_paper",
)
```

---

## Configuration Reference

Configuration is split into two places:

- **Vercel env vars** — secrets and operational switches, changeable from the dashboard without a code change (redeploy to apply): all API keys, `ENABLE_VECTOR_SEARCH`, `ENABLE_WEB_SEARCH`, `MODERATION_PROVIDER`
- **`config.ts`** — design and tuning parameters (models, thresholds, prompts, namespaces), changed via commit + push

The tables below list everything; parameters marked "(env var)" belong to the first group.

### Changing Settings in Vercel

Step-by-step guide for the env-var switches — no coding required:

1. Log in at [vercel.com](https://vercel.com) and open your project (e.g. `my-ai-5`)
2. Click **Settings** (top navigation) → **Environment Variables** (left menu)
3. To add a switch: type the name in **Key** (e.g. `ENABLE_WEB_SEARCH`), the value in **Value** (e.g. `false`), leave all environments checked, and click **Save**
4. To change an existing one: click the **⋯** menu next to it → **Edit** → change the value → **Save**
5. **Redeploy so the change takes effect**: go to **Deployments**, click **⋯** on the most recent deployment → **Redeploy**. (Vercel usually also offers a redeploy prompt right after you save.)

The change goes live in about a minute. To undo it, either delete the variable (the default applies again) or edit the value back.

### Identity

| Parameter | Default | Description |
|-----------|---------|-------------|
| `AI_NAME` | `"myAI6"` | Assistant display name (the chatbot presents itself under this name) |
| `AI_DESCRIPTION` | (derived from `AI_NAME`/`OWNER_NAME`) | Metadata description (browser/search snippet) |
| `BROWSER_TAB_TITLE` | `AI_NAME` | Browser tab / metadata title (derived from `AI_NAME` by default) |
| `OWNER_NAME` | `"Your Name"` | The person the assistant represents (used in prompts and UI) |
| `WELCOME_MESSAGE` | `"Hello! I'm myAI6..."` | First message shown to users |
| `CLEAR_CHAT_TEXT` | `"New"` | New chat button label |

### Model Selection

| Parameter | Default | Options |
|-----------|---------|---------|
| `DEFAULT_VENDOR` | `"anthropic"` | `"anthropic"`, `"openai"`, `"fireworks"` — vendor for the chat model |
| `DEFAULT_MODEL_ID` | `"claude-haiku-4-5"` | See model registry below |
| `DEFAULT_MODE` | `"chat"` | `"chat"`, `"reasoning"` |
| `DEFAULT_THINKING_LEVEL` | `"medium"` | `"off"`, `"low"`, `"medium"`, `"high"` — level used when reasoning mode is triggered |
| `CHAT_THINKING_LEVEL` | `"low"` | Thinking level in plain chat mode (`"low"`, `"medium"`, `"high"`) |
| `MAX_OUTPUT_TOKENS` | `undefined` | Optional response-token cap passed to `streamText`; `undefined` = provider default. If set with Anthropic thinking enabled, must exceed the thinking budget in use |
| `UTILITY_VENDOR` | `"anthropic"` | `"anthropic"`, `"openai"`, `"fireworks"` — vendor for background tasks (moderation classifier, compaction summaries) |
| `UTILITY_MODEL_ID` | `"claude-haiku-4-5"` | Pick a fast, cheap model from the registry (e.g. `gpt-5.4-mini`, `accounts/fireworks/models/deepseek-v3`) |

The chat model and the utility model are independent: you can run chat on one vendor and background tasks on another, or set both to the same vendor to fully switch providers (only that vendor's API key is then needed).

**Available Models** (verified August 2026 against the official vendor docs):

The registry is deliberately limited to cost-appropriate chatbot tiers. Premium models (Claude Fable/Opus, GPT-5.6 Sol, "pro" variants) are excluded — their per-request cost makes no sense for a public-facing chatbot. **Anthropic + Haiku is and should remain the default.**

| Vendor | Model ID | Modes | Pricing (in/out per M tokens) | Notes |
|--------|----------|-------|-------------------------------|-------|
| anthropic | `claude-haiku-4-5` | chat + reasoning | $1 / $5 | **Default.** Fastest; 200K context, 64K max output |
| anthropic | `claude-sonnet-5` | chat + reasoning | $2 / $10 (intro through Aug 2026, then $3 / $15) | Best speed/intelligence balance; 1M context |
| anthropic | `claude-sonnet-4-6` | chat + reasoning | $3 / $15 | Previous Sonnet (legacy, still active); 1M context |
| openai | `gpt-5.6-luna` | chat + reasoning | $0.20 / $1.20 | Economy; long context |
| openai | `gpt-5.6-terra` | chat + reasoning | $2 / $12 | Mid-tier; long context |
| openai | `gpt-5.4-mini` | chat + reasoning | $0.75 / $4.50 | Previous-gen compact |
| fireworks | `accounts/fireworks/models/deepseek-v4-pro` | chat only | $1.74 / $3.48 | Open-source via Fireworks (serverless) |
| fireworks | `accounts/fireworks/models/deepseek-r1` | reasoning only | see fireworks.ai | Open-source reasoning |
| fireworks | `accounts/fireworks/models/kimi-k2p6` | chat only | see fireworks.ai | Kimi K2.6 |

> Thinking/reasoning depth is capped at `high` throughout the app (`DEFAULT_THINKING_LEVEL`: `off` / `low` / `medium` / `high`) — there is deliberately no `max`-style setting.
>
> Fireworks model IDs require the full `accounts/fireworks/models/` prefix — copy the exact ID from the model's page on [fireworks.ai/models](https://fireworks.ai/models?modelTypes=Serverless). New open-source models (DeepSeek V4 Flash, Qwen 3.8, GLM 5.2, Kimi K2.7, MiniMax, gpt-oss) typically appear within days of release.
>
> Other models (e.g. Claude Opus, GPT-5.6 Sol) still work if you set their ID in `config.ts` — the registry list is guidance, not enforcement — but expect 5-25x the cost per request.

**Thinking configuration (Anthropic — handled automatically by model generation):**

| Model generation | Thinking config sent |
|------------------|---------------------|
| Haiku 4.5 (and older) | Fixed token budget (`THINKING_BUDGET_LOW/MEDIUM/HIGH`: 2,000 / 8,000 / 15,000) |
| Sonnet 4.6, Opus 4.8, Sonnet 5, Opus 5 | Adaptive thinking (the model decides depth; token budgets are rejected by these models) |
| Fable 5 | None (thinking is always on and cannot be configured) |

> Note: Anthropic thinking budgets are separate from output tokens. OpenAI reasoning effort consumes output tokens, which can cause truncation at high levels.

### Pinecone (Knowledge Base)

| Parameter | Default | Description |
|-----------|---------|-------------|
| `ENABLE_VECTOR_SEARCH` (env var) | `true` | Set env `ENABLE_VECTOR_SEARCH=false` to disconnect the knowledge base entirely (KB tool removed from the model, no Pinecone connection, `PINECONE_API_KEY` not needed) |
| `PINECONE_INDEX_NAME` | `"myai6"` | Your Pinecone index name (lowercase letters, numbers, hyphens) |
| `PINECONE_TOP_K` | `20` | Children retrieved per search |
| `PINECONE_MIN_SCORE` | `0.1` | Minimum relevance score (0-1) |
| `PINECONE_USE_PARENT_CHILD` | `true` | Use 3-namespace architecture |
| `PINECONE_NS_CHILDREN` | `"children"` | Children namespace |
| `PINECONE_NS_PARENTS` | `"parents"` | Parents namespace |
| `PINECONE_NS_PROPOSITIONS` | `"propositions"` | Propositions namespace |
| `PINECONE_PROP_BOOST` | `0.5` | Proposition score boost weight |
| `PINECONE_PROP_K` | `15` | Propositions retrieved per search |
| `PINECONE_VISUAL_TOP_K` | `20` | topK for the visual-enrichment query (figures/tables/slides of a retrieved source) |
| `PINECONE_CACHE_TTL_MS` | `300000` | Search cache TTL (5 minutes) |

### KB Scope

The `KB_SCOPE` constant in `config.ts` tells the LLM what topics are indexed. Update this whenever you ingest new content:

```typescript
export const KB_SCOPE = `
The knowledge base covers ${OWNER_NAME}'s work. Topics include:
- [Example] A research paper or article and its methods
- [Example] A CV or resume with education, employment, and awards
- [Example] Presentation slides or a talk transcript
`.trim();
```

Update `KB_SCOPE` whenever you ingest new content. The model uses it to decide whether to search the KB or answer from general knowledge.

### Switching or Disconnecting the Knowledge Base

**Switch to a different Pinecone index:**
1. Change the `PINECONE_API_KEY` env var (if the index lives in a different Pinecone account)
2. Change `PINECONE_INDEX_NAME` in `config.ts`
3. Rewrite `KB_SCOPE` to describe the new content
4. Redeploy

The new index must use integrated inference with `llama-text-embed-v2` (the embedding model the ingestion notebook uses) and the same record fields — the cleanest path is re-ingesting content with the notebook.

**Disconnect the knowledge base entirely:**
Set the env var `ENABLE_VECTOR_SEARCH=false` (in Vercel or `.env.local`) and redeploy. The KB tool is removed from the model, no Pinecone connection is made, `PINECONE_API_KEY` can be deleted, and the health endpoint reports `pinecone: "disabled"`. The bot answers from general knowledge (plus web search, if enabled).

### Exa Web Search

| Parameter | Default | Description |
|-----------|---------|-------------|
| `EXA_NUM_RESULTS` | `10` | Results per search |
| `EXA_SEARCH_TYPE` | `"deep"` | `"auto"`, `"neural"`, `"deep"`, `"deep-reasoning"` |
| `EXA_MAX_CHARACTERS` | `3000` | Max text per result |
| `EXA_LIVECRAWL` | `"preferred"` | Fetch live page content when possible: `"never"`, `"fallback"`, `"preferred"`, `"always"`. Reduces stale/deleted pages in results |
| `EXA_SYSTEM_PROMPT` | Prefer academic + owner profiles | Guides Exa's result selection |
| `OWNER_PROFILE_SOURCES` | placeholders (replace with real profiles) | The owner's official profile pages (name + exact URL). The `fetchOwnerProfiles` tool live-fetches these for "latest on the owner" queries; `OWNER_PROFILE_DOMAINS` (for `includeDomains`) is derived from them. Update here when a profile moves |
| `OWNER_PROFILE_MAX_CHARACTERS` | `5000` | Max live page text fetched per profile by `fetchOwnerProfiles` |
| `ENABLE_WEB_SEARCH` (env var) | `true` | Set env `ENABLE_WEB_SEARCH=false` to disable |

The Exa client is created lazily on the first search, so `EXA_API_KEY` is only needed at runtime when web search is actually used — not at build time.

**Search budget per response.** The model may call `webSearch` up to `MAX_WEB_SEARCHES` times, `vectorDatabaseSearch` up to `MAX_KB_SEARCHES` times, and `fetchOwnerProfiles` once (soft caps, enforced via prompt guidance). The hard ceiling is `MAX_STEPS` total tool steps — keep it at least `MAX_KB_SEARCHES + MAX_WEB_SEARCHES + 2` (one profile fetch plus the final compose step). To allow more searches, raise these in `config.ts`. Note that `EXA_SEARCH_TYPE = "deep"` consumes more Exa credits per call; switch to `"auto"` or `"neural"` to conserve them.

**Source attribution.** Each web result is returned with a distinct `source` (domain) alongside its `url`, and the system prompt requires the model to attribute every web-derived claim to the exact result it came from — it must not transfer a fact from one site to another site's citation, and must prefer live, authoritative sources over cached or removed pages.

### Citation Verification

Drives the green check mark in the Sources box. The sentence preceding each citation (its claim) is checked against the cited source's retrieved text by significant-word containment; legacy in-citation quotes, when present, are checked too. All deterministic, no model involvement.

| Parameter | Default | Description |
|-----------|---------|-------------|
| `CITATION_CLAIM_MIN_CHARS` | `20` | Shorter preceding fragments are not treated as claims |
| `CITATION_CLAIM_MAX_CHARS` | `300` | Claims are trimmed to their last N characters |
| `CITATION_CLAIM_MIN_WORD_LENGTH` | `4` | Minimum word length to count as significant for claim matching |
| `CITATION_CLAIM_MIN_WORDS` | `3` | Claims with fewer significant words are unverifiable (no marker) |
| `CITATION_CLAIM_MATCH_RATIO` | `0.6` | Share of significant claim words that must appear in the source |
| `CITATION_QUOTE_MIN_WORD_LENGTH` | `3` | Minimum word length for quote matching |
| `CITATION_QUOTE_MATCH_RATIO` | `0.8` | Share of quote words that must appear in the source |

### Chat Limits

| Parameter | Default | Description |
|-----------|---------|-------------|
| `MAX_STEPS` | `8` | Max tool steps per request (≥ `MAX_KB_SEARCHES + MAX_WEB_SEARCHES + 2`) |
| `MAX_KB_SEARCHES` | `2` | Max `vectorDatabaseSearch` calls per response (prompt-enforced) |
| `MAX_WEB_SEARCHES` | `3` | Max `webSearch` calls per response (prompt-enforced) |
| `MAX_MESSAGES` | `100` | Max messages in conversation |
| `MAX_MESSAGE_TEXT_LENGTH` | `10000` | Max characters per message |
| `VERCEL_MAX_DURATION` | `120` | Vercel function timeout (seconds, keep in sync with route.ts) |

### Conversation Compaction

Uses an LLM to intelligently summarize older messages when token count exceeds threshold, preserving source references and citation URLs for continuity.

| Parameter | Default | Description |
|-----------|---------|-------------|
| `COMPACTION_ENABLED` | `true` | Enable/disable conversation compaction |
| `COMPACTION_TOKEN_THRESHOLD` | `40000` | Compact when summary + unsummarized messages exceed this (tokens) |
| `COMPACTION_KEEP_RECENT` | `4` | Keep last N messages intact when compacting (2 user + 2 assistant turns) |
| `COMPACTION_CHARS_PER_TOKEN` | `4` | Character-to-token ratio for estimation (lower = more conservative) |
| `COMPACTION_MAX_SUMMARY_WORDS` | `1500` | Max word limit for LLM summaries (instructs model, not a hard cut) |
| `COMPACTION_MAX_SUMMARY_CHARS` | `8000` | Hard safety cap on summary character length |

**How it works:**
1. Client stores compaction summary in localStorage, sends it to the server via request headers (`X-Compacted-Summary`, `X-Compacted-UpTo`, `X-Compacted-Signature`)
2. Server verifies the summary's HMAC signature and size cap — a summary that was not issued (signed) by the server, or was modified, is ignored and the server recompacts from the full message history (see [Security](#security)). Then it checks: `tokens(summary) + tokens(unsummarized messages) > threshold?`
3. Under threshold → reuse stored summary + pass all unsummarized messages through (no LLM call)
4. Over threshold → the utility model re-summarizes existing summary + older unsummarized messages into ONE bounded summary
5. Last `COMPACTION_KEEP_RECENT` messages are always kept intact as full messages
6. Updated summary is returned to client via response headers (with a fresh signature) and saved to localStorage
7. Each re-summarization merges the existing summary with new messages — older content is compressed while key facts, decisions, and source URLs are preserved

**Feedback-aware summarization:**
- **Thumbs up** (👍): Messages the user liked are marked `[IMPORTANT]` and given priority in the summary
- **Thumbs down** (👎): Messages the user disliked are excluded entirely from summarization input — they are never sent to the summarization LLM
- Feedback is stored per-conversation in localStorage and sent to the server via the `X-Feedback` header

**Context Memory button:**
- A document icon (📄) in the header bar shows the current compaction summary when clicked
- Displays: number of summarized messages, the full summary text, and source URLs
- Toggle visibility via `COMPACTION_SHOW_CONTEXT_MEMORY` in config.ts

**Client-side storage (localStorage):**
All conversation data is stored in the browser's localStorage:
- `chat-conversations` — conversation index (id, title, timestamps)
- `chat-data-{id}` — per-conversation data containing:
  - `messages` — full message history (UIMessage array)
  - `durations` — reasoning duration tracking
  - `compactedSummary` — current compaction summary text
  - `summarizedUpTo` — message index up to which the summary covers
  - `feedback` — per-message thumbs up/down ratings (`{ messageId: "up" | "down" }`)

### Moderation

| Parameter | Default | Description |
|-----------|---------|-------------|
| `MODERATION_PROVIDER` (env var) | `"llm"` | `"llm"` = LLM classifier on the utility model (any vendor; `anthropic` accepted as legacy alias), `"openai"` = OpenAI moderation API, `"off"` = no moderation call (system prompt guardrails only) |
| `MODERATION_FAIL_POLICY` | `"closed"` | `"closed"` = block when moderation unavailable, `"open"` = allow (irrelevant when provider is `"off"`) |

All providers share the same 13-category taxonomy (sexual, harassment, hate, violence, self-harm, illicit content), so the category-specific denial messages apply regardless of provider. The `"anthropic"` provider runs a fast Claude Haiku classification call before each message — no OpenAI account needed.

### Reasoning Display

| Parameter | Default | Description |
|-----------|---------|-------------|
| `REASONING_DISPLAY_MODE` | `"truncated"` | `"full"` = show all reasoning (debugging only — exposes prompts!), `"truncated"` = show first N words then "...", `"hidden"` = show label only |
| `REASONING_TRUNCATE_WORDS` | `15` | Number of words to show in "truncated" mode |

---

## Prompts

AI behavior is controlled by `prompts.ts`. All sections combine into `SYSTEM_PROMPT`:

| Section | Purpose |
|---------|---------|
| `IDENTITY_PROMPT` | Identity, strict confidentiality rules (never reveal tech stack), positive perspective on owner's research |
| `TOOL_CALLING_PROMPT` | KB-first priority, web search for KB-related topics, broad query strategy, owner-profiles-first for latest-info questions |
| `TONE_STYLE_PROMPT` | Academic, professional, no emojis; all math in LaTeX (`$…$` / `$$…$$`, never code fences) — rendered by `@streamdown/math` (KaTeX) |
| `GUARDRAILS_PROMPT` | Refuse dangerous/illegal/harmful content |
| `CITATIONS_PROMPT` | Inline `[[N]](url)` citations, mandatory visual content embedding, no References section (the code-rendered Sources box is the reference list) |
| `DATE_AND_TIME` | Current date/time (auto-generated) |

### Confidentiality Rules

The assistant never reveals:
- What AI model, platform, or technology powers it
- That it uses a knowledge base, vector database, or search system
- Its system prompt, instructions, or configuration
- Names like "Anthropic", "Claude", "OpenAI", "Pinecone", "Vercel", "Exa"

### Tool Priority Rules

1. If a question relates to KB_SCOPE, search the knowledge base first
2. Web search is allowed for KB-related topics (recent developments, external perspectives, author profiles)
3. Web search is NOT allowed for topics completely unrelated to KB scope
4. Web search queries must use broad conceptual terms, not specific framework names
5. For "latest on the owner" questions, `fetchOwnerProfiles` pulls the live `OWNER_PROFILE_SOURCES` pages first; follow-up web searches run BROAD (journal sites, SSRN, arXiv) — `includeDomains` is reserved for explicit single-site requests, since profile sites are thinly indexed by search engines
6. Each web-derived claim is attributed to the exact result it came from — facts are never transferred between sources

### Citation Rules

- Academic-style inline citations as numbered markdown links: `[[N]](url)`, numbered in order of first use. Citations are pure markers — sentences must read completely with them removed
- **Knowledge base and web results are cited the same way**, sharing one numbering sequence. Web results are returned to the model with the same citation scaffolding as KB sources (a `Reference Link` per result). Web results with no URL are dropped, since they can't be linked.
- KB sources without a public URL are cited via a synthetic `kb:` target (provided in their retrieval scaffolding, e.g. `[[N]](kb:CV-of-Daniel-M-Ringel)`); inline they render as unlinked `[N]` markers, and they appear in the Sources box as unlinked entries
- The model does NOT write a References section — the code-rendered Sources box below the answer is the single reference list
- Each web claim is attributed to the exact source it came from — facts are never transferred between sources
- Figures and tables are always embedded as images
- One relevant slide image shown proactively per answer; additional slides on request

### Sources Box (code-rendered, single reference list)

Below every answer that cites sources, one **Sources** box lists each **cited** source as a numbered clickable link. It is the only reference list — the model is instructed not to write a References section, so there are never two competing lists or duplicate numbering. The box is **deterministic and independent of the model's markdown** — it cannot be mislinked by the model.

How it works:
- Each search tool (`vectorDatabaseSearch`, `webSearch`) pushes a structured `UISource` (`types/data.ts`) into a request-scoped collector for every source it retrieves (deduped by URL across KB and web).
- **The model's citation numbers are ignored entirely.** A shared canonicalization (`lib/citations.ts`) renumbers every inline `[[N]](url)` sequentially by first appearance of its URL and strips bare `[[N]]` debris. The client runs it on the displayed text; the server runs the same function on the joined answer text to build the box — so inline numbers and box numbers are always 1..K, gap-free, and identical by construction. Retrieved-but-uncited sources are not shown (`app/api/chat/route.ts`).
- KB sources without a URL are cited via synthetic `kb:` targets and appear in the box as **unlinked entries** (title and source name, no link) — every cited source is listed, clickable or not.
- **Claim verification**: for each citation, the route deterministically checks the sentence preceding it (the claim) against the cited source's retrieved text by significant-word containment (`claimSupported` in `lib/citations.ts`; legacy in-citation quotes, when present, are checked too via `quoteAppearsIn`). A source whose claim checks out gets a **green check mark** in the box; sources that can't be checked (not retrieved this turn, claim too short) show no marker. Verification requires no model cooperation — nothing rides inside the citation, so content can never be swallowed.
- `components/messages/sources.tsx` renders the box from `message.parts` (KB sources get a book icon, web sources a globe), and it persists with the conversation.

---

## Project Structure

```
myAI6/
├── app/
│   ├── api/
│   │   ├── chat/
│   │   │   ├── route.ts                    # Main chat endpoint (orchestrator)
│   │   │   └── tools/
│   │   │       ├── search-vector-database.ts  # Pinecone RAG tool
│   │   │       ├── web-search.ts              # Exa web search tool
│   │   │       └── fetch-owner-profiles.ts    # Live fetch of the owner's profile pages
│   │   ├── health/route.ts                 # Health check (detailed checks token-gated)
│   │   └── feedback/route.ts               # Thumbs up/down feedback logging
│   ├── page.tsx                            # Chat UI (main page)
│   ├── layout.tsx                          # Root layout (fonts, metadata)
│   ├── globals.css                         # Global styles
│   ├── parts/
│   │   └── chat-header.tsx                 # Header bar component
│   ├── terms/page.tsx                      # Terms of use page
│   └── images_raw/                         # Source assets (favicon, logo originals)
│       └── favicon/                        # Favicon files for various platforms
├── components/
│   ├── ai-elements/
│   │   ├── thinking-indicator.tsx          # Pulsing logo during "submitted" phase
│   │   ├── reasoning.tsx                   # Collapsible thinking blocks
│   │   ├── processing-indicator.tsx        # Post-tool processing status
│   │   ├── assembling-indicator.tsx        # Final response assembly status
│   │   ├── response.tsx                    # Markdown response renderer (sanitizes [blocked])
│   │   └── shimmer.tsx                     # Shimmer text effect
│   ├── messages/
│   │   ├── message-wall.tsx                # Conversation display with scroll
│   │   ├── assistant-message.tsx           # AI message with tools, reasoning, feedback, citation canonicalization
│   │   ├── user-message.tsx                # User message bubble
│   │   ├── reasoning-part.tsx              # Reasoning display (full/truncated/hidden)
│   │   ├── sources.tsx                     # Code-rendered Sources box (from data-sources stream part)
│   │   └── tool-call.tsx                   # Tool execution display with fun labels
│   ├── ui/                                 # Reusable Radix UI components (shadcn)
│   └── conversation-sidebar.tsx            # Chat history sidebar with delete
├── hooks/
│   └── use-rotating-label.ts              # Rotating status label hook
├── lib/
│   ├── ai/
│   │   ├── model-registry.ts              # Vendor/model definitions
│   │   ├── routing.ts                     # Request routing + reasoning escalation
│   │   └── tools.ts                       # Tool set assembly + guidance
│   ├── pinecone.ts                        # Vector search (3-namespace + visual enrichment)
│   ├── sources.ts                         # KB source formatting + context assembly
│   ├── citations.ts                       # Citation canonicalization (renumbering, list repair)
│   ├── moderation.ts                      # OpenAI moderation (13 categories)
│   ├── storage.ts                         # localStorage conversations + compaction data
│   ├── compaction.ts                      # Stateful LLM-based conversation compaction
│   ├── summary-signature.ts               # HMAC signing of compaction summaries
│   ├── cache.ts                           # TTL cache utility
│   ├── fun-labels.ts                      # Rotating UI labels + past tense variants
│   ├── env.ts                             # Zod env validation
│   └── __tests__/                         # Unit tests (vitest)
│       ├── cache.test.ts                   # Cache utility tests
│       ├── citations.test.ts               # Citation canonicalization tests
│       ├── routing.test.ts                 # Routing logic tests
│       └── sources.test.ts                 # KB source formatting tests
├── types/
│   └── data.ts                            # Chunk/Source TypeScript schemas
├── public/
│   ├── logo.png                           # App logo
│   └── thinking.png                       # Thinking indicator icon (separate from logo)
├── RAGloader/
│   ├── RAG_loader_pipeline.ipynb          # ⭐ Python notebook: ingest content into the Pinecone knowledge base
│   └── myAI5_RAG.py                       # Pipeline classes and functions imported by the notebook
├── config.ts                              # ⭐ Design/tuning parameters (models, thresholds, prompts scope)
├── prompts.ts                             # ⭐ All AI behavior prompts
├── middleware.ts                          # Rate limiting middleware (per-IP throttling)
├── env.template                           # Environment variable template (keys + operational switches)
├── components.json                        # shadcn/ui component config
├── package.json                           # Dependencies and scripts
├── tsconfig.json                          # TypeScript configuration
├── next.config.ts                         # Next.js configuration
├── vitest.config.ts                       # Test runner configuration
├── eslint.config.mjs                      # Linting configuration
├── .claude/settings.local.json            # Claude Code local settings
├── AGENTS.md                              # Agent/tool integration guide
└── LICENSE                                # MIT License
```

---

## UI Processing Indicators

The chat UI shows animated status labels during each phase of processing:

| Phase | Icon | Example Labels |
|-------|------|---------------|
| Thinking | Brain / Logo | Deliberating, Pondering, Contemplating |
| Knowledge Base Search | Book | Retrieving, Querying, Accessing |
| Processing (after tools) | Refresh arrows | Synthesizing, Correlating, Extracting |
| Web Search | Globe | Searching, Investigating, Browsing |
| Assembling (final answer) | Sparkles | Composing, Structuring, Formulating |

Labels rotate every 3 seconds with a shimmer effect. Once complete, they switch to past tense (e.g., "Reasoned for 2 seconds", "Retrieved knowledge").

Labels are fully customizable in `lib/fun-labels.ts`.

## Conversation Sidebar

A slide-out sidebar on the left provides multi-conversation management:

- **Conversation list** — all saved conversations with auto-generated titles (from the first user message)
- **New chat** — `+` button creates a new conversation
- **Switch conversations** — click any conversation to load it
- **Delete conversations** — trash icon removes a conversation and its data
- **Persistent storage** — all conversations stored in browser localStorage (see [Client-side storage](#client-side-storage-localstorage))
- **Toggle** — sidebar can be opened/closed via the panel icon in the header

Labels are fully customizable in `lib/fun-labels.ts`.

---

## API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/chat` | POST | Main chat (streaming response) |
| `/api/health` | GET | Health check — public liveness only; detailed checks token-gated |
| `/api/feedback` | POST | Log thumbs up/down feedback |

`/api/health` has two response levels:

- **Public (production, no token):** returns only `{"status":"ok"}` — a bare liveness check. No dependencies are probed and no configuration details are revealed.
- **Detailed (development, or production with `Authorization: Bearer <HEALTH_CHECK_TOKEN>`):** returns `status` (`healthy` / `degraded`) plus per-service checks:
  - `pinecone`: `ok` / `error` / `missing` (key absent while KB enabled) / `disabled` (`ENABLE_VECTOR_SEARCH=false`)
  - `anthropic`: `configured` / `missing`
  - `openai`: `configured` / `missing` (only when an OpenAI chat model, OpenAI moderation, or an OpenAI utility model is configured) / `not_required`

  `missing` and `error` values make the status `degraded` (HTTP 503); everything else is `healthy` (HTTP 200).

To enable detailed checks in production, set the `HEALTH_CHECK_TOKEN` env var (e.g. `openssl rand -hex 32`) and call:

```bash
curl -H "Authorization: Bearer $HEALTH_CHECK_TOKEN" https://your-domain.com/api/health
```

---

## Scripts

```bash
npm run dev        # Local development server
npm run build      # Production build
npm run start      # Start production server
npm run lint       # ESLint
npm run test       # Run tests (vitest)
npm run test:watch # Watch mode tests
```

---

## Tech Stack

- **Framework:** Next.js 16 (Turbopack)
- **AI SDK:** Vercel AI SDK v6 (streaming)
- **LLMs:** Anthropic Claude (default), OpenAI GPT, Fireworks
- **Vector DB:** Pinecone (integrated inference)
- **Web Search:** Exa API (deep search)
- **Moderation:** LLM classifier on the utility model (default) or OpenAI Moderation API
- **UI:** React 19, Radix UI, Tailwind CSS 4
- **Animations:** Motion (Framer Motion)
- **Validation:** Zod
- **Ingestion:** Python (Unstructured jobs API, KeyBERT, PyMuPDF, Claude enrichment + vision, Cloudinary/SFTP image hosting)

---

## Security

### Rate Limiting

Per-IP request throttling protects against abuse and runaway API costs.

| Parameter | Default | Description |
|-----------|---------|-------------|
| `RATE_LIMIT_ENABLED` | `true` | Enable/disable rate limiting |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Sliding window size (1 minute) |
| `RATE_LIMIT_MAX_REQUESTS` | `20` | Max requests per window per IP |

- Applied only to `/api/chat` endpoint
- Uses in-memory sliding window (resets on server restart)
- Returns HTTP 429 with `Retry-After` header when limit is exceeded
- Implemented via Next.js middleware (`middleware.ts`)

> **Limitation:** on serverless hosting (Vercel), the in-memory counter is per-instance and resets on every cold start, so parallel traffic can exceed the configured limit. Treat it as a first layer only. For a limit that holds across instances, add a platform-level rule — on Vercel: project → **Firewall** → **Rules** → new rule matching path `/api/chat` with a **Rate Limit** action (start with action **Log** to tune the threshold, then switch to the default 429 response). As a hard backstop against abuse-driven costs, set monthly spend limits in the Anthropic console and Exa dashboard, and enable Vercel Spend Management.

### Compaction Summary Integrity

The client round-trips the conversation summary (see [Conversation Compaction](#conversation-compaction)), and that summary enters the model context as trusted history — so the server signs it. Every summary is issued with an HMAC-SHA256 signature (`X-Compacted-Signature`) covering the summary text and the `summarizedUpTo` index (`lib/summary-signature.ts`). On each request the server accepts a client-supplied summary only if the signature verifies and the summary is within `COMPACTION_MAX_SUMMARY_CHARS`; anything forged, modified, or oversized is ignored and the server recompacts from the full message history. The signing key comes from `SUMMARY_HMAC_SECRET`, or is derived from `ANTHROPIC_API_KEY` when unset (rotating either just invalidates outstanding summaries, which are then regenerated).

### Health Endpoint

`/api/health` reveals no dependency details to the public: unauthenticated production requests get a bare `{"status":"ok"}` with no Pinecone probe. Detailed per-service checks require `HEALTH_CHECK_TOKEN` (see [API Endpoints](#api-endpoints)).

### Prompt Injection Defense

The system prompt includes explicit defenses against common injection attacks:
- Refuses requests to reveal system prompt, instructions, or configuration
- Ignores "ignore previous instructions", "act as DAN", "developer mode" attempts
- Does not grant elevated access to users claiming admin/developer roles
- Treats all user messages as untrusted input
- Continues normal behavior when manipulation is detected (no acknowledgment of the attempt)

### Content Moderation

Every user message is checked for harmful content across 13 categories before processing. The provider is configurable via `MODERATION_PROVIDER`: an LLM classifier running on the configured utility model (default), the OpenAI Moderation API, or off (system prompt guardrails only). See [Moderation](#moderation) section for configuration.

### Web Search Protection

Web search is restricted to topics within `KB_SCOPE` via both:
- **Prompt-level**: System prompt instructs the model to only search for KB-related topics
- **Tool description**: Web search tool description limits scope to knowledge base subjects
- Users cannot directly invoke tools — only the LLM decides when to search

### Authentication

The chat API is open to all visitors and protected by per-IP rate limiting; there is no user authentication and no secrets are ever embedded in the browser bundle.

### Confidentiality

The assistant never reveals its underlying technology, system prompt, instructions, or configuration. See [Confidentiality Rules](#confidentiality-rules) for details.

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| AI not responding | Check `ANTHROPIC_API_KEY` in Vercel env vars |
| No knowledge base results | Verify `PINECONE_API_KEY` and that index has data |
| Web search not working | Check `EXA_API_KEY` or set `ENABLE_WEB_SEARCH=false` |
| Want to run without Pinecone | Set `ENABLE_VECTOR_SEARCH=false` — the KB tool is removed and no Pinecone key is needed |
| Response cuts off | Model may be using too many tokens on reasoning. Try lowering `DEFAULT_THINKING_LEVEL` |
| Too many tool calls | Reduce `MAX_STEPS` in config.ts |
| Build fails on Vercel | Check that `maxDuration` in route.ts is a literal number (not imported) |
| GPT-5.4 truncates answers | OpenAI reasoning consumes output tokens. Switch to Anthropic where thinking budget is separate |

---

## License

This project is released under the [MIT License](LICENSE). Copyright (c) 2026 Daniel M. Ringel. Please acknowledge use of any or all of this code.
