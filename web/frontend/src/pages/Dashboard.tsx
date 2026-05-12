import { useState } from "react";
import { Link } from "react-router-dom";
import { Search, Plus, FolderOpen, Loader2, AlertTriangle } from "lucide-react";
import { useOutbox } from "../hooks/useOutbox.ts";
import CaseCard from "../components/CaseCard.tsx";
import HeroGraph from "../components/HeroGraph.tsx";

export default function Dashboard() {
  const [repoPath, setRepoPath] = useState("");
  const [query, setQuery] = useState("");
  const { cases, total, loading, error, refetch } = useOutbox(repoPath);

  const filtered = cases.filter(c =>
    !query ||
    c.title.toLowerCase().includes(query.toLowerCase()) ||
    c.rootCause.toLowerCase().includes(query.toLowerCase()) ||
    c.tags.some(t => t.toLowerCase().includes(query.toLowerCase()))
  );

  return (
    <div className="space-y-8">
      {/* Hero */}
      <div
        className="relative rounded-2xl overflow-hidden bg-navy-800 border border-navy-700 h-48 flex items-center"
        style={{ backgroundImage: "url(/hero-banner.png)", backgroundSize: "cover", backgroundPosition: "center" }}
      >
        <div className="absolute inset-0 bg-navy-900/60">
          <HeroGraph />
        </div>
        <div className="relative z-10 px-8">
          <h1 className="text-3xl font-bold text-white">Why Engine</h1>
          <p className="text-slate-400 mt-1">Root-cause analysis · Outbox browser · Audit verification</p>
          <Link to="/new" className="btn-primary inline-flex items-center gap-2 mt-4 text-sm">
            <Plus className="w-4 h-4" /> New Why Case
          </Link>
        </div>
      </div>

      {/* Repo path input */}
      <div className="flex gap-3">
        <div className="flex-1">
          <label className="label" htmlFor="repoPath">
            <FolderOpen className="w-3.5 h-3.5 inline mr-1" />
            Repository Path
          </label>
          <input
            id="repoPath"
            className="input font-mono text-sm"
            placeholder="/path/to/your/repo"
            value={repoPath}
            onChange={e => setRepoPath(e.target.value)}
          />
        </div>
        <div className="flex-1">
          <label className="label" htmlFor="search">
            <Search className="w-3.5 h-3.5 inline mr-1" />
            Search cases
          </label>
          <input
            id="search"
            className="input text-sm"
            placeholder="Filter by title, cause, tag…"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
        </div>
        <div className="flex items-end">
          <button className="btn-secondary" onClick={refetch}>Refresh</button>
        </div>
      </div>

      {/* Stats bar */}
      {total > 0 && (
        <div className="flex gap-6 text-sm">
          <span className="text-slate-400">Total: <span className="text-teal-400 font-semibold">{total}</span></span>
          <span className="text-slate-400">Shown: <span className="text-slate-200 font-semibold">{filtered.length}</span></span>
          <span className="text-slate-400">
            Secrets clean:{" "}
            <span className={cases.every(c => c.secretScanResult.clean) ? "text-emerald-400 font-semibold" : "text-red-400 font-semibold"}>
              {cases.filter(c => c.secretScanResult.clean).length}/{total}
            </span>
          </span>
        </div>
      )}

      {/* States */}
      {loading && (
        <div className="flex items-center gap-2 text-slate-400">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading outbox…
        </div>
      )}
      {error && (
        <div className="flex items-center gap-2 text-red-400 card border-red-500/30">
          <AlertTriangle className="w-4 h-4" /> {error}
        </div>
      )}
      {!loading && !error && repoPath && cases.length === 0 && (
        <div className="card text-center text-slate-500 py-12">
          <FolderOpen className="w-8 h-8 mx-auto mb-2 opacity-30" />
          <p>No why cases found in outbox.</p>
          <Link to="/new" className="text-teal-400 hover:text-teal-300 text-sm mt-1 inline-block">Create the first one →</Link>
        </div>
      )}
      {!repoPath && (
        <div className="card text-center text-slate-500 py-12">
          <p className="text-sm">Enter a repository path above to browse its outbox.</p>
        </div>
      )}

      {/* Cases grid */}
      {filtered.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filtered.map(c => (
            <CaseCard key={c.caseId} wc={c} repoPath={repoPath} />
          ))}
        </div>
      )}
    </div>
  );
}
