import fs from "fs";
import path from "path";
import crypto from "crypto";
import { ensureDir, getWhyEngineRoot } from "./path-policy";
import { appendLineDurable, atomicWriteFileSync, withLock } from "./durable-fs";

export interface AuditEntry {
  timestamp: string;
  action: string;
  payload: Record<string, unknown>;
  prevHash: string | null;
  hash: string;
}

export interface AuditVerifyResult {
  valid: boolean;
  totalEntries: number;
  brokenAt?: number;
  brokenReason?: string;
  /** True when the only defect is a malformed final line — the signature of a crash mid-append. */
  tornTail?: boolean;
  /** True when `repairAuditChain` can restore integrity by quarantining the torn tail. */
  repairable?: boolean;
}

export function getAuditLogPath(repoPath: string): string {
  const root = getWhyEngineRoot(repoPath);
  return path.join(root, "audit.log");
}

function getAuditHeadPath(repoPath: string): string {
  return path.join(getWhyEngineRoot(repoPath), "audit.head");
}

/**
 * Append an entry to the hash-chained audit log.
 *
 * Durability + integrity properties:
 * - Serialized across processes via an advisory lock, so concurrent CLI /
 *   MCP / web writers cannot interleave and fork the chain.
 * - The appended line is fsync'd before return.
 * - The previous hash is resolved in O(1) from `audit.head` (atomically
 *   maintained); if the head cache is missing or inconsistent, we fall back
 *   to scanning the log tail, so the cache is never a correctness dependency.
 */
export function appendAuditEntry(
  repoPath: string,
  action: string,
  payload: Record<string, unknown>
): AuditEntry {
  const logPath = getAuditLogPath(repoPath);
  const root = getWhyEngineRoot(repoPath);
  ensureDir(root);

  return withLock("audit", root, () => {
    const prevHash = resolvePrevHash(repoPath, logPath);
    const timestamp = new Date().toISOString();
    const hash = computeHash({ timestamp, action, payload, prevHash });
    const entry: AuditEntry = { timestamp, action, payload, prevHash, hash };
    appendLineDurable(logPath, JSON.stringify(entry));
    atomicWriteFileSync(getAuditHeadPath(repoPath), JSON.stringify({ hash, updatedAt: timestamp }));
    return entry;
  });
}

function resolvePrevHash(repoPath: string, logPath: string): string | null {
  if (!fs.existsSync(logPath)) {
    return null;
  }
  const headPath = getAuditHeadPath(repoPath);
  const lastLine = readLastNonEmptyLine(logPath);
  if (lastLine === null) {
    return null;
  }
  let lastHashFromLog: string | null = null;
  try {
    lastHashFromLog = (JSON.parse(lastLine) as AuditEntry).hash ?? null;
  } catch {
    throw new Error(
      "Audit log tail is malformed (torn tail from a crashed append?). Run `why-engine doctor` / repairAuditChain before appending."
    );
  }
  // Prefer the log itself; validate the head cache against it and self-heal drift.
  if (fs.existsSync(headPath)) {
    try {
      const head = JSON.parse(fs.readFileSync(headPath, "utf8")) as { hash?: string };
      if (head.hash !== lastHashFromLog) {
        atomicWriteFileSync(headPath, JSON.stringify({ hash: lastHashFromLog, updatedAt: new Date().toISOString() }));
      }
    } catch {
      /* corrupt head cache is rebuilt on next append */
    }
  }
  return lastHashFromLog;
}

function readLastNonEmptyLine(logPath: string): string | null {
  // Tail-read without loading the whole file: scan backwards in chunks.
  const fd = fs.openSync(logPath, "r");
  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0) {
      return null;
    }
    const chunkSize = 64 * 1024;
    let position = size;
    let carry = "";
    while (position > 0) {
      const readSize = Math.min(chunkSize, position);
      position -= readSize;
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, position);
      carry = buf.toString("utf8") + carry;
      const lines = carry.split("\n").filter((line) => line.trim() !== "");
      if (position === 0 || lines.length > 1) {
        return lines.length > 0 ? lines[lines.length - 1] : null;
      }
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

export function verifyAuditChain(logPath: string): AuditVerifyResult {
  if (!fs.existsSync(logPath)) {
    return { valid: true, totalEntries: 0 };
  }
  const raw = fs.readFileSync(logPath, "utf8");
  const lines = raw.split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) {
    return { valid: true, totalEntries: 0 };
  }

  let prevHash: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    let entry: AuditEntry;
    try {
      entry = JSON.parse(lines[i]) as AuditEntry;
    } catch {
      const isLast = i === lines.length - 1;
      return {
        valid: false,
        totalEntries: lines.length,
        brokenAt: i + 1,
        brokenReason: isLast
          ? "malformed final entry (torn tail: crash during append)"
          : "malformed entry (not valid JSON)",
        tornTail: isLast,
        repairable: isLast
      };
    }
    const expected = computeHash({
      timestamp: entry.timestamp,
      action: entry.action,
      payload: entry.payload,
      prevHash
    });
    if (entry.prevHash !== prevHash) {
      return {
        valid: false,
        totalEntries: lines.length,
        brokenAt: i + 1,
        brokenReason: "prevHash mismatch"
      };
    }
    if (entry.hash !== expected) {
      return {
        valid: false,
        totalEntries: lines.length,
        brokenAt: i + 1,
        brokenReason: "hash mismatch"
      };
    }
    prevHash = entry.hash;
  }

  return { valid: true, totalEntries: lines.length };
}

export interface AuditRepairResult {
  repaired: boolean;
  reason: string;
  quarantinePath?: string;
  entriesRetained?: number;
}

/**
 * Repair a torn tail: the ONLY defect this will touch is a malformed final
 * line, which is the expected artifact of a crash mid-append. The torn bytes
 * are quarantined (never silently deleted) so the repair itself is auditable,
 * and a `why.audit_repair` entry is chained on afterwards.
 *
 * Any other defect (hash mismatch, mid-log corruption) is evidence of
 * tampering or bit rot and is deliberately NOT auto-repairable.
 */
export function repairAuditChain(repoPath: string): AuditRepairResult {
  const result = repairAuditChainLocked(repoPath);
  if (result.repaired) {
    // Chained after the lock is released (the advisory lock is non-reentrant).
    appendAuditEntry(repoPath, "why.audit_repair", {
      quarantinePath: result.quarantinePath,
      entriesRetained: result.entriesRetained
    });
  }
  return result;
}

function repairAuditChainLocked(repoPath: string): AuditRepairResult {
  const logPath = getAuditLogPath(repoPath);
  const root = getWhyEngineRoot(repoPath);
  return withLock("audit", root, () => {
    const verdict = verifyAuditChain(logPath);
    if (verdict.valid) {
      return { repaired: false, reason: "audit chain already valid" };
    }
    if (!verdict.tornTail || !verdict.repairable) {
      return {
        repaired: false,
        reason: `not repairable: ${verdict.brokenReason ?? "unknown defect"} at entry ${verdict.brokenAt}`
      };
    }
    const raw = fs.readFileSync(logPath, "utf8");
    const lines = raw.split("\n").filter((line) => line.trim() !== "");
    const torn = lines[lines.length - 1];
    const retained = lines.slice(0, -1);
    const quarantinePath = `${logPath}.quarantine-${Date.now()}`;
    atomicWriteFileSync(quarantinePath, `${torn}\n`);
    atomicWriteFileSync(logPath, retained.length > 0 ? `${retained.join("\n")}\n` : "");
    const lastHash = retained.length > 0 ? (JSON.parse(retained[retained.length - 1]) as AuditEntry).hash : null;
    if (lastHash) {
      atomicWriteFileSync(
        path.join(root, "audit.head"),
        JSON.stringify({ hash: lastHash, updatedAt: new Date().toISOString() })
      );
    } else if (fs.existsSync(path.join(root, "audit.head"))) {
      fs.rmSync(path.join(root, "audit.head"));
    }
    return {
      repaired: true,
      reason: "torn tail quarantined",
      quarantinePath,
      entriesRetained: retained.length
    };
  });
}

function computeHash(input: {
  timestamp: string;
  action: string;
  payload: Record<string, unknown>;
  prevHash: string | null;
}): string {
  const data = JSON.stringify(input);
  return crypto.createHash("sha256").update(data).digest("hex");
}
