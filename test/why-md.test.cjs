"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

const { analyzeWhyCase } = require("../dist/core/case-builder.js");
const { publishWhyCase } = require("../dist/publishers/publisher.js");
const { promoteToWhyMd } = require("../dist/commands/promote-why.js");
const { runQualityGate } = require("../dist/core/quality-gate.js");

const CLI_BIN = path.resolve(__dirname, "../dist/cli.js");

function initRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "why-md-"));
  spawnSync("git", ["init"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "init.txt"), "init", "utf8");
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-m", "initial commit"], { cwd: dir });
  return dir;
}

function goodCase(overrides = {}) {
  return {
    title: "Quality gate behavior",
    rootCause: "The earlier workflow allowed placeholder prose to be persisted as if it were useful root-cause intelligence",
    whyNotCaught: "The schema validated strings structurally but did not check whether the text explained a real cause",
    whyFixWorked: "The gate works because it rejects low-effort phrases before writeWhyCase can persist the record",
    preventNextTime: "Keep quality-gate regression tests in CI so placeholder prose cannot enter the case store",
    generalizablePattern: "Semantic records need a quality gate before durable storage, not only structural validation",
    sensitivity: "public",
    ...overrides
  };
}

test("quality gate rejects low-effort prose before a case is written", () => {
  const repoDir = initRepo();
  assert.throws(
    () =>
      analyzeWhyCase({
        repoPath: repoDir,
        title: "Bad",
        rootCause: "bug",
        whyNotCaught: "no test",
        whyFixWorked: "fixed it",
        preventNextTime: "todo",
        sensitivity: "public"
      }),
    /Quality gate failed/
  );
  assert.strictEqual(fs.existsSync(path.join(repoDir, ".why-engine", "cases")), false);
});

test("quality gate scores meaningful prose high enough for promotion", () => {
  const result = runQualityGate(goodCase());
  assert.strictEqual(result.passed, true);
  assert.ok(result.score >= 70, `expected score >= 70, got ${result.score}`);
});

test("content classifier blocks high-risk prose from API publish", async () => {
  const repoDir = initRepo();
  const whyCase = analyzeWhyCase(
    goodCase({
      repoPath: repoDir,
      rootCause: "The IL6 auth proxy failed open when the timeout branch returned a permissive decision",
      whyFixWorked: "The fix works because it blocks the timeout branch before a permissive decision can be returned"
    })
  );

  const result = await publishWhyCase({
    repoPath: repoDir,
    caseId: whyCase.caseId,
    target: "api",
    dryRun: false
  });

  assert.strictEqual(result.contentClassification.level, "HIGH");
  assert.strictEqual(result.apiResult.success, false);
  assert.match(result.apiResult.error, /Content classifier blocked API publish/);
});

test("promote-why dry-run reports qualifying public cases without writing WHY.md", () => {
  const repoDir = initRepo();
  const whyCase = analyzeWhyCase(goodCase({ repoPath: repoDir, title: "Promotable case" }));

  const result = promoteToWhyMd({ repoPath: repoDir });

  assert.strictEqual(result.dryRun, true);
  assert.deepStrictEqual(result.promoted.map((item) => item.caseId), [whyCase.caseId]);
  assert.strictEqual(fs.existsSync(path.join(repoDir, "WHY.md")), false);
});

test("promote-why writes Fix Intelligence entries only for qualifying cases", () => {
  const repoDir = initRepo();
  const publicCase = analyzeWhyCase(goodCase({ repoPath: repoDir, title: "Public promotable case" }));
  analyzeWhyCase(goodCase({
    repoPath: repoDir,
    title: "Internal case should stay private",
    sensitivity: "internal"
  }));

  const result = promoteToWhyMd({ repoPath: repoDir, dryRun: false });
  const whyMd = fs.readFileSync(path.join(repoDir, "WHY.md"), "utf8");

  assert.strictEqual(result.written, true);
  assert.strictEqual(result.promoted.length, 1);
  assert.match(whyMd, new RegExp(`\\[CASE-${publicCase.caseId}\\]`));
  assert.doesNotMatch(whyMd, /Internal case should stay private/);
});

test("CLI promote-why is dry-run by default", () => {
  const repoDir = initRepo();
  analyzeWhyCase(goodCase({ repoPath: repoDir, title: "CLI promotable case" }));
  const r = spawnSync(process.execPath, [CLI_BIN, "promote-why", "--repo-path", repoDir], {
    encoding: "utf8"
  });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /promote-why dry-run/);
  assert.strictEqual(fs.existsSync(path.join(repoDir, "WHY.md")), false);
});
