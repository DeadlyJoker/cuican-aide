# CrewON MCP Runtime

Open, out-of-process MCP adapter for the CrewON Tool Port. The Agent Kernel and domain do not import an MCP SDK. This package is
the only adapter boundary that imports the official MIT-licensed Model Context Protocol TypeScript SDK, pinned to version 1.26.0
with a complete production transitive-license gate.

The generic adapter intentionally exposes only tools with an explicit trusted policy and only supports readOnly plus replaySafe.
MCP has no standard durable mutation receipt/reconcile operation, so enabling a generic MCP mutation would make crash recovery
unsafe. A future mutation adapter must supply a server-specific durable receipt implementation before it can satisfy the Tool
Runtime Port.

Local servers run as child processes over stdio. The command and optional working directory must be absolute, the environment is
an explicit map rather than ambient process inheritance, and stderr is drained without entering logs or model context. Tool
catalog pagination, names, descriptions, JSON Schemas, inputs and results have hard caps. Binary, audio, image and resource links
are not copied into model text; they require the future Artifact import boundary.
