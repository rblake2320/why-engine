import { useState } from "react";
import { Shield, Loader2, CheckCircle, XCircle, FolderOpen } from "lucide-react";
import { api } from "../api/client.ts";

export default function AuditPage() {
  const [repoPath, setRepoPath] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "ok" | "fail">("idle");
  const [result, setResult] = useState<unknown>(null);

  const verify = async () => {
    if (!repoPath) return;
    setStatus("loading");
    try {
      const res = await api.audit.verify(repoPath);
      setResult(res.data);
      setStatus("ok");
    } catch (e) {
      setResult({ error: e instanceof Error ? e.message : String(e) });
      setStatus("fail");
    }
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold flex items-center gap-2">
        <Shield className="text-teal-400 w-6 h-6" /> Audit Chain
      </h1>
      <p className="text-slate-400 text-sm">
        Verify the cryptographic audit chain for a repository's why-engine log. Each entry is HMAC-chained
        to the previous, ensuring tamper evidence.
      </p>

      <div className="flex gap-3">
        <div className="flex-1">
          <label className="label" htmlFor="auditRepo">
            <FolderOpen className="w-3.5 h-3.5 inline mr-1" />
            Repository Path
          </label>
          <input id="auditRepo" className="input font-mono text-sm"
            placeholder="/path/to/your/repo"
            value={repoPath} onChange={e => setRepoPath(e.target.value)} />
        </div>
        <div className="flex items-end">
          <button className="btn-primary flex items-center gap-2" onClick={verify}
            disabled={status === "loading" || !repoPath}>
            {status === "loading" ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Verifying…</>
            ) : (
              <><Shield className="w-4 h-4" /> Verify</>
            )}
          </button>
        </div>
      </div>

      {status === "ok" && (
        <div className="card border-emerald-500/30 space-y-3">
          <div className="flex items-center gap-2 text-emerald-400 font-semibold">
            <CheckCircle className="w-5 h-5" /> Audit chain valid
          </div>
          <pre className="text-xs text-slate-400 bg-navy-700/50 rounded-lg p-3 overflow-auto max-h-80">
            {JSON.stringify(result, null, 2)}
          </pre>
        </div>
      )}

      {status === "fail" && (
        <div className="card border-red-500/30 space-y-3">
          <div className="flex items-center gap-2 text-red-400 font-semibold">
            <XCircle className="w-5 h-5" /> Verification failed
          </div>
          <pre className="text-xs text-red-400/80 bg-navy-700/50 rounded-lg p-3 overflow-auto max-h-80">
            {JSON.stringify(result, null, 2)}
          </pre>
        </div>
      )}

      {status === "idle" && (
        <div className="card text-center text-slate-500 py-12">
          <Shield className="w-8 h-8 mx-auto mb-2 opacity-20" />
          <p className="text-sm">Enter a repository path and click Verify.</p>
        </div>
      )}
    </div>
  );
}
