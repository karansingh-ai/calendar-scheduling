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

/** Google's four-color "G" mark, as required by its sign-in branding guidelines. */
function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" className="h-[18px] w-[18px] shrink-0">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

/** "Continue with ..." button for the configured single sign-on provider. Google gets its branded style. */
function SsoButton({ returnTo }: { returnTo?: string }) {
  const { status } = useAuth();
  if (!status?.oidc.enabled) return null;
  const href = `/api/auth/oidc/start${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ""}`;
  if (status.oidc.provider === "google") {
    return (
      <a
        href={href}
        className="flex w-full items-center justify-center gap-3 rounded-md border border-[#747775] bg-white px-3.5 py-2 text-sm font-medium text-[#1f1f1f] hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
      >
        <GoogleMark />
        Continue with Google
      </a>
    );
  }
  return (
    <a href={href} className="flex w-full items-center justify-center rounded-md bg-gray-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-gray-800">
      Continue with {status.oidc.name}
    </a>
  );
}

const ERRORS: Record<string, string> = {
  sso_failed: "Single sign-on failed. Please try again.",
  sso_expired: "The sign-in attempt expired. Please try again.",
  sso_not_allowed: "Your account is not allowed to sign in here. Ask an admin for an invite.",
  sso_email_unverified: "Your identity provider did not confirm your email address, so it cannot be used to sign in here.",
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
        <SsoButton returnTo={returnTo} />
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
        <SsoButton />
        {status?.oidc.enabled && <div className="text-center text-xs uppercase tracking-wide text-gray-400">or set a password</div>}
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
