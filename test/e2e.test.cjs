const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

const { collectEvidence } = require("../dist/core/evidence-collector.js");
const { analyzeWhyCase } = require("../dist/core/case-builder.js");
const { publishWhyCase } = require("../dist/publishers/publisher.js");

function hasGit() {
  const result = spawnSync("git", ["--version"], { stdio: "ignore" });
  return result.status === 0;
}

test("collect -> analyze -> publish(outbox) works", { skip: !hasGit() }, async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "why-engine-test-"));
  spawnSync("git", ["init"], { cwd: repoDir });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  spawnSync("git", ["config", "user.name", "Test User"], { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, "file.txt"), "hello", "utf8");
  spawnSync("git", ["add", "file.txt"], { cwd: repoDir });
  spawnSync("git", ["commit", "-m", "init"], { cwd: repoDir });

  fs.writeFileSync(path.join(repoDir, "file.txt"), "hello world", "utf8");
  spawnSync("git", ["add", "file.txt"], { cwd: repoDir });
  spawnSync("git", ["commit", "-m", "update"], { cwd: repoDir });

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

  const result = await publishWhyCase({
    repoPath: repoDir,
    caseId: whyCase.caseId,
    target: "outbox",
    dryRun: false
  });

  assert.strictEqual(result.outboxResult.written, true);
  assert.ok(fs.existsSync(result.outboxResult.path));
  assert.match(result.outboxResult.path, new RegExp(whyCase.idempotencyKey));
});
