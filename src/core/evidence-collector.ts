import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { EvidenceBundle, EnvironmentInfo, Sensitivity } from "./contracts";
import { assertSafeRepoPath, ensureDir, getWhyEngineRoot } from "./path-policy";
import { hashContent, scanAndRedact } from "./secret-scanner";
import { appendAuditEntry } from "./audit-chain";

export interface CollectEvidenceInput {
  repoPath: string;
  commitRange: string;
  testOutput?: string;
  testOutputPath?: string;
  errorLog?: string;
  errorLogPath?: string;
  description?: string;
  tags?: string[];
  includeFullDiff?: boolean;
  sensitivity?: Sensitivity;
}

const MAX_LOG_CHARS = 200_000;
const MAX_FULL_DIFF_CHARS = 250_000;

export function collectEvidence(input: CollectEvidenceInput): EvidenceBundle {
  assertSafeRepoPath(input.repoPath);
  assertGitRepo(input.repoPath);
  const commitRange = input.commitRange || "HEAD~1..HEAD";
  const includeFullDiff = input.includeFullDiff === true;
  const sensitivity = input.sensitivity ?? "internal";

  const diffSummary = runGit(input.repoPath, ["diff", "--stat", commitRange]).trim();
  const diffStat = runGit(input.repoPath, ["diff", "--shortstat", commitRange]).trim();
  const fileList = runGit(input.repoPath, ["diff", "--name-only", commitRange])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const { filesChanged, insertions, deletions } = parseShortStat(diffStat);
  const fullDiffRaw = includeFullDiff && sensitivity !== "public"
    ? runGit(input.repoPath, ["diff", commitRange])
    : undefined;
  const fullDiffHash = fullDiffRaw ? hashContent(fullDiffRaw) : undefined;
  const fullDiffTruncated = fullDiffRaw ? fullDiffRaw.length > MAX_FULL_DIFF_CHARS : undefined;
  const fullDiff = fullDiffRaw
    ? fullDiffRaw.slice(0, MAX_FULL_DIFF_CHARS)
    : undefined;

  const commitMessages = collectCommitInfo(input.repoPath, commitRange);
  const environment = collectEnvironment(input.repoPath);

  const testOutputRaw = resolveInputText(input.testOutput, input.testOutputPath);
  const errorLogRaw = resolveInputText(input.errorLog, input.errorLogPath);

  const testOutput = testOutputRaw ? truncateText(testOutputRaw) : undefined;
  const testOutputHash = testOutputRaw ? hashContent(testOutputRaw) : undefined;
  const testOutputTruncated = testOutputRaw ? testOutputRaw.length > MAX_LOG_CHARS : undefined;

  const errorLog = errorLogRaw ? truncateText(errorLogRaw) : undefined;
  const errorLogHash = errorLogRaw ? hashContent(errorLogRaw) : undefined;
  const errorLogTruncated = errorLogRaw ? errorLogRaw.length > MAX_LOG_CHARS : undefined;

  const evidence: EvidenceBundle = {
    evidenceId: generateEvidenceId(commitRange, input.repoPath),
    repoPath: input.repoPath,
    collectedAt: new Date().toISOString(),
    commitRange,
    diffSummary,
    diffStat,
    filesChanged,
    insertions,
    deletions,
    fileList,
    fullDiff,
    fullDiffHash,
    fullDiffTruncated,
    commitMessages,
    testOutput,
    testOutputHash,
    testOutputTruncated,
    errorLog,
    errorLogHash,
    errorLogTruncated,
    description: input.description,
    environment,
    secretScanResult: { clean: true, secretsFound: 0, redactionsApplied: 0, findings: [] },
    tags: input.tags
  };

  const redacted = scanAndRedact(evidence, sensitivity, { repoPath: input.repoPath });
  redacted.redacted.secretScanResult = redacted.result;
  writeEvidenceBundle(input.repoPath, redacted.redacted);
  appendAuditEntry(input.repoPath, "why.collect_evidence", {
    evidenceId: redacted.redacted.evidenceId,
    commitRange: redacted.redacted.commitRange,
    includeFullDiff
  });
  return redacted.redacted;
}

function resolveInputText(value?: string, filePath?: string): string | undefined {
  if (value && value.trim().length > 0) {
    return value;
  }
  if (filePath) {
    return fs.readFileSync(filePath, "utf8");
  }
  return undefined;
}

function truncateText(value: string): string {
  if (value.length <= MAX_LOG_CHARS) {
    return value;
  }
  return value.slice(0, MAX_LOG_CHARS);
}

function parseShortStat(text: string): { filesChanged: number; insertions: number; deletions: number } {
  const filesMatch = text.match(/(\d+) files? changed/);
  const insertMatch = text.match(/(\d+) insertions?\(\+\)/);
  const deleteMatch = text.match(/(\d+) deletions?\(-\)/);
  return {
    filesChanged: filesMatch ? Number(filesMatch[1]) : 0,
    insertions: insertMatch ? Number(insertMatch[1]) : 0,
    deletions: deleteMatch ? Number(deleteMatch[1]) : 0
  };
}

function collectCommitInfo(repoPath: string, commitRange: string) {
  const hashes = runGit(repoPath, ["log", "--pretty=format:%H", commitRange])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return hashes.map((hash) => {
    const header = runGit(repoPath, ["show", "-s", "--format=%H|%an|%ad|%s", "--date=iso", hash]).trim();
    const [commitHash, author, date, message] = header.split("|");
    const numstat = runGit(repoPath, ["show", "--numstat", "--format=", hash])
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    let filesChanged = 0;
    let insertions = 0;
    let deletions = 0;
    for (const line of numstat) {
      const [ins, del] = line.split("\t");
      if (!ins || !del) {
        continue;
      }
      filesChanged += 1;
      insertions += Number(ins) || 0;
      deletions += Number(del) || 0;
    }

    return {
      hash: commitHash,
      author,
      date,
      message,
      filesChanged,
      insertions,
      deletions
    };
  });
}

function collectEnvironment(repoPath: string): EnvironmentInfo {
  const gitVersion = runGit(repoPath, ["--version"]).trim();
  const branch = runGit(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  const repoCommitHash = runGit(repoPath, ["rev-parse", "HEAD"]).trim();
  let repoRemoteUrl = "";
  try {
    repoRemoteUrl = runGit(repoPath, ["remote", "get-url", "origin"]).trim();
  } catch {
    repoRemoteUrl = "";
  }

  return {
    os: `${process.platform} ${process.arch}`,
    nodeVersion: process.version,
    gitVersion,
    branch,
    repoCommitHash,
    repoRemoteUrl: sanitizeRemoteUrl(repoRemoteUrl) || undefined
  };
}

function sanitizeRemoteUrl(url: string): string {
  if (!url) {
    return "";
  }
  return url.replace(/(https?:\/\/)([^@]+)@/i, "$1");
}

function runGit(repoPath: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: repoPath, encoding: "utf8" });
  if (result.status !== 0) {
    const error = result.stderr || result.stdout || "git command failed";
    throw new Error(error.trim());
  }
  return result.stdout || "";
}

function assertGitRepo(repoPath: string): void {
  if (!fs.existsSync(path.join(repoPath, ".git"))) {
    throw new Error("repoPath is not a git repository");
  }
}

function generateEvidenceId(commitRange: string, repoPath: string): string {
  const raw = `${commitRange}|${repoPath}|${Date.now()}|${Math.random()}`;
  return hashContent(raw).slice(0, 24);
}

function writeEvidenceBundle(repoPath: string, evidence: EvidenceBundle, overridePath?: string): string {
  const root = getWhyEngineRoot(repoPath);
  const dir = path.join(root, "evidence", evidence.evidenceId);
  ensureDir(dir);
  const filePath = overridePath ?? path.join(dir, "evidence.json");
  fs.writeFileSync(filePath, JSON.stringify(evidence, null, 2), "utf8");
  return filePath;
}
