const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { analyzeWhyCase } = require("../dist/core/case-builder.js");
const { recallCases, tokenize } = require("../dist/core/recall.js");
const { computeStats } = require("../dist/commands/stats.js");
const { runDoctor } = require("../dist/commands/doctor.js");
const { appendAuditEntry, getAuditLogPath } = require("../dist/core/audit-chain.js");

function tmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "why-recall-"));
}

function seedCase(repo, overrides = {}) {
  return analyzeWhyCase({
    repoPath: repo,
    title: overrides.title ?? "Race condition in outbox writer",
    rootCause:
      overrides.rootCause ??
      "Concurrent writers hit the outbox ledger without locking because appendFileSync provided no mutual exclusion",
    whyNotCaught:
      overrides.whyNotCaught ?? "Tests ran single-threaded so the interleaving never occurred in CI",
    whyFixWorked:
      overrides.whyFixWorked ??
      "Adding an advisory lock works because mkdir is atomic, so only one writer enters the critical section",
    preventNextTime:
      overrides.preventNextTime ?? "Add a concurrency stress test to CI that spawns parallel writers",
    generalizablePattern:
      overrides.generalizablePattern ??
      "Any append-only file shared across processes needs an atomic acquisition primitive before writes",
    tags: overrides.tags ?? ["concurrency", "durability"],
    sensitivity: overrides.sensitivity ?? "internal"
  });
}

test("tokenize keeps compound identifiers and their parts, drops stopwords", () => {
  const tokens = tokenize("The ENOENT error in src/core/audit-chain.ts because of the rename");
  assert.ok(tokens.includes("enoent"));
  assert.ok(tokens.includes("src/core/audit-chain.ts"));
  assert.ok(tokens.includes("audit"));
  assert.ok(tokens.includes("rename"));
  assert.ok(!tokens.includes("the"));
  assert.ok(!tokens.includes("because"));
});

test("recall ranks the matching prior case first for a new symptom description", () => {
  const repo = tmpRepo();
  seedCase(repo);
  seedCase(repo, {
    title: "CSS grid overflow on dashboard",
    rootCause: "The dashboard grid overflowed because min-width defaults prevented column shrink below content size",
    whyFixWorked: "Setting min-width zero works because grid items can then shrink so overflow ends",
    preventNextTime: "Add a visual regression test for the dashboard layout",
    generalizablePattern: "Grid and flex children default to min-width auto which blocks shrinking below content",
    tags: ["frontend", "css"]
  });

  const result = recallCases({
    repoPath: repo,
    query: "two processes wrote the ledger at the same time and corrupted it - race condition?"
  });
  assert.strictEqual(result.totalCases, 2);
  assert.ok(result.matches.length >= 1);
  assert.match(result.matches[0].title, /Race condition/);
  assert.ok(result.matches[0].score > 0);
  assert.ok(result.matches[0].matchedTerms.length > 0);
});

test("recall tag filter requires all tags", () => {
  const repo = tmpRepo();
  seedCase(repo, { tags: ["concurrency", "durability"] });
  seedCase(repo, {
    title: "Timeout in API client retries",
    rootCause: "Retries stacked because the client never honored abort signals during backoff sleep intervals",
    whyFixWorked: "Honoring abort works because pending sleeps cancel so retries stop when the caller gives up",
    preventNextTime: "Add a test asserting abort cancels in-flight retries",
    tags: ["network"]
  });
  const filtered = recallCases({ repoPath: repo, query: "locking race writer", tags: ["concurrency", "durability"] });
  assert.strictEqual(filtered.matches.length, 1);
  const none = recallCases({ repoPath: repo, query: "locking race writer", tags: ["concurrency", "network"] });
  assert.strictEqual(none.matches.length, 0);
});

test("recall on an empty store returns cleanly", () => {
  const repo = tmpRepo();
  const result = recallCases({ repoPath: repo, query: "anything at all" });
  assert.strictEqual(result.totalCases, 0);
  assert.deepStrictEqual(result.matches, []);
});

test("recall rejects unsafe repoPath", () => {
  assert.throws(() => recallCases({ repoPath: "../../etc", query: "x" }), /Unsafe repoPath/);
});

test("stats detects recurring root-cause clusters (prevention that did not hold)", () => {
  const repo = tmpRepo();
  seedCase(repo, { title: "Race condition in outbox writer" });
  seedCase(repo, {
    title: "Race condition in outbox writer strikes again",
    rootCause:
      "Concurrent writers hit the outbox ledger without locking because the second write path bypassed the mutex entirely"
  });
  seedCase(repo, {
    title: "CSS grid overflow on dashboard",
    rootCause: "The dashboard grid overflowed because min-width defaults prevented column shrink below content size",
    whyFixWorked: "Setting min-width zero works because grid items can then shrink so overflow ends",
    preventNextTime: "Add a visual regression test for the dashboard layout",
    tags: ["frontend"]
  });
  const stats = computeStats({ repoPath: repo, similarityThreshold: 0.4 });
  assert.strictEqual(stats.totalCases, 3);
  assert.ok(stats.recurringClusters.length >= 1, "the two race-condition cases must cluster");
  const cluster = stats.recurringClusters[0];
  assert.strictEqual(cluster.caseIds.length, 2);
  assert.ok(cluster.sharedTerms.includes("outbox"));
  assert.ok(stats.topTags.some((t) => t.tag === "concurrency" && t.count === 2));
  assert.ok(stats.averageQualityScore > 0);
});

test("doctor reports healthy on a clean store and detects a torn audit tail", () => {
  const repo = tmpRepo();
  seedCase(repo);
  let result = runDoctor({ repoPath: repo });
  assert.strictEqual(result.healthy, true);
  assert.ok(result.checks.some((c) => c.name === "audit.chain" && c.status === "pass"));
  assert.ok(result.checks.some((c) => c.name === "cases.parse" && c.status === "pass"));

  fs.appendFileSync(getAuditLogPath(repo), '{"torn');
  result = runDoctor({ repoPath: repo });
  assert.strictEqual(result.healthy, false);
  const auditCheck = result.checks.find((c) => c.name === "audit.chain");
  assert.strictEqual(auditCheck.status, "fail");
  assert.match(auditCheck.detail, /repairable/);
});

test("doctor --fix repairs a torn tail and the store returns to healthy", () => {
  const repo = tmpRepo();
  seedCase(repo);
  fs.appendFileSync(getAuditLogPath(repo), '{"torn');
  const fixed = runDoctor({ repoPath: repo, fix: true });
  assert.strictEqual(fixed.healthy, true);
  assert.ok(fixed.repaired);
  assert.ok(fs.existsSync(fixed.repaired.quarantinePath));
  assert.ok(fixed.checks.some((c) => c.name === "audit.repair" && c.status === "warn"));
});

test("doctor flags unparseable case files", () => {
  const repo = tmpRepo();
  const seeded = seedCase(repo);
  const badDir = path.join(repo, ".why-engine", "cases", "deadbeefdeadbeefdeadbeefdeadbeef");
  fs.mkdirSync(badDir, { recursive: true });
  fs.writeFileSync(path.join(badDir, "case.json"), "{not json");
  const result = runDoctor({ repoPath: repo });
  assert.strictEqual(result.healthy, false);
  const parseCheck = result.checks.find((c) => c.name === "cases.parse");
  assert.strictEqual(parseCheck.status, "fail");
  // recall must still work, skipping the bad file
  const recall = recallCases({ repoPath: repo, query: "outbox ledger locking race" });
  assert.ok(recall.matches.some((m) => m.caseId === seeded.caseId));
});

test("doctor warns on stale locks without failing the store", () => {
  const repo = tmpRepo();
  seedCase(repo);
  const lockDir = path.join(repo, ".why-engine", "orphan.lock");
  fs.mkdirSync(lockDir, { recursive: true });
  const old = new Date(Date.now() - 120000);
  fs.utimesSync(lockDir, old, old);
  const result = runDoctor({ repoPath: repo });
  const lockCheck = result.checks.find((c) => c.name === "locks");
  assert.strictEqual(lockCheck.status, "warn");
  assert.strictEqual(result.healthy, true);
});
