import { Router, Request, Response } from "express";
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";

const execFileAsync = promisify(execFile);
export const auditRouter = Router();

const CLI_BIN = path.resolve(process.cwd(), "../../dist/cli.js");

auditRouter.get("/verify", async (req: Request, res: Response): Promise<void> => {
  const repoPath = req.query["repoPath"] as string;
  if (!repoPath) { res.status(400).json({ error: "repoPath query param required" }); return; }

  try {
    const { stdout } = await execFileAsync(
      "node", [CLI_BIN, "verify-audit", "--repo-path", repoPath],
      { timeout: 15_000 }
    );
    res.json({ success: true, data: JSON.parse(stdout) });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});
