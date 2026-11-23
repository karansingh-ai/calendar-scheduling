# Integrations

## Single sign-on (OpenID Connect)

Any standards-compliant OpenID Connect provider works. Register a **web application** with:

- **Redirect URI:** `<APP_URL>/api/auth/oidc/callback`
- **Scopes:** `openid email profile`
- **Grant type:** authorization code (PKCE is always used)

Then set `OIDC_ISSUER`, `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`.

| Provider | Issuer URL |
|---|---|
| Microsoft Entra ID | `https://login.microsoftonline.com/<tenant-id>/v2.0` |
| Okta | `https://<your-org>.okta.com` (or a custom authorization server URL) |
| Google Workspace | `https://accounts.google.com` |
| Keycloak | `https://<host>/realms/<realm>` |
| Authentik | `https://<host>/application/o/<slug>/` |
| Auth0 | `https://<tenant>.auth0.com/` |

Sign-in matches users by the provider's subject ID, then by email for accounts not yet linked to SSO. An account already linked to a different subject is never re-linked by email, so a reassigned address cannot take over someone's account. New users are created as members when `OIDC_AUTO_PROVISION=true`.

Matching by email and creating accounts both trust the email address, so both require:

- **A verified email.** The ID token (or userinfo response) must include `email_verified: true`. Google, Okta, Keycloak and Auth0 send it. Microsoft Entra ID does not; with a tenant-specific issuer (not `common` or `organizations`) you can set `OIDC_TRUST_UNVERIFIED_EMAIL=true`.
- **An allowed domain**, when `ALLOWED_EMAIL_DOMAINS` is set.

## Sign in with Google

Google sign-in uses the same OAuth client as Google Calendar, so set that up first (next section), then:

1. Add a second **Authorized redirect URI** to the client: `<APP_URL>/api/auth/oidc/callback`.
2. Set `GOOGLE_SIGN_IN=true` and restart. The login and invite pages show a **Continue with Google** button.

`GOOGLE_SIGN_IN` is shorthand for `OIDC_ISSUER=https://accounts.google.com` with the Google client's ID and secret, and replaces any other OIDC provider (only one is supported at a time). Google's account chooser is always shown, so people with several Google accounts pick the right one. Invited users who sign in with Google are linked to their invite by email; the workspace owner created during setup can link Google the same way by signing in with the same address.

**Who can sign in:** with `OIDC_AUTO_PROVISION=true` and no `ALLOWED_EMAIL_DOMAINS`, anyone with a Google account can create a member account. Members can see the user directory (names and emails), so for a company deployment set `ALLOWED_EMAIL_DOMAINS=yourcompany.com`, or `OIDC_AUTO_PROVISION=false` to admit invited people only. While the OAuth consent screen is in **Testing**, Google only lets the test users you list sign in; an **External** app used by anyone must be published, and because it also requests calendar scopes Google shows an "unverified app" warning (and caps it at 100 users) until the app passes verification. **Internal** (Workspace-only) apps need no verification.

## Google Calendar and Google Meet

1. In Google Cloud Console, create a project and enable the **Google Calendar API**.
2. Configure the OAuth consent screen. Choose **Internal** for a Workspace-only deployment (no Google verification needed).
3. Create an **OAuth client ID** of type *Web application* with the redirect URI `<APP_URL>/api/integrations/google/callback` (add `<APP_URL>/api/auth/oidc/callback` too for Google sign-in).
4. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` and restart.

Scopes requested: `calendar.readonly` (free/busy and calendar list) and `calendar.events` (create bookings), plus `openid email`.

Each user connects their own account under **Calendars** and chooses which calendars to check for conflicts and which one receives new bookings. Event types with location **Google Meet** get a unique Meet link per booking.

## Microsoft 365 / Outlook and Teams

1. In the Entra admin center, go to **App registrations > New registration**.
2. Add the redirect URI `<APP_URL>/api/integrations/microsoft/callback` (platform: Web).
3. Under **Certificates & secrets**, create a client secret.
4. Under **API permissions**, add delegated Microsoft Graph permissions: `Calendars.ReadWrite`, `User.Read`, `offline_access`, `openid`, `email`. Grant admin consent for your tenant.
5. Set `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` and `MICROSOFT_TENANT_ID` (your tenant ID, or `common` for multi-tenant).

Event types with location **Microsoft Teams** get a Teams meeting link on the host's calendar event.

## ICS calendar feeds

Users can paste any secret iCal address under **Calendars**: iCloud (share a calendar publicly or use a private link), Fastmail, Proton Calendar, Outlook "publish calendar", Nextcloud and most CalDAV servers. Feeds are read-only and used for conflict checks, including recurring events. Busy times are cached for 60 seconds.

## Email

Any SMTP server works. Examples:

```
SMTP_URL=smtps://apikey:<key>@smtp.sendgrid.net:465
SMTP_URL=smtp://<user>:<pass>@email-smtp.us-east-1.amazonaws.com:587
SMTP_URL=smtp://<user>%40acme.com:<app-password>@smtp.office365.com:587
```

URL-encode special characters in usernames and passwords (`@` becomes `%40`).
