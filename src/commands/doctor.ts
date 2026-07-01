import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { getWhyEngineRoot, assertSafeRepoPath } from "../core/path-policy";
import { getAuditLogPath, repairAuditChain, verifyAuditChain } from "../core/audit-chain";
import { loadAllCases } from "../core/recall";
import { WhyCase } from "../core/contracts";

export interface DoctorInput {
  repoPath: string;
  /** Attempt safe repairs (torn audit tail quarantine). Default false. */
  fix?: boolean;
}

export type CheckStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorResult {
  healthy: boolean;
  checks: DoctorCheck[];
  repaired?: { quarantinePath?: string; entriesRetained?: number };
}

const REQUIRED_CASE_FIELDS: Array<keyof WhyCase> = [
  "caseId",
  "idempotencyKey",
  "title",
  "rootCause",
  "whyNotCaught",
  "whyFixWorked",
  "preventNextTime",
  "sensitivity"
];

export function runDoctor(input: DoctorInput): DoctorResult {
  assertSafeRepoPath(input.repoPath);
  const checks: DoctorCheck[] = [];
  const root = getWhyEngineRoot(input.repoPath);
  let repaired: DoctorResult["repaired"];

  // 1. Store exists
  if (!fs.existsSync(root)) {
    checks.push({
      name: "store",
      status: "warn",
      detail: ".why-engine store not initialized yet (created on first capture)"
    });
    return { healthy: true, checks };
  }
  checks.push({ name: "store", status: "pass", detail: root });

  // 2. Audit chain integrity (+ optional torn-tail repair)
  const logPath = getAuditLogPath(input.repoPath);
  let audit = verifyAuditChain(logPath);
  if (!audit.valid && audit.tornTail && input.fix) {
    const repair = repairAuditChain(input.repoPath);
    if (repair.repaired) {
      repaired = { quarantinePath: repair.quarantinePath, entriesRetained: repair.entriesRetained };
      audit = verifyAuditChain(logPath);
      checks.push({
        name: "audit.repair",
        status: "warn",
        detail: `torn tail quarantined to ${repair.quarantinePath}; ${repair.entriesRetained} entries retained`
      });
    }
  }
  if (audit.valid) {
    checks.push({ name: "audit.chain", status: "pass", detail: `${audit.totalEntries} entries, chain intact` });
  } else {
    checks.push({
      name: "audit.chain",
      status: "fail",
      detail: `broken at entry ${audit.brokenAt}: ${audit.brokenReason}${audit.repairable ? " (repairable with --fix)" : ""}`
    });
  }

  // 3. Audit head cache consistency
  const headPath = path.join(root, "audit.head");
  if (fs.existsSync(headPath) && fs.existsSync(logPath)) {
    try {
      const head = JSON.parse(fs.readFileSync(headPath, "utf8")) as { hash?: string };
      const lines = fs.readFileSync(logPath, "utf8").split("\n").filter((l) => l.trim() !== "");
      const lastHash = lines.length > 0 ? (JSON.parse(lines[lines.length - 1]) as { hash?: string }).hash : undefined;
      if (head.hash === lastHash) {
        checks.push({ name: "audit.head", status: "pass", detail: "head cache matches log tail" });
      } else {
        checks.push({
          name: "audit.head",
          status: "warn",
          detail: "head cache drifted from log tail (self-heals on next append)"
        });
      }
    } catch {
      checks.push({ name: "audit.head", status: "warn", detail: "head cache unreadable (self-heals on next append)" });
    }
  }

  // 4. Case files: parseable + required fields present
  const casesDir = path.join(root, "cases");
  let caseDirs: string[] = [];
  if (fs.existsSync(casesDir)) {
    caseDirs = fs.readdirSync(casesDir).filter((entry) => fs.existsSync(path.join(casesDir, entry, "case.json")));
  }
  const parsedCases = loadAllCases(input.repoPath);
  const unparseable = caseDirs.length - parsedCases.length;
  if (unparseable > 0) {
    checks.push({ name: "cases.parse", status: "fail", detail: `${unparseable} of ${caseDirs.length} case files unparseable` });
  } else {
    checks.push({ name: "cases.parse", status: "pass", detail: `${parsedCases.length} case file(s) parse cleanly` });
  }
  const incomplete = parsedCases.filter((c) =>
    REQUIRED_CASE_FIELDS.some((field) => c[field] === undefined || c[field] === null || c[field] === "")
  );
  if (incomplete.length > 0) {
    checks.push({
      name: "cases.schema",
      status: "fail",
      detail: `${incomplete.length} case(s) missing required fields: ${incomplete.map((c) => c.caseId).join(", ")}`
    });
  } else if (parsedCases.length > 0) {
    checks.push({ name: "cases.schema", status: "pass", detail: "all cases carry required fields" });
  }

  // 5. Ledger ↔ case referential integrity
  const publishedDir = path.join(root, "published");
  if (fs.existsSync(publishedDir)) {
    const keys = new Set(parsedCases.map((c) => c.idempotencyKey));
    const orphans: string[] = [];
    for (const entry of fs.readdirSync(publishedDir)) {
      if (!entry.endsWith(".json")) {
        continue;
      }
      const key = entry.replace(/\.json$/, "");
      if (!keys.has(key)) {
        orphans.push(key.slice(0, 12));
      }
    }
    if (orphans.length > 0) {
      checks.push({
        name: "ledger.orphans",
        status: "warn",
        detail: `${orphans.length} ledger entr(ies) without a local case: ${orphans.join(", ")}`
      });
    } else {
      checks.push({ name: "ledger.orphans", status: "pass", detail: "every ledger entry maps to a local case" });
    }
  }

  // 6. Outbox files parse
  const outboxDir = path.join(root, "outbox");
  if (fs.existsSync(outboxDir)) {
    let bad = 0;
    let total = 0;
    for (const entry of fs.readdirSync(outboxDir)) {
      if (!entry.endsWith(".json")) {
        continue;
      }
      total += 1;
      try {
        JSON.parse(fs.readFileSync(path.join(outboxDir, entry), "utf8"));
      } catch {
        bad += 1;
      }
    }
    checks.push(
      bad > 0
        ? { name: "outbox.parse", status: "fail", detail: `${bad} of ${total} outbox file(s) unparseable` }
        : { name: "outbox.parse", status: "pass", detail: `${total} outbox file(s) parse cleanly` }
    );
  }

  // 7. Stale locks
  const staleLocks = fs
    .readdirSync(root)
    .filter((entry) => entry.endsWith(".lock"))
    .filter((entry) => {
      try {
        return Date.now() - fs.statSync(path.join(root, entry)).mtimeMs > 30000;
      } catch {
        return false;
      }
    });
  if (staleLocks.length > 0) {
    checks.push({
      name: "locks",
      status: "warn",
      detail: `stale lock(s) detected (broken automatically on next write): ${staleLocks.join(", ")}`
    });
  } else {
    checks.push({ name: "locks", status: "pass", detail: "no stale locks" });
  }

  // 8. gitleaks availability (optional, improves secret scanning fidelity)
  const gitleaks = spawnSync("gitleaks", ["version"], { encoding: "utf8" });
  checks.push(
    gitleaks.status === 0
      ? { name: "gitleaks", status: "pass", detail: `available (${(gitleaks.stdout || "").trim()})` }
      : { name: "gitleaks", status: "warn", detail: "not installed; regex scanner still active, gitleaks adds coverage" }
  );

  const healthy = checks.every((check) => check.status !== "fail");
  return { healthy, checks, repaired };
}

export function formatDoctorResult(result: DoctorResult): string {
  const icon: Record<CheckStatus, string> = { pass: "PASS", warn: "WARN", fail: "FAIL" };
  const lines = result.checks.map((c) => `[${icon[c.status]}] ${c.name}: ${c.detail}`);
  lines.push("");
  lines.push(result.healthy ? "Store healthy." : "Store has failures. See above.");
  return `${lines.join("\n")}\n`;
}
