export type QualityField =
  | "title"
  | "rootCause"
  | "whyNotCaught"
  | "whyFixWorked"
  | "preventNextTime"
  | "generalizablePattern";

export interface QualityGateInput {
  title: string;
  rootCause: string;
  whyNotCaught: string;
  whyFixWorked: string;
  preventNextTime: string;
  generalizablePattern?: string;
}

export interface QualityFinding {
  field: QualityField;
  code: string;
  message: string;
}

export interface QualityGateResult {
  passed: boolean;
  score: number;
  violations: QualityFinding[];
  warnings: QualityFinding[];
}

const REQUIRED_FIELDS: Array<Exclude<QualityField, "generalizablePattern">> = [
  "rootCause",
  "whyNotCaught",
  "whyFixWorked",
  "preventNextTime"
];

const LOW_EFFORT_VALUES = new Set([
  "bug",
  "fixed",
  "fixed it",
  "fix",
  "todo",
  "tbd",
  "n/a",
  "na",
  "none",
  "unknown",
  "root",
  "miss",
  "prevent",
  "rc",
  "wnc",
  "wfw",
  "pnt",
  "no test",
  "no tests",
  "added test",
  "add test",
  "same fix",
  "same miss",
  "same prevention"
]);

const CAUSAL_RE =
  /\b(because|therefore|so that|ensures?|prevents?|removes?|closes?|guards?|validates?|rejects?|blocks?|catches?|by|when|after)\b/i;

const PREVENTION_RE =
  /\b(test|lint|check|gate|monitor|alert|review|validation|policy|guardrail|scanner|coverage|ci)\b/i;

export function runQualityGate(input: QualityGateInput): QualityGateResult {
  const violations: QualityFinding[] = [];
  const warnings: QualityFinding[] = [];

  for (const field of REQUIRED_FIELDS) {
    const value = String(input[field] ?? "").trim();
    const normalized = normalize(value);
    if (value.length < 10) {
      violations.push({
        field,
        code: "too_short",
        message: `${field} must contain a specific explanation, not a placeholder`
      });
    }
    if (LOW_EFFORT_VALUES.has(normalized)) {
      violations.push({
        field,
        code: "low_effort_phrase",
        message: `${field} uses low-effort prose: ${value}`
      });
    }
  }

  if (!CAUSAL_RE.test(input.whyFixWorked)) {
    violations.push({
      field: "whyFixWorked",
      code: "missing_causal_mechanism",
      message: "whyFixWorked must explain why the fix works, not only name the patch"
    });
  }

  if (!PREVENTION_RE.test(input.preventNextTime)) {
    warnings.push({
      field: "preventNextTime",
      code: "weak_prevention",
      message: "preventNextTime should name a concrete guardrail such as a test, lint, gate, monitor, or review"
    });
  }

  if (!input.generalizablePattern || input.generalizablePattern.trim().length < 20) {
    warnings.push({
      field: "generalizablePattern",
      code: "missing_generalizable_pattern",
      message: "generalizablePattern is optional, but promotion to WHY.md requires a reusable lesson"
    });
  }

  const score = Math.max(0, 100 - violations.length * 25 - warnings.length * 5);
  return {
    passed: violations.length === 0,
    score,
    violations,
    warnings
  };
}

export function formatQualityGateResult(result: QualityGateResult): string {
  const lines = [
    `Quality gate ${result.passed ? "passed" : "failed"}: score=${result.score}, violations=${result.violations.length}, warnings=${result.warnings.length}`
  ];
  for (const finding of result.violations) {
    lines.push(`VIOLATION ${finding.field}/${finding.code}: ${finding.message}`);
  }
  for (const finding of result.warnings) {
    lines.push(`WARNING ${finding.field}/${finding.code}: ${finding.message}`);
  }
  return `${lines.join("\n")}\n`;
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}
