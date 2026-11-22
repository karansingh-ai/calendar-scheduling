import { useState } from "react";
import { Navigate, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { isAdmin, useAuth } from "../auth";
import { api } from "../lib/api";
import { cx, Loading } from "./ui";

const nav = [
  { to: "/app", label: "Bookings", end: true },
  { to: "/app/event-types", label: "Event types" },
  { to: "/app/availability", label: "Availability" },
  { to: "/app/calendars", label: "Calendars" },
  { to: "/app/teams", label: "Teams" },
  { to: "/app/settings", label: "Settings" },
];
const adminNav = [
  { to: "/app/admin/users", label: "People" },
  { to: "/app/admin/audit", label: "Audit log" },
  { to: "/app/admin/org", label: "Organization" },
];

function Item({ to, label, end, onClick }: { to: string; label: string; end?: boolean; onClick?: () => void }) {
  return (
    <NavLink
      to={to}
      end={end}
      onClick={onClick}
      className={({ isActive }) => cx("block rounded-md px-3 py-2 text-sm font-medium", isActive ? "bg-brand/10 text-brand" : "text-gray-700 hover:bg-gray-100")}
    >
      {label}
    </NavLink>
  );
}

export function AppShell() {
  const { status, setUser } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  if (!status) return <Loading />;
  if (status.setupRequired) return <Navigate to="/setup" replace />;
  if (!status.user) return <Navigate to={`/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  const user = status.user;

  const logout = async () => {
    await api("/auth/logout", { method: "POST" });
    setUser(null);
    navigate("/login");
  };

  const sidebar = (
    <nav className="flex h-full flex-col gap-1 p-3">
      <div className="mb-4 flex items-center gap-2 px-2 pt-1">
        <img src="/favicon.svg" alt="" className="h-7 w-7" />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{status.orgName}</p>
          <p className="truncate text-xs text-gray-500">{status.appName}</p>
        </div>
      </div>
      {nav.map((n) => (
        <Item key={n.to} {...n} onClick={() => setOpen(false)} />
      ))}
      {isAdmin(user) && (
        <>
          <p className="mt-4 px-3 text-xs font-semibold uppercase tracking-wide text-gray-400">Admin</p>
          {adminNav.map((n) => (
            <Item key={n.to} {...n} onClick={() => setOpen(false)} />
          ))}
        </>
      )}
      <div className="mt-auto border-t pt-3">
        <a href={`/${user.username}`} target="_blank" rel="noreferrer" className="block truncate px-3 py-1 text-xs text-brand hover:underline">
          /{user.username} ↗
        </a>
        <p className="truncate px-3 pt-2 text-sm font-medium">{user.name}</p>
        <p className="truncate px-3 text-xs text-gray-500">{user.email}</p>
        <button onClick={logout} className="mt-2 w-full rounded-md px-3 py-1.5 text-left text-sm text-gray-600 hover:bg-gray-100">
          Sign out
        </button>
      </div>
    </nav>
  );

  return (
    <div className="flex min-h-full">
      <aside className="hidden w-60 shrink-0 border-r bg-white md:block">{sidebar}</aside>
      {open && (
        <div className="fixed inset-0 z-40 md:hidden" onClick={() => setOpen(false)}>
          <div className="absolute inset-0 bg-black/30" />
          <aside className="absolute inset-y-0 left-0 w-64 bg-white" onClick={(e) => e.stopPropagation()}>
            {sidebar}
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b bg-white px-4 py-3 md:hidden">
          <button onClick={() => setOpen(true)} aria-label="Open menu" className="rounded-md px-2 py-1 text-xl">
            ☰
          </button>
          <span className="font-semibold">{status.orgName}</span>
        </header>
        <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 md:px-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
