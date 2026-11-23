/** Minimal RFC 5545 writer for booking invites (.ics attachments). */

export interface IcsEvent {
  uid: string;
  sequence: number;
  method: "REQUEST" | "CANCEL";
  start: Date;
  end: Date;
  summary: string;
  description?: string;
  location?: string;
  url?: string;
  organizer: { name: string; email: string };
  attendees: { name: string; email: string }[];
  productName: string;
}

const fmt = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

function escapeText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

// Control characters (including CR/LF) would end the content line and let input write its own properties.
const CONTROL = /[\u0000-\u001f\u007f]/g;

function escapeParam(s: string): string {
  return `"${s.replace(CONTROL, " ").replace(/"/g, "'")}"`;
}

/** Calendar addresses and URLs are written raw, so they must not contain control characters or spaces. */
function raw(s: string): string {
  return s.replace(CONTROL, "").replace(/\s/g, "");
}

/** Fold lines longer than 75 octets as required by RFC 5545. */
function fold(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let current = "";
  for (const ch of line) {
    if (Buffer.byteLength(current + ch, "utf8") > (parts.length === 0 ? 75 : 74)) {
      parts.push(current);
      current = ch;
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.join("\r\n ");
}

export function buildIcs(e: IcsEvent): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//${escapeText(e.productName)}//Scheduling//EN`,
    "CALSCALE:GREGORIAN",
    `METHOD:${e.method}`,
    "BEGIN:VEVENT",
    `UID:${raw(e.uid)}`,
    `SEQUENCE:${e.sequence}`,
    `DTSTAMP:${fmt(new Date())}`,
    `DTSTART:${fmt(e.start)}`,
    `DTEND:${fmt(e.end)}`,
    `SUMMARY:${escapeText(e.summary)}`,
    e.description ? `DESCRIPTION:${escapeText(e.description)}` : "",
    e.location ? `LOCATION:${escapeText(e.location)}` : "",
    e.url ? `URL:${raw(e.url)}` : "",
    `ORGANIZER;CN=${escapeParam(e.organizer.name)}:mailto:${raw(e.organizer.email)}`,
    ...e.attendees.map(
      (a) => `ATTENDEE;CN=${escapeParam(a.name)};ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=FALSE:mailto:${raw(a.email)}`,
    ),
    `STATUS:${e.method === "CANCEL" ? "CANCELLED" : "CONFIRMED"}`,
    "TRANSP:OPAQUE",
    "END:VEVENT",
    "END:VCALENDAR",
  ].filter(Boolean);
  return lines.map(fold).join("\r\n") + "\r\n";
}
