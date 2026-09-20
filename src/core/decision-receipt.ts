import fs from "fs";
import path from "path";

import { appendAuditEntry } from "./audit-chain";
import { SecretScanResult, Sensitivity } from "./contracts";
import { atomicWriteFileSync } from "./durable-fs";
import { assertSafeId, assertSafeRepoPath, getWhyEngineRoot } from "./path-policy";
import { hashContent, scanAndRedact } from "./secret-scanner";

export type DecisionDisposition = "allow" | "block" | "review" | "defer";
export type CandidateStatus = "recommended" | "selected" | "rejected" | "vetoed" | "unavailable";
export type FactorDirection = "supports" | "opposes" | "vetoes" | "qualifies";
export type FactorSource = "observation" | "jev" | "policy" | "memory" | "outcome" | "human";
export type ReviewStatus = "unreviewed" | "machine-checked" | "human-reviewed" | "disputed";

export interface DecisionFactor {
  factorId: string;
  source: FactorSource;
  direction: FactorDirection;
  statement: string;
  probability?: number;
  evidenceRefs: string[];
}

export interface DecisionReceiptInput {
  repoPath: string;
  occurredAt?: string;
  actor: {
    agentId: string;
    runId: string;
    stepId: string;
    parentDecisionId?: string;
  };
  trigger: {
    eventType: string;
    goal: string;
    requestedAction?: string;
  };
  provenance: {
    stateHash: string;
    stateRef?: string;
    stateSummary?: string;
    policyVersion: string;
    questionSetVersion: string;
    traceId: string;
    priorCaseIds?: string[];
    evidenceRefs?: string[];
  };
  jev: {
    requestId?: string;
    requestedModel: string;
    resolvedModel: string;
    latencyMs?: number;
    inputTokens?: number;
    outputTokens?: number;
    questions: Record<string, unknown>;
    answers: Record<string, unknown>;
  };
  policy: {
    rulesEvaluated: string[];
    rulesFired: string[];
    vetoes: string[];
    disposition: DecisionDisposition;
  };
  decision: {
    recommendedAction?: string;
    selectedAction?: string;
    candidateActions: Array<{
      action: string;
      status: CandidateStatus;
      reason?: string;
    }>;
  };
  explanation: {
    summary: string;
    factors: DecisionFactor[];
    knownUnknowns: string[];
  };
  sensitivity?: Sensitivity;
  reviewStatus?: ReviewStatus;
}

export interface DecisionReceipt extends Omit<DecisionReceiptInput, "repoPath" | "occurredAt" | "sensitivity" | "reviewStatus"> {
  schemaVersion: "1.0.0";
  decisionId: string;
  occurredAt: string;
  sensitivity: Sensitivity;
  reviewStatus: ReviewStatus;
  secretScanResult: SecretScanResult;
  integrity: {
    payloadHash: string;
  };
}

export interface DecisionOutcome {
  observedAt: string;
  status: "succeeded" | "failed" | "partial" | "cancelled" | "unknown";
  summary: string;
  evidenceRefs: string[];
  metrics?: Record<string, unknown>;
}

export function recordDecisionReceipt(input: DecisionReceiptInput): DecisionReceipt {
  assertSafeRepoPath(input.repoPath);
  validateInput(input);

  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const sensitivity = input.sensitivity ?? "internal";
  const reviewStatus = input.reviewStatus ?? "machine-checked";
  const decisionId = hashContent([
    input.actor.agentId,
    input.actor.runId,
    input.actor.stepId,
    input.provenance.stateHash,
    input.provenance.policyVersion,
    input.provenance.questionSetVersion
  ].join("|")).slice(0, 32);

  const receiptWithoutIntegrity = {
    schemaVersion: "1.0.0" as const,
    decisionId,
    occurredAt,
    actor: input.actor,
    trigger: input.trigger,
    provenance: {
      ...input.provenance,
      priorCaseIds: unique(input.provenance.priorCaseIds ?? []),
      evidenceRefs: unique(input.provenance.evidenceRefs ?? [])
    },
    jev: input.jev,
    policy: {
      ...input.policy,
      rulesEvaluated: unique(input.policy.rulesEvaluated),
      rulesFired: unique(input.policy.rulesFired),
      vetoes: unique(input.policy.vetoes)
    },
    decision: input.decision,
    explanation: {
      ...input.explanation,
      factors: input.explanation.factors.map((factor) => ({
        ...factor,
        evidenceRefs: unique(factor.evidenceRefs)
      })),
      knownUnknowns: unique(input.explanation.knownUnknowns)
    },
    sensitivity,
    reviewStatus,
    secretScanResult: emptySecretScan()
  };

  const scan = scanAndRedact(receiptWithoutIntegrity, sensitivity, { repoPath: input.repoPath });
  const sanitized = JSON.parse(JSON.stringify(scan.redacted)) as typeof scan.redacted;
  sanitized.secretScanResult = JSON.parse(JSON.stringify(scan.result)) as SecretScanResult;
  const payloadHash = hashContent(JSON.stringify(sanitized));
  const receipt: DecisionReceipt = {
    ...sanitized,
    integrity: { payloadHash }
  };

  const filePath = getDecisionReceiptPath(input.repoPath, decisionId);
  if (fs.existsSync(filePath)) {
    const existing = JSON.parse(fs.readFileSync(filePath, "utf8")) as DecisionReceipt;
    if (existing.integrity?.payloadHash !== payloadHash) {
      throw new Error(`Decision ${decisionId} already exists with different content`);
    }
    return existing;
  }

  atomicWriteFileSync(filePath, JSON.stringify(receipt, null, 2));
  appendAuditEntry(input.repoPath, "why.record_decision", {
    decisionId,
    runId: receipt.actor.runId,
    stepId: receipt.actor.stepId,
    disposition: receipt.policy.disposition,
    selectedAction: receipt.decision.selectedAction,
    payloadHash
  });
  return receipt;
}

export function attachDecisionOutcome(
  repoPath: string,
  decisionId: string,
  outcome: DecisionOutcome,
  sensitivity: Sensitivity = "internal"
): DecisionOutcome {
  assertSafeRepoPath(repoPath);
  assertSafeId(decisionId);
  if (!fs.existsSync(getDecisionReceiptPath(repoPath, decisionId))) {
    throw new Error(`decisionId not found: ${decisionId}`);
  }
  if (!outcome.summary.trim()) {
    throw new Error("Outcome summary is required");
  }

  const scan = scanAndRedact(outcome, sensitivity, { repoPath });
  const filePath = getDecisionOutcomePath(repoPath, decisionId);
  atomicWriteFileSync(filePath, JSON.stringify(scan.redacted, null, 2));
  appendAuditEntry(repoPath, "why.attach_outcome", {
    decisionId,
    status: scan.redacted.status,
    outcomeHash: hashContent(JSON.stringify(scan.redacted))
  });
  return scan.redacted;
}

export function loadDecisionReceipt(repoPath: string, decisionId: string): DecisionReceipt {
  assertSafeRepoPath(repoPath);
  assertSafeId(decisionId);
  const filePath = getDecisionReceiptPath(repoPath, decisionId);
  if (!fs.existsSync(filePath)) {
    throw new Error(`decisionId not found: ${decisionId}`);
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as DecisionReceipt;
}

export function getDecisionReceiptPath(repoPath: string, decisionId: string): string {
  return path.join(getWhyEngineRoot(repoPath), "decisions", decisionId, "receipt.json");
}

export function getDecisionOutcomePath(repoPath: string, decisionId: string): string {
  return path.join(getWhyEngineRoot(repoPath), "decisions", decisionId, "outcome.json");
}

function validateInput(input: DecisionReceiptInput): void {
  const required = [
    ["agentId", input.actor.agentId],
    ["runId", input.actor.runId],
    ["stepId", input.actor.stepId],
    ["goal", input.trigger.goal],
    ["stateHash", input.provenance.stateHash],
    ["policyVersion", input.provenance.policyVersion],
    ["questionSetVersion", input.provenance.questionSetVersion],
    ["traceId", input.provenance.traceId],
    ["requestedModel", input.jev.requestedModel],
    ["resolvedModel", input.jev.resolvedModel],
    ["summary", input.explanation.summary]
  ];
  for (const [name, value] of required) {
    if (!String(value ?? "").trim()) {
      throw new Error(`${name} is required`);
    }
  }
  for (const factor of input.explanation.factors) {
    if (!factor.factorId.trim() || !factor.statement.trim()) {
      throw new Error("Every explanation factor requires factorId and statement");
    }
    if (factor.evidenceRefs.length === 0) {
      throw new Error(`Explanation factor ${factor.factorId} requires at least one evidence reference`);
    }
    if (factor.probability !== undefined && (factor.probability < 0 || factor.probability > 1)) {
      throw new Error(`Explanation factor ${factor.factorId} probability must be between 0 and 1`);
    }
  }
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0)));
}

function emptySecretScan(): SecretScanResult {
  return {
    clean: true,
    secretsFound: 0,
    redactionsApplied: 0,
    findings: []
  };
}
