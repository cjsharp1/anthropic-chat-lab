/**
 * search-docs.ts — keyword search over a small local corpus.
 *
 * This is retrieval: find the few documents relevant to a question and put
 * only those in front of the model. It is the same idea as RAG, with the
 * expensive part removed — there is no vector database and no embedding
 * model here, just keyword scoring over fourteen JSON records.
 *
 * ---------------------------------------------------------------------------
 * Why bother retrieving at all
 * ---------------------------------------------------------------------------
 *
 * The naive alternative is to paste the whole corpus into the system
 * prompt. For fourteen short records that would actually work. It stops
 * working as the corpus grows: every token is resent on every turn, the
 * cost scales with the size of the library rather than the size of the
 * question, and past a point it does not fit at all.
 *
 * Retrieval inverts that. The corpus can be any size; what enters the
 * context is three records.
 *
 * ---------------------------------------------------------------------------
 * How the scoring works, and where it falls down
 * ---------------------------------------------------------------------------
 *
 * Three refinements over counting raw word matches, each added because the
 * naive version demonstrably got something wrong:
 *
 *   1. Stopwords are dropped. Without this, "why is my key rejected"
 *      matched all fourteen records, because "is" and "my" appear
 *      everywhere.
 *
 *   2. Title and tag matches are weighted far above body matches. A word
 *      in the title says what a record is ABOUT; the same word in the body
 *      may be an aside. Without this, "how much does it cost" ranked the
 *      system prompt record above the pricing one, because the former
 *      happens to use the word "cost" in passing.
 *
 *   3. Matches must be on word boundaries. Substring matching makes "api"
 *      hit "rapid" and inflates scores unpredictably.
 *
 * What it still cannot do is match on meaning. A search for "expensive"
 * will not find a record that only ever says "cost", because the words
 * differ. That gap is exactly what embeddings solve, and it is the honest
 * reason production systems use them.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { defineTool } from "../types.js";

/** One record in the corpus. */
interface Doc {
  id: string;
  title: string;
  tags: string[];
  body: string;
}

/**
 * Loads the corpus from disk, once, when this module is first imported.
 *
 * Note how the path is built. __dirname does not exist in an ES module —
 * this project is "type": "module" — so a script-relative path has to be
 * derived from import.meta.url. Using a plain relative path instead would
 * resolve against whatever directory the server happened to be started
 * from, which works until someone runs it from elsewhere.
 */
const here = dirname(fileURLToPath(import.meta.url));
const docs: Doc[] = JSON.parse(
  readFileSync(join(here, "../../data/kb.json"), "utf-8"),
) as Doc[];

/**
 * Words too common to carry meaning.
 *
 * A short list aimed at the shape of real questions — "how do I", "why is
 * my", "what does X do". A production system would use a longer standard
 * list, or term frequency statistics computed from the corpus itself.
 */
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "do", "does",
  "for", "from", "get", "has", "have", "how", "i", "if", "in", "is", "it",
  "its", "me", "much", "my", "of", "on", "or", "that", "the", "their", "them",
  "then", "there", "they", "this", "to", "use", "using", "was", "what", "when",
  "where", "which", "who", "why", "will", "with", "you", "your",
]);

/** How much a match in each field is worth. */
const WEIGHT = { title: 10, tag: 6, body: 1 } as const;

/** Splits text into lowercase words, dropping stopwords and single letters. */
function terms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/) // underscores kept: "max_tokens" is one term
    .filter((word) => word.length > 1 && !STOPWORDS.has(word));
}

/** Counts whole-word occurrences of `term` in `text`. */
function countWholeWord(text: string, term: string): number {
  // Escaped, because a term could contain regex metacharacters.
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (text.match(new RegExp(`\\b${escaped}\\b`, "g")) ?? []).length;
}

/** Scores one document against a set of query terms. */
function scoreDoc(doc: Doc, queryTerms: string[]): number {
  const title = doc.title.toLowerCase();
  const tags = doc.tags.map((t) => t.toLowerCase());
  const body = doc.body.toLowerCase();

  let score = 0;

  for (const term of queryTerms) {
    score += countWholeWord(title, term) * WEIGHT.title;

    // A tag is a whole label, so an exact match counts; a partial one does
    // not. "token" should match the tag "tokens" though, hence the pair.
    for (const tag of tags) {
      if (tag === term || tag.startsWith(term) || term.startsWith(tag)) {
        score += WEIGHT.tag;
      }
    }

    score += countWholeWord(body, term) * WEIGHT.body;
  }

  return score;
}

const inputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      "What to search for. Keywords work better than a full sentence: " +
        '"prompt caching cost" rather than "how much money does prompt ' +
        'caching save me".',
    ),

  limit: z
    .number()
    .int()
    .min(1)
    .max(5)
    .optional()
    .describe("How many documents to return. Defaults to 3, maximum 5."),
});

export const searchDocs = defineTool({
  name: "search_docs",

  description:
    "Searches a reference library about the Anthropic Claude API — the " +
    "Messages API, tool use, prompt caching, streaming, error handling, " +
    "pricing and model IDs. Use this before answering a factual question " +
    "about how the API works, rather than relying on memory. Returns the " +
    "most relevant documents in full. Keyword queries work best.",

  // A prompt that reliably triggers this tool, with a note on
  // what to watch for. Shown in the Tools tab: a tool nobody
  // knows how to invoke teaches nothing.
  examplePrompt: "Search the docs for what stop_reason max_tokens means.",
  exampleWatch:
    "Returns the three most relevant records in full. Try \"expensive\" instead of \"cost\" and watch the ranking degrade — keyword search cannot know they mean the same thing.",

  inputSchema,

  run: async ({ query, limit }) => {
    const queryTerms = terms(query);

    if (queryTerms.length === 0) {
      // Everything was a stopword: "what is it", say. Telling the model
      // why it found nothing lets it rephrase, where "no results" would
      // just look like an empty library.
      throw new Error(
        `The query "${query}" contains only common words. ` +
          "Search for specific terms like 'prompt caching' or 'stop_reason'.",
      );
    }

    const ranked = docs
      .map((doc) => ({ doc, score: scoreDoc(doc, queryTerms) }))
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit ?? 3);

    if (ranked.length === 0) {
      // Not an error. An empty result is a real answer, and listing the
      // available topics is more useful to the model than a bare "none".
      return (
        `No documents matched "${query}".\n\n` +
        `The library covers: ${docs.map((d) => d.title).join("; ")}.`
      );
    }

    // Full bodies, not snippets. These records are short by design, and a
    // truncated answer would make the model guess at the rest — which is
    // the failure retrieval exists to prevent.
    const results = ranked
      .map(
        ({ doc, score }, index) =>
          `[${index + 1}] ${doc.title}  (id: ${doc.id}, relevance: ${score})\n${doc.body}`,
      )
      .join("\n\n");

    return `Found ${ranked.length} document(s) for "${query}":\n\n${results}`;
  },
});
