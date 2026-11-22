import { useState, type FormEvent, type ReactNode } from "react";
import { Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useAuth } from "../../auth";
import { Button, Card, ErrorBanner, Field, Input, Loading, Select } from "../../components/ui";
import { api, type User } from "../../lib/api";
import { useAction, useApi } from "../../lib/hooks";
import { allTimeZones, browserTimeZone } from "../../lib/time";

function AuthCard({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  const { status } = useAuth();
  return (
    <div className="flex min-h-full items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <img src="/favicon.svg" alt="" className="mx-auto mb-3 h-10 w-10" />
          <p className="text-sm font-medium text-gray-500">{status?.appName}</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-gray-500">{subtitle}</p>}
        </div>
        <Card className="p-6">{children}</Card>
      </div>
    </div>
  );
}

const ERRORS: Record<string, string> = {
  sso_failed: "Single sign-on failed. Please try again.",
  sso_expired: "The sign-in attempt expired. Please try again.",
  sso_not_allowed: "Your account is not allowed to sign in here. Ask an admin for an invite.",
  sso_account_conflict: "This email belongs to an account linked to a different sign-in identity. Ask an admin for help.",
  account_disabled: "This account is disabled.",
};

export function LoginPage() {
  const { status, setUser } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const { pending, error, run } = useAction();
  const returnTo = params.get("returnTo")?.startsWith("/") ? params.get("returnTo")! : "/app";

  if (!status) return <Loading />;
  if (status.setupRequired) return <Navigate to="/setup" replace />;
  if (status.user) return <Navigate to={returnTo} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await run(() => api<{ user: User }>("/auth/login", { body: { email, password } }));
    if (r) {
      setUser(r.user);
      navigate(returnTo, { replace: true });
    }
  };

  return (
    <AuthCard title={`Sign in to ${status.orgName}`}>
      <div className="space-y-4">
        <ErrorBanner error={error ?? (params.get("error") ? ERRORS[params.get("error")!] ?? "Sign-in failed" : null)} />
        {status.oidc.enabled && (
          <a href={`/api/auth/oidc/start?returnTo=${encodeURIComponent(returnTo)}`} className="flex w-full items-center justify-center rounded-md bg-gray-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-gray-800">
            Continue with {status.oidc.name}
          </a>
        )}
        {status.oidc.enabled && status.passwordLogin && <div className="text-center text-xs uppercase tracking-wide text-gray-400">or</div>}
        {(status.passwordLogin || !status.oidc.enabled) && (
          <form onSubmit={submit} className="space-y-4">
            <Field label="Email">
              <Input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field label="Password">
              <Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <Button type="submit" className="w-full" loading={pending}>
              Sign in
            </Button>
          </form>
        )}
      </div>
    </AuthCard>
  );
}

export function SetupPage() {
  const { status, refresh } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ orgName: "", name: "", email: "", password: "", timezone: browserTimeZone() });
  const { pending, error, run } = useAction();
  if (!status) return <Loading />;
  if (!status.setupRequired) return <Navigate to="/login" replace />;
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await run(() => api("/auth/setup", { body: form }));
    if (r) {
      await refresh();
      navigate("/app/event-types", { replace: true });
    }
  };
  return (
    <AuthCard title="Set up your workspace" subtitle="You'll be the owner. You can invite your team next.">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Company name">
          <Input required value={form.orgName} onChange={set("orgName")} placeholder="Acme Inc." />
        </Field>
        <Field label="Your name">
          <Input required autoComplete="name" value={form.name} onChange={set("name")} />
        </Field>
        <Field label="Work email">
          <Input required type="email" autoComplete="email" value={form.email} onChange={set("email")} />
        </Field>
        <Field label="Password" hint="At least 10 characters.">
          <Input required type="password" autoComplete="new-password" minLength={10} value={form.password} onChange={set("password")} />
        </Field>
        <Field label="Time zone">
          <Select value={form.timezone} onChange={set("timezone")}>
            {allTimeZones().map((z) => (
              <option key={z}>{z}</option>
            ))}
          </Select>
        </Field>
        <ErrorBanner error={error} />
        <Button type="submit" className="w-full" loading={pending}>
          Create workspace
        </Button>
      </form>
    </AuthCard>
  );
}

export function InvitePage() {
  const { token } = useParams();
  const { refresh, status } = useAuth();
  const navigate = useNavigate();
  const { data, error: loadError, loading } = useApi<{ email: string; name: string }>(`/auth/invite/${token}`);
  const [name, setName] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [timezone, setTimezone] = useState(browserTimeZone());
  const { pending, error, run } = useAction();
  if (loading) return <Loading />;
  if (loadError || !data) {
    return (
      <AuthCard title="Invite link">
        <ErrorBanner error={loadError ?? "Invalid invite"} />
      </AuthCard>
    );
  }
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await run(() => api(`/auth/invite/${token}`, { body: { password, name: name ?? data.name, timezone } }));
    if (r) {
      await refresh();
      navigate("/app/availability", { replace: true });
    }
  };
  return (
    <AuthCard title={`Join ${status?.orgName ?? ""}`} subtitle={data.email}>
      <form onSubmit={submit} className="space-y-4">
        {status?.oidc.enabled && (
          <a href="/api/auth/oidc/start" className="flex w-full items-center justify-center rounded-md bg-gray-900 px-3.5 py-2 text-sm font-medium text-white">
            Continue with {status.oidc.name}
          </a>
        )}
        <Field label="Your name">
          <Input required value={name ?? data.name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Choose a password" hint="At least 10 characters.">
          <Input required type="password" minLength={10} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Field label="Time zone">
          <Select value={timezone} onChange={(e) => setTimezone(e.target.value)}>
            {allTimeZones().map((z) => (
              <option key={z}>{z}</option>
            ))}
          </Select>
        </Field>
        <ErrorBanner error={error} />
        <Button type="submit" className="w-full" loading={pending}>
          Join
        </Button>
      </form>
    </AuthCard>
  );
}
