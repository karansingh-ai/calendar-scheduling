import { and, eq, inArray } from "drizzle-orm";
import { DateTime } from "luxon";
import type { AppContext } from "../context";
import { calendars, users, type BookingLocation } from "../db/schema";
import { buildIcs } from "../lib/ics";
import type { MailMessage } from "../lib/mailer";
import { bookingPayload } from "./webhooks";
import { getOrgSettings } from "./users";

export type BookingEmailKind = "confirmed" | "rescheduled" | "cancelled" | "reminder";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function when(start: Date, end: Date, zone: string) {
  const s = DateTime.fromJSDate(start, { zone });
  const e = DateTime.fromJSDate(end, { zone });
  return `${s.toFormat("cccc, LLLL d, yyyy")} · ${s.toFormat("h:mm a")} - ${e.toFormat("h:mm a")} (${s.toFormat("ZZZZ")}, ${zone})`;
}

function locationLine(l: BookingLocation): string | null {
  if (l.joinUrl) return l.joinUrl;
  if (l.type === "google_meet") return "Google Meet (link to follow from the host)";
  if (l.type === "microsoft_teams") return "Microsoft Teams (link to follow from the host)";
  return l.value ?? null;
}

function layout(opts: { appName: string; color: string; heading: string; rows: [string, string][]; footer?: string; button?: { label: string; url: string } }) {
  const rows = opts.rows
    .map(([k, v]) => `<tr><td style="padding:6px 12px 6px 0;color:#6b7280;vertical-align:top;white-space:nowrap">${esc(k)}</td><td style="padding:6px 0;color:#111827">${esc(v).replace(/\n/g, "<br>")}</td></tr>`)
    .join("");
  const button = opts.button
    ? `<p style="margin:24px 0 0"><a href="${esc(opts.button.url)}" style="background:${esc(opts.color)};color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;display:inline-block">${esc(opts.button.label)}</a></p>`
    : "";
  const html = `<!doctype html><html><body style="margin:0;background:#f3f4f6;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<div style="max-width:560px;margin:24px auto;background:#fff;border-radius:8px;padding:28px;border-top:4px solid ${esc(opts.color)}">
<h1 style="font-size:20px;margin:0 0 16px;color:#111827">${esc(opts.heading)}</h1>
<table style="border-collapse:collapse;font-size:14px">${rows}</table>${button}
${opts.footer ? `<p style="margin:24px 0 0;font-size:12px;color:#6b7280">${esc(opts.footer)}</p>` : ""}
</div><p style="text-align:center;font-size:12px;color:#9ca3af">Sent by ${esc(opts.appName)}</p></body></html>`;
  const text = [opts.heading, "", ...opts.rows.map(([k, v]) => `${k}: ${v}`), opts.button ? `\n${opts.button.label}: ${opts.button.url}` : "", opts.footer ? `\n${opts.footer}` : ""].join("\n");
  return { html, text };
}

export async function sendBookingEmails(ctx: AppContext, bookingId: string, kind: BookingEmailKind, reminderMinutes?: number) {
  const data = await bookingPayload(ctx, bookingId);
  if (!data) return;
  const { booking: b, eventType: et } = data.row;
  if (kind === "reminder" && b.status !== "confirmed") return;
  const org = await getOrgSettings(ctx.db);
  const appName = ctx.config.APP_NAME;
  const hosts = await ctx.db.select().from(users).where(inArray(users.id, data.hosts.map((h) => h.id)));
  const destinations = await ctx.db
    .select({ userId: calendars.userId })
    .from(calendars)
    .where(and(inArray(calendars.userId, hosts.map((h) => h.id)), eq(calendars.isDestination, true)));
  const hostsWithCalendar = new Set(destinations.map((d) => d.userId));
  const manageToken = ctx.encrypter.decrypt(b.manageTokenEnc);
  const manageUrl = `${ctx.config.APP_URL}/booking/${b.id}?token=${encodeURIComponent(manageToken)}`;
  const loc = locationLine(b.location);
  const hostNames = hosts.map((h) => h.name).join(", ");

  const ics = buildIcs({
    uid: b.icsUid,
    sequence: Math.floor(b.updatedAt.getTime() / 1000),
    method: kind === "cancelled" ? "CANCEL" : "REQUEST",
    start: b.startAt,
    end: b.endAt,
    summary: `${et.title}: ${b.inviteeName} and ${hostNames}`,
    description: `${et.description ? `${et.description}\n\n` : ""}Manage this booking: ${manageUrl}`,
    location: loc ?? undefined,
    url: manageUrl,
    organizer: { name: hosts[0]?.name ?? appName, email: hosts[0]?.email ?? "no-reply@localhost" },
    attendees: [{ name: b.inviteeName, email: b.inviteeEmail }, ...hosts.slice(1).map((h) => ({ name: h.name, email: h.email }))],
    productName: appName,
  });

  const verb = { confirmed: "Confirmed", rescheduled: "Rescheduled", cancelled: "Cancelled", reminder: "Reminder" }[kind];
  const answerRows: [string, string][] = Object.entries(b.answers).map(([k, v]) => [
    et.questions.find((q) => q.id === k)?.label ?? k,
    typeof v === "boolean" ? (v ? "Yes" : "No") : v,
  ]);
  const messages: MailMessage[] = [];

  // Invitee
  {
    const rows: [string, string][] = [
      ["What", et.title],
      ["When", when(b.startAt, b.endAt, b.inviteeTimezone)],
      ["With", hostNames],
    ];
    if (loc) rows.push(["Where", loc]);
    if (kind === "cancelled" && b.cancelReason) rows.push(["Reason", b.cancelReason]);
    const heading =
      kind === "reminder"
        ? `Reminder: ${et.title} in ${reminderMinutes && reminderMinutes >= 120 ? `${Math.round(reminderMinutes / 60)} hours` : `${reminderMinutes} minutes`}`
        : `${verb}: ${et.title} with ${hostNames}`;
    const { html, text } = layout({
      appName,
      color: org.brandColor,
      heading,
      rows,
      button: kind === "cancelled" ? undefined : { label: "Reschedule or cancel", url: manageUrl },
    });
    messages.push({
      to: b.inviteeEmail,
      replyTo: hosts[0]?.email,
      subject: `${verb}: ${et.title} with ${hostNames} - ${when(b.startAt, b.endAt, b.inviteeTimezone).split(" (")[0]}`,
      html,
      text,
      ics: kind === "reminder" ? undefined : { method: kind === "cancelled" ? "CANCEL" : "REQUEST", content: ics },
    });
  }

  // Hosts
  for (const host of hosts) {
    const rows: [string, string][] = [
      ["What", et.title],
      ["When", when(b.startAt, b.endAt, host.timezone)],
      ["Invitee", `${b.inviteeName} <${b.inviteeEmail}>`],
      ["Invitee time zone", b.inviteeTimezone],
    ];
    if (loc) rows.push(["Where", loc]);
    rows.push(...answerRows);
    if (b.assignmentReason && kind !== "reminder") rows.push(["Assigned because", b.assignmentReason]);
    if (kind === "cancelled" && b.cancelReason) rows.push(["Reason", b.cancelReason]);
    const { html, text } = layout({
      appName,
      color: org.brandColor,
      heading: kind === "reminder" ? `Reminder: ${et.title} with ${b.inviteeName}` : `${verb}: ${et.title} with ${b.inviteeName}`,
      rows,
      button: { label: "Open in " + appName, url: `${ctx.config.APP_URL}/app/bookings/${b.id}` },
    });
    messages.push({
      to: host.email,
      replyTo: b.inviteeEmail,
      subject: `${kind === "reminder" ? "Reminder" : `${verb} event`}: ${b.inviteeName} - ${et.title}`,
      html,
      text,
      ics: kind === "reminder" || hostsWithCalendar.has(host.id) ? undefined : { method: kind === "cancelled" ? "CANCEL" : "REQUEST", content: ics },
    });
  }

  for (const m of messages) await ctx.mailer.send(m);
}

export async function sendInviteEmail(ctx: AppContext, to: { email: string; name: string }, url: string, invitedBy: string) {
  const org = await getOrgSettings(ctx.db);
  const { html, text } = layout({
    appName: ctx.config.APP_NAME,
    color: org.brandColor,
    heading: `${invitedBy} invited you to ${org.name} on ${ctx.config.APP_NAME}`,
    rows: [["Your email", to.email]],
    button: { label: "Accept invite", url },
    footer: "This link expires in 7 days.",
  });
  await ctx.mailer.send({ to: to.email, subject: `You're invited to ${org.name} on ${ctx.config.APP_NAME}`, html, text });
}
