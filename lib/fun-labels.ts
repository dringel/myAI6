/**
 * Fun rotating status labels for different processing phases.
 * Each category maps to a phase of the AI pipeline.
 */

export const FUN_LABELS = {
  thinking: [
    "Deliberating",
    "Thinking",
    "Ringeling",
    "Pondering",
    "Brainstorming",
    "Contemplating",
    "Reasoning",
  ],
  processing: [
    "Distilling",
    "Synthesizing",
    "Aggregating",
    "Ringlating",
    "Extrapolating",
    "Understanding",
    "Scrutinizing",
    "Triangulating",
    "Correlating",
    "Transforming",
    "Extracting",
    "Filtering",
  ],
  knowledgeBase: [
    "Retrieving",
    "Querying",
    "Accessing",
    "Fetching ",
  ],
  webSearch: [
    "Searching",
    "Investigating",
    "Crawling",
    "Browsing",
    "Collecting",
  ],
  assembling: [
    "Composing",
    "Constructing",
    "Organizing",
    "Ringelizing",
    "Synthesizing",
    "Integrating",
    "Structuring",
    "Formulating",
    "Finalizing:",
  ],
  compacting: [
    "Archiving previous discussion",
    "Summarizing conversation",
    "Reflecting on our discussion",
    "Extracting key insights from conversation",
  ],
} as const;

export type FunLabelCategory = keyof typeof FUN_LABELS;

/** Pick a random label from a category, optionally excluding a specific one. */
export function pickRandom(
  category: FunLabelCategory,
  exclude?: string
): string {
  const labels = FUN_LABELS[category];
  const candidates = exclude
    ? labels.filter((l) => l !== exclude)
    : [...labels];
  return candidates[Math.floor(Math.random() * candidates.length)];
}

/**
 * Past-tense completions for result labels.
 * Maps the in-progress label to a suitable past-tense version.
 */
export const PAST_TENSE: Record<FunLabelCategory, string[]> = {
  thinking: [
    "Deliberated",
    "Thought",
    "Ringeld",
    "Pondered",
    "Brainstormed",
    "Contemplated",
    "Reasoned",
  ],
  processing: [
    "Distilled information",
    "Synthesized knowledge",
    "Aggregated data",
    "Ringelated",
    "Connected concepts",
    "Extrapolated findings",
    "Understood the bigger picture",
    "Scrutinized the information",
    "Triangulated results",
    "Correlated findings",
    "Transformed data",
    "Extracted insights",
    "Filtered information"

  ],
  knowledgeBase: [
    "Retrieved knowledge",
    "Queried archives",
    "Accessed knowledge",
    "Searched archives",
    "Fetched documents",
    "Searched memory",
    "Retrieved insights",
  ],
  webSearch: [
    "Searched the web",
    "Investigated online",
    "Crawled websites",
    "Browsed the internet",
    "Collected contemporary data",
  ],
  assembling: [
    "Composed an answer",
    "Constructed a response",
    "Organize thoughts",
    "Ringelized insights",
    "Synthesized all information",
    "Integrated insights",
    "Structured a response",
    "Formulated an answer",
    "Finalized your answer",
  ],
  compacting: [
    "Archived conversation",
    "Summarized discussion",
    "Extracted key insights from conversation",
    "Reflected on discussion",
  ],
};

export function pickRandomPastTense(category: FunLabelCategory): string {
  const labels = PAST_TENSE[category];
  return labels[Math.floor(Math.random() * labels.length)];
}
