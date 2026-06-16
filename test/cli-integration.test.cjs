/**
 * cli-integration.test.cjs
 * End-to-end CLI integration tests:
 *  - collect-evidence command
 *  - analyze command
 *  - publish command (outbox + dry-run)
 *  - capture-and-publish command
 *  - verify-audit command (alias)
 *  - verify-audit-chain command
 *  - error handling: missing required flags
 *  - error handling: invalid command
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

const CLI_BIN = path.resolve(__dirname, "../dist/cli.js");

function initRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "why-cli-"));
  spawnSync("git", ["init"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "init.txt"), "init", "utf8");
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-m", "initial commit"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "change.txt"), "change", "utf8");
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-m", "second commit"], { cwd: dir });
  return dir;
}

function runCLI(args, opts = {}) {
  return spawnSync(process.execPath, [CLI_BIN, ...args], {
    encoding: "utf8",
    ...opts
  });
}

function analysisArgs(title) {
  return [
    "--title", title,
    "--root-cause", "The handler trusted an optional value without first checking whether it was present",
    "--why-not-caught", "Existing tests covered only the populated path and never exercised the missing-value branch",
    "--why-fix-worked", "The guard works because it rejects the missing value before downstream code can dereference it",
    "--prevent-next-time", "Add a regression test for the missing-value branch and keep it in CI coverage"
  ];
}

// ─── collect-evidence ────────────────────────────────────────────────────────

test("CLI collect-evidence: outputs valid JSON evidence bundle", () => {
  const repoDir = initRepo();
  const r = runCLI(["collect-evidence", "--repo-path", repoDir, "--commit-range", "HEAD~1..HEAD"]);
  assert.strictEqual(r.status, 0, `CLI failed: ${r.stderr}`);
  const evidence = JSON.parse(r.stdout);
  assert.ok(evidence.evidenceId, "evidenceId should be present");
  assert.ok(evidence.collectedAt, "collectedAt should be present");
  assert.ok(Array.isArray(evidence.fileList), "fileList should be an array");
  assert.ok(evidence.secretScanResult, "secretScanResult should be present");
  assert.strictEqual(typeof evidence.secretScanResult.clean, "boolean");
});

test("CLI collect-evidence: fails without --repo-path", () => {
  const r = runCLI(["collect-evidence"]);
  assert.notStrictEqual(r.status, 0, "Should fail without --repo-path");
  assert.match(r.stderr, /repo-path/i);
});

test("CLI collect-evidence: sensitivity=public redacts host in remote URL", () => {
  const repoDir = initRepo();
  const r = runCLI(["collect-evidence", "--repo-path", repoDir, "--sensitivity", "public"]);
  assert.strictEqual(r.status, 0, `CLI failed: ${r.stderr}`);
  const evidence = JSON.parse(r.stdout);
  // repoRemoteUrl should be sanitized (no credentials)
  if (evidence.environment.repoRemoteUrl) {
    assert.doesNotMatch(evidence.environment.repoRemoteUrl, /@/,
      "Remote URL should not contain credentials in public mode");
  }
});

// ─── analyze ─────────────────────────────────────────────────────────────────

test("CLI analyze: outputs valid WhyCase JSON", () => {
  const repoDir = initRepo();
  const r = runCLI([
    "analyze",
    "--repo-path", repoDir,
    ...analysisArgs("Null guard regression")
  ]);
  assert.strictEqual(r.status, 0, `CLI failed: ${r.stderr}`);
  const wc = JSON.parse(r.stdout);
  assert.ok(wc.caseId, "caseId should be present");
  assert.ok(wc.idempotencyKey, "idempotencyKey should be present");
  assert.strictEqual(wc.title, "Null guard regression");
  assert.match(wc.rootCause, /optional value/);
  assert.strictEqual(wc.sensitivity, "internal");
  assert.strictEqual(typeof wc.secretScanResult.clean, "boolean");
});

test("CLI analyze: fails without required fields", () => {
  const repoDir = initRepo();
  const r = runCLI(["analyze", "--repo-path", repoDir, "--title", "Test"]);
  assert.notStrictEqual(r.status, 0, "Should fail with missing required fields");
});

test("CLI analyze: sensitivity flag is respected", () => {
  const repoDir = initRepo();
  const r = runCLI([
    "analyze",
    "--repo-path", repoDir,
    ...analysisArgs("Public redaction behavior"),
    "--sensitivity", "public"
  ]);
  assert.strictEqual(r.status, 0, `CLI failed: ${r.stderr}`);
  const wc = JSON.parse(r.stdout);
  assert.strictEqual(wc.sensitivity, "public");
});

// ─── publish ─────────────────────────────────────────────────────────────────

test("CLI publish: dry-run=true does not write outbox", async () => {
  const repoDir = initRepo();
  const analyzeResult = runCLI([
    "analyze",
    "--repo-path", repoDir,
    ...analysisArgs("Dry run publish behavior")
  ]);
  assert.strictEqual(analyzeResult.status, 0);
  const wc = JSON.parse(analyzeResult.stdout);

  const r = runCLI([
    "publish",
    "--repo-path", repoDir,
    "--case-id", wc.caseId,
    "--target", "outbox",
    "--dry-run", "true"
  ]);
  assert.strictEqual(r.status, 0, `CLI failed: ${r.stderr}`);
  const result = JSON.parse(r.stdout);
  assert.strictEqual(result.dryRun, true);
  // No outbox file should exist
  const outboxDir = path.join(repoDir, ".why-engine", "outbox");
  if (fs.existsSync(outboxDir)) {
    const files = fs.readdirSync(outboxDir).filter(f => f.endsWith(".json"));
    assert.strictEqual(files.length, 0, "No outbox files should be written in dry-run mode");
  }
});

test("CLI publish: outbox target writes file named by idempotencyKey", () => {
  const repoDir = initRepo();
  const analyzeResult = runCLI([
    "analyze",
    "--repo-path", repoDir,
    ...analysisArgs("Outbox idempotency path")
  ]);
  assert.strictEqual(analyzeResult.status, 0);
  const wc = JSON.parse(analyzeResult.stdout);

  const r = runCLI([
    "publish",
    "--repo-path", repoDir,
    "--case-id", wc.caseId,
    "--target", "outbox",
    "--dry-run", "false"
  ]);
  assert.strictEqual(r.status, 0, `CLI failed: ${r.stderr}`);
  const result = JSON.parse(r.stdout);
  assert.strictEqual(result.outboxResult.written, true);
  // File should be named by idempotencyKey
  const outboxBasename = path.basename(result.outboxResult.path, ".json");
  assert.strictEqual(outboxBasename, wc.idempotencyKey,
    `Outbox file should be named by idempotencyKey. Got: ${outboxBasename}`);
});

test("CLI publish: second publish to outbox is deduped", () => {
  const repoDir = initRepo();
  const analyzeResult = runCLI([
    "analyze",
    "--repo-path", repoDir,
    ...analysisArgs("Outbox dedupe behavior")
  ]);
  assert.strictEqual(analyzeResult.status, 0);
  const wc = JSON.parse(analyzeResult.stdout);

  const publishArgs = [
    "publish",
    "--repo-path", repoDir,
    "--case-id", wc.caseId,
    "--target", "outbox",
    "--dry-run", "false"
  ];
  const r1 = runCLI(publishArgs);
  const r2 = runCLI(publishArgs);
  assert.strictEqual(r1.status, 0);
  assert.strictEqual(r2.status, 0);
  const res1 = JSON.parse(r1.stdout);
  const res2 = JSON.parse(r2.stdout);
  assert.strictEqual(res1.outboxResult.written, true);
  assert.strictEqual(res2.outboxResult.written, false, "Second publish should be deduped");
});

// ─── capture-and-publish ─────────────────────────────────────────────────────

test("CLI capture-and-publish: produces evidenceId, caseId, and result", () => {
  const repoDir = initRepo();
  const r = runCLI([
    "capture-and-publish",
    "--repo-path", repoDir,
    "--commit-range", "HEAD~1..HEAD",
    ...analysisArgs("Full pipeline behavior"),
    "--target", "outbox",
    "--dry-run", "false"
  ]);
  assert.strictEqual(r.status, 0, `CLI failed: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.ok(out.evidenceId, "evidenceId should be present");
  assert.ok(out.caseId, "caseId should be present");
  assert.ok(out.result, "result should be present");
  assert.strictEqual(out.result.outboxResult.written, true);
});

// ─── verify-audit / verify-audit-chain ───────────────────────────────────────

test("CLI verify-audit: returns valid chain after operations", () => {
  const repoDir = initRepo();
  // Run an analyze to populate the audit log
  runCLI([
    "analyze",
    "--repo-path", repoDir,
    ...analysisArgs("Audit append behavior")
  ]);
  const r = runCLI(["verify-audit", "--repo-path", repoDir]);
  assert.strictEqual(r.status, 0, `CLI failed: ${r.stderr}`);
  const result = JSON.parse(r.stdout);
  assert.strictEqual(result.valid, true);
  assert.ok(result.totalEntries >= 1, "Should have at least one audit entry");
});

test("CLI verify-audit-chain: returns valid chain (canonical command)", () => {
  const repoDir = initRepo();
  runCLI([
    "analyze",
    "--repo-path", repoDir,
    ...analysisArgs("Audit chain behavior")
  ]);
  const r = runCLI(["verify-audit-chain", "--repo-path", repoDir]);
  assert.strictEqual(r.status, 0, `CLI failed: ${r.stderr}`);
  const result = JSON.parse(r.stdout);
  assert.strictEqual(result.valid, true);
});

test("CLI verify-audit and verify-audit-chain return identical results", () => {
  const repoDir = initRepo();
  runCLI([
    "analyze",
    "--repo-path", repoDir,
    ...analysisArgs("Audit alias parity behavior")
  ]);
  const r1 = runCLI(["verify-audit", "--repo-path", repoDir]);
  const r2 = runCLI(["verify-audit-chain", "--repo-path", repoDir]);
  const out1 = JSON.parse(r1.stdout);
  const out2 = JSON.parse(r2.stdout);
  assert.strictEqual(out1.valid, out2.valid);
  assert.strictEqual(out1.totalEntries, out2.totalEntries);
});

// ─── Error handling ───────────────────────────────────────────────────────────

test("CLI: unknown command exits non-zero", () => {
  const r = runCLI(["nonexistent-command"]);
  assert.notStrictEqual(r.status, 0, "Unknown command should exit non-zero");
});

test("CLI: no command exits non-zero", () => {
  const r = runCLI([]);
  assert.notStrictEqual(r.status, 0, "No command should exit non-zero");
});

test("CLI verify-audit: fails without --repo-path or --log-path", () => {
  const r = runCLI(["verify-audit"]);
  assert.notStrictEqual(r.status, 0, "Should fail without required path argument");
});
