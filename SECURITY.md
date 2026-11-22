# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through **GitHub Security Advisories** ("Report a vulnerability" on the repository's Security tab). Do not open public issues for security problems.

We aim to acknowledge reports within 3 business days and to ship fixes for critical issues as quickly as possible, with credit to the reporter if desired.

## Supported versions

Security fixes are released for the latest minor version. Self-hosters should follow releases and upgrade promptly.

## Security model

What the application does:

- **Passwords** are hashed with scrypt. Sessions are random 256-bit tokens stored only as SHA-256 hashes, sent in `HttpOnly`, `SameSite=Lax` cookies (`Secure` on HTTPS).
- **CSRF**: state-changing requests must be JSON and, when an `Origin` header is present, must come from `APP_URL`.
- **API keys** are shown once and stored as SHA-256 hashes. Keys cannot mint other keys.
- **Secrets at rest**: OAuth tokens, ICS feed URLs, webhook secrets and booking manage tokens are encrypted with AES-256-GCM using `ENCRYPTION_KEY`.
- **Invitee links** use unguessable per-booking tokens (192 bits) compared by hash.
- **SSO** uses OpenID Connect authorization code flow with PKCE, state and nonce, and rejects unverified emails.
- **Rate limits** apply to login attempts and public booking endpoints (per process).
- **Audit log** records sign-ins, failed sign-ins, configuration changes and booking changes with actor and IP.
- **Webhooks** are signed (HMAC-SHA256 with timestamp). Cloud metadata addresses are blocked as targets.
- **Headers**: `X-Content-Type-Options`, `Referrer-Policy`, and a Content Security Policy on HTML pages. The dashboard cannot be framed; booking pages can be embedded by design.

What operators are responsible for:

- Serving the app over HTTPS and keeping `ENCRYPTION_KEY` secret and backed up.
- Network policy for webhooks: members can create webhooks to any reachable URL, including internal hosts. Restrict egress from the container if that is a concern.
- Rate limiting at the proxy when running multiple replicas.
- Database access control and backups.
