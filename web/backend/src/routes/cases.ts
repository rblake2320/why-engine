import { Router, Request, Response } from "express";
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import { z } from "zod";

const execFileAsync = promisify(execFile);
export const casesRouter = Router();

const CLI_BIN = path.resolve(process.cwd(), "../../dist/cli.js");

const AnalyzeSchema = z.object({
  repoPath: z.string().min(1),
  evidenceId: z.string().optional(),
  title: z.string().min(1),
  rootCause: z.string().min(1),
  whyNotCaught: z.string().min(1),
  whyFixWorked: z.string().min(1),
  preventNextTime: z.string().min(1),
  generalizablePattern: z.string().optional(),
  tags: z.array(z.string()).optional(),
  sensitivity: z.enum(["public", "internal", "restricted"]).optional(),
  issueUrl: z.string().url().optional(),
  prUrl: z.string().url().optional(),
});

const PublishSchema = z.object({
  repoPath: z.string().min(1),
  caseId: z.string().min(1),
  target: z.enum(["api", "outbox", "both"]).default("outbox"),
  dryRun: z.boolean().default(true),
  problemId: z.string().optional(),
  keepHistory: z.boolean().optional(),
});

const CaptureSchema = z.object({
  repoPath: z.string().min(1),
  commitRange: z.string().optional(),
  title: z.string().min(1),
  rootCause: z.string().min(1),
  whyNotCaught: z.string().min(1),
  whyFixWorked: z.string().min(1),
  preventNextTime: z.string().min(1),
  generalizablePattern: z.string().optional(),
  tags: z.array(z.string()).optional(),
  sensitivity: z.enum(["public", "internal", "restricted"]).optional(),
  target: z.enum(["api", "outbox", "both"]).default("outbox"),
  dryRun: z.boolean().default(true),
});

function cliArgs(obj: Record<string, unknown>): string[] {
  const args: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const flag = "--" + k.replace(/([A-Z])/g, "-$1").toLowerCase();
    if (Array.isArray(v)) {
      args.push(flag, v.join(","));
    } else {
      args.push(flag, String(v));
    }
  }
  return args;
}

casesRouter.post("/analyze", async (req: Request, res: Response): Promise<void> => {
  const parsed = AnalyzeSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
  try {
    const { stdout } = await execFileAsync("node", [CLI_BIN, "analyze", ...cliArgs(parsed.data)], { timeout: 30_000 });
    res.json({ success: true, data: JSON.parse(stdout) });
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

casesRouter.post("/publish", async (req: Request, res: Response): Promise<void> => {
  const parsed = PublishSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
  try {
    const { stdout } = await execFileAsync("node", [CLI_BIN, "publish", ...cliArgs(parsed.data)], { timeout: 30_000 });
    res.json({ success: true, data: JSON.parse(stdout) });
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

casesRouter.post("/capture", async (req: Request, res: Response): Promise<void> => {
  const parsed = CaptureSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
  try {
    const { stdout } = await execFileAsync("node", [CLI_BIN, "capture-and-publish", ...cliArgs(parsed.data)], { timeout: 60_000 });
    res.json({ success: true, data: JSON.parse(stdout) });
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
