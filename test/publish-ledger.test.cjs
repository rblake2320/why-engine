const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

const { collectEvidence } = require("../dist/core/evidence-collector.js");
const { analyzeWhyCase } = require("../dist/core/case-builder.js");
const { publishWhyCase } = require("../dist/publishers/publisher.js");

function initRepo() {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "why-engine-ledger-"));
  spawnSync("git", ["init"], { cwd: repoDir });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  spawnSync("git", ["config", "user.name", "Test User"], { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, "file.txt"), "hello", "utf8");
  spawnSync("git", ["add", "file.txt"], { cwd: repoDir });
  spawnSync("git", ["commit", "-m", "init"], { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, "file.txt"), "hello world", "utf8");
  spawnSync("git", ["add", "file.txt"], { cwd: repoDir });
  spawnSync("git", ["commit", "-m", "update"], { cwd: repoDir });
  return repoDir;
}

test("publish uses ledger to dedupe", async () => {
  const repoDir = initRepo();
  const evidence = collectEvidence({
    repoPath: repoDir,
    commitRange: "HEAD~1..HEAD",
    includeFullDiff: false,
    sensitivity: "internal"
  });

  const whyCase = analyzeWhyCase({
    repoPath: repoDir,
    evidenceId: evidence.evidenceId,
    title: "Fix update",
    rootCause: "Missing update step",
    whyNotCaught: "No test coverage",
    whyFixWorked: "Added update commit",
    preventNextTime: "Add test"
  });

  const publishedDir = path.join(repoDir, ".why-engine", "published");
  fs.mkdirSync(publishedDir, { recursive: true });
  const ledgerPath = path.join(publishedDir, `${whyCase.idempotencyKey}.json`);
  fs.writeFileSync(
    ledgerPath,
    JSON.stringify(
      {
        problemId: "problem-1",
        solutionId: "solution-1",
        url: "https://aihangout.ai/problems/problem-1",
        timestamp: new Date().toISOString(),
        payloadHash: "hash"
      },
      null,
      2
    ),
    "utf8"
  );

  const result = await publishWhyCase({
    repoPath: repoDir,
    caseId: whyCase.caseId,
    target: "api",
    dryRun: false
  });

  assert.strictEqual(result.deduped, true);
  assert.strictEqual(result.apiResult.problemId, "problem-1");
});

test("restricted case blocks publish when secrets remain", async () => {
  const repoDir = initRepo();
  const whyCase = analyzeWhyCase({
    repoPath: repoDir,
    title: "Leak",
    rootCause: "token=supersecret",
    whyNotCaught: "No scanner",
    whyFixWorked: "Added scanner",
    preventNextTime: "Keep scanners",
    sensitivity: "restricted"
  });

  const result = await publishWhyCase({ repoPath: repoDir, caseId: whyCase.caseId, target: "outbox", dryRun: false });
  assert.strictEqual(result.blockedReason !== undefined, true);
  assert.strictEqual(result.outboxResult.written, true);
  const outboxPayload = JSON.parse(fs.readFileSync(result.outboxResult.path, "utf8"));
  assert.strictEqual(outboxPayload.blockedReason, "blocked_due_to_secrets");
  assert.strictEqual(outboxPayload.rootCause, undefined);
});

test("outbox dedupe uses idempotencyKey", async () => {
  const repoDir = initRepo();
  const evidence = collectEvidence({
    repoPath: repoDir,
    commitRange: "HEAD~1..HEAD",
    includeFullDiff: false,
    sensitivity: "internal"
  });

  const whyCase = analyzeWhyCase({
    repoPath: repoDir,
    evidenceId: evidence.evidenceId,
    title: "Fix update",
    rootCause: "Missing update step",
    whyNotCaught: "No test coverage",
    whyFixWorked: "Added update commit",
    preventNextTime: "Add test"
  });

  const first = await publishWhyCase({ repoPath: repoDir, caseId: whyCase.caseId, target: "outbox", dryRun: false });
  const second = await publishWhyCase({ repoPath: repoDir, caseId: whyCase.caseId, target: "outbox", dryRun: false });

  assert.strictEqual(first.outboxResult.written, true);
  if (second.outboxResult) {
    assert.strictEqual(second.outboxResult.written, false);
  } else {
    assert.strictEqual(second.deduped, true);
  }
  assert.match(first.outboxResult.path, new RegExp(whyCase.idempotencyKey));
  assert.doesNotMatch(first.outboxResult.path, /history/);
});

test("outbox publish does not create API dedupe ledger", async () => {
  const repoDir = initRepo();
  const whyCase = analyzeWhyCase({
    repoPath: repoDir,
    title: "Leak",
    rootCause: "token=supersecret",
    whyNotCaught: "No scanner",
    whyFixWorked: "Added scanner",
    preventNextTime: "Keep scanners",
    sensitivity: "restricted"
  });

  const outboxResult = await publishWhyCase({
    repoPath: repoDir,
    caseId: whyCase.caseId,
    target: "outbox",
    dryRun: false
  });
  assert.strictEqual(outboxResult.outboxResult.written, true);

  const apiResult = await publishWhyCase({
    repoPath: repoDir,
    caseId: whyCase.caseId,
    target: "api",
    dryRun: false
  });
  assert.strictEqual(apiResult.deduped, undefined);
  assert.strictEqual(apiResult.apiResult.success, false);
  assert.match(apiResult.apiResult.error, /blocked/i);
});

test("api publish blocked when secrets found", async () => {
  const repoDir = initRepo();
  const whyCase = analyzeWhyCase({
    repoPath: repoDir,
    title: "Leak",
    rootCause: "token=supersecret",
    whyNotCaught: "No scanner",
    whyFixWorked: "Added scanner",
    preventNextTime: "Keep scanners",
    sensitivity: "internal"
  });

  const result = await publishWhyCase({ repoPath: repoDir, caseId: whyCase.caseId, target: "api", dryRun: false });
  assert.strictEqual(result.apiResult.success, false);
  assert.match(result.apiResult.error, /blocked/);
});

test("path traversal rejected for evidenceId", () => {
  const repoDir = initRepo();
  assert.throws(() =>
    analyzeWhyCase({
      repoPath: repoDir,
      evidenceId: "../escape",
      title: "Test",
      rootCause: "Root",
      whyNotCaught: "Miss",
      whyFixWorked: "Fix",
      preventNextTime: "Prevent"
    })
  );
});
