import { Link } from "react-router-dom";
import { Lock, Globe, Building, Tag, ExternalLink } from "lucide-react";
import type { WhyCase } from "../api/client.ts";

const sensitivityIcon = {
  public: Globe,
  internal: Building,
  restricted: Lock,
};

const sensitivityColor = {
  public: "bg-emerald-500/15 text-emerald-400",
  internal: "bg-yellow-500/15 text-yellow-400",
  restricted: "bg-red-500/15 text-red-400",
};

export default function CaseCard({ wc, repoPath }: { wc: WhyCase; repoPath: string }) {
  const Icon = sensitivityIcon[wc.sensitivity] ?? Globe;
  const color = sensitivityColor[wc.sensitivity] ?? sensitivityColor.public;

  return (
    <div className="card hover:border-teal-500/30 transition-colors group">
      <div className="flex items-start justify-between gap-3 mb-3">
        <Link
          to={`/cases/${wc.caseId}?repoPath=${encodeURIComponent(repoPath)}`}
          className="font-semibold text-slate-100 group-hover:text-teal-400 transition-colors leading-tight line-clamp-2"
        >
          {wc.title}
        </Link>
        <span className={`badge ${color} shrink-0`}>
          <Icon className="w-3 h-3 mr-1" />
          {wc.sensitivity}
        </span>
      </div>

      <p className="text-sm text-slate-400 line-clamp-2 mb-3">{wc.rootCause}</p>

      <div className="flex items-center justify-between">
        <div className="flex flex-wrap gap-1">
          {wc.tags.slice(0, 4).map(t => (
            <span key={t} className="badge bg-navy-700 text-slate-400">
              <Tag className="w-2.5 h-2.5 mr-1" />{t}
            </span>
          ))}
          {wc.tags.length > 4 && (
            <span className="badge bg-navy-700 text-slate-500">+{wc.tags.length - 4}</span>
          )}
        </div>
        <span className="text-xs text-slate-600 font-mono shrink-0 ml-2">
          {new Date(wc.createdAt).toLocaleDateString()}
        </span>
      </div>

      {(wc.links?.issueUrl || wc.links?.prUrl) && (
        <div className="mt-3 pt-3 border-t border-navy-700 flex gap-3 text-xs">
          {wc.links.issueUrl && (
            <a href={wc.links.issueUrl} target="_blank" rel="noreferrer" className="text-slate-500 hover:text-teal-400 flex items-center gap-1">
              <ExternalLink className="w-3 h-3" /> Issue
            </a>
          )}
          {wc.links.prUrl && (
            <a href={wc.links.prUrl} target="_blank" rel="noreferrer" className="text-slate-500 hover:text-teal-400 flex items-center gap-1">
              <ExternalLink className="w-3 h-3" /> PR
            </a>
          )}
        </div>
      )}
    </div>
  );
}
