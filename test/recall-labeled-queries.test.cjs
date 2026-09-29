/**
 * Labeled query set + precision/recall measurement for recall ranking.
 *
 * Written 2026-09-28 after a scoring fix was validated on ONE hand-picked
 * example, in one direction only. That is the same failure the corpus itself
 * records ("Negative control passed for the wrong reason"): a retriever that
 * returns nothing passes a test that only checks that vague prompts DON'T match.
 *
 * This asserts BOTH directions against hand-labeled queries:
 *   should[]    - queries where the case MUST be retrieved (recall)
 *   shouldNot[] - queries where it MUST NOT be (precision)
 *
 * Run as a measurement (prints P/R/F1) and as a gate (fails if recall drops
 * below RECALL_FLOOR). Tune nothing against a single example again.
 */
const assert = require("assert");
const { recallCases } = require("../dist/core/recall.js");

const REPO = require("path").resolve(__dirname, "..");
const RECALL_FLOOR = 0.60;   // of labeled should-match queries, top-3
const PRECISION_FLOOR = 0.80;

/** caseId prefix -> queries. Written from each case's SITUATION, not its wording. */
const LABELS = [
  {
    id: "52f676b8", name: "negative control / false confidence",
    should: [
      "negative control positive control missing",
      "the control passed but the test proves nothing",
      "is this claim written in Latin nonsense control",
      "my eval passed a control, can I trust the result",
      "reporting a measurement, did I validate it correctly",
    ],
    shouldNot: ["two reviewers overwrote each other's output file",
                "the polling lock starved a thread on a busy machine"],
  },
  {
    id: "63f49f55", name: "gitleaks allowlist no effect",
    should: ["gitleaks allowlist has no effect", "added a suppression and the finding count did not change",
             "secret scanner still reports the same findings after config change"],
    shouldNot: ["negative control positive control missing"],
  },
  {
    id: "6b4d0b92", name: "unfair polling lock / starvation",
    should: ["thread starvation under load on windows", "flaky only when the machine is busy",
             "polling lock unfair scheduling intermittent"],
    shouldNot: ["gitleaks allowlist has no effect"],
  },
  {
    id: "92a88aec", name: "backup artifact as proof of a job",
    should: ["I used a backup file as proof the nightly job ran",
             "artifact exists so the scheduled job must have completed",
             "how do I prove a scheduled job actually ran"],
    shouldNot: ["thread starvation under load on windows"],
  },
  {
    id: "af120f02", name: "re-scanned instead of recalling memory",
    should: ["I re-scanned the folders instead of reading memory",
             "wasted tokens re-deriving what memory already knew",
             "should I search the repo or check durable memory first"],
    shouldNot: ["gitleaks allowlist has no effect"],
  },
  {
    id: "e49da532", name: "two reviewers one output path",
    should: ["two reviewers were given the same output file and one report was lost",
             "concurrent writers destroyed the first agent's report",
             "fanning work out to multiple agents writing to one path"],
    shouldNot: ["negative control positive control missing"],
  },
  {
    id: "e564f02d", name: "generic leading word false contradiction",
    should: ["a generic leading word made independent facts look contradictory",
             "false positive in contradiction detection", "consolidator flagged a contradiction that was not one"],
    shouldNot: ["thread starvation under load on windows"],
  },
  {
    id: "fa08c1d5", name: "correction gated by the heuristic it corrects",
    should: ["the correction logic was gated by the heuristic it was meant to fix",
             "a test blind spot because the checker uses the thing under test",
             "self-referential test design blind spot"],
    shouldNot: ["two reviewers overwrote each other's output file"],
  },
];

function topIds(query, k) {
  const r = recallCases({ repoPath: REPO, query, limit: k, minScore: 0.0 });
  return r.matches.map((m) => m.caseId.slice(0, 8));
}

let tp = 0, fn = 0, fp = 0, tn = 0;
const misses = [];
for (const lab of LABELS) {
  for (const q of lab.should) {
    if (topIds(q, 3).includes(lab.id)) tp += 1;
    else { fn += 1; misses.push(`RECALL MISS  [${lab.name}]  "${q}"`); }
  }
  for (const q of lab.shouldNot || []) {
    if (topIds(q, 3).includes(lab.id)) { fp += 1; misses.push(`FALSE POSITIVE [${lab.name}]  "${q}"`); }
    else tn += 1;
  }
}

const recall = tp / (tp + fn);
const precision = tp / (tp + fp);
const f1 = (2 * precision * recall) / (precision + recall);
console.log(`labeled queries: should=${tp + fn} shouldNot=${fp + tn}`);
console.log(`recall@3    = ${recall.toFixed(3)}  (${tp}/${tp + fn})`);
console.log(`precision@3 = ${precision.toFixed(3)}`);
console.log(`F1          = ${f1.toFixed(3)}`);
for (const m of misses) console.log("  " + m);

assert.ok(recall >= RECALL_FLOOR,
  `recall@3 ${recall.toFixed(3)} below floor ${RECALL_FLOOR} — a scoring change ` +
  `has made the store less able to surface the right lesson`);
assert.ok(precision >= PRECISION_FLOOR,
  `precision@3 ${precision.toFixed(3)} below floor ${PRECISION_FLOOR}`);
console.log("recall-labeled-queries: PASS");
