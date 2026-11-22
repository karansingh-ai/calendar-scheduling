import { useState, type FormEvent } from "react";
import { isAdmin, useUser } from "../../auth";
import { Badge, Button, Card, CopyButton, EmptyState, ErrorBanner, Field, Input, Loading, PageHeader, Select } from "../../components/ui";
import { api, type Team } from "../../lib/api";
import { useAction, useApi } from "../../lib/hooks";

function TeamCard({ team, canManage, directory, onChange }: { team: Team; canManage: boolean; directory: { id: string; name: string; email: string }[]; onChange: () => void }) {
  const action = useAction();
  const [adding, setAdding] = useState("");
  const save = (members: { userId: string; role: "manager" | "member" }[]) =>
    action.run(async () => {
      await api(`/v1/teams/${team.id}/members`, { method: "PUT", body: { members } });
      onChange();
    });
  const current = team.members.map((m) => ({ userId: m.userId, role: m.role }));
  const url = `${window.location.origin}/team/${team.slug}`;
  return (
    <Card className="p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-semibold">{team.name}</p>
          <a href={url} target="_blank" rel="noreferrer" className="text-sm text-brand hover:underline">
            {url}
          </a>
        </div>
        <CopyButton text={url} label="Copy team link" />
      </div>
      <ErrorBanner error={action.error} />
      <table className="w-full text-sm">
        <tbody>
          {team.members.map((m) => (
            <tr key={m.userId} className="border-t">
              <td className="py-2">
                {m.name} <span className="text-gray-500">{m.email}</span>
              </td>
              <td className="w-40">
                {canManage ? (
                  <Select value={m.role} onChange={(e) => save(current.map((x) => (x.userId === m.userId ? { ...x, role: e.target.value as "manager" | "member" } : x)))}>
                    <option value="member">Member</option>
                    <option value="manager">Manager</option>
                  </Select>
                ) : (
                  <Badge>{m.role}</Badge>
                )}
              </td>
              {canManage && (
                <td className="w-24 text-right">
                  <Button variant="ghost" onClick={() => save(current.filter((x) => x.userId !== m.userId))}>
                    Remove
                  </Button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {team.members.length === 0 && <p className="text-sm text-gray-500">No members yet.</p>}
      {canManage && (
        <div className="mt-3 flex gap-2">
          <Select value={adding} onChange={(e) => setAdding(e.target.value)} className="max-w-xs">
            <option value="">Add a member...</option>
            {directory
              .filter((u) => !team.members.some((m) => m.userId === u.id))
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} ({u.email})
                </option>
              ))}
          </Select>
          <Button
            variant="secondary"
            disabled={!adding}
            onClick={async () => {
              await save([...current, { userId: adding, role: "member" }]);
              setAdding("");
            }}
          >
            Add
          </Button>
        </div>
      )}
    </Card>
  );
}

export function TeamsPage() {
  const user = useUser();
  const { data, error, loading, reload } = useApi<{ teams: Team[] }>("/v1/teams");
  const directory = useApi<{ users: { id: string; name: string; email: string }[] }>("/v1/users");
  const [name, setName] = useState("");
  const action = useAction();
  if (loading && !data) return <Loading />;
  const create = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await action.run(() => api("/v1/teams", { body: { name } }));
    if (ok) {
      setName("");
      await reload();
    }
  };
  return (
    <>
      <PageHeader title="Teams" description="Teams own shared event types: round robin, collective and team booking pages." />
      <ErrorBanner error={error ?? action.error} />
      {isAdmin(user) && (
        <form onSubmit={create} className="mb-6 flex items-end gap-2">
          <Field label="New team name">
            <Input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Sales" />
          </Field>
          <Button type="submit" loading={action.pending}>
            Create team
          </Button>
        </form>
      )}
      {data?.teams.length === 0 ? (
        <EmptyState title="No teams yet">{isAdmin(user) ? "Create one above." : "Ask an admin to create a team."}</EmptyState>
      ) : (
        <div className="space-y-4">
          {data?.teams.map((t) => (
            <TeamCard
              key={t.id}
              team={t}
              canManage={isAdmin(user) || t.members.some((m) => m.userId === user.id && m.role === "manager")}
              directory={directory.data?.users ?? []}
              onChange={reload}
            />
          ))}
        </div>
      )}
    </>
  );
}
