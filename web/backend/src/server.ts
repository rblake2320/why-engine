import express from "express";
import cors from "cors";
import { evidenceRouter } from "./routes/evidence.js";
import { casesRouter } from "./routes/cases.js";
import { outboxRouter } from "./routes/outbox.js";
import { auditRouter } from "./routes/audit.js";

const app = express();
const PORT = process.env.PORT ?? 3001;

app.use(cors({ origin: process.env.CORS_ORIGIN ?? "http://localhost:5173" }));
app.use(express.json({ limit: "10mb" }));

// Health check
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", version: "0.1.0", timestamp: new Date().toISOString() });
});

// Routes
app.use("/api/evidence", evidenceRouter);
app.use("/api/cases", casesRouter);
app.use("/api/outbox", outboxRouter);
app.use("/api/audit", auditRouter);

// Catch-all 404
app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.listen(PORT, () => {
  console.log(`Why Engine API listening on http://localhost:${PORT}`);
});

export default app;
