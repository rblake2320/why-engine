import fs from "fs";
import path from "path";
import { EvidenceBundle, Sensitivity, WhyCase } from "./contracts";
import { assertSafeId, assertSafeRepoPath, ensureDir, getWhyEngineRoot } from "./path-policy";
import { hashContent, scanAndRedact } from "./secret-scanner";
import { appendAuditEntry } from "./audit-chain";

export interface AnalyzeInput {
  repoPath: string;
  evidenceId?: string;
  title: string;
  rootCause: string;
  whyNotCaught: string;
  whyFixWorked: string;
  preventNextTime: string;
  generalizablePattern?: string;
  tags?: string[];
  sensitivity: Sensitivity;
  issueUrl?: string;
  prUrl?: string;
}

const SNIPPET_LENGTH = 2000;

export function analyzeWhyCase(input: AnalyzeInput): WhyCase {
  assertSafeRepoPath(input.repoPath);
  if (input.evidenceId) {
    assertSafeId(input.evidenceId);
  }
  const evidence = input.evidenceId
    ? loadEvidence(input.repoPath, input.evidenceId)
    : undefined;

  const idempotencyKey = computeIdempotencyKey(input, evidence);
  const caseId = idempotencyKey.slice(0, 32);

  const tags = dedupeTags([...(evidence?.tags ?? []), ...(input.tags ?? [])]);

  const whyCase: WhyCase = {
    caseId,
    idempotencyKey,
    createdAt: new Date().toISOString(),
    repoPath: input.repoPath,
    evidenceId: input.evidenceId,
    title: input.title,
    rootCause: input.rootCause,
    whyNotCaught: input.whyNotCaught,
    whyFixWorked: input.whyFixWorked,
    preventNextTime: input.preventNextTime,
    generalizablePattern: input.generalizablePattern,
    evidence: {
      commitRange: evidence?.commitRange,
      diffSummary: evidence?.diffSummary,
      commitMessages: evidence?.commitMessages.map((commit) => commit.message),
      fileList: evidence?.fileList,
      testOutputSnippet: snippet(evidence?.testOutput),
      errorLogSnippet: snippet(evidence?.errorLog)
    },
    tags,
    sensitivity: input.sensitivity,
    secretScanResult: { clean: true, secretsFound: 0, redactionsApplied: 0, findings: [] },
    links: {
      issueUrl: input.issueUrl,
      prUrl: input.prUrl
    }
  };

  const redacted = scanAndRedact(whyCase, input.sensitivity, { repoPath: input.repoPath });
  redacted.redacted.secretScanResult = redacted.result;
  writeWhyCase(input.repoPath, redacted.redacted);
  appendAuditEntry(input.repoPath, "why.analyze", {
    caseId: redacted.redacted.caseId,
    evidenceId: redacted.redacted.evidenceId
  });
  return redacted.redacted;
}

function loadEvidence(repoPath: string, evidenceId: string): EvidenceBundle {
  const evidencePath = path.join(getWhyEngineRoot(repoPath), "evidence", evidenceId, "evidence.json");
  if (!fs.existsSync(evidencePath)) {
    throw new Error(`evidenceId not found: ${evidenceId}`);
  }
  return JSON.parse(fs.readFileSync(evidencePath, "utf8")) as EvidenceBundle;
}

function snippet(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.length > SNIPPET_LENGTH ? value.slice(0, SNIPPET_LENGTH) : value;
}

function writeWhyCase(repoPath: string, whyCase: WhyCase): void {
  const caseDir = path.join(getWhyEngineRoot(repoPath), "cases", whyCase.caseId);
  ensureDir(caseDir);
  fs.writeFileSync(path.join(caseDir, "case.json"), JSON.stringify(whyCase, null, 2), "utf8");
}

function computeIdempotencyKey(input: AnalyzeInput, evidence?: EvidenceBundle): string {
  const repoRemote = evidence?.environment.repoRemoteUrl ?? "";
  const commitRange = evidence?.commitRange ?? "";
  const raw = `${repoRemote}|${commitRange}|${input.title}|${input.rootCause}`;
  return hashContent(raw);
}

function dedupeTags(tags: string[]): string[] {
  return Array.from(new Set(tags.map((tag) => tag.trim()).filter(Boolean)));
}
