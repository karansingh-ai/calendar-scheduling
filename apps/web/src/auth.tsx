import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, type User } from "./lib/api";

export interface Status {
  appName: string;
  orgName: string;
  brandColor: string;
  setupRequired: boolean;
  passwordLogin: boolean;
  oidc: { enabled: boolean; name: string; provider: "google" | "generic" };
  integrations: { google: boolean; microsoft: boolean; ics: boolean };
  user: User | null;
}

const AuthContext = createContext<{ status: Status | null; refresh: () => Promise<void>; setUser: (u: User | null) => void } | null>(null);

export function applyBrand(color?: string) {
  if (color) document.documentElement.style.setProperty("--brand", color);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status | null>(null);
  const refresh = useCallback(async () => {
    const s = await api<Status>("/auth/status");
    applyBrand(s.brandColor);
    document.title = s.appName;
    setStatus(s);
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const setUser = (user: User | null) => setStatus((s) => (s ? { ...s, user } : s));
  return <AuthContext.Provider value={{ status, refresh, setUser }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}

export function useUser(): User {
  const { status } = useAuth();
  if (!status?.user) throw new Error("Not signed in");
  return status.user;
}

export const isAdmin = (u: User | null | undefined) => u?.role === "owner" || u?.role === "admin";
