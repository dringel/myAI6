/**
 * Citation parsing for the code-rendered Sources box.
 *
 * The model cites inline as numbered markdown links: [[N]](url). The box is
 * built FROM the answer text by parsing these citations, so the numbers shown
 * in the box are by construction the same ones used in the text — they cannot
 * disagree.
 */

import {
  CITATION_CLAIM_MIN_CHARS,
  CITATION_CLAIM_MAX_CHARS,
  CITATION_CLAIM_MIN_WORD_LENGTH,
  CITATION_CLAIM_MIN_WORDS,
  CITATION_CLAIM_MATCH_RATIO,
  CITATION_QUOTE_MIN_WORD_LENGTH,
  CITATION_QUOTE_MATCH_RATIO,
} from "@/config";

/** Normalize a URL for matching: lowercase, no trailing slashes. */
export function normUrl(url: string): string {
  return url.toLowerCase().replace(/\/+$/, "");
}

/**
 * Stable citation key for a knowledge-base source without a public URL, e.g.
 * "CV of Jane Doe" → "kb:CV-of-Jane-Doe". The retrieval
 * scaffolding hands this target to the model; the model cites it like a URL
 * ([[N]](kb:...)); the canonicalizer renders it as an unlinked [N] and the
 * Sources box lists the source as an unlinked entry.
 */
export function kbKey(name: string): string {
  return (
    "kb:" +
    name
      .trim()
      .replace(/[^A-Za-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
  );
}

export interface CitationEntry {
  /** Original citation target (http(s) URL or kb: key). */
  url: string;
  /** Verbatim quotes the model attached to citations of this target (legacy/optional). */
  quotes: string[];
  /** Sentence fragments preceding each citation of this target — the claims it supports. */
  claims: string[];
}

export interface CitationRewrite {
  /** Text with citations renumbered sequentially and bare citations stripped. */
  text: string;
  /** Distinct cited URLs in first-appearance order; index i is citation [i+1]. */
  orderedUrls: string[];
  /** Same order as orderedUrls, with the claims (and legacy quotes) gathered per target. */
  citations: CitationEntry[];
}

/**
 * Canonicalizes the model's inline citations. The model's own numbers are
 * IGNORED entirely: every [[N]](url) is renumbered sequentially by first
 * appearance of its URL (same URL → same number, no gaps possible), and bare
 * [[N]] citations without a URL are stripped as debris. URLs keep their
 * ORIGINAL casing (URLs can be case-sensitive, e.g. Google Scholar ids);
 * normalization is only used to detect that two spellings are the same URL.
 *
 * Both the client (display) and the server (Sources box) run this same
 * function on the same text, so the numbers shown inline and in the box agree
 * by construction.
 */
// Citation formats models actually produce, all canonicalized:
// - [[N]](target "quote")            — the requested format
// - [[N]](target "q1", "q2", "q3")   — multi-quote drift (comma-separated)
// - [[[N]]](target …) / [[N]]](…)    — stray-bracket drift (2-3 brackets)
// - [N](target …)                    — single-bracket drift; digits-only text.
//                                      Lookbehind excludes image syntax
//                                      (![1](url)) and the inner half of an
//                                      already-canonical [[k]](url).
// Targets are http(s) URLs or kb:… keys (URL-less knowledge-base sources).
// http targets render as [[k]](url) links; kb targets render as unlinked [k].
// Quotes are captured for server-side verification and stripped from display.
const QUOTES_BLOB = '((?:\\s*,?\\s*"[^"]*")*)';
const DOUBLE_CITATION = new RegExp(
  '\\[{2,3}\\d{1,3}\\]{2,3}\\s?\\(\\s*((?:https?:\\/\\/|kb:)[^)\\s"]+)' + QUOTES_BLOB + '\\s*\\)',
  "g"
);
const SINGLE_CITATION = new RegExp(
  '(?<![[!])\\[\\d{1,3}\\]\\(\\s*((?:https?:\\/\\/|kb:)[^)\\s"]+)' + QUOTES_BLOB + '\\s*\\)',
  "g"
);

function parseQuotes(blob: string | undefined): string[] {
  if (!blob) return [];
  return [...blob.matchAll(/"([^"]*)"/g)]
    .map((m) => m[1].trim())
    .filter(Boolean);
}

function rewriteWithState(
  text: string,
  normToNumber: Map<string, number>,
  orderedUrls: string[],
  citations: CitationEntry[]
): string {
  const canonicalize = (
    url: string,
    quotesBlob: string | undefined,
    offset: number,
    whole: string
  ): string => {
    const norm = normUrl(url);
    let num = normToNumber.get(norm);
    if (num == null) {
      num = normToNumber.size + 1;
      normToNumber.set(norm, num);
      orderedUrls.push(url);
      citations.push({ url, quotes: [], claims: [] });
    }
    const quotes = parseQuotes(quotesBlob);
    citations[num - 1].quotes.push(...quotes);
    // The sentence fragment preceding the citation is the claim it supports —
    // captured for server-side claim verification (no model cooperation
    // needed, nothing in-band that could swallow content).
    const before = whole.slice(0, offset).replace(/\s+$/, "");
    const claim = before.split(/[.!?\n]/).pop()?.trim() ?? "";
    if (claim.length >= CITATION_CLAIM_MIN_CHARS)
      citations[num - 1].claims.push(claim.slice(-CITATION_CLAIM_MAX_CHARS));
    // kb: targets have no clickable page — render as a plain [N] marker.
    const marker = url.startsWith("kb:") ? `[${num}]` : `[[${num}]](${url})`;
    // If the model used the citation AS the sentence's payload — a citation
    // directly after a colon ("the student concluded: [[1]](… "…")") — the
    // stripped quote WAS the content. Surface it as visible quoted text.
    if (quotes.length > 0 && before.endsWith(":")) {
      return `"${quotes[0]}" ${marker}`;
    }
    return marker;
  };

  let out = text.replace(
    DOUBLE_CITATION,
    (_m, url: string, quotesBlob: string | undefined, offset: number, whole: string) =>
      canonicalize(url, quotesBlob, offset, whole)
  );
  out = out.replace(
    SINGLE_CITATION,
    (_m, url: string, quotesBlob: string | undefined, offset: number, whole: string) =>
      canonicalize(url, quotesBlob, offset, whole)
  );

  // Wiki-style double brackets around PHRASES ([[Multimarket Membership
  // Mapping]]) are model drift from the [[N]](url) citation format — markdown
  // renders them literally. Unwrap: with an http target they become a normal
  // link, with a kb:/no target just the phrase. Pure-digit forms (real
  // citations) are excluded via the letter lookahead.
  out = out.replace(
    /\[\[((?=[^\]\n]*[A-Za-z])[^\[\]\n]{1,300})\]\]\((https?:\/\/[^)\s"]+)\)/g,
    "[$1]($2)"
  );
  out = out.replace(
    /\[\[((?=[^\]\n]*[A-Za-z])[^\[\]\n]{1,300})\]\]\((?:kb:[^)\s"]*)\)/g,
    "$1"
  );
  out = out.replace(
    /\[\[((?=[^\]\n]*[A-Za-z])[^\[\]\n]{1,300})\]\](?!\()/g,
    "$1"
  );

  // Malformed citations whose target is not a real URL — e.g. the literal
  // [[1]](no URL available) a model writes for URL-less sources — are debris:
  // strip the whole thing. Safe during streaming: only matches a closed paren.
  // The punctuation-aware pass runs first so "word [[1]](junk) ." collapses to
  // "word." instead of leaving a stray space before the punctuation.
  out = out.replace(/\s*\[{2,3}\d{1,3}\]{2,3}\s?\((?!https?:\/\/|kb:)[^)]*\)\s*(?=[,.;:!?])/gi, "");
  out = out.replace(/\[{2,3}\d{1,3}\]{2,3}\s?\((?!https?:\/\/|kb:)[^)]*\)\s?/gi, "");

  // Bare [[N]] with no link attached is citation debris (the prompt forbids
  // it): strip it, swallowing surrounding space so sentences stay clean and no
  // stray space is left before punctuation. The lookahead keeps [[N]] followed
  // by "(url" (a valid link) intact.
  out = out.replace(/\s*\[{2,3}\d{1,3}\]{2,3}(?!\s?\()\s*(?=[,.;:!?])/g, "");
  out = out.replace(/\[{2,3}\d{1,3}\]{2,3}(?!\s?\()\s?/g, "");

  return repairBrokenListMarkers(out);
}

/**
 * Rejoins a list marker ("1." / "-") that ends up alone on its line with the
 * content on the next line — markdown would otherwise render the marker as an
 * empty list item and the content as a separate paragraph. Happens when the
 * model splits marker and content, or when citation-debris stripping leaves a
 * dangling marker. The join is skipped when the next line is itself a list
 * marker or a heading.
 */
function repairBrokenListMarkers(text: string): string {
  return text.replace(
    /^([ \t ]*(?:\d{1,3}[.)]|[-*+•]))[ \t ]*(?:\r?\n[ \t ]*)+(?!(?:\d{1,3}[.)]|[-*+•])(?:[ \t ]|\r?\n|$))(?!#{1,6}[ \t])(?=\S)/gm,
    "$1 "
  );
}

export function rewriteCitations(answerText: string): CitationRewrite {
  const orderedUrls: string[] = [];
  const citations: CitationEntry[] = [];
  const normToNumber = new Map<string, number>();
  const text = rewriteWithState(answerText, normToNumber, orderedUrls, citations);
  return { text, orderedUrls, citations };
}

/**
 * Rewrites several text segments of ONE message with shared numbering state,
 * so citations keep counting across parts (text before/after tool calls)
 * exactly like the server's joined-text pass. Returns the rewritten segments
 * in order.
 */
export function rewriteCitationsInParts(texts: string[]): string[] {
  const orderedUrls: string[] = [];
  const citations: CitationEntry[] = [];
  const normToNumber = new Map<string, number>();
  return texts.map((t) => rewriteWithState(t, normToNumber, orderedUrls, citations));
}

/**
 * Legacy quote verification (in-citation quotes, optional), tolerant by design:
 * models lightly reformat while
 * "quoting" (punctuation, Ph.D./PhD, joined words), and the retrieved text is
 * itself a formatted excerpt. A quote supports a source when any of these
 * hold, in order of strictness:
 *  1. normalized substring match (all punctuation dropped, whitespace folded)
 *  2. space-squashed substring match (survives PhD/Ph.D.-style splits)
 *  3. word containment: ≥80% of the quote's significant words appear in the
 *     source (survives light paraphrase and reordering)
 */
export function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function quoteAppearsIn(quote: string, sourceText: string): boolean {
  const q = normalizeForMatch(quote);
  if (q.length < 3) return false;
  const src = normalizeForMatch(sourceText);
  if (src.includes(q)) return true;
  if (src.replace(/ /g, "").includes(q.replace(/ /g, ""))) return true;
  const words = q.split(" ").filter((w) => w.length >= CITATION_QUOTE_MIN_WORD_LENGTH);
  if (words.length === 0) return false;
  const hits = words.filter((w) => src.includes(w)).length;
  return hits / words.length >= CITATION_QUOTE_MATCH_RATIO;
}

/**
 * Claim verification: the sentence preceding a citation is checked against the
 * cited source's retrieved text by significant-word containment. Looser than
 * quote matching (a claim paraphrases the source by nature), so the threshold
 * asks for a solid majority of its significant words.
 */
export function claimSupported(claim: string, sourceText: string): boolean {
  const words = normalizeForMatch(claim)
    .split(" ")
    .filter((w) => w.length >= CITATION_CLAIM_MIN_WORD_LENGTH);
  if (words.length < CITATION_CLAIM_MIN_WORDS) return false;
  const src = normalizeForMatch(sourceText);
  const hits = words.filter((w) => src.includes(w)).length;
  return hits / words.length >= CITATION_CLAIM_MATCH_RATIO;
}

/** Hostname of a URL without the www. prefix, or "" if unparsable. */
export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
