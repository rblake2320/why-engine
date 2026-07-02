const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { atomicWriteFileSync, appendLineDurable, withLock } = require("../dist/core/durable-fs.js");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "why-durable-"));
}

test("atomicWriteFileSync writes content and leaves no temp files behind", () => {
  const dir = tmpDir();
  const target = path.join(dir, "data.json");
  atomicWriteFileSync(target, '{"a":1}');
  assert.strictEqual(fs.readFileSync(target, "utf8"), '{"a":1}');
  const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));
  assert.strictEqual(leftovers.length, 0);
});

test("atomicWriteFileSync replaces existing content fully (no partial mix)", () => {
  const dir = tmpDir();
  const target = path.join(dir, "data.json");
  atomicWriteFileSync(target, "A".repeat(10000));
  atomicWriteFileSync(target, "B");
  assert.strictEqual(fs.readFileSync(target, "utf8"), "B");
});

test("atomicWriteFileSync creates parent directories", () => {
  const dir = tmpDir();
  const target = path.join(dir, "nested", "deep", "data.json");
  atomicWriteFileSync(target, "x");
  assert.strictEqual(fs.readFileSync(target, "utf8"), "x");
});

test("appendLineDurable appends newline-terminated lines", () => {
  const dir = tmpDir();
  const target = path.join(dir, "log.jsonl");
  appendLineDurable(target, "one");
  appendLineDurable(target, "two\n");
  assert.strictEqual(fs.readFileSync(target, "utf8"), "one\ntwo\n");
});

test("withLock returns the callback result and releases the lock", () => {
  const dir = tmpDir();
  const result = withLock("test", dir, () => 42);
  assert.strictEqual(result, 42);
  assert.strictEqual(fs.existsSync(path.join(dir, "test.lock")), false);
});

test("withLock releases the lock even when the callback throws", () => {
  const dir = tmpDir();
  assert.throws(() => withLock("test", dir, () => { throw new Error("boom"); }), /boom/);
  assert.strictEqual(fs.existsSync(path.join(dir, "test.lock")), false);
});

test("withLock breaks a stale lock left by a crashed holder", () => {
  const dir = tmpDir();
  const lockDir = path.join(dir, "test.lock");
  fs.mkdirSync(lockDir, { recursive: true });
  const old = new Date(Date.now() - 120000);
  fs.utimesSync(lockDir, old, old);
  const result = withLock("test", dir, () => "recovered", { staleMs: 30000, timeoutMs: 2000 });
  assert.strictEqual(result, "recovered");
});

test("withLock times out on a fresh lock held by someone else", () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, "test.lock"), { recursive: true });
  assert.throws(
    () => withLock("test", dir, () => "never", { timeoutMs: 200, staleMs: 60000, pollMs: 20 }),
    /Timed out acquiring lock/
  );
});
