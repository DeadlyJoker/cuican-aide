# CrewON production Web boundary

The production Web entry is the static nginx image plus the dedicated `@crewon/web-bff` process. Vite's development proxy is
not part of this deployment and is not production evidence.

nginx serves the SPA and routes the following same-origin paths to the BFF on loopback port `3211`:

- `GET /control-api/session` resolves the existing HttpOnly identity session and returns exactly `{baseUrl, csrfToken}`.
- `/api/v1` and `/api/v1/*` proxy Control API traffic. nginx and the BFF both discard a browser-supplied `Authorization` header.
- `GET /control-api/health/live` proves only that the BFF process is alive. `/crewon-health` still proves only that static nginx is
  alive; neither endpoint proves Identity Center or Control readiness.

The BFF uses only Node.js standard-library components. nginx and Node.js are open-source runtime components; no proprietary
agent SDK or closed BFF framework is introduced.

## Identity contract and hard gates

The BFF does not accept actor, tenant, space, resource authority, or a Control token from browser headers, query parameters, or
JSON. It forwards the browser's opaque cookie only to the configured HTTPS Identity Center session endpoint using a separate
server credential. That endpoint must return this exact, bounded response:

```json
{
  "sessionId": "opaque-identity-session-id-at-least-32-bytes",
  "expiresAt": "2026-08-09T00:01:00.000Z",
  "controlAccessToken": "short-lived-audience-limited-control-token"
}
```

`expiresAt` must be canonical UTC RFC 3339, in the future, and no more than ten minutes away. The BFF derives the browser CSRF
token with HMAC from `sessionId` and the exact public origin. It injects a separate server-only Control CSRF value when proxying
mutations. Control responses cannot set browser cookies through this proxy.

For every Control request, the BFF injects both `Authorization: Bearer <short-lived user token>` and
`X-CrewON-BFF-Authorization: Bearer <BFF service credential>`. `CREWON_CONTROL_BFF_TOKEN` is a separate server-only secret of at
least 32 bytes. The browser cannot supply or observe it; the BFF replaces a forged inbound header and does not forward the same
header from Control responses. Control's production identity adapter must validate both credentials before resolving an actor.

Production cutover is blocked until all of these external identity conditions are true:

1. Identity Center completes Authorization Code + PKCE and owns the CrewON host's `HttpOnly; Secure; SameSite` session cookie,
   rotation, logout, revocation, and expiry. This repository does not implement that login/callback authority.
2. The server-to-server session endpoint authenticates `CREWON_IDENTITY_SERVICE_TOKEN`, validates the cookie against live
   session state, resolves explicit Principal-to-Actor/Tenant/Space bindings, and mints a short-lived Control-only audience token.
3. Control API has a production `ControlApiIdentityPort` adapter that sends the token to a trusted, bounded HTTPS verification
   authority and independently checks its issuer, audience, issued/expiry lifetime and exact actor scope. That identity authority
   owns signature/JWKS and revocation validation. `StandaloneIdentity` remains loopback/local composition only and is not a valid
   multi-user production substitute.
4. TLS, secrets, process supervision, rate limits, audit correlation, Identity/Control readiness, and logout/revocation are
   verified in staging and then live. Static build success or an nginx health response is insufficient.

The BFF intentionally fails startup if its public origin is not HTTPS, the Identity endpoint is not HTTPS, the Control target is
not fixed loopback HTTP, or required secrets are absent/short. Identity exchange schema drift, expiry, excessive lifetime and
transport errors fail closed.

## Build and process layout

Build both images from their required contexts:

```bash
docker build -t crewon-web:local -f deploy/crewon/web.Dockerfile apps/crewon-ui
docker build -t crewon-web-bff:local -f deploy/crewon/web-bff.Dockerfile .
```

The checked-in nginx configuration and BFF both assume the existing host-network deployment: nginx, Web BFF and Control API
share the host loopback namespace, with BFF on `127.0.0.1:3211` and Control on `127.0.0.1:3210`. Do not run them as separate
default bridge-network containers without changing this topology; publishing a loopback-only Control port externally would
weaken the boundary.

Start the BFF with the values documented in `apps/web-bff/.env.example`. Real secret values must be injected by the deployment
secret manager and must never be baked into either image or written into frontend variables. A release gate should verify:

```bash
pnpm --filter @crewon/web-bff test
pnpm --filter @crewon/web-bff typecheck
pnpm --filter @crewon/web-bff production:gate
docker build -t crewon-web-bff:verify -f deploy/crewon/web-bff.Dockerfile .
```

`production:gate` becomes green only when PostgreSQL production startup selects an explicit production composition with
request-scoped `ControlApiIdentityPort`, dynamic `AuthorizationPort`, tenant-scoped route resolution and tenant-neutral
readiness. The source gate also requires a trusted token verifier with expected issuer/audience, a policy authority, and
independent validation of `CREWON_CONTROL_BFF_TOKEN` from `X-CrewON-BFF-Authorization`; the standalone fixed-actor composition
remains isolated for local mode. Passing that source gate is necessary but still not staging/live token-validation evidence.

After deploying, verify an actual authenticated browser session, a mutation with CSRF, an SSE reconnect, session revocation,
and Control authorization for at least two distinct tenant/space principals. Those live checks are outside repository contract
tests.
