import { Router, Request, Response } from "express";
import fs from "fs";
import path from "path";
import { z } from "zod";

export const outboxRouter = Router();

const RepoSchema = z.object({ repoPath: z.string().min(1) });

outboxRouter.get("/", async (req: Request, res: Response): Promise<void> => {
  const parsed = RepoSchema.safeParse({ repoPath: req.query["repoPath"] });
  if (!parsed.success) { res.status(400).json({ error: "repoPath query param required" }); return; }

  const outboxDir = path.join(parsed.data.repoPath, ".why-engine", "outbox");
  if (!fs.existsSync(outboxDir)) {
    res.json({ cases: [], total: 0 });
    return;
  }

  try {
    const files = fs.readdirSync(outboxDir).filter(f => f.endsWith(".json") && !f.startsWith("ledger"));
    const cases = files.map(f => {
      try {
        const raw = fs.readFileSync(path.join(outboxDir, f), "utf8");
        return JSON.parse(raw);
      } catch {
        return null;
      }
    }).filter(Boolean);

    // Sort newest first
    cases.sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime());
    res.json({ cases, total: cases.length });
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

outboxRouter.get("/:caseId", async (req: Request, res: Response): Promise<void> => {
  const repoPath = req.query["repoPath"] as string;
  if (!repoPath) { res.status(400).json({ error: "repoPath query param required" }); return; }

  const filePath = path.join(repoPath, ".why-engine", "outbox", `${req.params["caseId"]}.json`);
  if (!fs.existsSync(filePath)) { res.status(404).json({ error: "Case not found" }); return; }

  try {
    const raw = fs.readFileSync(filePath, "utf8");
    res.json(JSON.parse(raw));
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
