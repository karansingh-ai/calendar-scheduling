import { useState, type FormEvent } from "react";
import { isAdmin, useAuth, useUser } from "../../auth";
import { Badge, Button, ErrorBanner, Field, Input, PageHeader, SecretReveal, Section, Select, Textarea } from "../../components/ui";
import { api, type User } from "../../lib/api";
import { useAction, useApi } from "../../lib/hooks";
import { allTimeZones } from "../../lib/time";

function Profile() {
  const user = useUser();
  const { setUser } = useAuth();
  const [form, setForm] = useState({ name: user.name, username: user.username, timezone: user.timezone, welcomeMessage: user.welcomeMessage ?? "" });
  const action = useAction();
  const [saved, setSaved] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await action.run(() => api<{ user: User }>("/v1/me", { method: "PATCH", body: { ...form, welcomeMessage: form.welcomeMessage || null } }));
    if (r) {
      setUser(r.user);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  };
  return (
    <Section title="Profile">
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          </Field>
          <Field label="Username" hint={`${window.location.origin}/${form.username}`}>
            <Input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value.toLowerCase() })} required />
          </Field>
          <Field label="Time zone" hint="Used for your emails and dashboard. Booking hours use each schedule's own time zone.">
            <Select value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })}>
              {allTimeZones().map((z) => (
                <option key={z}>{z}</option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Welcome message" hint="Shown on your public page.">
          <Textarea value={form.welcomeMessage} onChange={(e) => setForm({ ...form, welcomeMessage: e.target.value })} />
        </Field>
        <ErrorBanner error={action.error} />
        <div className="flex items-center gap-3">
          <Button type="submit" loading={action.pending}>
            Save profile
          </Button>
          {saved && <span className="text-sm text-green-700">Saved</span>}
        </div>
      </form>
    </Section>
  );
}

function Password() {
  const user = useUser();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const action = useAction();
  const [done, setDone] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await action.run(() => api("/auth/password", { body: { currentPassword: current || undefined, newPassword: next } }));
    if (r) {
      setCurrent("");
      setNext("");
      setDone(true);
    }
  };
  return (
    <Section title="Password">
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        {user.hasPassword && (
          <Field label="Current password">
            <Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
          </Field>
        )}
        <Field label="New password">
          <Input type="password" autoComplete="new-password" minLength={10} value={next} onChange={(e) => setNext(e.target.value)} required />
        </Field>
        <Button type="submit" loading={action.pending}>
          {user.hasPassword ? "Change password" : "Set password"}
        </Button>
      </form>
      <ErrorBanner error={action.error} />
      {done && <p className="text-sm text-green-700">Password updated.</p>}
    </Section>
  );
}

function ApiKeys() {
  const { data, reload } = useApi<{ apiKeys: { id: string; name: string; prefix: string; lastUsedAt: string | null; createdAt: string }[] }>("/v1/api-keys");
  const [name, setName] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const action = useAction();
  const create = async (e: FormEvent) => {
    e.preventDefault();
    const r = await action.run(() => api<{ secret: string }>("/v1/api-keys", { body: { name } }));
    if (r) {
      setSecret(r.secret);
      setName("");
      await reload();
    }
  };
  return (
    <Section title="API keys" description={<>Use with <code>Authorization: Bearer &lt;key&gt;</code>. See the API reference at <a className="text-brand underline" href="/api/openapi.yaml">/api/openapi.yaml</a>.</>}>
      {secret && <SecretReveal label="Copy your new key now. It will not be shown again." secret={secret} onDone={() => setSecret(null)} />}
      <form onSubmit={create} className="flex items-end gap-2">
        <Field label="Key name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="CRM sync" required />
        </Field>
        <Button type="submit" loading={action.pending}>
          Create key
        </Button>
      </form>
      <ErrorBanner error={action.error} />
      {data?.apiKeys.map((k) => (
        <div key={k.id} className="flex items-center justify-between border-t pt-3 text-sm">
          <div>
            <p className="font-medium">{k.name}</p>
            <p className="text-gray-500">
              <code>{k.prefix}...</code> · {k.lastUsedAt ? `last used ${new Date(k.lastUsedAt).toLocaleString()}` : "never used"}
            </p>
          </div>
          <Button variant="danger" onClick={() => action.run(async () => { await api(`/v1/api-keys/${k.id}`, { method: "DELETE" }); await reload(); })}>
            Revoke
          </Button>
        </div>
      ))}
    </Section>
  );
}

const EVENTS = ["booking.created", "booking.rescheduled", "booking.cancelled"];

function Webhooks() {
  const user = useUser();
  const { data, reload } = useApi<{ webhooks: { id: string; url: string; events: string[]; scope: string; active: boolean }[] }>("/v1/webhooks");
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<string[]>(EVENTS);
  const [scope, setScope] = useState<"user" | "org">("user");
  const [secret, setSecret] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const action = useAction();
  const create = async (e: FormEvent) => {
    e.preventDefault();
    const r = await action.run(() => api<{ secret: string }>("/v1/webhooks", { body: { url, events, scope } }));
    if (r) {
      setSecret(r.secret);
      setUrl("");
      await reload();
    }
  };
  return (
    <Section title="Webhooks" description="Get a signed POST when bookings are created, rescheduled or cancelled. Verify the x-webhook-signature header (HMAC-SHA256 of `timestamp.body`).">
      {secret && <SecretReveal label="Signing secret. Store it now; it will not be shown again." secret={secret} onDone={() => setSecret(null)} />}
      <form onSubmit={create} className="space-y-3">
        <Field label="Endpoint URL">
          <Input type="url" value={url} onChange={(e) => setUrl(e.target.value)} required placeholder="https://example.com/webhooks/scheduler" />
        </Field>
        <div className="flex flex-wrap gap-4 text-sm">
          {EVENTS.map((ev) => (
            <label key={ev} className="flex items-center gap-2">
              <input type="checkbox" checked={events.includes(ev)} onChange={(e) => setEvents(e.target.checked ? [...events, ev] : events.filter((x) => x !== ev))} />
              {ev}
            </label>
          ))}
        </div>
        {isAdmin(user) && (
          <Field label="Scope">
            <Select value={scope} onChange={(e) => setScope(e.target.value as "user" | "org")} className="max-w-xs">
              <option value="user">My bookings</option>
              <option value="org">Every booking in the organization</option>
            </Select>
          </Field>
        )}
        <Button type="submit" loading={action.pending} disabled={events.length === 0}>
          Add webhook
        </Button>
      </form>
      <ErrorBanner error={action.error} />
      {testResult && <p className="text-sm">{testResult}</p>}
      {data?.webhooks.map((w) => (
        <div key={w.id} className="flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-sm">
          <div className="min-w-0">
            <p className="truncate font-medium">{w.url}</p>
            <p className="text-gray-500">
              {w.events.join(", ")} {w.scope === "org" && <Badge tone="blue">Org-wide</Badge>} {!w.active && <Badge tone="amber">Paused</Badge>}
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              onClick={() =>
                action.run(async () => {
                  const r = await api<{ ok: boolean; status: number | null; error?: string }>(`/v1/webhooks/${w.id}/test`, { method: "POST" });
                  setTestResult(r.ok ? `Test ping delivered (HTTP ${r.status}).` : `Test ping failed: ${r.error ?? `HTTP ${r.status}`}`);
                })
              }
            >
              Send test
            </Button>
            <Button variant="ghost" onClick={() => action.run(async () => { await api(`/v1/webhooks/${w.id}`, { method: "PATCH", body: { active: !w.active } }); await reload(); })}>
              {w.active ? "Pause" : "Resume"}
            </Button>
            <Button variant="danger" onClick={() => action.run(async () => { await api(`/v1/webhooks/${w.id}`, { method: "DELETE" }); await reload(); })}>
              Delete
            </Button>
          </div>
        </div>
      ))}
    </Section>
  );
}

export function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" />
      <div className="space-y-6">
        <Profile />
        <Password />
        <ApiKeys />
        <Webhooks />
      </div>
    </>
  );
}
