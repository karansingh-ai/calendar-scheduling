import { DateTime } from "luxon";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api, errorMessage, type Booking, type PublicEventType } from "../lib/api";
import { allTimeZones, browserTimeZone, fmtDuration, fmtRange, fmtTime, LOCATION_LABELS } from "../lib/time";
import { Button, cx, ErrorBanner, Field, Input, Select, Spinner, Textarea } from "./ui";

interface Slot {
  start: string;
  end: string;
  seatsRemaining?: number;
}

export type BookerMode =
  | { kind: "new" }
  | { kind: "reschedule-invitee"; bookingId: string; token: string; currentStart: string }
  | { kind: "reschedule-host"; bookingId: string; currentStart: string };

export interface BookerResult {
  booking: Booking;
  manageToken?: string;
}

/** Post a message to the embedding page (see public/embed.js). */
export function notifyParent(type: string, payload: Record<string, unknown> = {}) {
  if (window.parent !== window) window.parent.postMessage({ type: `scheduler:${type}`, ...payload }, "*");
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function Booker({ eventType, mode = { kind: "new" }, onDone }: { eventType: PublicEventType; mode?: BookerMode; onDone?: (r: BookerResult) => void }) {
  const [tz, setTz] = useState(browserTimeZone);
  const [month, setMonth] = useState(() => DateTime.now().setZone(browserTimeZone()).startOf("month"));
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<Slot | null>(null);
  const [step, setStep] = useState<"pick" | "form">("pick");
  const [autoAdvanced, setAutoAdvanced] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setSlots(null);
    setLoadError(null);
    const now = DateTime.now();
    const from = DateTime.max(month.setZone(tz, { keepLocalTime: true }).startOf("month"), now);
    const to = month.setZone(tz, { keepLocalTime: true }).endOf("month").plus({ days: 1 }).startOf("day");
    if (to <= from) {
      setSlots([]);
      return;
    }
    const params = new URLSearchParams({ start: from.toUTC().toISO()!, end: to.toUTC().toISO()!, timezone: tz });
    if (mode.kind !== "new") params.set("rescheduleBookingId", mode.bookingId);
    api<{ slots: Slot[] }>(`/public/event-types/${eventType.id}/slots?${params}`)
      .then((r) => {
        if (cancelled) return;
        setSlots(r.slots);
        if (r.slots.length === 0 && autoAdvanced < 2) {
          setAutoAdvanced((n) => n + 1);
          setMonth((m) => m.plus({ months: 1 }));
        }
      })
      .catch((err) => !cancelled && setLoadError(errorMessage(err)));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventType.id, month, tz]);

  const byDate = useMemo(() => {
    const map = new Map<string, Slot[]>();
    for (const s of slots ?? []) {
      const key = DateTime.fromISO(s.start, { zone: tz }).toISODate()!;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(s);
    }
    return map;
  }, [slots, tz]);

  useEffect(() => {
    if (!slots) return;
    if (selectedDate && byDate.has(selectedDate)) return;
    const first = [...byDate.keys()].sort()[0] ?? null;
    setSelectedDate(first);
    setSelectedSlot(null);
  }, [byDate, slots, selectedDate]);

  const days = useMemo(() => {
    const start = month.startOf("month");
    const lead = start.weekday - 1;
    const total = start.daysInMonth!;
    const cells: (DateTime | null)[] = Array.from({ length: lead }, () => null);
    for (let d = 0; d < total; d++) cells.push(start.plus({ days: d }));
    while (cells.length % 7) cells.push(null);
    return cells;
  }, [month]);

  const canGoBack = month > DateTime.now().setZone(tz).startOf("month");

  if (step === "form" && selectedSlot && mode.kind === "new") {
    return <BookingForm eventType={eventType} slot={selectedSlot} tz={tz} onBack={() => setStep("pick")} onDone={onDone} />;
  }

  return (
    <div className="grid gap-6 md:grid-cols-[1fr_220px]">
      <div>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-semibold">{month.toFormat("LLLL yyyy")}</h3>
          <div className="flex gap-1">
            <button type="button" aria-label="Previous month" disabled={!canGoBack} onClick={() => setMonth((m) => m.minus({ months: 1 }))} className="rounded-md px-2.5 py-1 text-lg text-gray-600 hover:bg-gray-100 disabled:opacity-30">
              ‹
            </button>
            <button type="button" aria-label="Next month" onClick={() => setMonth((m) => m.plus({ months: 1 }))} className="rounded-md px-2.5 py-1 text-lg text-gray-600 hover:bg-gray-100">
              ›
            </button>
          </div>
        </div>
        <div className="grid grid-cols-7 gap-1 text-center text-xs font-medium text-gray-500">
          {WEEKDAYS.map((d) => (
            <div key={d} className="py-1">
              {d}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-1">
          {days.map((d, i) => {
            if (!d) return <div key={i} />;
            const key = d.toISODate()!;
            const available = byDate.has(key);
            const selected = key === selectedDate;
            return (
              <button
                key={key}
                type="button"
                disabled={!available}
                onClick={() => {
                  setSelectedDate(key);
                  setSelectedSlot(null);
                }}
                className={cx(
                  "aspect-square rounded-full text-sm transition",
                  selected ? "bg-brand font-semibold text-white" : available ? "bg-brand/10 font-semibold text-brand hover:bg-brand/20" : "text-gray-300",
                )}
                aria-label={`${d.toFormat("cccc, LLLL d")}${available ? "" : " (no times)"}`}
                aria-pressed={selected}
              >
                {d.day}
              </button>
            );
          })}
        </div>
        <div className="mt-4">
          <Field label="Time zone">
            <Select value={tz} onChange={(e) => setTz(e.target.value)}>
              {allTimeZones().map((z) => (
                <option key={z} value={z}>
                  {z.replace(/_/g, " ")} ({DateTime.now().setZone(z).toFormat("h:mm a")})
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </div>

      <div className="min-h-48">
        {loadError && <ErrorBanner error={loadError} />}
        {!slots && !loadError && (
          <div className="flex justify-center pt-10">
            <Spinner />
          </div>
        )}
        {slots && !selectedDate && <p className="pt-2 text-sm text-gray-500">No available times this month.</p>}
        {selectedDate && (
          <>
            <p className="mb-3 text-sm font-medium">{DateTime.fromISO(selectedDate).toFormat("cccc, LLLL d")}</p>
            <div className="flex max-h-[420px] flex-col gap-2 overflow-y-auto pr-1">
              {(byDate.get(selectedDate) ?? []).map((s) => {
                const active = selectedSlot?.start === s.start;
                return (
                  <div key={s.start} className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setSelectedSlot(s)}
                      className={cx(
                        "flex-1 rounded-md border px-3 py-2 text-sm font-semibold transition",
                        active ? "border-gray-700 bg-gray-700 text-white" : "border-brand/40 text-brand hover:border-brand",
                      )}
                    >
                      {fmtTime(s.start, tz)}
                      {s.seatsRemaining !== undefined && <span className="ml-1 text-xs font-normal opacity-80">· {s.seatsRemaining} left</span>}
                    </button>
                    {active && mode.kind === "new" && (
                      <Button className="flex-1" onClick={() => setStep("form")}>
                        Next
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
            {selectedSlot && mode.kind !== "new" && <RescheduleConfirm mode={mode} slot={selectedSlot} tz={tz} onDone={onDone} />}
          </>
        )}
      </div>
    </div>
  );
}

function RescheduleConfirm({ mode, slot, tz, onDone }: { mode: Exclude<BookerMode, { kind: "new" }>; slot: Slot; tz: string; onDone?: (r: BookerResult) => void }) {
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setPending(true);
    setError(null);
    try {
      const result =
        mode.kind === "reschedule-invitee"
          ? await api<BookerResult>(`/public/bookings/${mode.bookingId}/reschedule`, { body: { token: mode.token, start: slot.start, reason: reason || undefined } })
          : await api<BookerResult>(`/v1/bookings/${mode.bookingId}/reschedule`, { body: { start: slot.start, reason: reason || undefined } });
      onDone?.(result);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="mt-4 space-y-3 border-t pt-4">
      <p className="text-sm">
        Move to <strong>{fmtRange(slot.start, slot.end, tz)}</strong>
      </p>
      <Field label="Reason (optional)">
        <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} />
      </Field>
      <ErrorBanner error={error} />
      <Button className="w-full" loading={pending} onClick={submit}>
        Confirm new time
      </Button>
    </div>
  );
}

function BookingForm({ eventType, slot, tz, onBack, onDone }: { eventType: PublicEventType; slot: Slot; tz: string; onBack: () => void; onDone?: (r: BookerResult) => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [answers, setAnswers] = useState<Record<string, string | boolean>>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const result = await api<BookerResult>(`/public/event-types/${eventType.id}/bookings`, {
        body: { start: slot.start, invitee: { name, email, timezone: tz }, answers },
      });
      onDone?.(result);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <button type="button" onClick={onBack} className="text-sm text-brand hover:underline">
        ‹ Back
      </button>
      <p className="rounded-md bg-gray-50 px-3 py-2 text-sm">
        {fmtRange(slot.start, slot.end, tz)} <span className="text-gray-500">({tz.replace(/_/g, " ")})</span>
      </p>
      <Field label="Name *">
        <Input required value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={200} />
      </Field>
      <Field label="Email *">
        <Input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" maxLength={320} />
      </Field>
      {eventType.questions.map((q) => {
        const label = `${q.label}${q.required ? " *" : ""}`;
        const value = answers[q.id];
        const set = (v: string | boolean) => setAnswers((a) => ({ ...a, [q.id]: v }));
        if (q.type === "checkbox") {
          return (
            <label key={q.id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={Boolean(value)} required={q.required} onChange={(e) => set(e.target.checked)} />
              {label}
            </label>
          );
        }
        return (
          <Field key={q.id} label={label}>
            {q.type === "textarea" ? (
              <Textarea required={q.required} value={String(value ?? "")} onChange={(e) => set(e.target.value)} />
            ) : q.type === "select" ? (
              <Select required={q.required} value={String(value ?? "")} onChange={(e) => set(e.target.value)}>
                <option value="">Choose...</option>
                {q.options?.map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </Select>
            ) : (
              <Input required={q.required} type={q.type === "phone" ? "tel" : "text"} value={String(value ?? "")} onChange={(e) => set(e.target.value)} />
            )}
          </Field>
        );
      })}
      <ErrorBanner error={error} />
      <Button type="submit" loading={pending} className="w-full">
        Schedule event
      </Button>
    </form>
  );
}

export function EventSummary({ eventType, children }: { eventType: PublicEventType; children?: React.ReactNode }) {
  const who = eventType.owner.kind === "team" ? eventType.owner.name : eventType.owner.name;
  const hosts = eventType.kind === "collective" ? eventType.hosts.map((h) => h.name).join(", ") : who;
  return (
    <div className="space-y-3">
      <p className="text-sm font-medium text-gray-500">{hosts}</p>
      <h1 className="text-2xl font-semibold tracking-tight">{eventType.title}</h1>
      <ul className="space-y-1.5 text-sm text-gray-600">
        <li>⏱ {fmtDuration(eventType.durationMinutes)}</li>
        <li>
          📍 {LOCATION_LABELS[eventType.location.type]}
          {eventType.location.value ? `: ${eventType.location.value}` : ""}
        </li>
        {eventType.kind === "group" && eventType.seats && <li>👥 Group event, up to {eventType.seats} people</li>}
      </ul>
      {eventType.description && <p className="whitespace-pre-line text-sm text-gray-700">{eventType.description}</p>}
      {children}
    </div>
  );
}
