import { Outlet, NavLink, useLocation } from "react-router-dom";
import { GitBranch, Plus, Shield, LayoutDashboard } from "lucide-react";

const nav = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard },
  { to: "/new", label: "New Case", icon: Plus },
  { to: "/audit", label: "Audit Chain", icon: Shield },
];

export default function Layout() {
  const { pathname } = useLocation();

  return (
    <div className="min-h-screen flex flex-col">
      {/* Top nav */}
      <header className="border-b border-navy-700 bg-navy-800/80 backdrop-blur sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 h-14 flex items-center gap-6">
          <div className="flex items-center gap-2 mr-4">
            <GitBranch className="text-teal-400 w-5 h-5" />
            <span className="font-semibold text-slate-100 tracking-wide">Why Engine</span>
            <span className="text-xs text-slate-500 font-mono">v0.1.2</span>
          </div>

          <nav className="flex gap-1">
            {nav.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                end={to === "/"}
                className={({ isActive }) =>
                  `flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-colors ${
                    isActive
                      ? "bg-teal-500/15 text-teal-400"
                      : "text-slate-400 hover:text-slate-200 hover:bg-navy-700"
                  }`
                }
              >
                <Icon className="w-4 h-4" />
                {label}
              </NavLink>
            ))}
          </nav>

          <div className="ml-auto">
            <a
              href="https://github.com/rblake2320/why-engine"
              target="_blank"
              rel="noreferrer"
              className="text-slate-500 hover:text-slate-300 transition-colors text-xs font-mono"
            >
              github ↗
            </a>
          </div>
        </div>
      </header>

      {/* Page content */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 py-8">
        <Outlet />
      </main>

      <footer className="border-t border-navy-700 py-3 text-center text-xs text-slate-600 font-mono">
        why-engine · MIT · {pathname}
      </footer>
    </div>
  );
}
