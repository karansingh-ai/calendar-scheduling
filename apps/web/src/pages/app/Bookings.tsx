import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { isAdmin, useUser } from "../../auth";
import { Booker } from "../../components/Booker";
import { Badge, Button, Card, cx, EmptyState, ErrorBanner, Field, Loading, Modal, PageHeader, Textarea } from "../../components/ui";
import { api, type Booking, type PublicEventType, type Question } from "../../lib/api";
import { useAction, useApi } from "../../lib/hooks";
import { fmtRange, KIND_LABELS, LOCATION_LABELS } from "../../lib/time";

const TABS = [
  { id: "upcoming", label: "Upcoming" },
  { id: "past", label: "Past" },
  { id: "cancelled", label: "Cancelled" },
] as const;

export function BookingsPage() {
  const user = useUser();
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("upcoming");
  const [scope, setScope] = useState<"mine" | "org">("mine");
  const { data, error, loading } = useApi<{ bookings: Booking[]; total: number }>(`/v1/bookings?status=${tab}&scope=${scope}&limit=100`);

  return (
    <>
      <PageHeader
        title="Bookings"
        description="Meetings people have scheduled with you."
        actions={
          isAdmin(user) && (
            <div className="flex rounded-md border bg-white p-0.5 text-sm">
              {(["mine", "org"] as const).map((s) => (
                <button key={s} onClick={() => setScope(s)} className={cx("rounded px-3 py-1", scope === s ? "bg-gray-100 font-medium" : "text-gray-600")}>
                  {s === "mine" ? "Mine" : "Everyone"}
                </button>
              ))}
            </div>
          )
        }
      />
      <div className="mb-4 flex gap-1 border-b">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} className={cx("-mb-px border-b-2 px-4 py-2 text-sm font-medium", tab === t.id ? "border-brand text-brand" : "border-transparent text-gray-500 hover:text-gray-800")}>
            {t.label}
          </button>
        ))}
      </div>
      <ErrorBanner error={error} />
      {loading && !data ? (
        <Loading />
      ) : data && data.bookings.length === 0 ? (
        <EmptyState title={`No ${tab} bookings`}>Share your booking link from Event types to get started.</EmptyState>
      ) : (
        <Card className="divide-y">
          {data?.bookings.map((b) => (
            <Link key={b.id} to={`/app/bookings/${b.id}`} className="flex flex-wrap items-center gap-x-6 gap-y-1 px-5 py-4 hover:bg-gray-50">
              <div className="w-56 shrink-0 text-sm">
                <p className="font-medium">{fmtRange(b.start, b.end, user.timezone).split(" · ")[0]}</p>
                <p className="text-gray-500">{fmtRange(b.start, b.end, user.timezone).split(" · ")[1]}</p>
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{b.invitee.name}</p>
                <p className="truncate text-sm text-gray-500">
                  {b.eventType.title} · {b.hosts.map((h) => h.name).join(", ")}
                </p>
              </div>
              <div className="flex gap-2">
                {b.noShow && <Badge tone="amber">No-show</Badge>}
                {b.rescheduledFromId && <Badge tone="blue">Rescheduled</Badge>}
                {b.status === "cancelled" && <Badge tone="red">Cancelled</Badge>}
              </div>
            </Link>
          ))}
        </Card>
      )}
      {data && data.total > data.bookings.length && <p className="mt-3 text-sm text-gray-500">Showing {data.bookings.length} of {data.total}.</p>}
    </>
  );
}

export function BookingDetailPage() {
  const { id } = useParams();
  const user = useUser();
  const navigate = useNavigate();
  const { data, error, loading, reload } = useApi<{ booking: Booking; eventType: { questions: Question[] }; rescheduledFrom: { id: string; start: string } | null }>(`/v1/bookings/${id}`);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [rescheduling, setRescheduling] = useState(false);
  const action = useAction();
  const publicType = useApi<{ eventType: PublicEventType }>(rescheduling && data ? publicPath(data.booking) : null);

  if (loading && !data) return <Loading />;
  if (error || !data) return <ErrorBanner error={error ?? "Not found"} />;
  const b = data.booking;
  const upcoming = b.status === "confirmed" && new Date(b.start) > new Date();
  const label = (k: string) => data.eventType.questions.find((q) => q.id === k)?.label ?? k;

  return (
    <>
      <PageHeader
        title={b.title}
        description={<Link to="/app" className="text-brand hover:underline">‹ All bookings</Link>}
        actions={
          <>
            {upcoming && (
              <Button variant="secondary" onClick={() => setRescheduling((r) => !r)}>
                {rescheduling ? "Close" : "Reschedule"}
              </Button>
            )}
            {upcoming && (
              <Button variant="danger" onClick={() => setCancelOpen(true)}>
                Cancel
              </Button>
            )}
            {b.status === "confirmed" && !upcoming && (
              <Button variant="secondary" loading={action.pending} onClick={() => action.run(async () => { await api(`/v1/bookings/${b.id}/no-show`, { body: { noShow: !b.noShow } }); await reload(); })}>
                {b.noShow ? "Unmark no-show" : "Mark no-show"}
              </Button>
            )}
          </>
        }
      />
      <ErrorBanner error={action.error} />
      {rescheduling && (
        <Card className="mb-6 p-6">
          <h2 className="mb-4 font-semibold">Pick a new time</h2>
          {publicType.data ? (
            <Booker
              eventType={publicType.data.eventType}
              mode={{ kind: "reschedule-host", bookingId: b.id, currentStart: b.start }}
              onDone={(r) => {
                setRescheduling(false);
                navigate(`/app/bookings/${r.booking.id}`);
              }}
            />
          ) : (
            <ErrorBanner error={publicType.error} />
          )}
        </Card>
      )}
      <div className="grid gap-6 md:grid-cols-2">
        <Card className="space-y-3 p-5 text-sm">
          <Row k="Status">
            {b.status === "cancelled" ? <Badge tone="red">Cancelled{b.cancelledBy ? ` by ${b.cancelledBy}` : ""}</Badge> : <Badge tone="green">Confirmed</Badge>} {b.noShow && <Badge tone="amber">No-show</Badge>}
          </Row>
          <Row k="When">{fmtRange(b.start, b.end, user.timezone)}</Row>
          <Row k="Event type">
            {b.eventType.title} {b.eventType.kind && <span className="text-gray-500">({KIND_LABELS[b.eventType.kind]})</span>}
          </Row>
          <Row k="Hosts">{b.hosts.map((h) => h.name).join(", ")}</Row>
          <Row k="Location">
            {LOCATION_LABELS[b.location.type]}
            {b.location.joinUrl ? (
              <a href={b.location.joinUrl} target="_blank" rel="noreferrer" className="ml-1 break-all text-brand underline">
                {b.location.joinUrl}
              </a>
            ) : b.location.value ? `: ${b.location.value}` : ""}
          </Row>
          {b.assignmentReason && <Row k="Assigned because">{b.assignmentReason}</Row>}
          {b.cancelReason && <Row k="Cancel reason">{b.cancelReason}</Row>}
          {data.rescheduledFrom && (
            <Row k="Rescheduled from">
              <Link to={`/app/bookings/${data.rescheduledFrom.id}`} className="text-brand underline">
                {fmtRange(data.rescheduledFrom.start, data.rescheduledFrom.start, user.timezone).split(" · ")[0]}
              </Link>
            </Row>
          )}
        </Card>
        <Card className="space-y-3 p-5 text-sm">
          <Row k="Invitee">{b.invitee.name}</Row>
          <Row k="Email">
            <a href={`mailto:${b.invitee.email}`} className="text-brand underline">
              {b.invitee.email}
            </a>
          </Row>
          <Row k="Time zone">{b.invitee.timezone}</Row>
          {Object.entries(b.answers).map(([k, v]) => (
            <Row key={k} k={label(k)}>
              {typeof v === "boolean" ? (v ? "Yes" : "No") : v}
            </Row>
          ))}
        </Card>
      </div>
      <Modal open={cancelOpen} onClose={() => setCancelOpen(false)} title="Cancel this meeting?">
        <div className="space-y-4">
          <p className="text-sm text-gray-600">{b.invitee.name} will get an email with your reason.</p>
          <Field label="Reason">
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} />
          </Field>
          <ErrorBanner error={action.error} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setCancelOpen(false)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              loading={action.pending}
              onClick={async () => {
                const ok = await action.run(() => api(`/v1/bookings/${b.id}/cancel`, { body: { reason: reason || undefined } }));
                if (ok) {
                  setCancelOpen(false);
                  await reload();
                }
              }}
            >
              Cancel meeting
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}

function publicPath(b: Booking) {
  // The reschedule picker reuses the public event-type endpoint, keyed by the booking's event type.
  return `/v1/event-types/${b.eventType.id}`;
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[130px_1fr] gap-3">
      <span className="text-gray-500">{k}</span>
      <span className="min-w-0">{children}</span>
    </div>
  );
}
