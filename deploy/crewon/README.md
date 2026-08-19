# CrewON production Web boundary

The production Web entry is the static nginx image plus the dedicated `@crewon/web-bff` process. Vite's development proxy is
not part of this deployment and is not production evidence.

nginx serves the SPA and routes the following same-origin paths to the BFF on loopback port `3211`:

- `GET /control-api/session` resolves the existing HttpOnly identity session and returns exactly `{baseUrl, csrfToken}`.
- `/api/v1` and `/api/v1/*` proxy Control API traffic. nginx and the BFF both discard a browser-supplied `Authorization` header.
- `GET /control-api/health/live` proves only that the BFF process is alive. `GET /control-api/health/ready` additionally requires
  the Control Store readiness probe. `/crewon-health` still proves only that static nginx is alive. None of these endpoints claims
  Identity Center or Provider availability.

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

Build all four production images from the repository root:

```bash
docker build -t crewon-web:local -f deploy/crewon/web.Dockerfile .
docker build -t crewon-web-bff:local -f deploy/crewon/web-bff.Dockerfile .
docker build -t crewon-control-api:local -f deploy/crewon/control-api.Dockerfile .
docker build -t crewon-runtime-worker:local -f deploy/crewon/runtime-worker.Dockerfile .
```

The Control and Runtime images contain self-contained Node 24 bundles and run as the image's `node` user. The Runtime image
also contains `/app/init/release-main.mjs`; production startup must run this finite release authority successfully before the
long-lived Worker. Neither image contains a Rust Runtime, Device/Gateway/App Server, deterministic fake transport, or port
6176 compatibility path.

The checked-in nginx configuration and BFF both assume the existing host-network deployment: nginx, Web BFF and Control API
share the host loopback namespace, with BFF on `127.0.0.1:3211` and Control on `127.0.0.1:3210`. Do not run them as separate
default bridge-network containers without changing this topology; publishing a loopback-only Control port externally would
weaken the boundary.

`compose.production.yml` is the checked-in single-host topology. It uses host networking because Control, BFF, Provider Probe
and Workspace private listeners deliberately bind only loopback; it never publishes one of those ports onto a bridge network.
The fixed port allocation is Control `3210`, Web BFF `3211`, Provider Probe `3221`, Workspace private `3222`, and public TLS
nginx `6175`.

Copy the three process-specific examples outside source control and inject their real values from the deployment secret
manager:

```bash
cp deploy/crewon/control.production.env.example deploy/crewon/control.production.env
cp deploy/crewon/runtime.production.env.example deploy/crewon/runtime.production.env
cp deploy/crewon/web-bff.production.env.example deploy/crewon/web-bff.production.env
cp deploy/crewon/compose.host.env.example deploy/crewon/compose.host.env
```

Do not merge these files. Control receives database/identity/policy and private route credentials; Runtime receives database,
Provider, Workspace and model credentials; BFF receives only browser-session credentials. `compose.host.env` contains paths and
immutable image identities, not secret contents. The artifact encryption key, reviewed AgentVersion bindings, Workspace root
and TLS material are mounted read-only. The shared artifact volume is required because Control and Worker use the same local
artifact authority in this single-host deployment. Both images initialize that named volume from a directory owned by the
non-root Node user (UID/GID `1000`). Bind-mounted artifact keys, TLS material and Workspace roots must be readable by that UID;
do not grant container root or broaden host permissions to work around an unreadable mount.

Validate interpolation before touching processes, then start the release/Worker/Control/BFF/Web dependency chain:

```bash
docker compose --env-file deploy/crewon/compose.host.env \
  -f deploy/crewon/compose.production.yml config --quiet
docker compose --env-file deploy/crewon/compose.host.env \
  -f deploy/crewon/compose.production.yml up -d --build
```

The release job has `restart: "no"`; Worker starts only after it exits successfully. The Worker publishes its readiness marker
only after composition, Provider prewarm and private listeners succeed. Control starts after that marker, BFF only after Control
Store readiness, and nginx only after BFF confirms Control readiness. A production secret manager or orchestrator may project the same contract,
but must preserve the process-specific secret scopes, loopback topology and release completion fence.

Rollback is an explicit one-shot TypeScript authority in the same immutable Runtime image. Supply an existing release ID and a
fresh idempotency key; the `rollback` profile is never part of a normal `up`:

```bash
docker compose --env-file deploy/crewon/compose.host.env \
  -f deploy/crewon/compose.production.yml \
  --profile rollback run --rm \
  -e CREWON_RELEASE_ROLLBACK_TARGET_ID=<sha256-release-id> \
  -e CREWON_RELEASE_IDEMPOTENCY_KEY=<operator-idempotency-key> \
  runtime-rollback
```

After rollback, restart the long-lived Worker and verify Control readiness before admitting new work.

The repository gates verify:

```bash
pnpm --filter @crewon/web-bff test
pnpm --filter @crewon/web-bff typecheck
pnpm --filter @crewon/web-bff production:gate
node --test deploy/crewon/control-runtime-images.test.mjs
node deploy/crewon/check-production-topology.mjs
docker build -t crewon-web:verify -f deploy/crewon/web.Dockerfile .
docker build -t crewon-web-bff:verify -f deploy/crewon/web-bff.Dockerfile .
docker build -t crewon-control-api:verify -f deploy/crewon/control-api.Dockerfile .
docker build -t crewon-runtime-worker:verify -f deploy/crewon/runtime-worker.Dockerfile .
```

Server release tags use `server-v<semver>`. The release workflow accepts only an immutable tag whose commit is an ancestor of
the current protected `main` branch and whose required checks passed. It builds the four Linux images with BuildKit SBOM and
max-mode provenance attestations, signs every digest with GitHub OIDC/Sigstore, and publishes a signed
`crewon.server-release.v0` manifest only after all four signatures verify. Production Compose inputs must use the manifest's
`image@sha256:...` references; mutable registry tags are discovery aliases, never deployment authority. Configure
`SERVER_RELEASE_TRUST_TOKEN` with the same branch-protection and Checks read access documented for desktop release trust when
the default token cannot inspect repository rules.

`production:gate` becomes green only when PostgreSQL production startup selects an explicit production composition with
request-scoped `ControlApiIdentityPort`, dynamic `AuthorizationPort`, tenant-scoped route resolution and tenant-neutral
readiness. The source gate also requires a trusted token verifier with expected issuer/audience, a policy authority, and
independent validation of `CREWON_CONTROL_BFF_TOKEN` from `X-CrewON-BFF-Authorization`; the standalone fixed-actor composition
remains isolated for local mode. Passing that source gate is necessary but still not staging/live token-validation evidence.

After deploying, verify an actual authenticated browser session, a mutation with CSRF, an SSE reconnect, session revocation,
and Control authorization for at least two distinct tenant/space principals. Those live checks are outside repository contract
tests.
