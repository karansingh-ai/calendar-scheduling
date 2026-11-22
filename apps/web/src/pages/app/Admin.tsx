import { useEffect, useState, type FormEvent } from "react";
import { useAuth, useUser } from "../../auth";
import { applyBrand } from "../../auth";
import { Badge, Button, Card, ErrorBanner, Field, Input, Loading, PageHeader, SecretReveal, Section, Select } from "../../components/ui";
import { api, type User } from "../../lib/api";
import { useAction, useApi } from "../../lib/hooks";

export function UsersPage() {
  const me = useUser();
  const { data, error, loading, reload } = useApi<{ users: User[] }>("/v1/admin/users");
  const [form, setForm] = useState({ email: "", name: "", role: "member" });
  const [invite, setInvite] = useState<{ url: string; emailed: boolean } | null>(null);
  const action = useAction();
  if (loading && !data) return <Loading />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await action.run(() => api<{ inviteUrl: string; emailed: boolean }>("/v1/admin/users", { body: form }));
    if (r) {
      setInvite({ url: r.inviteUrl, emailed: r.emailed });
      setForm({ email: "", name: "", role: "member" });
      await reload();
    }
  };
  const update = (id: string, body: Record<string, unknown>) =>
    action.run(async () => {
      await api(`/v1/admin/users/${id}`, { method: "PATCH", body });
      await reload();
    });

  return (
    <>
      <PageHeader title="People" description="Invite colleagues and manage roles. With single sign-on enabled, people can also join by signing in." />
      <div className="space-y-6">
        <Section title="Invite someone">
          <form onSubmit={submit} className="grid gap-3 sm:grid-cols-[1fr_1fr_140px_auto] sm:items-end">
            <Field label="Email">
              <Input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </Field>
            <Field label="Name">
              <Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label="Role">
              <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </Select>
            </Field>
            <Button type="submit" loading={action.pending}>
              Invite
            </Button>
          </form>
          {invite && (
            <SecretReveal label={invite.emailed ? "Invite sent. You can also share this link (valid 7 days):" : "Email is not configured; share this invite link (valid 7 days):"} secret={invite.url} onDone={() => setInvite(null)} />
          )}
          <ErrorBanner error={error ?? action.error} />
        </Section>
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b bg-gray-50 text-left text-xs text-gray-500">
              <tr>
                <th className="px-4 py-2">Person</th>
                <th>Role</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data?.users.map((u) => (
                <tr key={u.id} className="border-t">
                  <td className="px-4 py-3">
                    <p className="font-medium">{u.name}</p>
                    <p className="text-gray-500">{u.email}</p>
                  </td>
                  <td className="w-40">
                    {u.role === "owner" || u.id === me.id ? (
                      <Badge tone="blue">{u.role}</Badge>
                    ) : (
                      <Select value={u.role} onChange={(e) => update(u.id, { role: e.target.value })}>
                        <option value="member">Member</option>
                        <option value="admin">Admin</option>
                      </Select>
                    )}
                  </td>
                  <td>{u.disabled ? <Badge tone="red">Disabled</Badge> : u.hasPassword ? <Badge tone="green">Active</Badge> : <Badge tone="amber">Invited</Badge>}</td>
                  <td className="px-4 text-right">
                    {u.id !== me.id && u.role !== "owner" && (
                      <div className="flex justify-end gap-2">
                        {!u.hasPassword && !u.disabled && (
                          <Button
                            variant="ghost"
                            onClick={() =>
                              action.run(async () => {
                                const r = await api<{ inviteUrl: string; emailed: boolean }>(`/v1/admin/users/${u.id}/invite`, { method: "POST" });
                                setInvite({ url: r.inviteUrl, emailed: r.emailed });
                              })
                            }
                          >
                            Resend invite
                          </Button>
                        )}
                        <Button variant={u.disabled ? "secondary" : "danger"} onClick={() => update(u.id, { disabled: !u.disabled })}>
                          {u.disabled ? "Enable" : "Disable"}
                        </Button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
    </>
  );
}

interface AuditEntry {
  id: number;
  actorLabel: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
  createdAt: string;
}

export function AuditPage() {
  const [action, setAction] = useState("");
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const run = useAction();
  const load = async (before?: number) => {
    const qs = new URLSearchParams({ limit: "100", ...(before ? { before: String(before) } : {}), ...(action ? { action } : {}) });
    const r = await run.run(() => api<{ entries: AuditEntry[]; nextBefore: number | null }>(`/v1/admin/audit?${qs}`));
    if (r) {
      setEntries((e) => (before ? [...(e ?? []), ...r.entries] : r.entries));
      setNext(r.nextBefore);
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <>
      <PageHeader
        title="Audit log"
        description="Sign-ins, configuration changes and every booking change. Kept until you delete it."
        actions={
          <a href="/api/v1/admin/audit.csv">
            <Button variant="secondary">Export CSV</Button>
          </a>
        }
      />
      <form
        className="mb-4 flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void load();
        }}
      >
        <Field label="Filter by action prefix">
          <Input value={action} onChange={(e) => setAction(e.target.value)} placeholder="booking." />
        </Field>
        <Button type="submit" variant="secondary">
          Filter
        </Button>
      </form>
      <ErrorBanner error={run.error} />
      {!entries ? (
        <Loading />
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b bg-gray-50 text-left text-xs text-gray-500">
              <tr>
                <th className="px-4 py-2">When</th>
                <th>Who</th>
                <th>Action</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className="border-t align-top">
                  <td className="whitespace-nowrap px-4 py-2 text-gray-500">{new Date(e.createdAt).toLocaleString()}</td>
                  <td className="py-2 pr-4">{e.actorLabel}</td>
                  <td className="py-2 pr-4">
                    <code className="text-xs">{e.action}</code>
                  </td>
                  <td className="max-w-md py-2 pr-4 text-xs text-gray-600">
                    {e.targetType && (
                      <p>
                        {e.targetType} {e.targetId}
                      </p>
                    )}
                    {Object.keys(e.metadata).length > 0 && <p className="break-all font-mono">{JSON.stringify(e.metadata)}</p>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {next && (
        <Button variant="secondary" className="mt-4" onClick={() => load(next)} loading={run.pending}>
          Load older
        </Button>
      )}
    </>
  );
}

export function OrgPage() {
  const { refresh } = useAuth();
  const { data, loading } = useApi<{ org: { name: string; brandColor: string; logoUrl: string | null } }>("/v1/admin/org");
  const [form, setForm] = useState<{ name: string; brandColor: string; logoUrl: string } | null>(null);
  const action = useAction();
  const [saved, setSaved] = useState(false);
  if (loading || !data) return <Loading />;
  const f = form ?? { name: data.org.name, brandColor: data.org.brandColor, logoUrl: data.org.logoUrl ?? "" };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await action.run(() => api("/v1/admin/org", { method: "PATCH", body: { ...f, logoUrl: f.logoUrl || null } }));
    if (r) {
      applyBrand(f.brandColor);
      await refresh();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  };
  return (
    <>
      <PageHeader title="Organization" description="Branding shown on booking pages and emails." />
      <Section title="Branding">
        <form onSubmit={submit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Organization name">
              <Input value={f.name} onChange={(e) => setForm({ ...f, name: e.target.value })} required />
            </Field>
            <Field label="Brand color">
              <Input type="color" value={f.brandColor} onChange={(e) => setForm({ ...f, brandColor: e.target.value })} className="h-10 p-1" />
            </Field>
          </div>
          <Field label="Logo URL" hint="Shown at the top of public booking pages.">
            <Input type="url" value={f.logoUrl} onChange={(e) => setForm({ ...f, logoUrl: e.target.value })} />
          </Field>
          <ErrorBanner error={action.error} />
          <div className="flex items-center gap-3">
            <Button type="submit" loading={action.pending}>
              Save
            </Button>
            {saved && <span className="text-sm text-green-700">Saved</span>}
          </div>
        </form>
      </Section>
    </>
  );
}
