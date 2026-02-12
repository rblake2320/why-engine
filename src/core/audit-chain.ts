import fs from "fs";
import path from "path";
import crypto from "crypto";
import { ensureDir, getWhyEngineRoot } from "./path-policy";

export interface AuditEntry {
  timestamp: string;
  action: string;
  payload: Record<string, unknown>;
  prevHash: string | null;
  hash: string;
}

export function getAuditLogPath(repoPath: string): string {
  const root = getWhyEngineRoot(repoPath);
  return path.join(root, "audit.log");
}

export function appendAuditEntry(
  repoPath: string,
  action: string,
  payload: Record<string, unknown>
): AuditEntry {
  const logPath = getAuditLogPath(repoPath);
  ensureDir(path.dirname(logPath));

  let prevHash: string | null = null;
  if (fs.existsSync(logPath)) {
    const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
    if (lines.length > 0 && lines[0] !== "") {
      const last = JSON.parse(lines[lines.length - 1]) as AuditEntry;
      prevHash = last.hash;
    }
  }

  const timestamp = new Date().toISOString();
  const hash = computeHash({ timestamp, action, payload, prevHash });
  const entry: AuditEntry = { timestamp, action, payload, prevHash, hash };
  fs.appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf8");
  return entry;
}

export function verifyAuditChain(logPath: string): {
  valid: boolean;
  totalEntries: number;
  brokenAt?: number;
  brokenReason?: string;
} {
  if (!fs.existsSync(logPath)) {
    return { valid: true, totalEntries: 0 };
  }
  const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
  if (lines.length === 1 && lines[0] === "") {
    return { valid: true, totalEntries: 0 };
  }

  let prevHash: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const entry = JSON.parse(lines[i]) as AuditEntry;
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

function computeHash(input: {
  timestamp: string;
  action: string;
  payload: Record<string, unknown>;
  prevHash: string | null;
}): string {
  const data = JSON.stringify(input);
  return crypto.createHash("sha256").update(data).digest("hex");
}
