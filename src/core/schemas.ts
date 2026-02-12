import { z } from "zod";

export const sensitivitySchema = z.enum(["public", "internal", "restricted"]);
export const publishTargetSchema = z.enum(["api", "outbox", "both"]);
export const gitleaksModeSchema = z.enum(["block", "warn", "ignoreFingerprints"]);

export const safeIdSchema = z
  .string()
  .min(4)
  .max(128)
  .regex(/^[a-zA-Z0-9._-]+$/);

export const safePathSchema = z.string().min(3).max(260);

export const collectEvidenceSchema = z
  .object({
    repoPath: safePathSchema,
    commitRange: z.string().min(3).max(128).default("HEAD~1..HEAD"),
    testOutput: z.string().max(500_000).optional(),
    testOutputPath: safePathSchema.optional(),
    errorLog: z.string().max(500_000).optional(),
    errorLogPath: safePathSchema.optional(),
    description: z.string().max(10_000).optional(),
    tags: z.array(z.string().min(1).max(50)).max(20).optional(),
    includeFullDiff: z.boolean().default(false),
    sensitivity: sensitivitySchema.optional()
  })
  .strict();

export const analyzeSchema = z
  .object({
    repoPath: safePathSchema,
    evidenceId: safeIdSchema.optional(),
    title: z.string().min(5).max(200),
    rootCause: z.string().min(10).max(5000),
    whyNotCaught: z.string().min(10).max(5000),
    whyFixWorked: z.string().min(10).max(5000),
    preventNextTime: z.string().min(10).max(5000),
    generalizablePattern: z.string().max(5000).optional(),
    tags: z.array(z.string().min(1).max(50)).max(20).optional(),
    sensitivity: sensitivitySchema.default("internal"),
    issueUrl: z.string().url().optional(),
    prUrl: z.string().url().optional()
  })
  .strict();

export const publishSchema = z
  .object({
    repoPath: safePathSchema,
    caseId: safeIdSchema,
    target: publishTargetSchema.default("both"),
    dryRun: z.boolean().default(true),
    problemId: z.string().max(128).optional(),
    evidenceLink: z.string().url().optional(),
    forceStub: z.boolean().default(false),
    allowSecrets: z.boolean().default(false),
    gitleaksMode: gitleaksModeSchema.default("block"),
    keepHistory: z.boolean().default(false)
  })
  .strict();

export const captureAndPublishSchema = collectEvidenceSchema
  .omit({ sensitivity: true })
  .extend(analyzeSchema.shape)
  .extend({
    target: publishTargetSchema.default("both"),
    dryRun: z.boolean().default(true),
    problemId: z.string().max(128).optional(),
    evidenceLink: z.string().url().optional(),
    forceStub: z.boolean().default(false),
    allowSecrets: z.boolean().default(false),
    gitleaksMode: gitleaksModeSchema.default("block"),
    keepHistory: z.boolean().default(false)
  })
  .strict();

export const verifyAuditSchema = z
  .object({
    logPath: safePathSchema.optional()
  })
  .strict();
