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
- **SSO** uses OpenID Connect authorization code flow with PKCE, state and nonce. Accounts are linked or created by email only when the provider marks the email verified.
- **Rate limits** apply to login attempts and public booking endpoints (per process).
- **Audit log** records sign-ins, failed sign-ins, configuration changes and booking changes with actor and IP.
- **Webhooks and ICS feeds**: webhooks are signed (HMAC-SHA256 with timestamp). For every user-supplied URL, cloud metadata and other link-local addresses are blocked after DNS resolution (including IPv4-mapped IPv6 forms), on every redirect hop, with timeouts and a size limit on feeds.
- **Headers**: `X-Content-Type-Options`, `Referrer-Policy`, and a Content Security Policy on HTML pages. The dashboard cannot be framed; booking pages can be embedded by design.

What operators are responsible for:

- Serving the app over HTTPS and keeping `ENCRYPTION_KEY` secret and backed up.
- Network policy for webhooks and ICS feeds: members can point them at any reachable URL, including internal hosts. The metadata check runs on the resolved address just before each request, so a DNS answer that changes between the check and the connection is not covered. Restrict egress from the container if that is a concern.
- Rate limiting at the proxy when running multiple replicas.
- Database access control and backups.
