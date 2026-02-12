const test = require("node:test");
const assert = require("node:assert");

const { scanAndRedact } = require("../dist/core/secret-scanner.js");

test("scanAndRedact redacts tokens", () => {
  const input = { token: "Bearer abc123" };
  const result = scanAndRedact(input, "internal");
  assert.strictEqual(result.result.secretsFound > 0, true);
  assert.match(JSON.stringify(result.redacted), /REDACTED/);
});

test("scanAndRedact public redacts emails", () => {
  const input = { email: "john.doe@example.com", ip: "10.1.2.3", url: "https://example.com/path" };
  const result = scanAndRedact(input, "public");
  const output = JSON.stringify(result.redacted);
  assert.match(output, /@redacted/);
  assert.match(output, /\[REDACTED_IP\]/);
  assert.match(output, /\[REDACTED_HOST\]/);
});
