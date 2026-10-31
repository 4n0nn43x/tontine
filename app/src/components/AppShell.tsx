import { useState } from "react";
import { Link, NavLink, Outlet } from "react-router-dom";
import { useAppState } from "../lib/hooks";
import { AccountMenu } from "./AccountMenu";

const LINKS = [
  { to: "/app", label: "Dashboard", icon: "fa-gauge-high", end: true },
  { to: "/app/orders", label: "Orders", icon: "fa-right-left" },
  { to: "/app/firms", label: "Firms", icon: "fa-building" },
  { to: "/app/portfolio", label: "Portfolio", icon: "fa-wallet" },
  { to: "/thesis", label: "Thesis", icon: "fa-chart-line" },
];

export function AppShell() {
  const { data, error } = useAppState();
  const [open, setOpen] = useState(false);
  return (
    <div className="app">
      <header className="topbar">
        <Link className="logo small" to="/" aria-label="Tontine, home">
          <img src="/assets/logo.svg" alt="" width="34" height="34" />
        </Link>
        <nav className={`appnav ${open ? "open" : ""}`} aria-label="App">
          {LINKS.map((l) => (
            <NavLink key={l.to} to={l.to} end={l.end} onClick={() => setOpen(false)}>
              <i className={`fa-solid ${l.icon}`} aria-hidden="true" /> {l.label}
            </NavLink>
          ))}
          <NavLink to="/app/trade" className="post-link" onClick={() => setOpen(false)}>
            <i className="fa-solid fa-arrow-right-arrow-left" aria-hidden="true" /> Trade
          </NavLink>
        </nav>
        <span className={`netbadge ${error ? "down" : data ? "up" : ""}`} title={error ?? "Tontine devnet: a NEAR sandbox node with the real contracts"}>
          <span className="live-dot" aria-hidden="true" /> {error ? "offline" : "devnet"}
        </span>
        <AccountMenu />
        <button className="appnav-toggle" aria-label="Menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <i className={`fa-solid ${open ? "fa-xmark" : "fa-bars"}`} aria-hidden="true" />
        </button>
      </header>
      <main className="app-main">
        <Outlet />
      </main>
      <footer className="app-foot">
        <span>Tontine · settled on NEAR</span>
        <Link to="/thesis">Thesis</Link>
      </footer>
    </div>
  );
}
