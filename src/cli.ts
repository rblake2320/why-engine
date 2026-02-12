#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { collectEvidence } from "./core/evidence-collector";
import { analyzeWhyCase } from "./core/case-builder";
import { publishWhyCase } from "./publishers/publisher";
import { getAuditLogPath, verifyAuditChain } from "./core/audit-chain";
import { Sensitivity } from "./core/contracts";

type ArgMap = Record<string, string | boolean>;

function parseArgs(argv: string[]): ArgMap {
  const args: ArgMap = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function getString(args: ArgMap, key: string): string | undefined {
  const val = args[key];
  return typeof val === "string" ? val : undefined;
}

function getBoolean(args: ArgMap, key: string, defaultValue = false): boolean {
  const val = args[key];
  if (typeof val === "boolean") {
    return val;
  }
  if (typeof val === "string") {
    return val.toLowerCase() === "true";
  }
  return defaultValue;
}

function getList(args: ArgMap, key: string): string[] | undefined {
  const val = getString(args, key);
  if (!val) {
    return undefined;
  }
  return val.split(",").map((item) => item.trim()).filter(Boolean);
}

function readMaybeFile(value?: string, filePath?: string): string | undefined {
  if (value && value.length > 0) {
    return value;
  }
  if (filePath) {
    return fs.readFileSync(filePath, "utf8");
  }
  return undefined;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command) {
    printHelp();
    process.exit(1);
  }
  const args = parseArgs(rest);

  if (command === "collect-evidence") {
    const repoPath = getString(args, "repo-path");
    if (!repoPath) {
      throw new Error("--repo-path is required");
    }
    const evidence = collectEvidence({
      repoPath,
      commitRange: getString(args, "commit-range") ?? "HEAD~1..HEAD",
      testOutput: readMaybeFile(getString(args, "test-output"), getString(args, "test-output-file")),
      errorLog: readMaybeFile(getString(args, "error-log"), getString(args, "error-log-file")),
      description: getString(args, "description"),
      tags: getList(args, "tags"),
      includeFullDiff: getBoolean(args, "include-full-diff"),
      sensitivity: (getString(args, "sensitivity") as Sensitivity | undefined) ?? "internal"
    });
    console.log(JSON.stringify(evidence, null, 2));
    return;
  }

  if (command === "analyze") {
    const repoPath = getString(args, "repo-path");
    if (!repoPath) {
      throw new Error("--repo-path is required");
    }
    const title = getString(args, "title");
    const rootCause = getString(args, "root-cause");
    const whyNotCaught = getString(args, "why-not-caught");
    const whyFixWorked = getString(args, "why-fix-worked");
    const preventNextTime = getString(args, "prevent-next-time");
    if (!title || !rootCause || !whyNotCaught || !whyFixWorked || !preventNextTime) {
      throw new Error("Missing required analysis fields");
    }
    const whyCase = analyzeWhyCase({
      repoPath,
      evidenceId: getString(args, "evidence-id"),
      title,
      rootCause,
      whyNotCaught,
      whyFixWorked,
      preventNextTime,
      generalizablePattern: getString(args, "generalizable-pattern"),
      tags: getList(args, "tags"),
      sensitivity: (getString(args, "sensitivity") as Sensitivity | undefined) ?? "internal",
      issueUrl: getString(args, "issue-url"),
      prUrl: getString(args, "pr-url")
    });
    console.log(JSON.stringify(whyCase, null, 2));
    return;
  }

  if (command === "publish") {
    const repoPath = getString(args, "repo-path");
    const caseId = getString(args, "case-id");
    if (!repoPath || !caseId) {
      throw new Error("--repo-path and --case-id are required");
    }
    const result = await publishWhyCase({
      repoPath,
      caseId,
      target: (getString(args, "target") as "api" | "outbox" | "both" | undefined) ?? "both",
      dryRun: getBoolean(args, "dry-run", true),
      problemId: getString(args, "problem-id"),
      evidenceLink: getString(args, "evidence-link"),
      forceStub: getBoolean(args, "force-stub", false),
      allowSecrets: getBoolean(args, "allow-secrets", false),
      gitleaksMode: (getString(args, "gitleaks-mode") as "block" | "warn" | "ignoreFingerprints" | undefined) ?? "block",
      keepHistory: getBoolean(args, "keep-history", false)
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "capture-and-publish") {
    const repoPath = getString(args, "repo-path");
    if (!repoPath) {
      throw new Error("--repo-path is required");
    }
    const evidence = collectEvidence({
      repoPath,
      commitRange: getString(args, "commit-range") ?? "HEAD~1..HEAD",
      testOutput: readMaybeFile(getString(args, "test-output"), getString(args, "test-output-file")),
      errorLog: readMaybeFile(getString(args, "error-log"), getString(args, "error-log-file")),
      description: getString(args, "description"),
      tags: getList(args, "tags"),
      includeFullDiff: getBoolean(args, "include-full-diff"),
      sensitivity: (getString(args, "sensitivity") as Sensitivity | undefined) ?? "internal"
    });

    const title = getString(args, "title");
    const rootCause = getString(args, "root-cause");
    const whyNotCaught = getString(args, "why-not-caught");
    const whyFixWorked = getString(args, "why-fix-worked");
    const preventNextTime = getString(args, "prevent-next-time");
    if (!title || !rootCause || !whyNotCaught || !whyFixWorked || !preventNextTime) {
      throw new Error("Missing required analysis fields");
    }

    const whyCase = analyzeWhyCase({
      repoPath,
      evidenceId: evidence.evidenceId,
      title,
      rootCause,
      whyNotCaught,
      whyFixWorked,
      preventNextTime,
      generalizablePattern: getString(args, "generalizable-pattern"),
      tags: getList(args, "tags"),
      sensitivity: (getString(args, "sensitivity") as Sensitivity | undefined) ?? "internal",
      issueUrl: getString(args, "issue-url"),
      prUrl: getString(args, "pr-url")
    });

    const result = await publishWhyCase({
      repoPath,
      caseId: whyCase.caseId,
      target: (getString(args, "target") as "api" | "outbox" | "both" | undefined) ?? "both",
      dryRun: getBoolean(args, "dry-run", true),
      problemId: getString(args, "problem-id"),
      evidenceLink: getString(args, "evidence-link"),
      forceStub: getBoolean(args, "force-stub", false),
      allowSecrets: getBoolean(args, "allow-secrets", false),
      gitleaksMode: (getString(args, "gitleaks-mode") as "block" | "warn" | "ignoreFingerprints" | undefined) ?? "block",
      keepHistory: getBoolean(args, "keep-history", false)
    });

    console.log(JSON.stringify({ evidenceId: evidence.evidenceId, caseId: whyCase.caseId, result }, null, 2));
    return;
  }

  if (command === "verify-audit-chain") {
    const repoPath = getString(args, "repo-path");
    const logPath = getString(args, "log-path") ?? (repoPath ? getAuditLogPath(repoPath) : undefined);
    if (!logPath) {
      throw new Error("--log-path or --repo-path is required");
    }
    const result = verifyAuditChain(logPath);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "start-mcp") {
    const serverPath = path.join(__dirname, "mcp", "server.js");
    if (!fs.existsSync(serverPath)) {
      throw new Error("MCP server not built. Run npm run build first.");
    }
    require(serverPath);
    return;
  }

  printHelp();
  process.exit(1);
}

function printHelp(): void {
  console.error(`why-engine CLI\n\nCommands:\n  collect-evidence\n  analyze\n  publish\n  capture-and-publish\n  verify-audit-chain\n  start-mcp\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
