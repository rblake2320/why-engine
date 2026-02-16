import fs from "fs";
import path from "path";
import { PublishResult, PublishTarget, WhyCase } from "../core/contracts";
import { assertSafeId, assertSafeRepoPath, getWhyEngineRoot, ensureDir } from "../core/path-policy";
import { hashContent, scanAndRedact } from "../core/secret-scanner";
import { appendAuditEntry } from "../core/audit-chain";
import { AihangoutClient } from "./api-client";

export interface PublishInput {
  repoPath: string;
  caseId: string;
  target: PublishTarget;
  dryRun: boolean;
  problemId?: string;
  evidenceLink?: string;
  forceStub?: boolean;
  allowSecrets?: boolean;
  gitleaksMode?: "block" | "warn" | "ignoreFingerprints";
  keepHistory?: boolean;
}

export async function publishWhyCase(input: PublishInput): Promise<PublishResult> {
  assertSafeRepoPath(input.repoPath);
  assertSafeId(input.caseId);
  const caseFile = getCasePath(input.repoPath, input.caseId);
  if (!fs.existsSync(caseFile)) {
    throw new Error(`caseId not found: ${input.caseId}`);
  }

  const loaded = JSON.parse(fs.readFileSync(caseFile, "utf8")) as WhyCase;
  const scan = scanAndRedact(loaded, loaded.sensitivity, { repoPath: input.repoPath });
  const redactedCase = scan.redacted as WhyCase;
  const evidenceScan = loadEvidenceSecretScan(input.repoPath, loaded.evidenceId);
  const mergedScan = mergeSecretScan(scan.result, loaded.secretScanResult, evidenceScan);
  redactedCase.secretScanResult = mergedScan;

  const allowSecrets = input.allowSecrets === true;
  const previousSecrets = mergedScan.secretsFound;
  const regexFindings = mergedScan.findings.length;
  const gitleaksTotal = mergedScan.gitleaksFindings ?? 0;
  const gitleaksUnallowlisted = mergedScan.gitleaksSummary?.unallowlistedCount ?? gitleaksTotal;
  const hasSecrets = previousSecrets > 0 || regexFindings > 0 || gitleaksTotal > 0;
  const mode = input.gitleaksMode ?? "block";

  const result: PublishResult = {
    caseId: input.caseId,
    idempotencyKey: redactedCase.idempotencyKey,
    target: input.target,
    dryRun: input.dryRun,
    secretScanResult: mergedScan
  };

  if (input.dryRun) {
    appendAuditEntry(input.repoPath, "why.publish.dry_run", {
      caseId: input.caseId,
      target: input.target
    });
    return result;
  }

  const ledger = readPublishedLedger(input.repoPath, redactedCase.idempotencyKey);
  if (ledger && !input.forceStub) {
    const includeApiResult = input.target === "api" || input.target === "both";
    return {
      ...result,
      ...(includeApiResult
        ? {
            apiResult: {
              success: true,
              problemId: ledger.problemId,
              solutionId: ledger.solutionId,
              url: ledger.url
            }
          }
        : {}),
      deduped: true,
      dedupeSource: "ledger",
      previousPublish: {
        problemId: ledger.problemId,
        solutionId: ledger.solutionId,
        url: ledger.url,
        publishedAt: ledger.timestamp
      }
    };
  }

  const shouldWriteOutbox = input.target === "outbox" || input.target === "both";
  const blockedByRestricted = redactedCase.sensitivity === "restricted" && hasSecrets;
  const shouldWriteStub = hasSecrets || gitleaksUnallowlisted > 0;
  const allowOutboxFull = !shouldWriteStub;
  if (blockedByRestricted) {
    result.blockedReason = "Restricted case contains secrets after redaction; publish blocked";
  }

  const outboxResult = shouldWriteOutbox
    ? writeOutbox(input.repoPath, redactedCase, {
        forceStub: input.forceStub === true,
        stubOnly: shouldWriteStub,
        keepHistory: input.keepHistory === true
      })
    : undefined;

  result.outboxResult = outboxResult;

  if (input.target === "api" || input.target === "both") {
    const apiBlockedByGitleaks =
      mode === "block" ? gitleaksTotal > 0 : gitleaksUnallowlisted > 0;
    const apiBlockedBySecrets = previousSecrets > 0 || regexFindings > 0 || apiBlockedByGitleaks;

    if (blockedByRestricted) {
      result.apiResult = {
        success: false,
        error: result.blockedReason
      };
    } else if (!allowSecrets && apiBlockedBySecrets) {
      result.apiResult = {
        success: false,
        error: "Secrets found after redaction; API publish blocked"
      };
    } else {
      const client = new AihangoutClient();
      const evidenceHash = getEvidenceHash(input.repoPath, redactedCase.evidenceId);
      result.apiResult = await retryPublish(() =>
        client.publishWhyCase(redactedCase, {
          problemId: input.problemId,
          idempotencyKey: redactedCase.idempotencyKey,
          evidenceLink: input.evidenceLink,
          evidenceHash
        })
      );

      if (result.apiResult.success && result.apiResult.problemId) {
        writePublishedLedger(input.repoPath, redactedCase, result.apiResult, hashContent(JSON.stringify(redactedCase)));
      }
    }
  }

  appendAuditEntry(input.repoPath, "why.publish", {
    caseId: input.caseId,
    target: input.target,
    dryRun: input.dryRun,
    apiSuccess: result.apiResult?.success ?? false,
    outboxWritten: result.outboxResult?.written ?? false
  });

  return result;
}

function getCasePath(repoPath: string, caseId: string): string {
  return path.join(getWhyEngineRoot(repoPath), "cases", caseId, "case.json");
}

function getPublishedPath(repoPath: string, idempotencyKey: string): string {
  const dir = path.join(getWhyEngineRoot(repoPath), "published");
  ensureDir(dir);
  return path.join(dir, `${idempotencyKey}.json`);
}

function readPublishedLedger(repoPath: string, idempotencyKey: string): {
  problemId: string;
  solutionId?: string;
  url?: string;
  timestamp: string;
  payloadHash: string;
} | null {
  const ledgerPath = getPublishedPath(repoPath, idempotencyKey);
  if (!fs.existsSync(ledgerPath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
}

function writePublishedLedger(
  repoPath: string,
  whyCase: WhyCase,
  apiResult: { problemId?: string; solutionId?: string; url?: string } | undefined,
  payloadHash: string
): void {
  const ledgerPath = getPublishedPath(repoPath, whyCase.idempotencyKey);
  if (fs.existsSync(ledgerPath)) {
    return;
  }
  const payload = {
    problemId: apiResult?.problemId,
    solutionId: apiResult?.solutionId,
    url: apiResult?.url,
    timestamp: new Date().toISOString(),
    payloadHash
  };
  fs.writeFileSync(ledgerPath, JSON.stringify(payload, null, 2), "utf8");
}

function writeOutbox(
  repoPath: string,
  whyCase: WhyCase,
  options: { forceStub: boolean; stubOnly: boolean; keepHistory: boolean }
) {
  const outboxDir = path.join(getWhyEngineRoot(repoPath), "outbox");
  ensureDir(outboxDir);
  const basePath = path.join(outboxDir, `${whyCase.idempotencyKey}.json`);
  if (fs.existsSync(basePath) && !options.forceStub) {
    return { written: false, path: basePath };
  }

  const outboxPath = basePath;

  const payload = options.stubOnly || options.forceStub
    ? buildStubRecord(repoPath, whyCase)
    : whyCase;

  fs.writeFileSync(outboxPath, JSON.stringify(payload, null, 2), "utf8");
  if (options.keepHistory) {
    const historyDir = path.join(outboxDir, "history");
    ensureDir(historyDir);
    const historyPath = path.join(historyDir, `${whyCase.idempotencyKey}-${Date.now()}.json`);
    fs.writeFileSync(historyPath, JSON.stringify(payload, null, 2), "utf8");
  }
  return { written: true, path: outboxPath };
}

function buildStubRecord(repoPath: string, whyCase: WhyCase) {
  const evidenceHash = getEvidenceHash(repoPath, whyCase.evidenceId);
  const evidenceMeta = loadEvidenceMetadata(repoPath, whyCase.evidenceId);
  const remoteHost = evidenceMeta?.repoRemoteUrl
    ? sanitizeRemoteHost(evidenceMeta.repoRemoteUrl)
    : undefined;
  const secretSummary = summarizeSecretScan(whyCase.secretScanResult);
  return {
    caseId: whyCase.caseId,
    idempotencyKey: whyCase.idempotencyKey,
    createdAt: whyCase.createdAt,
    repo: {
      repoPath: whyCase.repoPath,
      remote: remoteHost,
      branch: evidenceMeta?.branch,
      commitRange: whyCase.evidence.commitRange
    },
    evidenceHash,
    payloadHash: hashContent(JSON.stringify(whyCase)),
    secretScanResult: secretSummary,
    blockedReason: "blocked_due_to_secrets",
    sensitivity: whyCase.sensitivity
  };
}

function loadEvidenceSecretScan(repoPath: string, evidenceId?: string) {
  if (!evidenceId) {
    return undefined;
  }
  const evidencePath = path.join(getWhyEngineRoot(repoPath), "evidence", evidenceId, "evidence.json");
  if (!fs.existsSync(evidencePath)) {
    return undefined;
  }
  const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8")) as { secretScanResult?: WhyCase["secretScanResult"] };
  return evidence.secretScanResult;
}

function mergeSecretScan(
  current: WhyCase["secretScanResult"],
  previous?: WhyCase["secretScanResult"],
  evidence?: WhyCase["secretScanResult"]
): WhyCase["secretScanResult"] {
  const results = [current, previous, evidence].filter(Boolean) as WhyCase["secretScanResult"][];
  const secretsFound = Math.max(...results.map((r) => r.secretsFound));
  const redactionsApplied = Math.max(...results.map((r) => r.redactionsApplied));
  const gitleaksFindings = Math.max(...results.map((r) => r.gitleaksFindings ?? 0));
  const gitleaksRan = results.some((r) => r.gitleaksRan);
  const summaries = results
    .map((r) => r.gitleaksSummary)
    .filter((value): value is NonNullable<WhyCase["secretScanResult"]["gitleaksSummary"]> => Boolean(value));
  const gitleaksSummary = mergeGitleaksSummaries(summaries);
  const findings = current.findings;
  const clean = results.every((r) => r.clean) && gitleaksFindings === 0 && secretsFound === 0;
  return {
    clean,
    secretsFound,
    redactionsApplied,
    findings,
    gitleaksRan,
    gitleaksFindings,
    gitleaksSummary
  };
}

function mergeGitleaksSummaries(
  summaries: Array<NonNullable<WhyCase["secretScanResult"]["gitleaksSummary"]>>
): WhyCase["secretScanResult"]["gitleaksSummary"] | undefined {
  if (summaries.length === 0) {
    return undefined;
  }
  const rules = new Set<string>();
  const files = new Set<string>();
  const fingerprints = new Set<string>();
  let count = 0;
  let allowlistedCount = 0;
  let unallowlistedCount = 0;
  for (const summary of summaries) {
    count = Math.max(count, summary.count ?? 0);
    allowlistedCount = Math.max(allowlistedCount, summary.allowlistedCount ?? 0);
    unallowlistedCount = Math.max(unallowlistedCount, summary.unallowlistedCount ?? 0);
    summary.rules?.forEach((rule) => rules.add(rule));
    summary.files?.forEach((file) => files.add(file));
    summary.fingerprints?.forEach((fp) => fingerprints.add(fp));
  }
  return {
    count,
    rules: Array.from(rules),
    files: Array.from(files),
    fingerprints: Array.from(fingerprints),
    allowlistedCount,
    unallowlistedCount
  };
}

function getEvidenceHash(repoPath: string, evidenceId?: string): string | undefined {
  if (!evidenceId) {
    return undefined;
  }
  const evidencePath = path.join(getWhyEngineRoot(repoPath), "evidence", evidenceId, "evidence.json");
  if (!fs.existsSync(evidencePath)) {
    return undefined;
  }
  const content = fs.readFileSync(evidencePath, "utf8");
  return hashContent(content);
}

function loadEvidenceMetadata(repoPath: string, evidenceId?: string) {
  if (!evidenceId) {
    return undefined;
  }
  const evidencePath = path.join(getWhyEngineRoot(repoPath), "evidence", evidenceId, "evidence.json");
  if (!fs.existsSync(evidencePath)) {
    return undefined;
  }
  const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8")) as {
    environment?: { branch?: string; repoRemoteUrl?: string };
  };
  return {
    branch: evidence.environment?.branch,
    repoRemoteUrl: evidence.environment?.repoRemoteUrl
  };
}

function sanitizeRemoteHost(remoteUrl: string): string | undefined {
  try {
    const parsed = new URL(remoteUrl);
    return parsed.hostname;
  } catch {
    return undefined;
  }
}

function summarizeSecretScan(secretScan: WhyCase["secretScanResult"]) {
  const ruleIds = new Set<string>();
  const files = new Set<string>();
  const fingerprintPrefixes = new Set<string>();

  secretScan.findings.forEach((finding) => {
    ruleIds.add(finding.ruleId);
  });

  const summary = secretScan.gitleaksSummary;
  summary?.rules?.forEach((rule) => ruleIds.add(rule));
  summary?.files?.forEach((file) => files.add(path.basename(file)));
  summary?.fingerprints?.forEach((fingerprint) => fingerprintPrefixes.add(fingerprint.slice(0, 6)));

  return {
    clean: secretScan.clean,
    secretsFound: secretScan.secretsFound,
    redactionsApplied: secretScan.redactionsApplied,
    gitleaksFindings: secretScan.gitleaksFindings ?? 0,
    gitleaksSummary: {
      count: summary?.count ?? 0,
      ruleIds: Array.from(ruleIds),
      files: Array.from(files),
      fingerprintPrefixes: Array.from(fingerprintPrefixes),
      allowlistedCount: summary?.allowlistedCount ?? 0,
      unallowlistedCount: summary?.unallowlistedCount ?? 0
    }
  };
}

async function retryPublish<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw lastError;
}
