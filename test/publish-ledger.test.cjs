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

function goodWhyCase(overrides = {}) {
  return {
    title: "File update behavior",
    rootCause: "The update path wrote the file without recording which branch of behavior changed",
    whyNotCaught: "The prior tests asserted only that a file existed and did not verify the changed behavior",
    whyFixWorked: "The fix works because the changed behavior is now captured before publish dedupe runs",
    preventNextTime: "Add regression tests that verify both the written file and the dedupe ledger behavior",
    ...overrides
  };
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
    ...goodWhyCase({ title: "Ledger dedupe behavior" })
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
    ...goodWhyCase({
      title: "Restricted token leak",
      rootCause: "token=supersecret remained in the narrative payload before publish",
      whyNotCaught: "The earlier path did not scan the final outbox payload after case assembly",
      whyFixWorked: "The scanner works because it redacts token-shaped values before the outbox writer persists them",
      preventNextTime: "Keep scanner regression tests that assert restricted outbox records are stub-only"
    }),
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
    ...goodWhyCase({ title: "Outbox dedupe behavior" })
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
    ...goodWhyCase({
      title: "Restricted token outbox behavior",
      rootCause: "token=supersecret remained in the narrative payload before publish",
      whyNotCaught: "The earlier path did not scan the final outbox payload after case assembly",
      whyFixWorked: "The scanner works because it redacts token-shaped values before the outbox writer persists them",
      preventNextTime: "Keep scanner regression tests that assert restricted outbox records are stub-only"
    }),
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
    ...goodWhyCase({
      title: "Internal token API block",
      rootCause: "token=supersecret remained in the narrative payload before API publish",
      whyNotCaught: "The earlier API path relied on caller discipline instead of scanning final prose",
      whyFixWorked: "The scanner works because it blocks token-shaped values before an API request is attempted",
      preventNextTime: "Keep API publish regression tests that assert secret-bearing cases are blocked"
    }),
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
