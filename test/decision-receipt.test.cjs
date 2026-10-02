const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  attachDecisionOutcome,
  getDecisionOutcomePath,
  getDecisionReceiptPath,
  loadDecisionReceipt,
  recordDecisionReceipt,
} = require("../dist/core/decision-receipt.js");
const { verifyAuditChain, getAuditLogPath } = require("../dist/core/audit-chain.js");

function makeRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "why-decision-test-"));
}

function makeInput(repoPath) {
  return {
    repoPath,
    occurredAt: "2026-09-20T15:00:00.000Z",
    actor: { agentId: "test-agent", runId: "run-1", stepId: "step-1" },
    trigger: { eventType: "tool.proposed", goal: "Inspect logs", requestedAction: "inspect_logs" },
    provenance: {
      stateHash: "state-abc",
      stateRef: "trace://run-1/step-1",
      stateSummary: "A read-only diagnosis is needed.",
      policyVersion: "policy-1",
      questionSetVersion: "questions-1",
      traceId: "trace-1",
      priorCaseIds: ["case-1", "case-1"],
      evidenceRefs: ["event://1"]
    },
    jev: {
      requestId: "request-1",
      requestedModel: "jev-1.13.0",
      resolvedModel: "jev-1.13.0",
      latencyMs: 120,
      inputTokens: 100,
      outputTokens: 20,
      questions: { next_action: { type: "choice" } },
      answers: { next_action: { type: "choice", choice: "inspect_logs", confidence: 0.93 } }
    },
    policy: {
      rulesEvaluated: ["read-only-actions-allowed"],
      rulesFired: ["read-only-actions-allowed"],
      vetoes: [],
      disposition: "allow"
    },
    decision: {
      selectedAction: "inspect_logs",
      candidateActions: [
        { action: "inspect_logs", status: "selected", reason: "Selected by Jev and permitted by policy" },
        { action: "halt", status: "rejected", reason: "No hard veto applied" }
      ]
    },
    explanation: {
      summary: "Inspect logs because the action is read-only and the evidence is sufficient.",
      factors: [
        {
          factorId: "jev-next-action",
          source: "jev",
          direction: "supports",
          statement: "Jev selected inspect_logs with high confidence.",
          probability: 0.93,
          evidenceRefs: ["jev://answers/next_action"]
        }
      ],
      knownUnknowns: ["The root cause is not yet established."]
    },
    sensitivity: "internal",
    reviewStatus: "machine-checked"
  };
}

test("recordDecisionReceipt writes a durable, loadable, hash-linked decision", () => {
  const repoPath = makeRepo();
  const receipt = recordDecisionReceipt(makeInput(repoPath));
  assert.strictEqual(receipt.policy.disposition, "allow");
  assert.strictEqual(receipt.provenance.priorCaseIds.length, 1);
  assert.ok(receipt.integrity.payloadHash.length >= 64);
  assert.ok(fs.existsSync(getDecisionReceiptPath(repoPath, receipt.decisionId)));
  assert.deepStrictEqual(loadDecisionReceipt(repoPath, receipt.decisionId), receipt);
  assert.strictEqual(verifyAuditChain(getAuditLogPath(repoPath)).valid, true);
});

test("recordDecisionReceipt is idempotent and rejects conflicting content", () => {
  const repoPath = makeRepo();
  const input = makeInput(repoPath);
  const first = recordDecisionReceipt(input);
  const second = recordDecisionReceipt(input);
  assert.deepStrictEqual(second, first);

  assert.throws(
    () => recordDecisionReceipt({ ...input, explanation: { ...input.explanation, summary: "Changed explanation." } }),
    /already exists with different content/
  );
});

test("recordDecisionReceipt requires evidence references for every explanation factor", () => {
  const repoPath = makeRepo();
  const input = makeInput(repoPath);
  input.explanation.factors[0].evidenceRefs = [];
  assert.throws(() => recordDecisionReceipt(input), /requires at least one evidence reference/);
});

test("attachDecisionOutcome persists an outcome and extends the audit chain", () => {
  const repoPath = makeRepo();
  const receipt = recordDecisionReceipt(makeInput(repoPath));
  const outcome = attachDecisionOutcome(repoPath, receipt.decisionId, {
    observedAt: "2026-09-20T15:01:00.000Z",
    status: "succeeded",
    summary: "The read-only inspection completed without side effects.",
    evidenceRefs: ["trace://run-1/result"]
  });
  assert.strictEqual(outcome.status, "succeeded");
  assert.ok(fs.existsSync(getDecisionOutcomePath(repoPath, receipt.decisionId)));
  assert.strictEqual(verifyAuditChain(getAuditLogPath(repoPath)).totalEntries, 2);
});
