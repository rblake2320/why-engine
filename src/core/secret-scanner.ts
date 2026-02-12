import crypto from "crypto";
import os from "os";
import path from "path";
import fs from "fs";
import { spawnSync } from "child_process";
import { SecretFinding, SecretScanResult, Sensitivity } from "./contracts";

type ScanResult<T> = { redacted: T; result: SecretScanResult };
type ScanOptions = { repoPath?: string; allowlistPath?: string };

const SECRET_RULES: Array<{ id: string; description: string; regex: RegExp }> = [
  {
    id: "authorization-header",
    description: "Authorization header",
    regex: /authorization\s*[:=]\s*[^\n\r]+/gi
  },
  {
    id: "cookie-header",
    description: "Cookie header",
    regex: /(cookie|set-cookie)\s*[:=]\s*[^\n\r]+/gi
  },
  { id: "aws-access-key", description: "AWS access key ID", regex: /AKIA[0-9A-Z]{16}/g },
  {
    id: "aws-secret-key",
    description: "AWS secret access key",
    regex: /aws_secret_access_key\s*[:=]\s*([A-Za-z0-9/+=]{20,})/gi
  },
  {
    id: "generic-api-key",
    description: "API key",
    regex: /api[_-]?key\s*[:=]\s*([A-Za-z0-9/+=_-]{16,})/gi
  },
  {
    id: "generic-secret",
    description: "Generic secret/password/token",
    regex: /(secret|password|token)\s*[:=]\s*([^\s"'`]{8,})/gi
  },
  {
    id: "private-key",
    description: "Private key block",
    regex: /-----BEGIN[\s\S]*PRIVATE KEY-----/g
  },
  {
    id: "github-token",
    description: "GitHub token",
    regex: /gh[pousr]_[A-Za-z0-9_]{36,}/g
  },
  {
    id: "jwt-token",
    description: "JWT token",
    regex: /eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*/g
  },
  {
    id: "connection-string",
    description: "Database connection string",
    regex: /(mongodb|postgresql|mysql|redis):\/\/[^\s]+/gi
  },
  {
    id: "url-embedded-credentials",
    description: "URL with embedded credentials",
    regex: /https?:\/\/[^\s/:]+:[^\s@]+@/gi
  },
  {
    id: "bearer-token",
    description: "Bearer token",
    regex: /Bearer\s+[A-Za-z0-9_\-.~+/]+=*/g
  },
  {
    id: "slack-token",
    description: "Slack token",
    regex: /xox[baprs]-[A-Za-z0-9-]{10,}/g
  }
];

export function scanAndRedact<T>(
  input: T,
  sensitivity: Sensitivity,
  options: ScanOptions = {}
): ScanResult<T> {
  const findings: SecretFinding[] = [];
  let redactionsApplied = 0;

  const redacted = walkAndRedact(input, "", (text, location) => {
    let updated = text;
    for (const rule of SECRET_RULES) {
      updated = updated.replace(rule.regex, (match) => {
        findings.push({
          ruleId: rule.id,
          description: rule.description,
          location,
          redacted: true
        });
        redactionsApplied += 1;
        return `[REDACTED:${rule.id}]`;
      });
    }
    if (sensitivity === "public") {
      updated = applyPublicRedactions(updated);
    }
    return updated;
  }) as T;

  const gitleaks = runGitleaksIfAvailable({
    content: JSON.stringify(redacted),
    repoPath: options.repoPath,
    allowlistPath: options.allowlistPath
  });
  const unallowlisted = gitleaks.unallowlistedCount ?? gitleaks.findings ?? 0;
  const clean = findings.length === 0 && (!gitleaks.ran || unallowlisted === 0);

  return {
    redacted,
    result: {
      clean,
      secretsFound: findings.length + unallowlisted,
      redactionsApplied,
      findings,
      gitleaksRan: gitleaks.ran,
      gitleaksFindings: gitleaks.findings,
      gitleaksSummary: gitleaks.summary
    }
  };
}

export function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function walkAndRedact(
  value: unknown,
  location: string,
  redact: (text: string, location: string) => string
): unknown {
  if (typeof value === "string") {
    return redact(value, location || "$");
  }
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      walkAndRedact(item, location ? `${location}[${index}]` : `$[${index}]`, redact)
    );
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const childLocation = location ? `${location}.${key}` : `$.${key}`;
      result[key] = walkAndRedact(child, childLocation, redact);
    }
    return result;
  }
  return value;
}

function applyPublicRedactions(text: string): string {
  let updated = text;
  updated = updated.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (match) => {
    const [user] = match.split("@");
    const initials = user
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean)
      .map((part) => part[0])
      .join("")
      .toLowerCase();
    return `${initials || "u"}@redacted`;
  });

  updated = updated.replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "[REDACTED_IP]");

  updated = updated.replace(/https?:\/\/([^/\s]+)/g, (match, host) => {
    return match.replace(host, "[REDACTED_HOST]");
  });

  updated = updated.replace(/[A-Za-z]:\\[^\s"']+/g, (match) => {
    const base = path.basename(match);
    return base || "[REDACTED_PATH]";
  });

  if (!updated.includes("http://") && !updated.includes("https://")) {
    updated = updated.replace(/(?:\/[^\/\s"']+)+/g, (match) => {
      const base = path.basename(match);
      return base || "[REDACTED_PATH]";
    });
  }

  return updated;
}

function runGitleaksIfAvailable(input: {
  content: string;
  repoPath?: string;
  allowlistPath?: string;
}): {
  ran: boolean;
  findings?: number;
  unallowlistedCount?: number;
  summary?: SecretScanResult["gitleaksSummary"];
} {
  const cmd = isCommandAvailable("gitleaks") ? "gitleaks" : null;
  if (!cmd) {
    return { ran: false };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "why-engine-"));
  const reportPath = path.join(tmpDir, "report.json");
  let result;
  if (input.repoPath) {
    const excludePath = path.join(input.repoPath, ".why-engine");
    result = spawnSync(cmd, [
      "detect",
      "--no-git",
      "--source",
      input.repoPath,
      "--exclude-path",
      excludePath,
      "--report-format",
      "json",
      "--report-path",
      reportPath
    ]);
  } else {
    const inputPath = path.join(tmpDir, "scan.txt");
    fs.writeFileSync(inputPath, input.content, "utf8");
    result = spawnSync(cmd, [
      "detect",
      "--no-git",
      "--source",
      inputPath,
      "--report-format",
      "json",
      "--report-path",
      reportPath
    ]);
  }

  let findings = 0;
  let summary: SecretScanResult["gitleaksSummary"] | undefined;
  let unallowlistedCount = 0;
  if (fs.existsSync(reportPath)) {
    try {
      const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
      const items = Array.isArray(report) ? report : [];
      findings = items.length;
      const allowlist = loadAllowlist(input.allowlistPath ?? (input.repoPath ? path.join(input.repoPath, ".why-engine", "gitleaks.allowlist") : undefined));
      const rules = new Set<string>();
      const files = new Set<string>();
      const fingerprints = new Set<string>();
      let allowlistedCount = 0;
      for (const item of items) {
        const ruleId = item.RuleID || item.RuleId || item.rule || item.ruleID;
        const file = item.File || item.file || item.FilePath;
        const fingerprint = item.Fingerprint || item.fingerprint;
        if (ruleId) {
          rules.add(String(ruleId));
        }
        if (file) {
          files.add(path.basename(String(file)));
        }
        if (fingerprint) {
          const short = String(fingerprint).slice(0, 8);
          fingerprints.add(short);
          if (allowlist.has(String(fingerprint)) || allowlist.has(short)) {
            allowlistedCount += 1;
          } else {
            unallowlistedCount += 1;
          }
        } else {
          unallowlistedCount += 1;
        }
      }
      summary = {
        count: findings,
        rules: Array.from(rules),
        files: Array.from(files),
        fingerprints: Array.from(fingerprints),
        allowlistedCount,
        unallowlistedCount
      };
    } catch {
      findings = 0;
    }
  }

  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    return { ran: true, findings };
  }

  if (!summary) {
    summary = {
      count: findings,
      rules: [],
      files: [],
      fingerprints: [],
      allowlistedCount: 0,
      unallowlistedCount
    };
  }

  return {
    ran: true,
    findings: result.status === 0 ? findings : findings,
    unallowlistedCount,
    summary
  };
}

function loadAllowlist(filePath?: string): Set<string> {
  if (!filePath || !fs.existsSync(filePath)) {
    return new Set();
  }
  const lines = fs.readFileSync(filePath, "utf8").split("\n");
  const entries = lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  return new Set(entries);
}

function isCommandAvailable(command: string): boolean {
  const checker = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(checker, [command], { stdio: "ignore" });
  return result.status === 0;
}
