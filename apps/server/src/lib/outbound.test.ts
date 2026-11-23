import { describe, expect, it } from "vitest";
import { assertAllowedUrl, BlockedUrlError, checkUrlShape, guardedFetch, isBlockedIp, readTextLimited } from "./outbound";

describe("isBlockedIp", () => {
  it.each([
    "169.254.169.254",
    "169.254.0.1",
    "0.0.0.0",
    "100.100.100.200",
    "::",
    "fe80::1",
    "fd00:ec2::254",
    "::ffff:169.254.169.254",
    "::ffff:a9fe:a9fe",
    "0:0:0:0:0:ffff:a9fe:a9fe",
    "::169.254.169.254",
  ])("blocks %s", (ip) => expect(isBlockedIp(ip)).toBe(true));

  it.each(["93.184.215.14", "10.0.0.5", "192.168.1.10", "127.0.0.1", "2606:4700::1111", "::ffff:10.0.0.5", "fd00::1"])("allows %s", (ip) =>
    expect(isBlockedIp(ip)).toBe(false),
  );
});

describe("URL checks", () => {
  it("rejects bad schemes, credentials and literal metadata addresses in any spelling", () => {
    for (const u of ["ftp://x.test/", "http://user:pw@x.test/", "http://[::ffff:169.254.169.254]/", "http://2852039166/", "http://metadata.google.internal./"]) {
      expect(() => checkUrlShape(u), u).toThrow(BlockedUrlError);
    }
    expect(checkUrlShape("https://hooks.example.com/in").hostname).toBe("hooks.example.com");
  });

  it("rejects names that resolve to a blocked address", async () => {
    await expect(assertAllowedUrl("https://evil.test/", async () => ["10.0.0.1", "169.254.169.254"])).rejects.toThrow(BlockedUrlError);
    await expect(assertAllowedUrl("https://ok.test/", async () => ["10.0.0.1"])).resolves.toBeInstanceOf(URL);
  });

  it("re-checks every redirect hop", async () => {
    const dns = async (h: string) => (h === "inner.test" ? ["169.254.169.254"] : ["93.184.215.14"]);
    const fetchFn = (async () => new Response(null, { status: 302, headers: { location: "http://inner.test/latest/meta-data" } })) as typeof fetch;
    await expect(guardedFetch(fetchFn, dns, "https://feed.test/cal.ics", {}, { maxRedirects: 3 })).rejects.toThrow(BlockedUrlError);
    // Without redirect following, the 3xx comes back untouched.
    expect((await guardedFetch(fetchFn, dns, "https://feed.test/cal.ics")).status).toBe(302);
  });

  it("caps response size", async () => {
    await expect(readTextLimited(new Response("x".repeat(2000)), 1000)).rejects.toThrow(/larger than/);
    expect(await readTextLimited(new Response("hello"), 1000)).toBe("hello");
  });
});
