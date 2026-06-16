/**
 * audit-chain.test.cjs
 * Tests for:
 *  - verify-audit CLI alias (verify-audit == verify-audit-chain)
 *  - Audit chain integrity: tamper detection
 *  - Gitleaks integration (when gitleaks is available)
 *  - Outbox lookup by caseId (not just idempotencyKey)
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const { appendAuditEntry, verifyAuditChain, getAuditLogPath } = require("../dist/core/audit-chain.js");
const { analyzeWhyCase } = require("../dist/core/case-builder.js");
const { publishWhyCase } = require("../dist/publishers/publisher.js");
const { collectEvidence } = require("../dist/core/evidence-collector.js");

const CLI_BIN = path.resolve(__dirname, "../dist/cli.js");

function initRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "why-test-"));
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

function goodWhyCase(overrides = {}) {
  return {
    title: "Outbox behavior regression",
    rootCause: "The publish path relied on a short case id even though outbox files are keyed by the idempotency hash",
    whyNotCaught: "The previous tests checked that a response existed but did not verify the persisted filename contract",
    whyFixWorked: "The fix works because it verifies the idempotency hash before reading the outbox payload back",
    preventNextTime: "Keep regression tests that assert both the outbox filename and the embedded case id",
    ...overrides
  };
}

// ─── Audit chain tests ─────────────────────────────────────────────────────

test("audit chain: empty log is valid", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "why-audit-"));
  const logPath = path.join(dir, "audit.log");
  const result = verifyAuditChain(logPath);
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.totalEntries, 0);
});

test("audit chain: single entry is valid", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "why-audit-"));
  const repoDir = initRepo();
  appendAuditEntry(repoDir, "why.test", { foo: "bar" });
  const logPath = getAuditLogPath(repoDir);
  const result = verifyAuditChain(logPath);
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.totalEntries, 1);
});

test("audit chain: multiple entries are valid", () => {
  const repoDir = initRepo();
  appendAuditEntry(repoDir, "why.test.a", { step: 1 });
  appendAuditEntry(repoDir, "why.test.b", { step: 2 });
  appendAuditEntry(repoDir, "why.test.c", { step: 3 });
  const logPath = getAuditLogPath(repoDir);
  const result = verifyAuditChain(logPath);
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.totalEntries, 3);
});

test("audit chain: tampered hash is detected", () => {
  const repoDir = initRepo();
  appendAuditEntry(repoDir, "why.test.a", { step: 1 });
  appendAuditEntry(repoDir, "why.test.b", { step: 2 });
  const logPath = getAuditLogPath(repoDir);
  // Tamper: overwrite the first line with a modified entry
  const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
  const first = JSON.parse(lines[0]);
  first.payload = { step: 999 }; // Tamper the payload
  lines[0] = JSON.stringify(first);
  fs.writeFileSync(logPath, lines.join("\n") + "\n", "utf8");
  const result = verifyAuditChain(logPath);
  assert.strictEqual(result.valid, false);
  assert.ok(result.brokenAt !== undefined);
});

test("audit chain: tampered prevHash is detected", () => {
  const repoDir = initRepo();
  appendAuditEntry(repoDir, "why.test.a", { step: 1 });
  appendAuditEntry(repoDir, "why.test.b", { step: 2 });
  const logPath = getAuditLogPath(repoDir);
  const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
  const second = JSON.parse(lines[1]);
  second.prevHash = "0000000000000000000000000000000000000000000000000000000000000000";
  lines[1] = JSON.stringify(second);
  fs.writeFileSync(logPath, lines.join("\n") + "\n", "utf8");
  const result = verifyAuditChain(logPath);
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.brokenAt, 2);
  assert.strictEqual(result.brokenReason, "prevHash mismatch");
});

// ─── CLI verify-audit alias test ────────────────────────────────────────────

test("CLI: verify-audit alias works (same as verify-audit-chain)", () => {
  const repoDir = initRepo();
  appendAuditEntry(repoDir, "why.test", { x: 1 });

  const r1 = spawnSync(process.execPath, [CLI_BIN, "verify-audit-chain", "--repo-path", repoDir], { encoding: "utf8" });
  const r2 = spawnSync(process.execPath, [CLI_BIN, "verify-audit", "--repo-path", repoDir], { encoding: "utf8" });

  assert.strictEqual(r1.status, 0, `verify-audit-chain failed: ${r1.stderr}`);
  assert.strictEqual(r2.status, 0, `verify-audit alias failed: ${r2.stderr}`);

  const out1 = JSON.parse(r1.stdout);
  const out2 = JSON.parse(r2.stdout);
  assert.strictEqual(out1.valid, true);
  assert.strictEqual(out2.valid, true);
  assert.strictEqual(out1.totalEntries, out2.totalEntries);
});

test("CLI: verify-audit detects tampered chain", () => {
  const repoDir = initRepo();
  appendAuditEntry(repoDir, "why.test.a", { step: 1 });
  appendAuditEntry(repoDir, "why.test.b", { step: 2 });
  const logPath = getAuditLogPath(repoDir);
  const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
  const first = JSON.parse(lines[0]);
  first.payload = { step: 999 };
  lines[0] = JSON.stringify(first);
  fs.writeFileSync(logPath, lines.join("\n") + "\n", "utf8");

  const r = spawnSync(process.execPath, [CLI_BIN, "verify-audit", "--repo-path", repoDir], { encoding: "utf8" });
  assert.strictEqual(r.status, 0); // CLI exits 0 but returns valid:false
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.valid, false);
});

// ─── Gitleaks integration test ──────────────────────────────────────────────

test("gitleaks: scans and detects secrets in repo", () => {
  const { scanAndRedact } = require("../dist/core/secret-scanner.js");
  // A fake AWS key that gitleaks should catch
  const payload = { config: "aws_access_key_id = AKIAIOSFODNN7EXAMPLE\naws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };
  const result = scanAndRedact(payload, "internal");
  // With gitleaks installed, at least one scanner should catch this
  assert.ok(result.result.secretsFound > 0 || (result.result.gitleaksRan && (result.result.gitleaksFindings ?? 0) > 0),
    "Expected secrets to be found by regex or gitleaks scanner");
});

test("gitleaks: clean payload reports clean", () => {
  const { scanAndRedact } = require("../dist/core/secret-scanner.js");
  const payload = { message: "This is a normal log message with no secrets." };
  const result = scanAndRedact(payload, "internal");
  assert.strictEqual(result.result.secretsFound, 0);
  assert.strictEqual(result.result.clean, true);
});

// ─── Outbox lookup by caseId vs idempotencyKey ───────────────────────────────

test("outbox: file is named by idempotencyKey and contains caseId", async () => {
  const repoDir = initRepo();
  const whyCase = analyzeWhyCase({
    repoPath: repoDir,
    ...goodWhyCase({ title: "Outbox key test" }),
    sensitivity: "internal"
  });

  const result = await publishWhyCase({
    repoPath: repoDir,
    caseId: whyCase.caseId,
    target: "outbox",
    dryRun: false
  });

  assert.strictEqual(result.outboxResult.written, true);
  // File should be named by idempotencyKey
  assert.ok(result.outboxResult.path.includes(whyCase.idempotencyKey),
    `Expected outbox path to contain idempotencyKey. Got: ${result.outboxResult.path}`);
  // File should be named by idempotencyKey (64 hex chars), not just caseId (32 hex chars)
  const outboxBasename = path.basename(result.outboxResult.path, '.json');
  assert.strictEqual(outboxBasename, whyCase.idempotencyKey,
    `Outbox file should be named by full idempotencyKey. Got: ${outboxBasename}`);

  // The file should contain the caseId inside
  const content = JSON.parse(fs.readFileSync(result.outboxResult.path, "utf8"));
  assert.strictEqual(content.caseId, whyCase.caseId);
  assert.strictEqual(content.idempotencyKey, whyCase.idempotencyKey);
});

test("outbox: stub record contains caseId and idempotencyKey but not secrets", async () => {
  const repoDir = initRepo();
  const whyCase = analyzeWhyCase({
    repoPath: repoDir,
    ...goodWhyCase({
      title: "Secret stub test",
      rootCause: "token=supersecret123 remained in the narrative payload before outbox publish",
      whyNotCaught: "The earlier test covered direct fields but did not verify the final stub-only outbox payload",
      whyFixWorked: "The scanner works because it redacts token-shaped prose before the outbox payload is written",
      preventNextTime: "Keep scanner regression tests that assert restricted outbox records omit narrative fields"
    }),
    sensitivity: "restricted"
  });

  const result = await publishWhyCase({
    repoPath: repoDir,
    caseId: whyCase.caseId,
    target: "outbox",
    dryRun: false
  });

  assert.strictEqual(result.outboxResult.written, true);
  const content = JSON.parse(fs.readFileSync(result.outboxResult.path, "utf8"));
  // Stub should have caseId and idempotencyKey
  assert.ok(content.caseId, "Stub should have caseId");
  assert.ok(content.idempotencyKey, "Stub should have idempotencyKey");
  // Stub should NOT have sensitive narrative fields
  assert.strictEqual(content.rootCause, undefined, "Stub must not contain rootCause");
  assert.strictEqual(content.whyNotCaught, undefined, "Stub must not contain whyNotCaught");
  assert.strictEqual(content.blockedReason, "blocked_due_to_secrets");
});

// ─── Secret scanner: additional edge cases ──────────────────────────────────

test("scanAndRedact: Stripe secret key is detected", () => {
  const { scanAndRedact } = require("../dist/core/secret-scanner.js");
  const input = { key: "sk_live_51ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789" };
  const result = scanAndRedact(input, "internal");
  // The generic-secret rule should catch sk_live_ prefix
  const str = JSON.stringify(result.redacted);
  assert.ok(result.result.secretsFound > 0 || str.includes("REDACTED"),
    "Expected Stripe key to be detected/redacted");
});

test("scanAndRedact: JWT token is detected and redacted", () => {
  const { scanAndRedact } = require("../dist/core/secret-scanner.js");
  const input = { auth: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c" };
  const result = scanAndRedact(input, "internal");
  assert.ok(result.result.secretsFound > 0, "JWT token should be detected");
  assert.match(JSON.stringify(result.redacted), /REDACTED/);
});

test("scanAndRedact: GitHub token is detected and redacted", () => {
  const { scanAndRedact } = require("../dist/core/secret-scanner.js");
  const input = { token: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ab" };
  const result = scanAndRedact(input, "internal");
  assert.ok(result.result.secretsFound > 0, "GitHub token should be detected");
  assert.match(JSON.stringify(result.redacted), /REDACTED/);
});

test("scanAndRedact: database connection string is detected", () => {
  const { scanAndRedact } = require("../dist/core/secret-scanner.js");
  const input = { db: "postgresql://user:password@localhost:5432/mydb" };
  const result = scanAndRedact(input, "internal");
  assert.ok(result.result.secretsFound > 0, "DB connection string should be detected");
});

test("scanAndRedact: nested objects are fully scanned", () => {
  const { scanAndRedact } = require("../dist/core/secret-scanner.js");
  const input = {
    level1: {
      level2: {
        level3: { secret: "password=mysupersecret123" }
      }
    }
  };
  const result = scanAndRedact(input, "internal");
  assert.ok(result.result.secretsFound > 0, "Nested secret should be detected");
  assert.match(JSON.stringify(result.redacted), /REDACTED/);
});

test("scanAndRedact: arrays are fully scanned", () => {
  const { scanAndRedact } = require("../dist/core/secret-scanner.js");
  const input = {
    logs: ["normal log", "token=abc123secretvalue", "another normal log"]
  };
  const result = scanAndRedact(input, "internal");
  assert.ok(result.result.secretsFound > 0, "Secret in array should be detected");
});

// ─── Path policy edge cases ──────────────────────────────────────────────────

test("assertSafeId: rejects slashes", () => {
  const { assertSafeId } = require("../dist/core/path-policy.js");
  assert.throws(() => assertSafeId("../../etc/passwd"), /Unsafe id/);
  assert.throws(() => assertSafeId("a/b"), /Unsafe id/);
  assert.throws(() => assertSafeId("a\\b"), /Unsafe id/);
});

test("assertSafeId: accepts valid ids", () => {
  const { assertSafeId } = require("../dist/core/path-policy.js");
  assert.doesNotThrow(() => assertSafeId("abc123"));
  assert.doesNotThrow(() => assertSafeId("case-id_1.0"));
});

test("assertSafeRepoPath: rejects null bytes", () => {
  const { assertSafeRepoPath } = require("../dist/core/path-policy.js");
  assert.throws(() => assertSafeRepoPath("/tmp/repo\0evil"), /Unsafe repoPath/);
});

test("assertSafeRepoPath: rejects double-dot traversal", () => {
  const { assertSafeRepoPath } = require("../dist/core/path-policy.js");
  assert.throws(() => assertSafeRepoPath("/tmp/../etc"), /Unsafe repoPath/);
});

// ─── Idempotency key stability test ─────────────────────────────────────────

test("idempotencyKey is stable across two identical analyze calls", () => {
  const repoDir = initRepo();
  const params = {
    repoPath: repoDir,
    ...goodWhyCase({
      title: "Stable key test",
      rootCause: "The same root cause text should map to the same content-derived idempotency key",
      whyNotCaught: "The earlier check did not repeat the same analysis payload to prove deterministic keying",
      whyFixWorked: "The hash works because identical title and root-cause inputs produce the same SHA-256 value",
      preventNextTime: "Keep deterministic idempotency tests in CI so retry behavior cannot create duplicate cases"
    }),
    sensitivity: "internal"
  };
  const wc1 = analyzeWhyCase(params);
  const wc2 = analyzeWhyCase(params);
  assert.strictEqual(wc1.idempotencyKey, wc2.idempotencyKey,
    "idempotencyKey must be stable for identical inputs");
});

test("idempotencyKey changes when title changes", () => {
  const repoDir = initRepo();
  const base = {
    repoPath: repoDir,
    ...goodWhyCase({
      rootCause: "The idempotency key includes the title as part of the content hash input",
      whyNotCaught: "The earlier coverage did not compare two otherwise identical analyses with different titles",
      whyFixWorked: "The hash changes because the title is included in the SHA-256 idempotency input",
      preventNextTime: "Keep title-variance tests in CI so key rotation remains intentional and visible"
    }),
    sensitivity: "internal"
  };
  const wc1 = analyzeWhyCase({ ...base, title: "Title A" });
  const wc2 = analyzeWhyCase({ ...base, title: "Title B" });
  assert.notStrictEqual(wc1.idempotencyKey, wc2.idempotencyKey,
    "idempotencyKey must change when title changes");
});
