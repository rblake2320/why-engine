export type Sensitivity = "public" | "internal" | "restricted";
export type PublishTarget = "api" | "outbox" | "both";

export interface EvidenceBundle {
  evidenceId: string;
  repoPath: string;
  collectedAt: string;
  commitRange: string;
  diffSummary: string;
  diffStat?: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  fileList: string[];
  fullDiff?: string;
  fullDiffHash?: string;
  fullDiffTruncated?: boolean;
  commitMessages: CommitInfo[];
  testOutput?: string;
  testOutputHash?: string;
  testOutputTruncated?: boolean;
  errorLog?: string;
  errorLogHash?: string;
  errorLogTruncated?: boolean;
  description?: string;
  environment: EnvironmentInfo;
  secretScanResult: SecretScanResult;
  tags?: string[];
}

export interface CommitInfo {
  hash: string;
  author: string;
  date: string;
  message: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export interface EnvironmentInfo {
  os: string;
  nodeVersion: string;
  gitVersion?: string;
  branch: string;
  repoCommitHash: string;
  repoRemoteUrl?: string;
}

export interface WhyCase {
  caseId: string;
  idempotencyKey: string;
  createdAt: string;
  repoPath: string;
  evidenceId?: string;
  title: string;
  rootCause: string;
  whyNotCaught: string;
  whyFixWorked: string;
  preventNextTime: string;
  generalizablePattern?: string;
  evidence: {
    commitRange?: string;
    diffSummary?: string;
    commitMessages?: string[];
    fileList?: string[];
    testOutputSnippet?: string;
    errorLogSnippet?: string;
  };
  tags: string[];
  sensitivity: Sensitivity;
  secretScanResult: SecretScanResult;
  links?: {
    issueUrl?: string;
    prUrl?: string;
  };
}

export interface SecretScanResult {
  clean: boolean;
  secretsFound: number;
  redactionsApplied: number;
  findings: SecretFinding[];
  gitleaksRan?: boolean;
  gitleaksFindings?: number;
  gitleaksSummary?: {
    count: number;
    rules?: string[];
    files?: string[];
    fingerprints?: string[];
    allowlistedCount?: number;
    unallowlistedCount?: number;
  };
}

export interface SecretFinding {
  ruleId: string;
  description: string;
  location: string;
  redacted: boolean;
}

export interface PublishResult {
  caseId: string;
  idempotencyKey: string;
  target: PublishTarget;
  dryRun: boolean;
  apiResult?: ApiPublishResult;
  outboxResult?: OutboxResult;
  secretScanResult: SecretScanResult;
  deduped?: boolean;
  blockedReason?: string;
  dedupeSource?: "ledger";
  previousPublish?: {
    problemId?: string;
    solutionId?: string;
    url?: string;
    target?: PublishTarget;
    publishedAt?: string;
  };
}

export interface ApiPublishResult {
  success: boolean;
  problemId?: string;
  solutionId?: string;
  url?: string;
  error?: string;
  httpStatus?: number;
}

export interface OutboxResult {
  written: boolean;
  path: string;
  error?: string;
}
