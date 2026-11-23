import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { isAdmin, useUser } from "../../auth";
import { Badge, Button, Card, CopyButton, EmptyState, ErrorBanner, Field, Input, Loading, Notice, PageHeader, Section, Select, Textarea, Toggle } from "../../components/ui";
import { api, type EventType, type Host, type Kind, type LocationType, type Question, type Schedule, type Team } from "../../lib/api";
import { useAction, useApi } from "../../lib/hooks";
import { fmtDuration, KIND_LABELS, LOCATION_LABELS } from "../../lib/time";

function publicUrl(et: EventType, username: string, teams: Team[]) {
  const origin = window.location.origin;
  if (et.teamId) {
    const team = teams.find((t) => t.id === et.teamId);
    return `${origin}/team/${team?.slug ?? "team"}/${et.slug}`;
  }
  return `${origin}/${username}/${et.slug}`;
}

export function EventTypesPage() {
  const user = useUser();
  const { data, error, loading, reload } = useApi<{ eventTypes: EventType[] }>("/v1/event-types");
  const teams = useApi<{ teams: Team[] }>("/v1/teams");
  const action = useAction();
  if (loading && !data) return <Loading />;
  const list = data?.eventTypes.filter((e) => !e.slug.includes("-deleted-")) ?? [];
  const personal = list.filter((e) => e.ownerUserId === user.id);
  const others = list.filter((e) => e.ownerUserId !== user.id);

  const toggle = (et: EventType) => action.run(async () => {
    await api(`/v1/event-types/${et.id}`, { method: "PATCH", body: { active: !et.active } });
    await reload();
  });

  const renderList = (items: EventType[]) => (
    <div className="grid gap-4 sm:grid-cols-2">
      {items.map((et) => {
        const url = publicUrl(et, user.username, teams.data?.teams ?? []);
        return (
          <Card key={et.id} className="flex flex-col p-5" >
            <div className="mb-3 h-1.5 w-12 rounded-full" style={{ background: et.color }} />
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <Link to={`/app/event-types/${et.id}`} className="font-semibold hover:underline">
                  {et.title}
                </Link>
                <p className="mt-0.5 text-sm text-gray-500">
                  {fmtDuration(et.durationMinutes)} · {KIND_LABELS[et.kind]}
                  {et.teamId && ` · ${teams.data?.teams.find((t) => t.id === et.teamId)?.name ?? "Team"}`}
                </p>
              </div>
              <Toggle checked={et.active} onChange={() => void toggle(et)} />
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {et.hidden && <Badge>Hidden</Badge>}
              {!et.active && <Badge tone="amber">Off</Badge>}
            </div>
            <p className="mt-3 truncate text-xs text-gray-500">{url}</p>
            <div className="mt-4 flex gap-2">
              <CopyButton text={url} label="Copy link" />
              <Link to={`/app/event-types/${et.id}`}>
                <Button variant="ghost">Edit</Button>
              </Link>
            </div>
          </Card>
        );
      })}
    </div>
  );

  return (
    <>
      <PageHeader
        title="Event types"
        description="Templates people book from. Share a link or embed one on your site."
        actions={
          <Link to="/app/event-types/new">
            <Button>New event type</Button>
          </Link>
        }
      />
      <ErrorBanner error={error ?? action.error} />
      {personal.length === 0 && others.length === 0 ? (
        <EmptyState title="No event types yet">Create one to get a booking link.</EmptyState>
      ) : (
        <div className="space-y-8">
          {personal.length > 0 && renderList(personal)}
          {others.length > 0 && (
            <div>
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">Team event types</h2>
              {renderList(others)}
            </div>
          )}
        </div>
      )}
    </>
  );
}

const DEFAULTS: Partial<EventType> = {
  title: "",
  description: "",
  kind: "one_on_one",
  durationMinutes: 30,
  slotIntervalMinutes: null,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  minimumNoticeMinutes: 240,
  bookingWindow: { type: "rolling", days: 60 },
  dailyLimit: null,
  weeklyLimit: null,
  seats: null,
  location: { type: "link", value: "" },
  questions: [],
  reminderMinutes: [1440, 60],
  rrStrategy: "maximize_availability",
  rrMaxImbalance: null,
  redirectUrl: null,
  color: "#2563eb",
  hidden: false,
  active: true,
  hosts: [],
  teamId: null,
};

const num = (v: string) => (v === "" ? null : Number(v));

export function EventTypeEditorPage() {
  const { id } = useParams();
  const isNew = !id;
  const user = useUser();
  const navigate = useNavigate();
  const existing = useApi<{ eventType: EventType }>(isNew ? null : `/v1/event-types/${id}`);
  const directory = useApi<{ users: { id: string; name: string; email: string }[] }>("/v1/users");
  const teams = useApi<{ teams: Team[] }>("/v1/teams");
  const schedules = useApi<{ schedules: Schedule[] }>("/v1/schedules");
  const [draft, setDraft] = useState<Partial<EventType> | null>(isNew ? DEFAULTS : null);
  const action = useAction();
  const [saved, setSaved] = useState(false);

  const et = draft ?? existing.data?.eventType ?? null;
  const set = <K extends keyof EventType>(k: K, v: EventType[K]) => setDraft((d) => ({ ...(d ?? existing.data!.eventType), [k]: v }));

  const managedTeams = useMemo(
    () => (teams.data?.teams ?? []).filter((t) => isAdmin(user) || t.members.some((m) => m.userId === user.id && m.role === "manager")),
    [teams.data, user],
  );
  const hostPool = useMemo(() => {
    const all = directory.data?.users ?? [];
    if (!et?.teamId) return all;
    const team = teams.data?.teams.find((t) => t.id === et.teamId);
    return all.filter((u) => team?.members.some((m) => m.userId === u.id));
  }, [directory.data, teams.data, et?.teamId]);

  if (!et) return existing.error ? <ErrorBanner error={existing.error} /> : <Loading />;

  const multiHost = et.kind === "collective" || et.kind === "round_robin" || Boolean(et.teamId);
  const hosts = et.hosts ?? [];
  const setHosts = (h: Host[]) => set("hosts", h);

  const save = async () => {
    const body: Record<string, unknown> = { ...et };
    for (const k of ["id", "ownerUserId", "createdAt", "updatedAt"]) delete body[k];
    if (!isNew) delete body.teamId;
    const ownerId = et.ownerUserId ?? user.id;
    body.hosts = (multiHost ? hosts : hosts.filter((h) => h.userId === ownerId)).map(({ userId, priority, weight, scheduleId }) => ({ userId, priority, weight, scheduleId }));
    if (et.location?.value === "") body.location = { type: et.location.type };
    if (et.kind !== "group") body.seats = null;
    const r = await action.run(() =>
      isNew ? api<{ eventType: EventType }>("/v1/event-types", { body }) : api<{ eventType: EventType }>(`/v1/event-types/${id}`, { method: "PATCH", body }),
    );
    if (r) {
      setDraft(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      if (isNew) navigate(`/app/event-types/${r.eventType.id}`, { replace: true });
      else await existing.reload();
    }
  };

  const remove = async () => {
    if (!confirm("Delete this event type? Existing bookings are kept.")) return;
    const r = await action.run(() => api(`/v1/event-types/${id}`, { method: "DELETE" }));
    if (r) navigate("/app/event-types");
  };

  const url = !isNew && existing.data ? publicUrl(existing.data.eventType, user.username, teams.data?.teams ?? []) : null;
  const embedCode = url
    ? `<div data-timebook-url="${url}" style="min-width:320px;height:700px"></div>\n<script src="${window.location.origin}/embed.js" async></script>`
    : "";

  return (
    <>
      <PageHeader
        title={isNew ? "New event type" : et.title || "Event type"}
        description={<Link to="/app/event-types" className="text-brand hover:underline">‹ Event types</Link>}
        actions={
          <>
            {saved && <span className="self-center text-sm text-green-700">Saved</span>}
            {!isNew && (
              <Button variant="danger" onClick={remove}>
                Delete
              </Button>
            )}
            <Button onClick={save} loading={action.pending}>
              {isNew ? "Create" : "Save"}
            </Button>
          </>
        }
      />
      <div className="space-y-6">
        <ErrorBanner error={action.error} />
        {url && (
          <Notice>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">Booking link:</span>
              <a href={url} target="_blank" rel="noreferrer" className="break-all underline">
                {url}
              </a>
              <CopyButton text={url} />
            </div>
          </Notice>
        )}

        <Section title="Basics">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Title">
              <Input value={et.title ?? ""} onChange={(e) => set("title", e.target.value)} placeholder="30 minute meeting" />
            </Field>
            <Field label="URL slug" hint="Leave empty to generate from the title.">
              <Input value={et.slug ?? ""} onChange={(e) => set("slug", e.target.value.toLowerCase())} placeholder="intro-call" />
            </Field>
            <Field label="Duration (minutes)">
              <Input type="number" min={5} max={720} value={et.durationMinutes ?? 30} onChange={(e) => set("durationMinutes", Number(e.target.value))} />
            </Field>
            <Field label="Color">
              <Input type="color" value={et.color ?? "#2563eb"} onChange={(e) => set("color", e.target.value)} className="h-10 p-1" />
            </Field>
          </div>
          <Field label="Description">
            <Textarea value={et.description ?? ""} onChange={(e) => set("description", e.target.value)} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Location">
              <Select value={et.location?.type ?? "link"} onChange={(e) => set("location", { type: e.target.value as LocationType, value: et.location?.value })}>
                {Object.entries(LOCATION_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            </Field>
            {!["google_meet", "microsoft_teams"].includes(et.location?.type ?? "") ? (
              <Field label={et.location?.type === "link" ? "Meeting URL" : et.location?.type === "phone" ? "Phone number" : et.location?.type === "in_person" ? "Address" : "Details"}>
                <Input value={et.location?.value ?? ""} onChange={(e) => set("location", { type: et.location!.type, value: e.target.value })} />
              </Field>
            ) : (
              <p className="self-end pb-2 text-xs text-gray-500">A unique link is created on the host's connected {et.location?.type === "google_meet" ? "Google" : "Microsoft"} calendar for each booking.</p>
            )}
          </div>
        </Section>

        <Section title="Who hosts" description="One-on-one and group events have one host. Collective needs all hosts free; round robin picks one free host.">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Kind">
              <Select value={et.kind} onChange={(e) => set("kind", e.target.value as Kind)}>
                {Object.entries(KIND_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            </Field>
            {isNew && managedTeams.length > 0 && (
              <Field label="Owner" hint="Team event types live at /team/<team>/<slug>.">
                <Select value={et.teamId ?? ""} onChange={(e) => set("teamId", e.target.value || null)}>
                  <option value="">Me ({user.name})</option>
                  {managedTeams.map((t) => (
                    <option key={t.id} value={t.id}>
                      Team: {t.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            {et.kind === "group" && (
              <Field label="Seats per time slot">
                <Input type="number" min={2} value={et.seats ?? ""} onChange={(e) => set("seats", num(e.target.value))} />
              </Field>
            )}
            {!multiHost && (
              <Field label="Availability schedule">
                <Select
                  value={hosts[0]?.scheduleId ?? ""}
                  onChange={(e) => setHosts(e.target.value ? [{ userId: user.id, priority: 0, weight: 1, scheduleId: e.target.value }] : [])}
                >
                  <option value="">Default schedule</option>
                  {schedules.data?.schedules.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </div>
          {multiHost && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Select
                  value=""
                  onChange={(e) => e.target.value && setHosts([...hosts, { userId: e.target.value, priority: 0, weight: 1, scheduleId: null }])}
                  className="max-w-xs"
                >
                  <option value="">Add a host...</option>
                  {hostPool
                    .filter((u) => !hosts.some((h) => h.userId === u.id))
                    .map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name} ({u.email})
                      </option>
                    ))}
                </Select>
                {et.teamId && hostPool.length === 0 && <span className="text-xs text-gray-500">Add members to the team first.</span>}
              </div>
              {hosts.length > 0 && (
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-gray-500">
                    <tr>
                      <th className="py-1">Host</th>
                      {et.kind === "round_robin" && <th>Priority (0-10)</th>}
                      {et.kind === "round_robin" && et.rrStrategy === "equal_distribution" && <th>Weight</th>}
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {hosts.map((h, i) => {
                      const u = directory.data?.users.find((x) => x.id === h.userId);
                      const update = (patch: Partial<Host>) => setHosts(hosts.map((x, j) => (j === i ? { ...x, ...patch } : x)));
                      return (
                        <tr key={h.userId} className="border-t">
                          <td className="py-2">{u?.name ?? h.name ?? h.userId}</td>
                          {et.kind === "round_robin" && (
                            <td>
                              <Input type="number" min={0} max={10} value={h.priority} onChange={(e) => update({ priority: Number(e.target.value) })} className="w-20" />
                            </td>
                          )}
                          {et.kind === "round_robin" && et.rrStrategy === "equal_distribution" && (
                            <td>
                              <Input type="number" min={1} max={100} value={h.weight} onChange={(e) => update({ weight: Number(e.target.value) })} className="w-20" />
                            </td>
                          )}
                          <td className="text-right">
                            <Button variant="ghost" onClick={() => setHosts(hosts.filter((_, j) => j !== i))}>
                              Remove
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          )}
          {et.kind === "round_robin" && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Distribution" hint="Equal distribution balances bookings over the last 30 days, adjusted by weight.">
                <Select value={et.rrStrategy} onChange={(e) => set("rrStrategy", e.target.value as EventType["rrStrategy"])}>
                  <option value="maximize_availability">Maximize availability (priority first)</option>
                  <option value="equal_distribution">Equal distribution</option>
                </Select>
              </Field>
              {et.rrStrategy === "equal_distribution" && (
                <Field label="Hide hosts ahead by (meetings)" hint="Optional. Keeps busy hosts from taking more until others catch up.">
                  <Input type="number" min={1} value={et.rrMaxImbalance ?? ""} onChange={(e) => set("rrMaxImbalance", num(e.target.value))} />
                </Field>
              )}
            </div>
          )}
        </Section>

        <Section title="Scheduling rules">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Minimum notice (minutes)">
              <Input type="number" min={0} value={et.minimumNoticeMinutes ?? 0} onChange={(e) => set("minimumNoticeMinutes", Number(e.target.value))} />
            </Field>
            <Field label="Buffer before (minutes)">
              <Input type="number" min={0} value={et.bufferBeforeMinutes ?? 0} onChange={(e) => set("bufferBeforeMinutes", Number(e.target.value))} />
            </Field>
            <Field label="Buffer after (minutes)">
              <Input type="number" min={0} value={et.bufferAfterMinutes ?? 0} onChange={(e) => set("bufferAfterMinutes", Number(e.target.value))} />
            </Field>
            <Field label="Start times every (minutes)" hint="Defaults to the duration.">
              <Input type="number" min={5} value={et.slotIntervalMinutes ?? ""} onChange={(e) => set("slotIntervalMinutes", num(e.target.value))} />
            </Field>
            <Field label="Max per day" hint="Per host. Empty = no limit.">
              <Input type="number" min={1} value={et.dailyLimit ?? ""} onChange={(e) => set("dailyLimit", num(e.target.value))} />
            </Field>
            <Field label="Max per week">
              <Input type="number" min={1} value={et.weeklyLimit ?? ""} onChange={(e) => set("weeklyLimit", num(e.target.value))} />
            </Field>
            <Field label="Bookable up to (days ahead)" hint="Empty = no limit.">
              <Input
                type="number"
                min={0}
                value={et.bookingWindow?.type === "rolling" ? et.bookingWindow.days : ""}
                onChange={(e) => set("bookingWindow", e.target.value === "" ? null : { type: "rolling", days: Number(e.target.value) })}
              />
            </Field>
          </div>
        </Section>

        <Section
          title="Booking questions"
          description="Name and email are always asked."
          actions={
            <Button variant="secondary" onClick={() => set("questions", [...(et.questions ?? []), { id: `q${(et.questions?.length ?? 0) + 1}`, label: "", type: "text", required: false }])}>
              Add question
            </Button>
          }
        >
          {(et.questions ?? []).length === 0 && <p className="text-sm text-gray-500">No extra questions.</p>}
          {(et.questions ?? []).map((q, i) => {
            const update = (patch: Partial<Question>) => set("questions", et.questions!.map((x, j) => (j === i ? { ...x, ...patch } : x)));
            return (
              <div key={i} className="grid gap-3 rounded-md border p-3 sm:grid-cols-[1fr_140px_auto_auto]">
                <Input placeholder="Question" value={q.label} onChange={(e) => update({ label: e.target.value, id: q.id || e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 40) })} />
                <Select value={q.type} onChange={(e) => update({ type: e.target.value as Question["type"] })}>
                  <option value="text">Short text</option>
                  <option value="textarea">Long text</option>
                  <option value="phone">Phone</option>
                  <option value="select">Dropdown</option>
                  <option value="checkbox">Checkbox</option>
                </Select>
                <Toggle checked={q.required} onChange={(v) => update({ required: v })} label="Required" />
                <Button variant="ghost" onClick={() => set("questions", et.questions!.filter((_, j) => j !== i))}>
                  Remove
                </Button>
                {q.type === "select" && (
                  <Input className="sm:col-span-4" placeholder="Options, comma separated" value={(q.options ?? []).join(", ")} onChange={(e) => update({ options: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} />
                )}
              </div>
            );
          })}
        </Section>

        <Section title="Notifications and follow-up">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Email reminders (minutes before)" hint="Comma separated, e.g. 1440, 60. Leave empty for none.">
              <Input
                value={(et.reminderMinutes ?? []).join(", ")}
                onChange={(e) => set("reminderMinutes", e.target.value.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n >= 5))}
              />
            </Field>
            <Field label="Redirect after booking" hint="Optional URL. The booking id and start time are appended.">
              <Input type="url" value={et.redirectUrl ?? ""} onChange={(e) => set("redirectUrl", e.target.value || null)} />
            </Field>
          </div>
          <div className="flex flex-wrap gap-6">
            <Toggle checked={!et.hidden} onChange={(v) => set("hidden", !v)} label="Show on public profile page" />
            <Toggle checked={et.active ?? true} onChange={(v) => set("active", v)} label="Accepting bookings" />
          </div>
        </Section>

        {embedCode && (
          <Section title="Embed on your website" description="Paste this where the booking page should appear. Listen for the `timebook:event_scheduled` event to react to bookings.">
            <pre className="overflow-x-auto rounded-md bg-gray-900 p-3 text-xs text-gray-100">{embedCode}</pre>
            <CopyButton text={embedCode} label="Copy embed code" />
          </Section>
        )}
      </div>
    </>
  );
}
