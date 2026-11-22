import * as oidc from "openid-client";
import type { Config } from "../config";

let cached: { key: string; config: oidc.Configuration } | null = null;

export async function oidcConfiguration(config: Config): Promise<oidc.Configuration> {
  const key = `${config.OIDC_ISSUER}|${config.OIDC_CLIENT_ID}`;
  if (cached?.key === key) return cached.config;
  const discovered = await oidc.discovery(
    new URL(config.OIDC_ISSUER!),
    config.OIDC_CLIENT_ID!,
    config.OIDC_CLIENT_SECRET ? { client_secret: config.OIDC_CLIENT_SECRET } : undefined,
    config.OIDC_CLIENT_SECRET ? oidc.ClientSecretPost(config.OIDC_CLIENT_SECRET) : oidc.None(),
    config.OIDC_ISSUER!.startsWith("http://") ? { execute: [oidc.allowInsecureRequests] } : undefined,
  );
  cached = { key, config: discovered };
  return discovered;
}

export function oidcRedirectUri(config: Config) {
  return `${config.APP_URL}/api/auth/oidc/callback`;
}

export async function buildOidcLogin(config: Config) {
  const oc = await oidcConfiguration(config);
  const codeVerifier = oidc.randomPKCECodeVerifier();
  const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const url = oidc.buildAuthorizationUrl(oc, {
    redirect_uri: oidcRedirectUri(config),
    scope: "openid email profile",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
    nonce,
  });
  return { url: url.href, state, nonce, codeVerifier };
}

export async function completeOidcLogin(config: Config, currentUrl: URL, expected: { state: string; nonce: string | null; codeVerifier: string }) {
  const oc = await oidcConfiguration(config);
  const tokens = await oidc.authorizationCodeGrant(oc, currentUrl, {
    pkceCodeVerifier: expected.codeVerifier,
    expectedState: expected.state,
    expectedNonce: expected.nonce ?? undefined,
  });
  const claims = tokens.claims();
  if (!claims) throw new Error("Identity provider returned no ID token");
  let email = claims.email as string | undefined;
  let name = claims.name as string | undefined;
  if (!email) {
    const info = await oidc.fetchUserInfo(oc, tokens.access_token, claims.sub);
    email = info.email;
    name = name ?? info.name;
  }
  if (!email) throw new Error("Identity provider did not share an email address (request the 'email' scope)");
  if (claims.email_verified === false) throw new Error("Email address is not verified by the identity provider");
  return { subject: claims.sub, email: email.toLowerCase(), name: name ?? email };
}
