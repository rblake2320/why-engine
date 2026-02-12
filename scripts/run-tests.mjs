import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const testDir = path.join(root, "test");

function collectTests(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTests(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".test.cjs")) {
      files.push(fullPath);
    }
  }
  return files;
}

const testFiles = collectTests(testDir);
if (testFiles.length === 0) {
  console.log("No test files found.");
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...testFiles], {
  stdio: "inherit"
});

process.exit(result.status ?? 1);
