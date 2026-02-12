const test = require("node:test");
const assert = require("node:assert");

const { assertPathUnder } = require("../dist/core/path-policy.js");

test("assertPathUnder allows child paths", () => {
  assert.doesNotThrow(() => assertPathUnder("C:/repo/root", "C:/repo/root/sub/file.txt"));
});

test("assertPathUnder rejects escape", () => {
  assert.throws(() => assertPathUnder("C:/repo/root", "C:/repo/other/file.txt"));
});
