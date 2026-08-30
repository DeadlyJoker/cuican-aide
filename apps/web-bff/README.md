# CrewON Web BFF

This loopback process is the dynamic half of the production Web entry. It validates the browser's HttpOnly Identity Center
session through a server-to-server adapter, returns only a same-origin CSRF bootstrap, and proxies the bounded Control API
surface without exposing a bearer to browser code.

Every Control request carries two independent server-injected credentials: the short-lived user-scoped token in
`Authorization` and the BFF service credential in `X-CrewON-BFF-Authorization`. The latter comes only from
`CREWON_CONTROL_BFF_TOKEN`; a browser-supplied header with that name is discarded and replaced. It is never returned by the
bootstrap endpoint, copied from a Control response, or logged. Both credentials are required so Control can authenticate the
trusted BFF hop independently from the end-user identity.

The browser boundary is implemented here, but multi-user production identity is not complete in the current repository. The
Control API composition still resolves a fixed `ActorContext` through `StandaloneIdentity` and authorizes against the same fixed
actor. The required integration point is a production implementation of `ControlApiIdentityPort.resolveActor()` plus an
`AuthorizationPort` backed by server-side tenant/space policy. It must validate the short-lived Control token minted by Identity
Center; a BFF-supplied token is not itself proof that Control performed that validation.

Run the focused checks with:

```bash
pnpm --filter @crewon/web-bff test
pnpm --filter @crewon/web-bff typecheck
pnpm --filter @crewon/web-bff production:gate
```

The final command intentionally fails while PostgreSQL production startup still calls the standalone fixed-actor composition.
It passes only after `apps/control-api/src/production-composition.ts` explicitly wires non-standalone identity and authorization
ports with issuer, audience and JWKS configuration. Do not suppress or bypass that gate. See `deploy/crewon/README.md` for the
external Identity Center and deployment requirements.
