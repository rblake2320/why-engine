import { Router, Request, Response } from "express";
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import { z } from "zod";

const execFileAsync = promisify(execFile);
export const evidenceRouter = Router();

const CollectSchema = z.object({
  repoPath: z.string().min(1),
  commitRange: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  includeFullDiff: z.boolean().optional(),
  sensitivity: z.enum(["public", "internal", "restricted"]).optional(),
});

const CLI_BIN = path.resolve(process.cwd(), "../../dist/cli.js");

evidenceRouter.post("/collect", async (req: Request, res: Response): Promise<void> => {
  const parsed = CollectSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const d = parsed.data;
  const args = ["collect-evidence", "--repo-path", d.repoPath];
  if (d.commitRange) args.push("--commit-range", d.commitRange);
  if (d.description) args.push("--description", d.description);
  if (d.tags?.length) args.push("--tags", d.tags.join(","));
  if (d.includeFullDiff) args.push("--include-full-diff", "true");
  if (d.sensitivity) args.push("--sensitivity", d.sensitivity);

  try {
    const { stdout } = await execFileAsync("node", [CLI_BIN, ...args], { timeout: 30_000 });
    const result = JSON.parse(stdout);
    res.json({ success: true, data: result });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});
