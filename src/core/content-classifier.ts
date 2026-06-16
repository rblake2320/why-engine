import { Sensitivity } from "./contracts";

export type ClassificationLevel = "CLEAR" | "LOW" | "MEDIUM" | "HIGH";

export interface ContentClassifierInput {
  rootCause: string;
  whyNotCaught: string;
  whyFixWorked: string;
  preventNextTime: string;
  generalizablePattern?: string;
  sensitivity: Sensitivity;
}

export interface ContentFinding {
  field: keyof ContentClassifierInput;
  ruleId: string;
  level: Exclude<ClassificationLevel, "CLEAR">;
  message: string;
  snippet: string;
}

export interface ContentClassificationResult {
  level: ClassificationLevel;
  findings: ContentFinding[];
  blocksApiPublish: boolean;
  blocksOutboxPublish: boolean;
}

const RULES: Array<{
  ruleId: string;
  level: Exclude<ClassificationLevel, "CLEAR">;
  regex: RegExp;
  message: string;
}> = [
  {
    ruleId: "classified-marker",
    level: "HIGH",
    regex: /\b(classified|secret\/\/|top secret|ts\/sci|no ?forn)\b/i,
    message: "classification marker or classified-system phrase"
  },
  {
    ruleId: "controlled-government-data",
    level: "HIGH",
    regex: /\b(cui|itar|il[5-7]|dod enclave|government enclave)\b/i,
    message: "controlled government or enclave context"
  },
  {
    ruleId: "security-failure-mode",
    level: "HIGH",
    regex: /\b(failed open|auth bypass|bypass(ed)? auth|privilege escalation|lateral movement)\b/i,
    message: "operational security failure mode"
  },
  {
    ruleId: "network-topology",
    level: "MEDIUM",
    regex: /\b(private subnet|internal network|jump host|bastion|service account|auth proxy)\b/i,
    message: "internal topology or privileged infrastructure detail"
  },
  {
    ruleId: "exploit-detail",
    level: "MEDIUM",
    regex: /\b(ssrf|rce|sql injection|command injection|deserialization)\b/i,
    message: "exploit class detail"
  },
  {
    ruleId: "operator-sensitive",
    level: "LOW",
    regex: /\b(on call|pager|incident bridge|customer tenant|production outage)\b/i,
    message: "operator or production incident context"
  }
];

const FIELD_NAMES: Array<keyof ContentClassifierInput> = [
  "rootCause",
  "whyNotCaught",
  "whyFixWorked",
  "preventNextTime",
  "generalizablePattern"
];

export function classifyContent(input: ContentClassifierInput): ContentClassificationResult {
  const findings: ContentFinding[] = [];
  for (const field of FIELD_NAMES) {
    const value = input[field];
    if (typeof value !== "string" || value.length === 0) {
      continue;
    }
    for (const rule of RULES) {
      const match = value.match(rule.regex);
      if (match) {
        findings.push({
          field,
          ruleId: rule.ruleId,
          level: rule.level,
          message: rule.message,
          snippet: snippet(value, match.index ?? 0)
        });
      }
    }
  }

  const level = highestLevel(findings);
  return {
    level,
    findings,
    blocksApiPublish: level === "HIGH",
    blocksOutboxPublish: level === "HIGH" && input.sensitivity === "public"
  };
}

export function formatClassificationResult(result: ContentClassificationResult): string {
  const lines = [
    `Content classification: level=${result.level}, findings=${result.findings.length}, blocksApiPublish=${result.blocksApiPublish}, blocksOutboxPublish=${result.blocksOutboxPublish}`
  ];
  for (const finding of result.findings) {
    lines.push(`${finding.level} ${finding.field}/${finding.ruleId}: ${finding.message} (${finding.snippet})`);
  }
  return `${lines.join("\n")}\n`;
}

function highestLevel(findings: ContentFinding[]): ClassificationLevel {
  if (findings.some((finding) => finding.level === "HIGH")) {
    return "HIGH";
  }
  if (findings.some((finding) => finding.level === "MEDIUM")) {
    return "MEDIUM";
  }
  if (findings.some((finding) => finding.level === "LOW")) {
    return "LOW";
  }
  return "CLEAR";
}

function snippet(value: string, index: number): string {
  const start = Math.max(0, index - 40);
  const end = Math.min(value.length, index + 80);
  return value.slice(start, end).replace(/\s+/g, " ");
}
