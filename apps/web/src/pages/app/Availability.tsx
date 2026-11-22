import { useEffect, useState } from "react";
import { Badge, Button, Card, ErrorBanner, Field, Input, Loading, PageHeader, Section, Select, Toggle } from "../../components/ui";
import { api, type Schedule } from "../../lib/api";
import { useAction, useApi } from "../../lib/hooks";
import { allTimeZones, browserTimeZone } from "../../lib/time";

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
type Range = { start: string; end: string };

function RangesEditor({ ranges, onChange }: { ranges: Range[]; onChange: (r: Range[]) => void }) {
  return (
    <div className="space-y-2">
      {ranges.map((r, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input type="time" value={r.start} onChange={(e) => onChange(ranges.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)))} className="w-32" />
          <span className="text-gray-400">-</span>
          <Input type="time" value={r.end === "24:00" ? "23:59" : r.end} onChange={(e) => onChange(ranges.map((x, j) => (j === i ? { ...x, end: e.target.value === "23:59" ? "24:00" : e.target.value } : x)))} className="w-32" />
          <Button variant="ghost" aria-label="Remove range" onClick={() => onChange(ranges.filter((_, j) => j !== i))}>
            ✕
          </Button>
        </div>
      ))}
      <button type="button" className="text-sm text-brand hover:underline" onClick={() => onChange([...ranges, { start: ranges.at(-1)?.end && ranges.at(-1)!.end < "22:00" ? ranges.at(-1)!.end : "09:00", end: "17:00" }])}>
        + Add hours
      </button>
    </div>
  );
}

function ScheduleEditor({ schedule, onSaved }: { schedule: Schedule; onSaved: () => void }) {
  const [s, setS] = useState(schedule);
  const [newDate, setNewDate] = useState("");
  const action = useAction();
  const [saved, setSaved] = useState(false);
  useEffect(() => setS(schedule), [schedule]);
  const dayRanges = (day: number) => s.weekly.find((w) => w.day === day)?.ranges ?? [];
  const setDay = (day: number, ranges: Range[]) =>
    setS((x) => ({ ...x, weekly: [...x.weekly.filter((w) => w.day !== day), ...(ranges.length ? [{ day, ranges }] : [])].sort((a, b) => a.day - b.day) }));

  const save = async () => {
    const r = await action.run(() =>
      api(`/v1/schedules/${s.id}`, { method: "PATCH", body: { name: s.name, timezone: s.timezone, weekly: s.weekly, overrides: s.overrides, ...(s.isDefault ? { isDefault: true } : {}) } }),
    );
    if (r) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      onSaved();
    }
  };

  return (
    <div className="space-y-6">
      <Section
        title="Weekly hours"
        actions={
          <div className="flex items-center gap-3">
            {saved && <span className="text-sm text-green-700">Saved</span>}
            <Button onClick={save} loading={action.pending}>
              Save
            </Button>
          </div>
        }
      >
        <ErrorBanner error={action.error} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">
            <Input value={s.name} onChange={(e) => setS({ ...s, name: e.target.value })} />
          </Field>
          <Field label="Time zone">
            <Select value={s.timezone} onChange={(e) => setS({ ...s, timezone: e.target.value })}>
              {allTimeZones().map((z) => (
                <option key={z}>{z}</option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="divide-y">
          {DAYS.map((label, i) => {
            const day = i + 1;
            const ranges = dayRanges(day);
            return (
              <div key={day} className="flex flex-wrap items-start gap-4 py-3">
                <div className="w-36 pt-2">
                  <Toggle checked={ranges.length > 0} onChange={(on) => setDay(day, on ? [{ start: "09:00", end: "17:00" }] : [])} label={label} />
                </div>
                {ranges.length > 0 ? <RangesEditor ranges={ranges} onChange={(r) => setDay(day, r)} /> : <p className="pt-2 text-sm text-gray-400">Unavailable</p>}
              </div>
            );
          })}
        </div>
      </Section>

      <Section title="Date overrides" description="Change your hours for specific dates, or block a day off. Overrides replace the weekly hours for that date.">
        <div className="flex items-end gap-2">
          <Field label="Date">
            <Input type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} />
          </Field>
          <Button
            variant="secondary"
            disabled={!newDate || s.overrides.some((o) => o.date === newDate)}
            onClick={() => {
              setS({ ...s, overrides: [...s.overrides, { date: newDate, ranges: [] }].sort((a, b) => a.date.localeCompare(b.date)) });
              setNewDate("");
            }}
          >
            Add override
          </Button>
        </div>
        {s.overrides.length === 0 && <p className="text-sm text-gray-500">No overrides.</p>}
        <div className="divide-y">
          {s.overrides.map((o) => (
            <div key={o.date} className="flex flex-wrap items-start gap-4 py-3">
              <div className="w-36 pt-2 text-sm font-medium">{o.date}</div>
              <div className="flex-1">
                {o.ranges.length === 0 ? <p className="pb-2 pt-2 text-sm text-gray-500">Unavailable all day</p> : null}
                <RangesEditor ranges={o.ranges} onChange={(r) => setS({ ...s, overrides: s.overrides.map((x) => (x.date === o.date ? { ...x, ranges: r } : x)) })} />
              </div>
              <Button variant="ghost" onClick={() => setS({ ...s, overrides: s.overrides.filter((x) => x.date !== o.date) })}>
                Remove
              </Button>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}

export function AvailabilityPage() {
  const { data, error, loading, reload } = useApi<{ schedules: Schedule[] }>("/v1/schedules");
  const [selected, setSelected] = useState<string | null>(null);
  const action = useAction();
  if (loading && !data) return <Loading />;
  const schedules = data?.schedules ?? [];
  const current = schedules.find((s) => s.id === selected) ?? schedules.find((s) => s.isDefault) ?? schedules[0];

  const create = async () => {
    const r = await action.run(() =>
      api<{ schedule: Schedule }>("/v1/schedules", {
        body: { name: "New schedule", timezone: current?.timezone ?? browserTimeZone(), weekly: current?.weekly ?? [], overrides: [] },
      }),
    );
    if (r) {
      await reload();
      setSelected(r.schedule.id);
    }
  };

  return (
    <>
      <PageHeader title="Availability" description="When people can book you. Connected calendars are checked for conflicts on top of these hours." actions={<Button variant="secondary" onClick={create}>New schedule</Button>} />
      <ErrorBanner error={error ?? action.error} />
      {schedules.length > 1 && (
        <Card className="mb-6 flex flex-wrap gap-2 p-2">
          {schedules.map((s) => (
            <button key={s.id} onClick={() => setSelected(s.id)} className={`rounded-md px-3 py-1.5 text-sm ${current?.id === s.id ? "bg-brand/10 font-medium text-brand" : "hover:bg-gray-100"}`}>
              {s.name} {s.isDefault && <Badge>Default</Badge>}
            </button>
          ))}
        </Card>
      )}
      {current && (
        <>
          <ScheduleEditor key={current.id} schedule={current} onSaved={reload} />
          <div className="mt-4 flex gap-2">
            {!current.isDefault && (
              <>
                <Button variant="secondary" onClick={() => action.run(async () => { await api(`/v1/schedules/${current.id}`, { method: "PATCH", body: { isDefault: true } }); await reload(); })}>
                  Make default
                </Button>
                <Button variant="danger" onClick={() => action.run(async () => { await api(`/v1/schedules/${current.id}`, { method: "DELETE" }); setSelected(null); await reload(); })}>
                  Delete schedule
                </Button>
              </>
            )}
          </div>
        </>
      )}
    </>
  );
}
