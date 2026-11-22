import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { Badge, Button, Card, EmptyState, ErrorBanner, Field, Input, Loading, Notice, PageHeader, Section, Toggle } from "../../components/ui";
import { api } from "../../lib/api";
import { useAction, useApi } from "../../lib/hooks";

interface CalendarsResponse {
  available: { google: boolean; microsoft: boolean; ics: boolean };
  connections: {
    id: string;
    provider: "google" | "microsoft" | "ics";
    accountEmail: string | null;
    lastError: string | null;
    calendars: { id: string; name: string; checkConflicts: boolean; isDestination: boolean; readOnly: boolean }[];
  }[];
}

const NAMES = { google: "Google Calendar", microsoft: "Microsoft 365 / Outlook", ics: "Calendar feed (ICS)" };

export function CalendarsPage() {
  const [params] = useSearchParams();
  const { data, error, loading, reload } = useApi<CalendarsResponse>("/v1/calendars");
  const action = useAction();
  const [feedUrl, setFeedUrl] = useState("");
  const [feedName, setFeedName] = useState("Personal calendar");

  if (loading && !data) return <Loading />;
  if (!data) return <ErrorBanner error={error} />;

  const patch = (id: string, body: Record<string, boolean>) =>
    action.run(async () => {
      await api(`/v1/calendars/${id}`, { method: "PATCH", body });
      await reload();
    });

  const addFeed = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await action.run(() => api("/v1/calendar-connections/ics", { body: { url: feedUrl, name: feedName } }));
    if (ok) {
      setFeedUrl("");
      await reload();
    }
  };

  return (
    <>
      <PageHeader title="Calendars" description="Connect calendars so busy times block bookings, and new bookings land on your calendar." />
      <div className="space-y-6">
        {params.get("connected") && <Notice tone="green">Calendar connected.</Notice>}
        {params.get("error") && <ErrorBanner error={`Could not connect the calendar (${params.get("error")}).`} />}
        <ErrorBanner error={action.error} />

        <Section title="Connect a calendar">
          <div className="flex flex-wrap gap-3">
            {data.available.google ? (
              <a href="/api/integrations/google/start">
                <Button variant="secondary">Connect Google Calendar</Button>
              </a>
            ) : (
              <Button variant="secondary" disabled title="Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the server">
                Google Calendar (not configured)
              </Button>
            )}
            {data.available.microsoft ? (
              <a href="/api/integrations/microsoft/start">
                <Button variant="secondary">Connect Microsoft 365</Button>
              </a>
            ) : (
              <Button variant="secondary" disabled title="Set MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET on the server">
                Microsoft 365 (not configured)
              </Button>
            )}
          </div>
          <form onSubmit={addFeed} className="grid gap-3 sm:grid-cols-[1fr_200px_auto] sm:items-end">
            <Field label="Or add a read-only calendar feed" hint="Any secret iCal/ICS address: iCloud, Fastmail, Proton, Outlook published calendars, CalDAV exports.">
              <Input type="url" placeholder="https:// or webcal://" value={feedUrl} onChange={(e) => setFeedUrl(e.target.value.replace(/^webcal:/, "https:"))} required />
            </Field>
            <Field label="Name">
              <Input value={feedName} onChange={(e) => setFeedName(e.target.value)} />
            </Field>
            <Button type="submit" variant="secondary" loading={action.pending}>
              Add feed
            </Button>
          </form>
        </Section>

        {data.connections.length === 0 ? (
          <EmptyState title="No calendars connected">Without a calendar, only your weekly hours and existing bookings are used.</EmptyState>
        ) : (
          data.connections.map((conn) => (
            <Card key={conn.id} className="p-5">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-semibold">{NAMES[conn.provider]}</p>
                  {conn.accountEmail && <p className="text-sm text-gray-500">{conn.accountEmail}</p>}
                </div>
                <div className="flex gap-2">
                  {conn.provider !== "ics" && (
                    <Button variant="ghost" onClick={() => action.run(async () => { await api(`/v1/calendar-connections/${conn.id}/sync`, { method: "POST" }); await reload(); })}>
                      Refresh list
                    </Button>
                  )}
                  <Button
                    variant="danger"
                    onClick={() =>
                      confirm("Disconnect this calendar?") &&
                      action.run(async () => {
                        await api(`/v1/calendar-connections/${conn.id}`, { method: "DELETE" });
                        await reload();
                      })
                    }
                  >
                    Disconnect
                  </Button>
                </div>
              </div>
              {conn.lastError && <ErrorBanner error={`Last sync error: ${conn.lastError}`} />}
              <table className="mt-2 w-full text-sm">
                <thead className="text-left text-xs text-gray-500">
                  <tr>
                    <th className="py-1">Calendar</th>
                    <th>Check for conflicts</th>
                    <th>Add new bookings here</th>
                  </tr>
                </thead>
                <tbody>
                  {conn.calendars.map((cal) => (
                    <tr key={cal.id} className="border-t">
                      <td className="py-2">
                        {cal.name} {cal.readOnly && <Badge>Read only</Badge>}
                      </td>
                      <td>
                        <Toggle checked={cal.checkConflicts} onChange={(v) => void patch(cal.id, { checkConflicts: v })} />
                      </td>
                      <td>
                        {cal.readOnly ? (
                          <span className="text-xs text-gray-400">n/a</span>
                        ) : (
                          <input type="radio" name="destination" checked={cal.isDestination} onChange={() => void patch(cal.id, { isDestination: true })} aria-label={`Add bookings to ${cal.name}`} />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          ))
        )}
      </div>
    </>
  );
}
