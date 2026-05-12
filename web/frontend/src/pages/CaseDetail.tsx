import { useEffect, useState } from "react";
import { useParams, useSearchParams, Link } from "react-router-dom";
import { ArrowLeft, Loader2, AlertTriangle, Tag, Lock, Globe, Building, ExternalLink } from "lucide-react";
import { api, type WhyCase } from "../api/client.ts";

const sensitivityIcon = { public: Globe, internal: Building, restricted: Lock };
const sensitivityColor = {
  public: "bg-emerald-500/15 text-emerald-400 border-emerald-500/20",
  internal: "bg-yellow-500/15 text-yellow-400 border-yellow-500/20",
  restricted: "bg-red-500/15 text-red-400 border-red-500/20",
};

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <dt className="text-xs font-semibold text-slate-500 uppercase tracking-wider">{label}</dt>
      <dd className="text-slate-200 text-sm leading-relaxed bg-navy-700/50 rounded-lg px-3 py-2.5 whitespace-pre-wrap">
        {children}
      </dd>
    </div>
  );
}

export default function CaseDetail() {
  const { caseId } = useParams<{ caseId: string }>();
  const [searchParams] = useSearchParams();
  const repoPath = searchParams.get("repoPath") ?? "";

  const [wc, setWc] = useState<WhyCase | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!caseId || !repoPath) return;
    api.outbox.get(repoPath, caseId)
      .then(setWc)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [caseId, repoPath]);

  if (loading) return (
    <div className="flex items-center gap-2 text-slate-400">
      <Loader2 className="w-4 h-4 animate-spin" /> Loading case…
    </div>
  );
  if (error) return (
    <div className="flex items-center gap-2 text-red-400 card border-red-500/30">
      <AlertTriangle className="w-4 h-4" /> {error}
    </div>
  );
  if (!wc) return null;

  const Icon = sensitivityIcon[wc.sensitivity] ?? Globe;
  const color = sensitivityColor[wc.sensitivity] ?? sensitivityColor.public;

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Link to="/" className="btn-secondary flex items-center gap-1 text-sm">
          <ArrowLeft className="w-4 h-4" /> Back
        </Link>
        <span className={`badge border ${color}`}>
          <Icon className="w-3 h-3 mr-1" />{wc.sensitivity}
        </span>
        {!wc.secretScanResult.clean && (
          <span className="badge bg-red-500/15 text-red-400 border border-red-500/20">
            <AlertTriangle className="w-3 h-3 mr-1" /> secrets detected
          </span>
        )}
      </div>

      <h1 className="text-2xl font-bold text-slate-100">{wc.title}</h1>
      <p className="text-xs text-slate-500 font-mono">{wc.caseId} · {new Date(wc.createdAt).toLocaleString()}</p>

      <dl className="space-y-4">
        <Section label="Root Cause">{wc.rootCause}</Section>
        <Section label="Why Wasn't It Caught?">{wc.whyNotCaught}</Section>
        <Section label="Why the Fix Worked">{wc.whyFixWorked}</Section>
        <Section label="Prevention">{wc.preventNextTime}</Section>
        {wc.generalizablePattern && (
          <Section label="Generalizable Pattern">{wc.generalizablePattern}</Section>
        )}
      </dl>

      {wc.tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {wc.tags.map(t => (
            <span key={t} className="badge bg-navy-700 text-slate-400">
              <Tag className="w-2.5 h-2.5 mr-1" />{t}
            </span>
          ))}
        </div>
      )}

      {(wc.links?.issueUrl || wc.links?.prUrl) && (
        <div className="card flex gap-4 text-sm">
          {wc.links.issueUrl && (
            <a href={wc.links.issueUrl} target="_blank" rel="noreferrer"
              className="text-teal-400 hover:text-teal-300 flex items-center gap-1">
              <ExternalLink className="w-4 h-4" /> Issue
            </a>
          )}
          {wc.links.prUrl && (
            <a href={wc.links.prUrl} target="_blank" rel="noreferrer"
              className="text-teal-400 hover:text-teal-300 flex items-center gap-1">
              <ExternalLink className="w-4 h-4" /> Pull Request
            </a>
          )}
        </div>
      )}
    </div>
  );
}
