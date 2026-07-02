const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const {
  appendAuditEntry,
  verifyAuditChain,
  getAuditLogPath
} = require("../dist/core/audit-chain.js");
const { withLock } = require("../dist/core/durable-fs.js");

const DIST = path.resolve(__dirname, "..", "dist");

function tmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "why-real-"));
}

// ---------------------------------------------------------------------------
// REAL cross-process concurrency: 8 actual node processes hammer the same
// audit log simultaneously. No mocks, no in-process simulation. If the
// advisory lock does not provide true cross-process mutual exclusion, the
// hash chain forks and this fails.
// ---------------------------------------------------------------------------
test("8 real processes appending concurrently produce one unbroken chain", async () => {
  const repo = tmpRepo();
  const workers = 8;
  const perWorker = 10;
  const script = `
    const { appendAuditEntry } = require(${JSON.stringify(path.join(DIST, "core", "audit-chain.js"))});
    const repo = process.argv[2];
    const worker = process.argv[3];
    for (let i = 0; i < ${perWorker}; i += 1) {
      appendAuditEntry(repo, "stress", { worker, i });
    }
  `;
  const children = [];
  for (let w = 0; w < workers; w += 1) {
    children.push(
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["-e", script, "node", repo, String(w)], {
          stdio: ["ignore", "ignore", "pipe"]
        });
        let stderr = "";
        child.stderr.on("data", (d) => { stderr += d; });
        child.on("exit", (code) =>
          code === 0 ? resolve() : reject(new Error(`worker ${w} exited ${code}: ${stderr}`))
        );
      })
    );
  }
  await Promise.all(children);
  const verdict = verifyAuditChain(getAuditLogPath(repo));
  assert.strictEqual(verdict.valid, true, `chain broken: ${JSON.stringify(verdict)}`);
  assert.strictEqual(verdict.totalEntries, workers * perWorker);
});

// ---------------------------------------------------------------------------
// REAL crash artifact: a tear exactly at the newline boundary leaves valid
// JSON with no trailing newline. The next append must NOT glue onto that
// line. Before the fix, this scenario glued two valid entries onto one line
// and the repair path then quarantined BOTH valid records.
// ---------------------------------------------------------------------------
test("append after a newline-boundary tear self-heals with zero data loss", () => {
  const repo = tmpRepo();
  appendAuditEntry(repo, "a", { n: 1 });
  const logPath = getAuditLogPath(repo);
  fs.writeFileSync(logPath, fs.readFileSync(logPath, "utf8").trimEnd()); // tear the \n off
  appendAuditEntry(repo, "b", { n: 2 });
  const verdict = verifyAuditChain(logPath);
  assert.strictEqual(verdict.valid, true, `expected self-heal, got ${JSON.stringify(verdict)}`);
  assert.strictEqual(verdict.totalEntries, 2, "both entries must survive; nothing quarantined");
  const raw = fs.readFileSync(logPath, "utf8");
  assert.strictEqual(raw.trim().split("\n").length, 2, "records must be on separate lines");
});

// ---------------------------------------------------------------------------
// Multibyte stress: an entry whose serialized line far exceeds the 64KB
// backward-scan chunk, packed with multibyte UTF-8. Before the fix, a
// character split across a chunk boundary corrupted the decoded line and
// broke prev-hash resolution.
// ---------------------------------------------------------------------------
test("tail resolution survives >64KB multibyte entries (chunk-boundary safety)", () => {
  const repo = tmpRepo();
  const big = "причина—原因—سبب—𝔴𝔥𝔶 ".repeat(6000); // ~200KB of multibyte text
  appendAuditEntry(repo, "big", { detail: big });
  appendAuditEntry(repo, "after", { ok: true }); // must resolve prevHash across the huge line
  const verdict = verifyAuditChain(getAuditLogPath(repo));
  assert.strictEqual(verdict.valid, true, JSON.stringify(verdict).slice(0, 300));
  assert.strictEqual(verdict.totalEntries, 2);
});

// ---------------------------------------------------------------------------
// Live-holder protection: a REAL child process holds the lock longer than
// staleMs. The parent must WAIT, not steal. Before the fix, mtime-only stale
// detection stole locks from any holder running longer than staleMs.
// ---------------------------------------------------------------------------
test("a live holder running past staleMs keeps its lock (no theft)", async () => {
  const dir = tmpRepo();
  const marker = path.join(dir, "critical.txt");
  const holdMs = 1200;
  const script = `
    const fs = require("node:fs");
    const { withLock } = require(${JSON.stringify(path.join(DIST, "core", "durable-fs.js"))});
    withLock("shared", process.argv[2], () => {
      fs.writeFileSync(process.argv[3], "held");
      const until = Date.now() + ${holdMs};
      while (Date.now() < until) { /* real work, real time */ }
      fs.writeFileSync(process.argv[3], "released");
    });
  `;
  const child = spawn(process.execPath, ["-e", script, "node", dir, marker], {
    stdio: ["ignore", "ignore", "inherit"]
  });
  // Wait until the child actually holds the lock.
  while (!fs.existsSync(marker)) {
    await new Promise((r) => setTimeout(r, 20));
  }
  const started = Date.now();
  // staleMs far below the hold time: theft would let us in almost instantly.
  const observed = withLock(
    "shared",
    dir,
    () => fs.readFileSync(marker, "utf8"),
    { staleMs: 150, timeoutMs: 10000, pollMs: 25 }
  );
  const waited = Date.now() - started;
  assert.strictEqual(observed, "released", "entered critical section while holder was alive");
  assert.ok(waited >= holdMs - 300, `acquired too fast (${waited}ms): lock was stolen`);
  await new Promise((resolve) => child.on("exit", resolve));
});

// ---------------------------------------------------------------------------
// Dead-holder recovery: a lock whose recorded pid no longer exists IS broken.
// Uses a real short-lived process so the pid is genuinely dead, not faked.
// ---------------------------------------------------------------------------
test("a lock abandoned by a genuinely dead process is broken and reacquired", () => {
  const dir = tmpRepo();
  const lockDir = path.join(dir, "shared.lock");
  fs.mkdirSync(lockDir, { recursive: true });
  const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  assert.strictEqual(dead.status, 0);
  fs.writeFileSync(
    path.join(lockDir, "owner.json"),
    JSON.stringify({ pid: dead.pid, acquiredAt: new Date().toISOString() })
  );
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lockDir, old, old);
  const result = withLock("shared", dir, () => "recovered", { staleMs: 1000, timeoutMs: 3000 });
  assert.strictEqual(result, "recovered");
});
