/** Paths used by the app itself; these cannot be usernames because public pages live at /:username. */
export const RESERVED_USERNAMES = new Set([
  "admin",
  "api",
  "app",
  "assets",
  "booking",
  "bookings",
  "embed",
  "embed.js",
  "favicon.ico",
  "health",
  "healthz",
  "invite",
  "login",
  "logout",
  "robots.txt",
  "settings",
  "setup",
  "static",
  "team",
  "teams",
]);

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}
