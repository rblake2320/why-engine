/**
 * Regression: a vague prompt containing one common word must NOT produce a
 * high-confidence match, and must not outrank a genuinely relevant case.
 *
 * Found 2026-09-28. `maxPossible` skipped tokens absent from the corpus, so the
 * denominator only counted words the corpus knew. "test it and let me know" kept
 * only "test" (let/me/know are absent) and scored 100% on two irrelevant cases,
 * pushing the relevant one to third place. Because nearly every engineering
 * prompt contains such a word, the recall block became uniform 100% wallpaper
 * rather than a signal — a real lesson sat in context and was not acted on.
 *
 * Both guards are asserted:
 *   1. unrecognized query words DILUTE the score (normalisation over all tokens)
 *   2. a lone ubiquitous token cannot admit a case at all (distinctiveness gate)
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { recallCases } = require("../dist/core/recall.js");

function makeCase(id, title, body, tags) {
  return {
    caseId: id,
    title,
    rootCause: body,
    whyNotCaught: "",
    whyFixWorked: body,
    preventNextTime: body,
    generalizablePattern: body,
    tags: tags || [],
    sensitivity: "internal",
    createdAt: "2026-01-01T00:00:00.000Z",
    evidence: {}
  };
}

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "why-recall-"));
const casesDir = path.join(repo, ".why-engine", "cases");
// "test" appears in most cases -> ubiquitous, must not admit on its own.
const corpus = [
  makeCase("a".repeat(32), "Flaky test harness under load", "the test suite raced", ["test"]),
  makeCase("b".repeat(32), "Test fixture leaked state", "the test fixture leaked", ["test"]),
  makeCase("c".repeat(32), "Unit test masked a regression", "a test masked it", ["test"]),
  makeCase("d".repeat(32), "Negative control passed for the wrong reason",
    "a negative control was passed by an always-no model; a positive control was missing", ["control"]),
];
for (const c of corpus) {
  const dir = path.join(casesDir, c.caseId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "case.json"), JSON.stringify(c));
}

// --- 1. vague prompt with one ubiquitous token ---
const vague = recallCases({ repoPath: repo, query: "test it and let me know" });
for (const m of vague.matches) {
  assert.ok(
    m.score < 0.5,
    `vague prompt scored ${(m.score * 100).toFixed(1)}% on "${m.title}" — a single ` +
    `ubiquitous token must not yield a confident match`
  );
  assert.ok(
    !(m.matchedTerms.length === 1 && m.matchedTerms[0] === "test"),
    `case "${m.title}" was admitted by the lone ubiquitous token "test"`
  );
}

// --- 2. a precise prompt still retrieves the right case, ranked first ---
const precise = recallCases({
  repoPath: repo,
  query: "negative control positive control missing always-no model"
});
assert.ok(precise.matches.length > 0, "precise query returned nothing — retrieval regressed");
assert.strictEqual(
  precise.matches[0].title,
  "Negative control passed for the wrong reason",
  "precise query did not rank the relevant case first"
);

// --- 3. unrecognized words must dilute: same signal, more noise => lower score ---
const tight = recallCases({ repoPath: repo, query: "negative control" });
const padded = recallCases({
  repoPath: repo,
  query: "negative control " + "zzqqxx ".repeat(12)
});
const tightTop = tight.matches[0] ? tight.matches[0].score : 0;
const paddedTop = padded.matches.length ? padded.matches[0].score : 0;
assert.ok(
  paddedTop < tightTop,
  `padding with unrecognized words did not reduce the score ` +
  `(tight=${tightTop}, padded=${paddedTop}) — unrecognized tokens are being ` +
  `dropped from the denominator again`
);

fs.rmSync(repo, { recursive: true, force: true });
console.log("recall-generic-query: PASS");
