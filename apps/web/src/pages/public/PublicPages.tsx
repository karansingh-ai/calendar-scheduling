import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { applyBrand } from "../../auth";
import { Booker, EventSummary, notifyParent, type BookerResult } from "../../components/Booker";
import { Badge, Button, Card, cx, ErrorBanner, Field, Loading, Notice, Textarea } from "../../components/ui";
import { api, errorMessage, type Booking, type Org, type PublicEventType } from "../../lib/api";
import { useApi } from "../../lib/hooks";
import { browserTimeZone, fmtDuration, fmtRange } from "../../lib/time";

export function useEmbed() {
  const [params] = useSearchParams();
  const embed = params.get("embed") === "1";
  useEffect(() => {
    if (!embed) return;
    document.body.classList.add("embed");
    const ro = new ResizeObserver(() => notifyParent("page_height", { height: document.documentElement.scrollHeight }));
    ro.observe(document.body);
    return () => ro.disconnect();
  }, [embed]);
  return embed;
}

function Shell({ org, children, embed }: { org?: Org; children: React.ReactNode; embed?: boolean }) {
  useEffect(() => applyBrand(org?.brandColor), [org?.brandColor]);
  return (
    <div className={cx("min-h-full", embed ? "p-2" : "px-4 py-10")}>
      <div className="mx-auto max-w-4xl">
        {!embed && org?.logoUrl && <img src={org.logoUrl} alt={org.name} className="mx-auto mb-6 h-10" />}
        {children}
        {!embed && org && <p className="mt-6 text-center text-xs text-gray-400">Powered by {org.appName}</p>}
      </div>
    </div>
  );
}

function NotFoundCard({ message }: { message: string }) {
  return (
    <Shell>
      <Card className="mx-auto max-w-md p-8 text-center">
        <p className="font-medium">{message}</p>
      </Card>
    </Shell>
  );
}

interface ListPage {
  org: Org;
  user?: { name: string; username: string; welcomeMessage: string | null };
  team?: { name: string; slug: string };
  eventTypes: { id: string; slug: string; title: string; description: string; durationMinutes: number; color: string }[];
}

export function ProfilePage({ team }: { team?: boolean }) {
  const params = useParams();
  const embed = useEmbed();
  const path = team ? `/public/teams/${params.teamSlug}` : `/public/users/${params.username}`;
  const { data, error, loading } = useApi<ListPage>(path);
  if (loading) return <Loading />;
  if (error || !data) return <NotFoundCard message={error ?? "Page not found"} />;
  const title = data.team?.name ?? data.user?.name;
  const base = team ? `/team/${data.team!.slug}` : `/${data.user!.username}`;
  return (
    <Shell org={data.org} embed={embed}>
      <Card className="p-8">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold">{title}</h1>
          {data.user?.welcomeMessage && <p className="mx-auto mt-2 max-w-lg text-gray-600">{data.user.welcomeMessage}</p>}
        </div>
        {data.eventTypes.length === 0 ? (
          <p className="text-center text-sm text-gray-500">No public event types yet.</p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {data.eventTypes.map((et) => (
              <Link key={et.id} to={`${base}/${et.slug}${embed ? "?embed=1" : ""}`} className="rounded-lg border border-gray-200 p-5 transition hover:border-brand hover:shadow-sm" style={{ borderTopColor: et.color, borderTopWidth: 4 }}>
                <p className="font-semibold">{et.title}</p>
                <p className="mt-1 text-sm text-gray-500">{fmtDuration(et.durationMinutes)}</p>
                {et.description && <p className="mt-2 line-clamp-2 text-sm text-gray-600">{et.description}</p>}
              </Link>
            ))}
          </div>
        )}
      </Card>
    </Shell>
  );
}

export function BookingPage({ team }: { team?: boolean }) {
  const params = useParams();
  const embed = useEmbed();
  const navigate = useNavigate();
  const path = team ? `/public/teams/${params.teamSlug}/event-types/${params.slug}` : `/public/users/${params.username}/event-types/${params.slug}`;
  const { data, error, loading } = useApi<{ org: Org; eventType: PublicEventType }>(path);

  if (loading) return <Loading />;
  if (error || !data) return <NotFoundCard message={error ?? "This page does not exist"} />;

  const done = (r: BookerResult) => {
    notifyParent("event_scheduled", { booking: { id: r.booking.id, start: r.booking.start, end: r.booking.end, invitee: r.booking.invitee } });
    if (data.eventType.redirectUrl && !embed) {
      const url = new URL(data.eventType.redirectUrl);
      url.searchParams.set("booking_id", r.booking.id);
      url.searchParams.set("start", r.booking.start);
      window.location.href = url.toString();
      return;
    }
    navigate(`/booking/${r.booking.id}?token=${encodeURIComponent(r.manageToken ?? "")}&new=1${embed ? "&embed=1" : ""}`);
  };

  return (
    <Shell org={data.org} embed={embed}>
      <Card className="grid gap-8 p-6 md:grid-cols-[280px_1fr] md:p-8">
        <div className="md:border-r md:pr-8">
          <EventSummary eventType={data.eventType} />
        </div>
        <div>
          <h2 className="mb-4 text-lg font-semibold">Select a date and time</h2>
          <Booker eventType={data.eventType} onDone={done} />
        </div>
      </Card>
    </Shell>
  );
}

interface ManageData {
  org: Org;
  booking: Booking;
  eventType: PublicEventType;
  canCancel: boolean;
  canReschedule: boolean;
}

export function ManageBookingPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const embed = useEmbed();
  const token = params.get("token") ?? "";
  const isNew = params.get("new") === "1";
  const { data, error, loading, reload } = useApi<ManageData>(`/public/bookings/${id}?token=${encodeURIComponent(token)}`);
  const [mode, setMode] = useState<"view" | "reschedule" | "cancel">("view");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const tz = data?.booking.invitee.timezone ?? browserTimeZone();

  if (loading) return <Loading />;
  if (error || !data) return <NotFoundCard message={error ?? "This booking link is invalid"} />;
  const b = data.booking;

  const cancel = async () => {
    setPending(true);
    setActionError(null);
    try {
      await api(`/public/bookings/${b.id}/cancel`, { body: { token, reason: reason || undefined } });
      notifyParent("event_canceled", { bookingId: b.id });
      setMode("view");
      await reload();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <Shell org={data.org} embed={embed}>
      <Card className="mx-auto max-w-2xl p-8">
        {b.status === "cancelled" ? (
          <div className="mb-6 text-center">
            <Badge tone="red">Cancelled</Badge>
            <h1 className="mt-3 text-2xl font-semibold">This meeting was cancelled</h1>
            {b.cancelReason && <p className="mt-1 text-gray-600">{b.cancelReason}</p>}
          </div>
        ) : (
          <div className="mb-6 text-center">
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-green-100 text-2xl text-green-700">✓</div>
            <h1 className="text-2xl font-semibold">{isNew ? "You are scheduled" : "Your meeting"}</h1>
            {isNew && <p className="mt-1 text-gray-600">A calendar invitation is on its way to {b.invitee.email}.</p>}
          </div>
        )}

        <div className="space-y-2 rounded-lg border p-5 text-sm">
          <p className="text-base font-semibold">{data.eventType.title}</p>
          <p>🗓 {fmtRange(b.start, b.end, tz)}</p>
          <p className="text-gray-500">🌐 {tz.replace(/_/g, " ")}</p>
          <p>👤 {b.hosts.map((h) => h.name).join(", ")}</p>
          {(b.location.joinUrl || b.location.value) && (
            <p>
              📍{" "}
              {b.location.joinUrl ? (
                <a href={b.location.joinUrl} className="text-brand underline" target="_blank" rel="noreferrer">
                  {b.location.joinUrl}
                </a>
              ) : (
                b.location.value
              )}
            </p>
          )}
        </div>

        {mode === "view" && (data.canCancel || data.canReschedule) && (
          <div className="mt-6 flex justify-center gap-3">
            {data.canReschedule && (
              <Button variant="secondary" onClick={() => setMode("reschedule")}>
                Reschedule
              </Button>
            )}
            {data.canCancel && (
              <Button variant="danger" onClick={() => setMode("cancel")}>
                Cancel meeting
              </Button>
            )}
          </div>
        )}

        {mode === "cancel" && (
          <div className="mt-6 space-y-3">
            <Field label="Reason for cancelling (optional)">
              <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} />
            </Field>
            <ErrorBanner error={actionError} />
            <div className="flex gap-2">
              <Button variant="danger" loading={pending} onClick={cancel}>
                Confirm cancellation
              </Button>
              <Button variant="ghost" onClick={() => setMode("view")}>
                Keep meeting
              </Button>
            </div>
          </div>
        )}

        {mode === "reschedule" && (
          <div className="mt-6 border-t pt-6">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="font-semibold">Pick a new time</h2>
              <Button variant="ghost" onClick={() => setMode("view")}>
                Back
              </Button>
            </div>
            <Booker
              eventType={data.eventType}
              mode={{ kind: "reschedule-invitee", bookingId: b.id, token, currentStart: b.start }}
              onDone={(r) => {
                notifyParent("event_rescheduled", { bookingId: r.booking.id, previousBookingId: b.id });
                setMode("view");
                navigate(`/booking/${r.booking.id}?token=${encodeURIComponent(r.manageToken ?? "")}${embed ? "&embed=1" : ""}`, { replace: true });
              }}
            />
          </div>
        )}
        {data.booking.status === "confirmed" && !data.canCancel && <Notice>This meeting has already started or ended.</Notice>}
      </Card>
    </Shell>
  );
}
