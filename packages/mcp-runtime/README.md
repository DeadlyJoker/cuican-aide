# CrewON MCP Runtime

Open, out-of-process MCP adapter for the CrewON Tool Port. The Agent Kernel and domain do not import an MCP SDK. This package is
the only adapter boundary that imports the official MIT-licensed Model Context Protocol TypeScript SDK, pinned to version 1.26.0
with a complete production transitive-license gate.

The generic adapter intentionally exposes only tools with an explicit trusted policy and only supports readOnly plus replaySafe.
MCP SDK 1.26.0 has no standard durable mutation receipt/reconcile operation, so enabling a generic MCP mutation would make crash
recovery unsafe. `CrewonRemoteMcpMutationProvider` is an explicit CrewON server-specific protocol adapter; its versioned wire is
not a general MCP extension. It binds each execute/reconcile/cancel request and response to the phase, Worker-owned execution ID,
original MCP tool name, and complete validated `ToolExecutionCommand`. A stable request-derived idempotency key and bounded durable
receipt/result response let a replacement Worker reconcile a possibly-sent execute without replaying it. `StdioMcpClient` remains
read-only/replay-safe and has no server opt-in mutation path or in-process receipt store.

`ConfiguredRemoteMcpClient` is the matching non-standard, server-specific client boundary for a configuration-authoritative static
tool catalog. It never performs discovery or reads environment, files, credentials, or the network: the caller injects immutable
`McpToolDescriptor` values and an `McpMutationProviderPort`, while `McpToolRuntime` remains responsible for reviewed per-server
policies and exposed names. The client deliberately rejects generic/read-only `callTool`; remote configured tools can execute only
through the injected durable mutation port. Refreshing a runtime re-reads the same isolated catalog. This does not change the
generic `StdioMcpClient`, which continues to discover and invoke replay-safe read-only tools over stdio.

Production mode requires HTTPS, an injected `CrewonRemoteMcpMutationHttpPort`, and a credential lease port. The lease resolver is
called independently for every execute, reconcile, and cancel after request preflight and inside the same total deadline, so an
immutable credential binding can rotate its bearer between attempts. A lease applies its bounded visible-ASCII bearer through a
narrow one-use sink and is released best-effort after the HTTP promise settles; credential values and lifecycle errors are never
retained in provider errors. Static bearer configuration is accepted only by explicit `standaloneLoopback` mode.

That port is a security boundary: production composition must validate every DNS answer, reject forbidden address ranges, pin the
validated address to the socket while preserving TLS SNI/hostname verification, reject redirects, and enforce bounded response
streaming. Its `post` implementation must synchronously capture request data and honor the request signal; the provider revokes
the dynamic authorization header when the returned promise settles. Runtime Worker provides the pinned production HTTP adapter,
but production composition does not yet inject that adapter or a credential resolver into the remote runtime, so remote mutation
remains gated off in production. The built-in fetch transport exists only under explicit `standaloneLoopback` mode and accepts
only raw IPv4 `127.0.0.0/8` HTTP endpoints for real loopback tests and standalone development.

Local servers run as child processes over stdio. The command and optional working directory must be absolute, the environment is
an explicit map rather than ambient process inheritance, and stderr is drained without entering logs or model context. Tool
catalog pagination, names, descriptions, JSON Schemas, inputs and results have hard caps. Binary, audio, image and resource links
are not copied into model text; they require the future Artifact import boundary.
