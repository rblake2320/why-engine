import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import { collectEvidence } from "../core/evidence-collector";
import { analyzeWhyCase } from "../core/case-builder";
import { publishWhyCase } from "../publishers/publisher";
import { getAuditLogPath, verifyAuditChain } from "../core/audit-chain";
import { promoteToWhyMd } from "../commands/promote-why";
import { collectEvidenceSchema, analyzeSchema, publishSchema, captureAndPublishSchema, verifyAuditSchema, promoteWhySchema, recallSchema, statsSchema, doctorSchema } from "../core/schemas";
import { recallCases } from "../core/recall";
import { computeStats } from "../commands/stats";
import { runDoctor } from "../commands/doctor";

const SERVER_NAME = "why-engine";
const SERVER_VERSION = "0.2.0";

const tools: Tool[] = [
  {
    name: "why.collect_evidence",
    description: "Collect git diff/log evidence, run secret scan, write evidence bundle",
    inputSchema: {
      type: "object",
      properties: {
        repoPath: { type: "string" },
        commitRange: { type: "string" },
        testOutput: { type: "string" },
        testOutputPath: { type: "string" },
        errorLog: { type: "string" },
        errorLogPath: { type: "string" },
        description: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        includeFullDiff: { type: "boolean" },
        sensitivity: { type: "string", enum: ["public", "internal", "restricted"] }
      },
      required: ["repoPath"]
    }
  },
  {
    name: "why.analyze",
    description: "Build a WhyCase from evidence + analysis fields",
    inputSchema: {
      type: "object",
      properties: {
        repoPath: { type: "string" },
        evidenceId: { type: "string" },
        title: { type: "string" },
        rootCause: { type: "string" },
        whyNotCaught: { type: "string" },
        whyFixWorked: { type: "string" },
        preventNextTime: { type: "string" },
        generalizablePattern: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        sensitivity: { type: "string", enum: ["public", "internal", "restricted"] },
        issueUrl: { type: "string" },
        prUrl: { type: "string" }
      },
      required: ["repoPath", "title", "rootCause", "whyNotCaught", "whyFixWorked", "preventNextTime"]
    }
  },
  {
    name: "why.publish",
    description: "Publish a WhyCase to API and/or outbox with idempotency",
    inputSchema: {
      type: "object",
      properties: {
        repoPath: { type: "string" },
        caseId: { type: "string" },
        target: { type: "string", enum: ["api", "outbox", "both"] },
        dryRun: { type: "boolean" },
        problemId: { type: "string" },
        evidenceLink: { type: "string" },
        forceStub: { type: "boolean" },
        allowSecrets: { type: "boolean" },
        gitleaksMode: { type: "string", enum: ["block", "warn", "ignoreFingerprints"] },
        keepHistory: { type: "boolean" }
      },
      required: ["repoPath", "caseId"]
    }
  },
  {
    name: "why.capture_and_publish",
    description: "One-shot collect + analyze + publish (dryRun=true by default)",
    inputSchema: {
      type: "object",
      properties: {
        repoPath: { type: "string" },
        commitRange: { type: "string" },
        testOutput: { type: "string" },
        testOutputPath: { type: "string" },
        errorLog: { type: "string" },
        errorLogPath: { type: "string" },
        description: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        includeFullDiff: { type: "boolean" },
        title: { type: "string" },
        rootCause: { type: "string" },
        whyNotCaught: { type: "string" },
        whyFixWorked: { type: "string" },
        preventNextTime: { type: "string" },
        generalizablePattern: { type: "string" },
        sensitivity: { type: "string", enum: ["public", "internal", "restricted"] },
        issueUrl: { type: "string" },
        prUrl: { type: "string" },
        target: { type: "string", enum: ["api", "outbox", "both"] },
        dryRun: { type: "boolean" },
        problemId: { type: "string" },
        evidenceLink: { type: "string" },
        forceStub: { type: "boolean" },
        allowSecrets: { type: "boolean" },
        gitleaksMode: { type: "string", enum: ["block", "warn", "ignoreFingerprints"] },
        keepHistory: { type: "boolean" }
      },
      required: ["repoPath", "title", "rootCause", "whyNotCaught", "whyFixWorked", "preventNextTime"]
    }
  },
  {
    name: "why.verify_audit_chain",
    description: "Verify hash-chained audit log integrity",
    inputSchema: {
      type: "object",
      properties: {
        logPath: { type: "string" }
      }
    }
  },
  {
    name: "why.recall",
    description: "BEFORE attempting a fix, recall prior root-cause cases matching an error message, stack trace, or symptom description. Returns ranked matches with their root causes, why the fixes worked, and prevention guidance.",
    inputSchema: {
      type: "object",
      properties: {
        repoPath: { type: "string" },
        query: { type: "string", description: "Error message, stack trace, symptom, or question" },
        tags: { type: "array", items: { type: "string" } },
        limit: { type: "number" },
        minScore: { type: "number" }
      },
      required: ["repoPath", "query"]
    }
  },
  {
    name: "why.stats",
    description: "Fleet-level insight over the case store: totals, top tags, quality scores, and recurring root-cause clusters (preventions that did not hold)",
    inputSchema: {
      type: "object",
      properties: {
        repoPath: { type: "string" },
        similarityThreshold: { type: "number" }
      },
      required: ["repoPath"]
    }
  },
  {
    name: "why.doctor",
    description: "Health-check the .why-engine store: audit chain integrity, torn-tail detection, case/ledger/outbox consistency, stale locks. Set fix=true to quarantine a torn audit tail.",
    inputSchema: {
      type: "object",
      properties: {
        repoPath: { type: "string" },
        fix: { type: "boolean" }
      },
      required: ["repoPath"]
    }
  },
  {
    name: "why.promote_why",
    description: "Promote qualifying public WhyCases with generalizablePattern into WHY.md Fix Intelligence",
    inputSchema: {
      type: "object",
      properties: {
        repoPath: { type: "string" },
        dryRun: { type: "boolean" },
        minScore: { type: "number" },
        force: { type: "boolean" }
      },
      required: ["repoPath"]
    }
  }
];

const server = new Server(
  { name: SERVER_NAME, version: SERVER_VERSION },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs } = request.params;
  try {
    if (name === "why.collect_evidence") {
      const args = collectEvidenceSchema.parse(rawArgs ?? {});
      const evidence = collectEvidence(args);
      return { content: [{ type: "text", text: JSON.stringify(evidence, null, 2) }] };
    }
    if (name === "why.analyze") {
      const args = analyzeSchema.parse(rawArgs ?? {});
      const whyCase = analyzeWhyCase(args);
      return { content: [{ type: "text", text: JSON.stringify(whyCase, null, 2) }] };
    }
    if (name === "why.publish") {
      const args = publishSchema.parse(rawArgs ?? {});
      const result = await publishWhyCase(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    if (name === "why.capture_and_publish") {
      const args = captureAndPublishSchema.parse(rawArgs ?? {});
      const evidence = collectEvidence(args);
      const whyCase = analyzeWhyCase({
        repoPath: args.repoPath,
        evidenceId: evidence.evidenceId,
        title: args.title,
        rootCause: args.rootCause,
        whyNotCaught: args.whyNotCaught,
        whyFixWorked: args.whyFixWorked,
        preventNextTime: args.preventNextTime,
        generalizablePattern: args.generalizablePattern,
        tags: args.tags,
        sensitivity: args.sensitivity ?? "internal",
        issueUrl: args.issueUrl,
        prUrl: args.prUrl
      });
      const result = await publishWhyCase({
        repoPath: args.repoPath,
        caseId: whyCase.caseId,
        target: args.target ?? "both",
        dryRun: args.dryRun ?? true,
        problemId: args.problemId,
        evidenceLink: args.evidenceLink,
        forceStub: args.forceStub,
        allowSecrets: args.allowSecrets,
        gitleaksMode: args.gitleaksMode,
        keepHistory: args.keepHistory
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ evidenceId: evidence.evidenceId, caseId: whyCase.caseId, result }, null, 2)
          }
        ]
      };
    }
    if (name === "why.verify_audit_chain") {
      const args = verifyAuditSchema.parse(rawArgs ?? {});
      const logPath = args.logPath ?? getAuditLogPath(process.cwd());
      const result = verifyAuditChain(logPath);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    if (name === "why.recall") {
      const args = recallSchema.parse(rawArgs ?? {});
      const result = recallCases(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    if (name === "why.stats") {
      const args = statsSchema.parse(rawArgs ?? {});
      const result = computeStats(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    if (name === "why.doctor") {
      const args = doctorSchema.parse(rawArgs ?? {});
      const result = runDoctor(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    if (name === "why.promote_why") {
      const args = promoteWhySchema.parse(rawArgs ?? {});
      const result = promoteToWhyMd(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    throw new Error(`Unknown tool: ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: message }],
      isError: true
    };
  }
});

async function start(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
