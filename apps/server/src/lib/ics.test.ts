import { describe, expect, it } from "vitest";
import { buildIcs } from "./ics";

describe("buildIcs", () => {
  it("keeps names and addresses from breaking out of their content line", () => {
    const ics = buildIcs({
      uid: "abc@example.com",
      sequence: 1,
      method: "REQUEST",
      start: new Date("2030-01-07T09:00:00Z"),
      end: new Date("2030-01-07T09:30:00Z"),
      summary: "Intro\r\nATTENDEE:mailto:evil@example.com",
      organizer: { name: "Host", email: "host@example.com" },
      attendees: [{ name: 'Jane\r\nATTENDEE;CN=Evil:mailto:evil@example.com\r\nX-"', email: "jane@example.com\r\nX-EVIL:1" }],
      productName: "Timebook",
    });
    const lines = ics.replace(/\r\n /g, "").split("\r\n");
    expect(lines.filter((l) => l.startsWith("ATTENDEE"))).toHaveLength(1);
    expect(lines.some((l) => l.startsWith("X-EVIL") || l.startsWith("X-'"))).toBe(false);
    expect(lines.find((l) => l.startsWith("SUMMARY"))).toBe("SUMMARY:Intro\\nATTENDEE:mailto:evil@example.com");
  });
});
