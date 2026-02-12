import fs from "node:fs";
import path from "node:path";

const repo = process.argv[2] || process.cwd();
const outboxDir = path.join(repo, ".why-engine", "outbox");

function fail(message) {
  console.error("VERIFY FAIL:", message);
  process.exit(1);
}

if (!fs.existsSync(outboxDir)) {
  console.log("VERIFY: no outbox dir (ok)");
  process.exit(0);
}

const forbiddenStubKeys = new Set([
  "rootCause",
  "whyNotCaught",
  "whyFixWorked",
  "preventNextTime",
  "generalizablePattern",
  "gitDiff",
  "diff",
  "diffSummary",
  "testOutput",
  "errorLog",
  "commitMessages"
]);

const files = fs.readdirSync(outboxDir).filter((file) => file.endsWith(".json"));
for (const file of files) {
  const filePath = path.join(outboxDir, file);
  const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));

  if (!payload.idempotencyKey) {
    fail(`${file}: missing idempotencyKey`);
  }
  if (!file.startsWith(payload.idempotencyKey)) {
    fail(`${file}: filename not keyed by idempotencyKey`);
  }

  const clean = payload?.secretScanResult?.clean;
  if (clean === false) {
    for (const key of forbiddenStubKeys) {
      if (key in payload) {
        fail(`${file}: stub contains forbidden key ${key}`);
      }
    }
    if (payload.blockedReason !== "blocked_due_to_secrets") {
      fail(`${file}: missing/incorrect blockedReason`);
    }
  }
}

console.log(`VERIFY PASS: ${files.length} outbox file(s) checked`);
