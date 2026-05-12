import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Zap, Loader2, CheckCircle, AlertTriangle, FolderOpen, GitBranch } from "lucide-react";
import { api, type CaptureRequest } from "../api/client.ts";

const SENSITIVITY = ["public", "internal", "restricted"] as const;
const TARGETS = ["outbox", "api", "both"] as const;

export default function NewCase() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [message, setMessage] = useState("");
  const [form, setForm] = useState<CaptureRequest>({
    repoPath: "",
    commitRange: "",
    title: "",
    rootCause: "",
    whyNotCaught: "",
    whyFixWorked: "",
    preventNextTime: "",
    generalizablePattern: "",
    tags: [],
    sensitivity: "internal",
    target: "outbox",
    dryRun: true,
  });
  const [tagsInput, setTagsInput] = useState("");

  const set = (k: keyof CaptureRequest, v: unknown) =>
    setForm(prev => ({ ...prev, [k]: v }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus("loading");
    try {
      const payload: CaptureRequest = {
        ...form,
        tags: tagsInput ? tagsInput.split(",").map(t => t.trim()).filter(Boolean) : [],
        commitRange: form.commitRange || undefined,
        generalizablePattern: form.generalizablePattern || undefined,
      };
      await api.cases.capture(payload);
      setStatus("success");
      setMessage("Why case captured! Check the outbox on the dashboard.");
      setTimeout(() => navigate("/"), 2000);
    } catch (err) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : "Capture failed");
    }
  };

  const Field = ({ id, label, value, onChange, placeholder, rows }: {
    id: string; label: string; value: string;
    onChange: (v: string) => void; placeholder?: string; rows?: number;
  }) => (
    <div>
      <label className="label" htmlFor={id}>{label}</label>
      {rows ? (
        <textarea
          id={id} rows={rows} className="input resize-none" required
          placeholder={placeholder} value={value} onChange={e => onChange(e.target.value)}
        />
      ) : (
        <input id={id} className="input" required placeholder={placeholder}
          value={value} onChange={e => onChange(e.target.value)} />
      )}
    </div>
  );

  return (
    <div className="max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold mb-6 flex items-center gap-2">
        <Zap className="text-teal-400 w-6 h-6" /> New Why Case
      </h1>

      <form onSubmit={submit} className="space-y-5">
        {/* Repo + range */}
        <div className="card space-y-4">
          <h2 className="text-sm font-semibold text-teal-400 uppercase tracking-wider">Context</h2>
          <Field id="repoPath" label={<><FolderOpen className="w-3.5 h-3.5 inline mr-1" />Repository Path</>  as unknown as string}
            value={form.repoPath} onChange={v => set("repoPath", v)} placeholder="/path/to/repo" />
          <div>
            <label className="label" htmlFor="commitRange">
              <GitBranch className="w-3.5 h-3.5 inline mr-1" />Commit Range <span className="text-slate-500">(optional)</span>
            </label>
            <input id="commitRange" className="input font-mono text-sm" placeholder="abc1234..def5678"
              value={form.commitRange ?? ""} onChange={e => set("commitRange", e.target.value)} />
          </div>
        </div>

        {/* Analysis */}
        <div className="card space-y-4">
          <h2 className="text-sm font-semibold text-teal-400 uppercase tracking-wider">Analysis</h2>
          <Field id="title" label="Title" value={form.title} onChange={v => set("title", v)}
            placeholder="Short descriptive title of the issue" />
          <Field id="rootCause" label="Root Cause" rows={3} value={form.rootCause}
            onChange={v => set("rootCause", v)} placeholder="What was the actual root cause?" />
          <Field id="whyNotCaught" label="Why Wasn't It Caught?" rows={2} value={form.whyNotCaught}
            onChange={v => set("whyNotCaught", v)} placeholder="What failed in the detection/review process?" />
          <Field id="whyFixWorked" label="Why Did the Fix Work?" rows={2} value={form.whyFixWorked}
            onChange={v => set("whyFixWorked", v)} placeholder="What made the fix effective?" />
          <Field id="preventNextTime" label="Prevention" rows={3} value={form.preventNextTime}
            onChange={v => set("preventNextTime", v)} placeholder="What process/test/guard prevents recurrence?" />
          <div>
            <label className="label" htmlFor="pattern">
              Generalizable Pattern <span className="text-slate-500">(optional)</span>
            </label>
            <textarea id="pattern" rows={2} className="input resize-none"
              placeholder="If this pattern applies broadly, describe it here"
              value={form.generalizablePattern ?? ""}
              onChange={e => set("generalizablePattern", e.target.value)} />
          </div>
        </div>

        {/* Meta */}
        <div className="card space-y-4">
          <h2 className="text-sm font-semibold text-teal-400 uppercase tracking-wider">Metadata</h2>
          <div>
            <label className="label" htmlFor="tags">Tags <span className="text-slate-500">(comma-separated)</span></label>
            <input id="tags" className="input" placeholder="auth, regression, performance"
              value={tagsInput} onChange={e => setTagsInput(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Sensitivity</label>
              <select className="input" value={form.sensitivity}
                onChange={e => set("sensitivity", e.target.value)}>
                {SENSITIVITY.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Target</label>
              <select className="input" value={form.target}
                onChange={e => set("target", e.target.value)}>
                {TARGETS.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <input type="checkbox" id="dryRun" className="w-4 h-4 accent-teal-500"
              checked={form.dryRun ?? true} onChange={e => set("dryRun", e.target.checked)} />
            <label htmlFor="dryRun" className="text-sm text-slate-300">
              Dry run <span className="text-slate-500">(simulate publish without writing)</span>
            </label>
          </div>
        </div>

        {/* Status */}
        {status === "success" && (
          <div className="flex items-center gap-2 text-emerald-400 card border-emerald-500/30">
            <CheckCircle className="w-4 h-4" /> {message}
          </div>
        )}
        {status === "error" && (
          <div className="flex items-center gap-2 text-red-400 card border-red-500/30">
            <AlertTriangle className="w-4 h-4" /> {message}
          </div>
        )}

        <button type="submit" className="btn-primary w-full flex items-center justify-center gap-2"
          disabled={status === "loading"}>
          {status === "loading" ? (
            <><Loader2 className="w-4 h-4 animate-spin" /> Capturing…</>
          ) : (
            <><Zap className="w-4 h-4" /> Capture Why Case</>
          )}
        </button>
      </form>
    </div>
  );
}
