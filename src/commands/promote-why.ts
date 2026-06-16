import fs from "fs";
import path from "path";
import { ContentClassificationResult, classifyContent } from "../core/content-classifier";
import { WhyCase } from "../core/contracts";
import { assertSafeRepoPath, getWhyEngineRoot } from "../core/path-policy";
import { QualityGateResult, runQualityGate } from "../core/quality-gate";

export interface PromoteWhyInput {
  repoPath: string;
  dryRun?: boolean;
  minScore?: number;
  force?: boolean;
}

export interface PromoteWhyCandidate {
  caseId: string;
  title: string;
  status: "promoted" | "skipped";
  reason?: string;
  qualityScore?: number;
  classificationLevel?: ContentClassificationResult["level"];
}

export interface PromoteWhyResult {
  repoPath: string;
  whyPath: string;
  dryRun: boolean;
  minScore: number;
  promoted: PromoteWhyCandidate[];
  skipped: PromoteWhyCandidate[];
  written: boolean;
}

const FIX_INTELLIGENCE_HEADING = "## Fix Intelligence";

export function promoteToWhyMd(input: PromoteWhyInput): PromoteWhyResult {
  assertSafeRepoPath(input.repoPath);
  const dryRun = input.dryRun ?? true;
  const minScore = input.minScore ?? 70;
  const force = input.force === true;
  if (!Number.isInteger(minScore) || minScore < 0 || minScore > 100) {
    throw new Error("minScore must be an integer between 0 and 100");
  }

  const whyPath = path.join(input.repoPath, "WHY.md");
  const hadWhyMd = fs.existsSync(whyPath);
  const existing = hadWhyMd ? fs.readFileSync(whyPath, "utf8") : defaultWhyMd();
  const cases = loadCases(input.repoPath);
  const promoted: PromoteWhyCandidate[] = [];
  const skipped: PromoteWhyCandidate[] = [];
  const entries: string[] = [];

  for (const whyCase of cases) {
    const quality = runQualityGate(whyCase);
    const classification = classifyCase(whyCase);
    const skipReason = whyCaseSkipReason(whyCase, quality, classification, existing, minScore, force);
    if (skipReason) {
      skipped.push({
        caseId: whyCase.caseId,
        title: whyCase.title,
        status: "skipped",
        reason: skipReason,
        qualityScore: quality.score,
        classificationLevel: classification.level
      });
      continue;
    }
    promoted.push({
      caseId: whyCase.caseId,
      title: whyCase.title,
      status: "promoted",
      qualityScore: quality.score,
      classificationLevel: classification.level
    });
    entries.push(formatFixIntelligenceEntry(whyCase, quality, classification));
  }

  if (!dryRun && entries.length > 0) {
    fs.writeFileSync(whyPath, appendFixIntelligence(existing, entries), "utf8");
  } else if (!dryRun && !fs.existsSync(whyPath)) {
    fs.writeFileSync(whyPath, existing, "utf8");
  }

  return {
    repoPath: input.repoPath,
    whyPath,
    dryRun,
    minScore,
    promoted,
    skipped,
    written: !dryRun && (entries.length > 0 || !hadWhyMd)
  };
}

export function formatPromoteResult(result: PromoteWhyResult): string {
  const lines = [
    `promote-why ${result.dryRun ? "dry-run" : "write"}: promoted=${result.promoted.length}, skipped=${result.skipped.length}, minScore=${result.minScore}`,
    `WHY.md: ${result.whyPath}`
  ];
  for (const item of result.promoted) {
    lines.push(`PROMOTE ${item.caseId}: ${item.title} (quality=${item.qualityScore}, classification=${item.classificationLevel})`);
  }
  for (const item of result.skipped) {
    lines.push(`SKIP ${item.caseId}: ${item.reason}`);
  }
  return `${lines.join("\n")}\n`;
}

function loadCases(repoPath: string): WhyCase[] {
  const casesDir = path.join(getWhyEngineRoot(repoPath), "cases");
  if (!fs.existsSync(casesDir)) {
    return [];
  }
  return fs
    .readdirSync(casesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(casesDir, entry.name, "case.json"))
    .filter((casePath) => fs.existsSync(casePath))
    .map((casePath) => JSON.parse(fs.readFileSync(casePath, "utf8")) as WhyCase)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function classifyCase(whyCase: WhyCase): ContentClassificationResult {
  return classifyContent({
    rootCause: whyCase.rootCause,
    whyNotCaught: whyCase.whyNotCaught,
    whyFixWorked: whyCase.whyFixWorked,
    preventNextTime: whyCase.preventNextTime,
    generalizablePattern: whyCase.generalizablePattern,
    sensitivity: whyCase.sensitivity
  });
}

function whyCaseSkipReason(
  whyCase: WhyCase,
  quality: QualityGateResult,
  classification: ContentClassificationResult,
  existingWhyMd: string,
  minScore: number,
  force: boolean
): string | undefined {
  if (whyCase.sensitivity !== "public") {
    return `sensitivity is ${whyCase.sensitivity}, not public`;
  }
  if (!whyCase.generalizablePattern || whyCase.generalizablePattern.trim().length === 0) {
    return "generalizablePattern is empty";
  }
  if (!quality.passed) {
    return `quality gate failed with ${quality.violations.length} violation(s)`;
  }
  if (quality.score < minScore) {
    return `quality score ${quality.score} below minimum ${minScore}`;
  }
  if (classification.blocksApiPublish || classification.blocksOutboxPublish) {
    return `content classification blocks promotion: ${classification.level}`;
  }
  if (!force && existingWhyMd.includes(`[CASE-${whyCase.caseId}]`)) {
    return "already present in WHY.md";
  }
  return undefined;
}

function appendFixIntelligence(existing: string, entries: string[]): string {
  const normalized = existing.trimEnd();
  const body = entries.join("\n");
  if (!normalized.includes(FIX_INTELLIGENCE_HEADING)) {
    return `${normalized}\n\n${FIX_INTELLIGENCE_HEADING}\n\n${body}\n`;
  }
  return normalized.replace(/\n?_\(No fix intelligence entries yet[\s\S]*?\)_\s*$/m, "") + `\n\n${body}\n`;
}

function formatFixIntelligenceEntry(
  whyCase: WhyCase,
  quality: QualityGateResult,
  classification: ContentClassificationResult
): string {
  return `### [CASE-${whyCase.caseId}] ${whyCase.title}

- **Root Cause:** ${whyCase.rootCause}
- **Why Not Caught:** ${whyCase.whyNotCaught}
- **Why Fix Worked:** ${whyCase.whyFixWorked}
- **Generalizable Pattern:** ${whyCase.generalizablePattern}
- **Prevent Next Time:** ${whyCase.preventNextTime}
- **Sensitivity:** ${whyCase.sensitivity}
- **Quality Score:** ${quality.score}
- **Classification:** ${classification.level}
- **Evidence:** \`.why-engine/cases/${whyCase.caseId}/case.json\`
`;
}

function defaultWhyMd(): string {
  return `# WHY.md - Project Rationale & Fix Intelligence

## Architectural Decisions

Architectural decisions are written proactively before or during implementation.

${FIX_INTELLIGENCE_HEADING}

_(No fix intelligence entries yet - run promote-why after a reviewed public WhyCase has a generalizablePattern.)_
`;
}
