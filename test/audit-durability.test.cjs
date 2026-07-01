const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  appendAuditEntry,
  verifyAuditChain,
  repairAuditChain,
  getAuditLogPath
} = require("../dist/core/audit-chain.js");

function tmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "why-audit-crash-"));
}

test("verifyAuditChain classifies a torn tail (crash mid-append) as repairable", () => {
  const repo = tmpRepo();
  appendAuditEntry(repo, "a", { n: 1 });
  appendAuditEntry(repo, "b", { n: 2 });
  const logPath = getAuditLogPath(repo);
  // Simulate crash: partial JSON line appended without newline completion.
  fs.appendFileSync(logPath, '{"timestamp":"2026-07-01T00:00:00.000Z","action":"c","pay');
  const result = verifyAuditChain(logPath);
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.tornTail, true);
  assert.strictEqual(result.repairable, true);
  assert.strictEqual(result.brokenAt, 3);
});

test("repairAuditChain quarantines the torn tail and restores a valid, appendable chain", () => {
  const repo = tmpRepo();
  appendAuditEntry(repo, "a", { n: 1 });
  appendAuditEntry(repo, "b", { n: 2 });
  const logPath = getAuditLogPath(repo);
  fs.appendFileSync(logPath, '{"broken');
  const repair = repairAuditChain(repo);
  assert.strictEqual(repair.repaired, true);
  assert.strictEqual(repair.entriesRetained, 2);
  assert.ok(fs.existsSync(repair.quarantinePath), "torn bytes must be quarantined, not deleted");
  assert.match(fs.readFileSync(repair.quarantinePath, "utf8"), /broken/);
  // Repair itself is chained on as an audit entry, and the chain verifies.
  const verdict = verifyAuditChain(logPath);
  assert.strictEqual(verdict.valid, true);
  assert.strictEqual(verdict.totalEntries, 3); // a, b, why.audit_repair
  const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
  assert.match(lines[2], /why\.audit_repair/);
  // Appends continue on the repaired chain.
  appendAuditEntry(repo, "c", { n: 3 });
  assert.strictEqual(verifyAuditChain(logPath).valid, true);
});

test("repairAuditChain refuses to touch mid-log corruption (tamper evidence preserved)", () => {
  const repo = tmpRepo();
  appendAuditEntry(repo, "a", { n: 1 });
  appendAuditEntry(repo, "b", { n: 2 });
  appendAuditEntry(repo, "c", { n: 3 });
  const logPath = getAuditLogPath(repo);
  const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
  const middle = JSON.parse(lines[1]);
  middle.payload.n = 999; // tamper
  lines[1] = JSON.stringify(middle);
  fs.writeFileSync(logPath, lines.join("\n") + "\n");
  const repair = repairAuditChain(repo);
  assert.strictEqual(repair.repaired, false);
  assert.match(repair.reason, /not repairable/);
  assert.strictEqual(verifyAuditChain(logPath).valid, false);
});

test("repairAuditChain is a no-op on a healthy chain", () => {
  const repo = tmpRepo();
  appendAuditEntry(repo, "a", { n: 1 });
  const repair = repairAuditChain(repo);
  assert.strictEqual(repair.repaired, false);
  assert.match(repair.reason, /already valid/);
});

test("appendAuditEntry self-heals a corrupt or stale head cache", () => {
  const repo = tmpRepo();
  appendAuditEntry(repo, "a", { n: 1 });
  const headPath = path.join(repo, ".why-engine", "audit.head");
  fs.writeFileSync(headPath, "not json at all");
  appendAuditEntry(repo, "b", { n: 2 });
  const logPath = getAuditLogPath(repo);
  assert.strictEqual(verifyAuditChain(logPath).valid, true);
  const head = JSON.parse(fs.readFileSync(headPath, "utf8"));
  const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
  assert.strictEqual(head.hash, JSON.parse(lines[lines.length - 1]).hash);
});

test("appendAuditEntry refuses to append onto a torn tail (no silent chain fork)", () => {
  const repo = tmpRepo();
  appendAuditEntry(repo, "a", { n: 1 });
  fs.appendFileSync(getAuditLogPath(repo), '{"torn');
  assert.throws(() => appendAuditEntry(repo, "b", { n: 2 }), /torn tail/i);
});

test("chains remain verifiable across many appends with head cache active", () => {
  const repo = tmpRepo();
  for (let i = 0; i < 50; i += 1) {
    appendAuditEntry(repo, "bulk", { i });
  }
  const result = verifyAuditChain(getAuditLogPath(repo));
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.totalEntries, 50);
});

test("pre-existing logs from v0.1.x verify unchanged (hash function compatibility)", () => {
  // Reconstruct an entry exactly the way v0.1.x computed it and verify.
  const crypto = require("node:crypto");
  const repo = tmpRepo();
  const logPath = getAuditLogPath(repo);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const e1 = { timestamp: "2026-01-01T00:00:00.000Z", action: "legacy", payload: { k: "v" }, prevHash: null };
  e1.hash = crypto.createHash("sha256").update(JSON.stringify(e1)).digest("hex");
  const e2 = { timestamp: "2026-01-02T00:00:00.000Z", action: "legacy2", payload: {}, prevHash: e1.hash };
  e2.hash = crypto
    .createHash("sha256")
    .update(JSON.stringify({ timestamp: e2.timestamp, action: e2.action, payload: e2.payload, prevHash: e2.prevHash }))
    .digest("hex");
  fs.writeFileSync(logPath, JSON.stringify(e1) + "\n" + JSON.stringify(e2) + "\n");
  const result = verifyAuditChain(logPath);
  assert.strictEqual(result.valid, true, "v0.2.0 must verify chains written by v0.1.x");
  // And new appends extend the legacy chain seamlessly.
  appendAuditEntry(repo, "modern", { ok: true });
  assert.strictEqual(verifyAuditChain(logPath).valid, true);
  assert.strictEqual(verifyAuditChain(logPath).totalEntries, 3);
});
