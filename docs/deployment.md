# CrewON deployment

CrewON has two supported deployment shapes.

## Standalone desktop

Electron supervises the staged Node.js runtime bundles on loopback. Local durable state uses SQLite and desktop-owned provider settings. Build and release procedures are documented in [desktop-release.md](desktop-release.md).

## Web and team services

The browser-facing deployment consists of the static UI, Web BFF, Control API, Runtime Worker, Device Gateway when device capabilities are enabled, and the configured durable stores. Browser identity terminates at the Web BFF; service credentials between the BFF, Control API, Worker, and Gateway remain independent.

The checked-in web container and reverse-proxy assets live in `deploy/crewon/`. Use its README and `check-web-production-gates.mjs` as the executable deployment reference. Do not copy example credentials into production configuration.

Production deployments must provide:

- TLS at every external and service trust boundary
- a supported PostgreSQL configuration for multi-process authority
- explicit tenant, identity, origin, provider-egress, and device policies
- independently rotated browser, service, provider, and device credentials
- durable backup, restore, retention, observability, and incident procedures
- health checks and rollout gates for the BFF, Control API, Worker, and optional Gateway

Environment variables are documented by the owning application README and validated by its startup path. Unknown, conflicting, or incomplete security-sensitive configuration must fail closed.
