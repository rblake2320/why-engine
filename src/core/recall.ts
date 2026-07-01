import fs from "fs";
import path from "path";
import { WhyCase } from "./contracts";
import { assertSafeRepoPath, getWhyEngineRoot } from "./path-policy";

/**
 * Recall engine: turns the write-only case store into queryable
 * institutional memory. Zero dependencies, zero network, deterministic.
 *
 * Ranking is TF-IDF over field-weighted tokens. Titles, root causes,
 * generalizable patterns, and tags carry the most signal because they are
 * the fields a *new* failure is most likely to share with an old one.
 * Error-log snippets are weighted highly for exact symptom matching
 * (stack frames, error codes) since those tokens are rare and diagnostic.
 */

export interface RecallQuery {
  repoPath: string;
  /** Free text: an error message, stack trace, symptom description, or question. */
  query: string;
  /** Restrict to cases carrying ALL of these tags. */
  tags?: string[];
  /** Max results. Default 5. */
  limit?: number;
  /** Minimum score (0-1 normalized) to include. Default 0.05. */
  minScore?: number;
}

export interface RecallMatch {
  caseId: string;
  title: string;
  score: number;
  matchedTerms: string[];
  rootCause: string;
  whyFixWorked: string;
  preventNextTime: string;
  generalizablePattern?: string;
  tags: string[];
  sensitivity: string;
  createdAt: string;
}

export interface RecallResult {
  totalCases: number;
  matches: RecallMatch[];
}

interface FieldSpec {
  name: keyof IndexableFields;
  weight: number;
}

interface IndexableFields {
  title: string;
  rootCause: string;
  whyNotCaught: string;
  whyFixWorked: string;
  preventNextTime: string;
  generalizablePattern: string;
  tags: string;
  errorLogSnippet: string;
  testOutputSnippet: string;
  fileList: string;
  commitMessages: string;
}

const FIELD_SPECS: FieldSpec[] = [
  { name: "title", weight: 3.0 },
  { name: "tags", weight: 3.0 },
  { name: "rootCause", weight: 2.5 },
  { name: "generalizablePattern", weight: 2.5 },
  { name: "errorLogSnippet", weight: 2.0 },
  { name: "whyNotCaught", weight: 1.0 },
  { name: "whyFixWorked", weight: 1.0 },
  { name: "preventNextTime", weight: 1.0 },
  { name: "testOutputSnippet", weight: 1.0 },
  { name: "fileList", weight: 1.5 },
  { name: "commitMessages", weight: 1.0 }
];

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "for", "with",
  "is", "was", "are", "were", "be", "been", "being", "it", "its", "this",
  "that", "these", "those", "as", "at", "by", "from", "not", "no", "we",
  "our", "you", "your", "they", "their", "he", "she", "his", "her", "when",
  "then", "than", "so", "if", "into", "out", "up", "down", "did", "do",
  "does", "have", "has", "had", "will", "would", "should", "could", "can",
  "there", "here", "what", "which", "who", "how", "why", "all", "any",
  "some", "because", "after", "before", "while", "during"
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .flatMap((raw) => {
      // Preserve compound identifiers (paths, error codes) AND their parts,
      // so both `ENOENT` and `src/core/audit-chain.ts` style tokens match.
      const parts = raw.split(/[./-]+/).filter(Boolean);
      return raw.length > 0 ? [raw, ...parts.filter((p) => p !== raw)] : [];
    })
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token));
}

export function loadAllCases(repoPath: string): WhyCase[] {
  assertSafeRepoPath(repoPath);
  const casesDir = path.join(getWhyEngineRoot(repoPath), "cases");
  if (!fs.existsSync(casesDir)) {
    return [];
  }
  const cases: WhyCase[] = [];
  for (const entry of fs.readdirSync(casesDir)) {
    const caseFile = path.join(casesDir, entry, "case.json");
    if (!fs.existsSync(caseFile)) {
      continue;
    }
    try {
      cases.push(JSON.parse(fs.readFileSync(caseFile, "utf8")) as WhyCase);
    } catch {
      /* doctor reports unparseable cases; recall skips them */
    }
  }
  return cases;
}

function extractFields(whyCase: WhyCase): IndexableFields {
  return {
    title: whyCase.title ?? "",
    rootCause: whyCase.rootCause ?? "",
    whyNotCaught: whyCase.whyNotCaught ?? "",
    whyFixWorked: whyCase.whyFixWorked ?? "",
    preventNextTime: whyCase.preventNextTime ?? "",
    generalizablePattern: whyCase.generalizablePattern ?? "",
    tags: (whyCase.tags ?? []).join(" "),
    errorLogSnippet: whyCase.evidence?.errorLogSnippet ?? "",
    testOutputSnippet: whyCase.evidence?.testOutputSnippet ?? "",
    fileList: (whyCase.evidence?.fileList ?? []).join(" "),
    commitMessages: (whyCase.evidence?.commitMessages ?? []).join(" ")
  };
}

export function recallCases(input: RecallQuery): RecallResult {
  const limit = input.limit ?? 5;
  const minScore = input.minScore ?? 0.05;
  let cases = loadAllCases(input.repoPath);
  const totalCases = cases.length;

  if (input.tags && input.tags.length > 0) {
    const required = input.tags.map((t) => t.toLowerCase());
    cases = cases.filter((c) => {
      const have = new Set((c.tags ?? []).map((t) => t.toLowerCase()));
      return required.every((t) => have.has(t));
    });
  }

  const queryTokens = Array.from(new Set(tokenize(input.query)));
  if (queryTokens.length === 0 || cases.length === 0) {
    return { totalCases, matches: [] };
  }

  // Document frequency per token across the (filtered) corpus.
  const docTokenSets = cases.map((c) => {
    const fields = extractFields(c);
    const perField = new Map<keyof IndexableFields, Set<string>>();
    for (const spec of FIELD_SPECS) {
      perField.set(spec.name, new Set(tokenize(fields[spec.name])));
    }
    const all = new Set<string>();
    for (const set of perField.values()) {
      for (const token of set) {
        all.add(token);
      }
    }
    return { perField, all };
  });

  const df = new Map<string, number>();
  for (const token of queryTokens) {
    let count = 0;
    for (const doc of docTokenSets) {
      if (doc.all.has(token)) {
        count += 1;
      }
    }
    df.set(token, count);
  }

  const n = cases.length;
  const scored: Array<{ whyCase: WhyCase; score: number; matched: string[] }> = [];
  for (let i = 0; i < cases.length; i += 1) {
    const doc = docTokenSets[i];
    let score = 0;
    const matched: string[] = [];
    for (const token of queryTokens) {
      const dfCount = df.get(token) ?? 0;
      if (dfCount === 0) {
        continue;
      }
      const idf = Math.log(1 + n / dfCount);
      let fieldBoost = 0;
      for (const spec of FIELD_SPECS) {
        if (doc.perField.get(spec.name)?.has(token)) {
          fieldBoost = Math.max(fieldBoost, spec.weight);
        }
      }
      if (fieldBoost > 0) {
        score += idf * fieldBoost;
        matched.push(token);
      }
    }
    if (score > 0) {
      scored.push({ whyCase: cases[i], score, matched });
    }
  }

  // Normalize against the best possible score for THIS query so thresholds
  // are stable regardless of query length.
  const maxPossible = queryTokens.reduce((sum, token) => {
    const dfCount = df.get(token) ?? 0;
    if (dfCount === 0) {
      return sum;
    }
    return sum + Math.log(1 + n / dfCount) * 3.0;
  }, 0);

  const matches = scored
    .map(({ whyCase, score, matched }) => ({
      caseId: whyCase.caseId,
      title: whyCase.title,
      score: maxPossible > 0 ? Number((score / maxPossible).toFixed(4)) : 0,
      matchedTerms: Array.from(new Set(matched)).sort(),
      rootCause: whyCase.rootCause,
      whyFixWorked: whyCase.whyFixWorked,
      preventNextTime: whyCase.preventNextTime,
      generalizablePattern: whyCase.generalizablePattern,
      tags: whyCase.tags ?? [],
      sensitivity: whyCase.sensitivity,
      createdAt: whyCase.createdAt
    }))
    .filter((m) => m.score >= minScore)
    .sort((a, b) => b.score - a.score || a.createdAt.localeCompare(b.createdAt))
    .slice(0, limit);

  return { totalCases, matches };
}

export function formatRecallResult(result: RecallResult): string {
  if (result.matches.length === 0) {
    return `No matching prior cases (searched ${result.totalCases}).\n`;
  }
  const lines: string[] = [
    `Found ${result.matches.length} prior case(s) out of ${result.totalCases}:`
  ];
  for (const m of result.matches) {
    lines.push("");
    lines.push(`[${(m.score * 100).toFixed(1)}%] ${m.title} (${m.caseId})`);
    lines.push(`  rootCause: ${m.rootCause}`);
    lines.push(`  whyFixWorked: ${m.whyFixWorked}`);
    lines.push(`  preventNextTime: ${m.preventNextTime}`);
    if (m.generalizablePattern) {
      lines.push(`  pattern: ${m.generalizablePattern}`);
    }
    if (m.tags.length > 0) {
      lines.push(`  tags: ${m.tags.join(", ")}`);
    }
    lines.push(`  matched: ${m.matchedTerms.join(", ")}`);
  }
  return `${lines.join("\n")}\n`;
}
