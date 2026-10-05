// This file is generated from openapi/control-api.v1.json. Do not edit.
export interface paths {
  "/api/v1/capabilities/execution-intent-v1": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** @description Read-only hint that execution-intent v1 semantics are available on this server instance. Mutation safety is enforced by the dedicated versioned Goal and Turn paths; clients must not treat this response as proof that every node in a mixed fleet is upgraded. */
    get: operations["getExecutionIntentCapabilityV1"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/model-provider-settings": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["getModelProviderSettings"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/model-provider-settings/probe": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["probeModelProvider"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/automations": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["listAutomations"];
    put?: never;
    post: operations["createAutomation"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/automations/{automationId}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["getAutomation"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/automations/{automationId}:run-now": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["runAutomationNow"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/threads": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["listThreads"];
    put?: never;
    post: operations["createThread"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/threads/{threadId}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["getThread"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/threads/{threadId}/task-changes": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** @description Returns a bounded exact mutation ledger for terminal Turn Runs referenced by the Thread's effective post-rollback Model History. The response is bound to both the Thread revision and Model History sequence; incomplete or oversized ledgers return canonical zero values with complete=false. */
    get: operations["getThreadTaskChanges"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/threads/{threadId}:archive": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["archiveThread"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/threads/{threadId}:rollback": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["rollbackThread"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/threads/{threadId}:unarchive": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["unarchiveThread"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/threads/{threadId}:rename": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["renameThread"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/threads/{threadId}:delete": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["deleteThread"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/threads/{threadId}/events": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["streamThreadEvents"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/threads/{threadId}/goal": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["getThreadGoal"];
    put: operations["setThreadGoal"];
    post?: never;
    delete: operations["clearThreadGoal"];
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/threads/{threadId}/goal/execution-intent-v1": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    /** @description Capability-gated Goal mutation used by multi-step execution-intent workflows. Older servers do not expose this path and therefore fail before applying legacy Goal semantics. The admission version participates in the idempotency fingerprint. */
    put: operations["setThreadGoalWithExecutionIntentV1"];
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/threads/{threadId}/goal/events": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["streamThreadGoalEvents"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/threads/{threadId}/messages": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["listThreadMessages"];
    put?: never;
    post: operations["appendThreadMessage"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/threads/{threadId}/forks": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["forkThread"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/threads/{threadId}/turns": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["startTurn"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/threads/{threadId}/turns/execution-intent-v1": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** @description Capability-gated Turn admission for Goal, Plan, and ResumeGoal. Older servers do not expose this path and therefore fail before committing a Turn. Successful responses always include acceptedExecutionIntent. */
    post: operations["startTurnWithExecutionIntentV1"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/threads/{threadId}:compact": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["compactThread"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/threads/{threadId}/runs": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["listThreadRuns"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/offices": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["listOffices"];
    put?: never;
    post: operations["createOffice"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/offices/{officeVersionId}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["getOffice"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/offices/{officeVersionId}:authorize-run": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["authorizeOfficeRun"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/runs": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["createRun"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/workflow-runs": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["startWorkflowRun"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/runs/{runId}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["getRun"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/runs/{runId}/plan": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["getRunPlan"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/runs/{runId}:cancel": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["cancelRun"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/runs/{runId}/events": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["streamRunEvents"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/tool-approvals/{approvalId}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["getToolApproval"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/tool-approvals/{approvalId}:decide": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["decideToolApproval"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/threads/{threadId}/workspace-list": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** @description List redacted Workspace operations in raw UTF-8 byte lexicographic executionId order. nextAfterExecutionId is the last returned executionId only when another page exists. */
    get: operations["listWorkspaceListOperations"];
    put?: never;
    /** @description Create one durable, manual Workspace list operation against the server-selected active/default execution route. The request never accepts an agent version or device route. */
    post: operations["createWorkspaceListOperation"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/threads/{threadId}/workspace-list/{executionId}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** @description Read the redacted operation and its eventSequence from one durable Store snapshot. */
    get: operations["getWorkspaceListOperation"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/threads/{threadId}/workspace-list/{executionId}:reconcile": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["reconcileWorkspaceListOperation"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/threads/{threadId}/workspace-list/{executionId}:cancel": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["cancelWorkspaceListOperation"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/threads/{threadId}/workspace-list/{executionId}/events": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** @description Durable catch-up for one Workspace execution. The connection may close after a terminal replacement, but Last-Event-ID reconnects still replay any committed successor revision. */
    get: operations["streamWorkspaceListOperationEvents"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/workflow-versions": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["listWorkflowVersions"];
    put?: never;
    post: operations["publishWorkflowVersion"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/workflow-versions/{workflowVersionId}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["getWorkflowVersion"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/agent-versions": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["listAgentVersions"];
    put?: never;
    post: operations["publishAgentVersion"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/agent-versions/active": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["getActiveAgentVersionCatalog"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/agent-versions/{agentVersionId}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["getAgentVersion"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/artifacts/{artifactId}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["getArtifact"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/artifacts/{artifactId}/content": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["downloadArtifactContent"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/health/live": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["liveHealth"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/health/ready": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["readyHealth"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/threads/{threadId}/message-window": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** @description Read a bounded standard-view message window in ascending order. Without a cursor returns the newest messages. Cursors are exclusive, thread-scoped and revision-bound; a concurrent append or rollback returns 409. A page may split a logical turn. No audit data is included. */
    get: operations["getThreadMessageWindow"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/thread-catalog": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** @description Bounded live catalog, newest first. Scans at most limit candidates and returns literal Unicode lowercase display-title matches. Empty data with a cursor is not end-of-search. Cursors bind status, search and excludeForks. Concurrent changes can move rows; refresh starts at the current head. Existing /threads semantics are unchanged. */
    get: operations["getThreadCatalog"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/threads/{threadId}/active-run": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Read the current non-terminal Run independently of history pagination */
    get: operations["getThreadActiveRun"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/threads/{threadId}/transcript-window": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** @description Read one revision-bound message window and its exact Run bindings from immutable admission receipts and completion events. Requires thread:read and run:read for each referenced Run. Missing legacy evidence is explicitly unassociated; timestamps are never used to infer a Run. A page may begin or end within a logical turn. */
    get: operations["getThreadTranscriptWindow"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/offices/{officeVersionId}/thread": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["getOfficeThread"];
    put?: never;
    post: operations["createOfficeThread"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/offices/{officeVersionId}/thread-binding": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** @description Explicitly adopt an existing same-space thread with revision CAS. An association is immutable; the same association is idempotent without a command receipt. */
    post: operations["bindOfficeThread"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/extensions/{pluginId}/configuration": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["getExtensionConfiguration"];
    put: operations["saveExtensionConfiguration"];
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/extensions/{pluginId}/activation": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["getExtensionActivation"];
    put: operations["setExtensionActivation"];
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/extensions/{pluginId}/tasks": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** @description Opt-in plugin task admission. Atomically appends the user message and commits the Run and immutable plugin binding. Query intent requires current read permission on the original Run and uses its exact configuration. Observe execution through existing Run/event endpoints. */
    post: operations["createExtensionTask"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/extensions": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** @description Opt-in reviewed plugin metadata only. No instructions, tool definitions, digests, executable code, credentials or execution authority. No query parameters or body. Response <=2MiB. */
    get: operations["listExtensions"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/extensions/{pluginId}/runtime": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** @description Read readiness for one explicit deployed AgentVersion and saved configuration revision. Does not publish, activate, select a model, or change the default Agent. Response <=128KiB. No request body. */
    get: operations["getExtensionRuntime"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/extensions/{pluginId}/tasks/{runId}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** @description Read the authenticated durable plugin Run projection and bounded external operation result references. No query parameters or body. Response <=128KiB. */
    get: operations["getExtensionTask"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/plugins/packages": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["listPluginPackages"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/plugins/packages/{packageDigest}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["getPluginPackage"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/plugins/selections": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["listPluginSelections"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/plugins/selections/{pluginId}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["getPluginSelection"];
    put: operations["selectPluginPackage"];
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/plugins/installations": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["installPluginPackage"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/plugins/ui/catalog": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["listPluginUiCatalog"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/plugins/ui/mounts": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["openPluginUiMount"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/plugins/ui/mounts/{mountRef}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["validatePluginUiMount"];
    put?: never;
    post?: never;
    /** @description No query. An absent body, null or a strict empty JSON object is accepted for existing JSON transports. Cleans only this actor's reference; returns 200 {closed:true}. */
    delete: operations["closePluginUiMount"];
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/plugins/ui/mounts/{mountRef}/actions": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["invokePluginUiAction"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/plugins/ui/mounts/{mountRef}/assets/{assetPath}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["getPluginUiAsset"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/plugins/sources": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["listPluginSources"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/creative-projects": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** @description Explicitly enabled project service using the current authenticated actor and a separately configured project authorization policy. No Run submission, supplier calls, selection or billing. */
    get: operations["listCreativeProjects"];
    put?: never;
    /** @description Metadata/input mutation only. Requires current authorization, exact body fields, CAS revisions where applicable and an actor-scoped Idempotency-Key. Same input/key replays the original result; the same key with changed input conflicts. No generation or charge is performed. */
    post: operations["createCreativeProject"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/creative-projects/{projectId}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** @description Explicitly enabled project service using the current authenticated actor and a separately configured project authorization policy. No Run submission, supplier calls, selection or billing. */
    get: operations["getCreativeProject"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/creative-projects/{projectId}/title": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    /** @description Metadata/input mutation only. Requires current authorization, exact body fields, CAS revisions where applicable and an actor-scoped Idempotency-Key. Same input/key replays the original result; the same key with changed input conflicts. No generation or charge is performed. */
    put: operations["renameCreativeProject"];
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/creative-projects/{projectId}/state": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    /** @description Metadata/input mutation only. Requires current authorization, exact body fields, CAS revisions where applicable and an actor-scoped Idempotency-Key. Same input/key replays the original result; the same key with changed input conflicts. No generation or charge is performed. */
    put: operations["setCreativeProjectState"];
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/creative-projects/{projectId}/briefs": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** @description Explicitly enabled project service using the current authenticated actor and a separately configured project authorization policy. No Run submission, supplier calls, selection or billing. */
    get: operations["listProjectBriefs"];
    put?: never;
    /** @description Metadata/input mutation only. Requires current authorization, exact body fields, CAS revisions where applicable and an actor-scoped Idempotency-Key. Same input/key replays the original result; the same key with changed input conflicts. No generation or charge is performed. */
    post: operations["appendProjectBrief"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/creative-projects/{projectId}/briefs/{briefRevision}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** @description Explicitly enabled project service using the current authenticated actor and a separately configured project authorization policy. No Run submission, supplier calls, selection or billing. */
    get: operations["getProjectBrief"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/creative-projects/{projectId}/concepts": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** @description Explicitly enabled project service using the current authenticated actor and a separately configured project authorization policy. No Run submission, supplier calls, selection or billing. */
    get: operations["listConceptAssets"];
    put?: never;
    /** @description Metadata/input mutation only. Requires current authorization, exact body fields, CAS revisions where applicable and an actor-scoped Idempotency-Key. Same input/key replays the original result; the same key with changed input conflicts. No generation or charge is performed. */
    post: operations["createConceptAsset"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/creative-projects/{projectId}/concepts/{assetId}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** @description Explicitly enabled project service using the current authenticated actor and a separately configured project authorization policy. No Run submission, supplier calls, selection or billing. */
    get: operations["getConceptAsset"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/creative-projects/{projectId}/concepts/{assetId}/revisions": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** @description Explicitly enabled project service using the current authenticated actor and a separately configured project authorization policy. No Run submission, supplier calls, selection or billing. */
    get: operations["listConceptRevisions"];
    put?: never;
    /** @description Metadata/input mutation only. Requires current authorization, exact body fields, CAS revisions where applicable and an actor-scoped Idempotency-Key. Same input/key replays the original result; the same key with changed input conflicts. No generation or charge is performed. */
    post: operations["appendConceptAssetRevision"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/creative-projects/{projectId}/concepts/{assetId}/revisions/{assetRevision}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** @description Explicitly enabled project service using the current authenticated actor and a separately configured project authorization policy. No Run submission, supplier calls, selection or billing. */
    get: operations["getConceptRevision"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/creative-projects/{projectId}/concepts/{assetId}/revisions/{assetRevision}/generation": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** @description Explicit read-only project-generation capability. Uses the current authenticated owner and saved project/input association to derive the original execution plugin and Run, then applies the original task read authorization. Empty query only. No supplier calls, polling, new Run, fees or result selection. */
    get: operations["getConceptGeneration"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/creative-projects/{projectId}/concepts/{assetId}/selection": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** @description Independent opt-in selection read. Current owner/project and original execution read authorization. Empty query only. Reads durable pointer and original verified result without provider IO, Run creation or credits. */
    get: operations["getConceptSelection"];
    /** @description Independent opt-in selection write. Same transaction rechecks paid generation provenance, exact succeeded operation revision, raw result index, current active project/asset metadata CAS and selection CAS. No supplier calls, new Run, credits or metadata revision changes. Same key replays the original committed receipt without replacing a newer pointer. */
    put: operations["selectConceptImage"];
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/plugins/ui/mounts/{mountRef}/renew": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** @description Explicit renewal of a still-live mount after old-expiry CAS and full current authorization/publication checks. No query. Keeps the same reference and all publication pins; validate GET never renews. Expired or closed references cannot revive. */
    post: operations["renewPluginUiMount"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/creative-projects/{projectId}/text-artifacts": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** @description Explicit project text opt-in, current authenticated actor and creative project authorization. Candidate/selection/lock only affect text artifact CAS; old project shape and revision remain unchanged. No model, Run, supplier, generation or billing. Exact body/query fields; total response <=60 KiB, history trims only complete suffix records with last returned cursor. */
    get: operations["listProjectTextArtifacts"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/creative-projects/{projectId}/text-artifacts/outline": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** @description Explicit project text opt-in, current authenticated actor and creative project authorization. Candidate/selection/lock only affect text artifact CAS; old project shape and revision remain unchanged. No model, Run, supplier, generation or billing. Exact body/query fields; total response <=60 KiB, history trims only complete suffix records with last returned cursor. */
    get: operations["getProjectOutline"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/creative-projects/{projectId}/text-artifacts/outline/candidates": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** @description Explicit project text opt-in, current authenticated actor and creative project authorization. Candidate/selection/lock only affect text artifact CAS; old project shape and revision remain unchanged. No model, Run, supplier, generation or billing. Exact body/query fields; total response <=60 KiB, history trims only complete suffix records with last returned cursor. */
    post: operations["saveProjectOutlineCandidate"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/creative-projects/{projectId}/text-artifacts/scripts/{episodeId}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** @description Explicit project text opt-in, current authenticated actor and creative project authorization. Candidate/selection/lock only affect text artifact CAS; old project shape and revision remain unchanged. No model, Run, supplier, generation or billing. Exact body/query fields; total response <=60 KiB, history trims only complete suffix records with last returned cursor. */
    get: operations["getProjectScript"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/creative-projects/{projectId}/text-artifacts/scripts/{episodeId}/candidates": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** @description Explicit project text opt-in, current authenticated actor and creative project authorization. Candidate/selection/lock only affect text artifact CAS; old project shape and revision remain unchanged. No model, Run, supplier, generation or billing. Exact body/query fields; total response <=60 KiB, history trims only complete suffix records with last returned cursor. */
    post: operations["saveProjectScriptCandidate"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/creative-projects/{projectId}/text-artifacts/items/{artifactId}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** @description Explicit project text opt-in, current authenticated actor and creative project authorization. Candidate/selection/lock only affect text artifact CAS; old project shape and revision remain unchanged. No model, Run, supplier, generation or billing. Exact body/query fields; total response <=60 KiB, history trims only complete suffix records with last returned cursor. */
    get: operations["getProjectTextArtifact"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/creative-projects/{projectId}/text-artifacts/items/{artifactId}/revisions": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** @description Explicit project text opt-in, current authenticated actor and creative project authorization. Candidate/selection/lock only affect text artifact CAS; old project shape and revision remain unchanged. No model, Run, supplier, generation or billing. Exact body/query fields; total response <=60 KiB, history trims only complete suffix records with last returned cursor. */
    get: operations["listProjectTextRevisions"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/creative-projects/{projectId}/text-artifacts/items/{artifactId}/revisions/{contentRevision}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** @description Explicit project text opt-in, current authenticated actor and creative project authorization. Candidate/selection/lock only affect text artifact CAS; old project shape and revision remain unchanged. No model, Run, supplier, generation or billing. Exact body/query fields; total response <=60 KiB, history trims only complete suffix records with last returned cursor. */
    get: operations["getProjectTextRevision"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/creative-projects/{projectId}/text-artifacts/items/{artifactId}/selection": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    /** @description Explicit project text opt-in, current authenticated actor and creative project authorization. Candidate/selection/lock only affect text artifact CAS; old project shape and revision remain unchanged. No model, Run, supplier, generation or billing. Exact body/query fields; total response <=60 KiB, history trims only complete suffix records with last returned cursor. */
    put: operations["selectProjectTextRevision"];
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/creative-projects/{projectId}/text-artifacts/items/{artifactId}/lock": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    /** @description Explicit project text opt-in, current authenticated actor and creative project authorization. Candidate/selection/lock only affect text artifact CAS; old project shape and revision remain unchanged. No model, Run, supplier, generation or billing. Exact body/query fields; total response <=60 KiB, history trims only complete suffix records with last returned cursor. */
    put: operations["setProjectTextArtifactLocked"];
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
}
export type webhooks = Record<string, never>;
export interface components {
  schemas: {
    OfficeMember: {
      memberId: string;
      displayName: string;
      agentVersionId: string;
      /** @description Optional immutable responsibility used to coordinate this Office member without an extra planning round. */
      responsibility?: string;
    };
    OfficeExecutionTarget: {
      targetId: string;
      agentVersionId: string;
    };
    Office: {
      /** @constant */
      schemaVersion: "crewon.office-definition.v0";
      tenantId: string;
      spaceId: string;
      officeId: string;
      officeVersionId: string;
      revision: number;
      title: string;
      members: components["schemas"]["OfficeMember"][];
      executionTargets: components["schemas"]["OfficeExecutionTarget"][];
      createdByActorId: string;
      /** Format: date-time */
      createdAt: string;
    };
    CreateOfficeRequest: {
      officeId?: string;
      expectedRevision: number;
      title: string;
      members: components["schemas"]["OfficeMember"][];
      executionTargets: components["schemas"]["OfficeExecutionTarget"][];
    };
    OfficeMutationResponse: {
      /** @enum {string} */
      disposition: "created" | "replayed";
      office: components["schemas"]["Office"];
    };
    GetOfficeResponse: {
      office: components["schemas"]["Office"];
    };
    StartOfficeRunRequest: {
      targetId: string;
      threadId: string;
    };
    AuthorizeOfficeRunResponse: {
      target: components["schemas"]["OfficeExecutionTarget"];
    };
    ListOfficesResponse: {
      data: components["schemas"]["Office"][];
      nextCursor: string | null;
    };
    HealthResponse: {
      /** @constant */
      status: "ok";
    };
    /** @enum {string} */
    ModelProviderCredentialKind: "environment" | "keychain" | "none";
    /** @enum {string} */
    ModelProviderRuntimeAvailability:
      | "available"
      | "unconfigured"
      | "switchPending"
      | "unavailable";
    ModelProviderSettingsSnapshot: {
      revision: number;
      activeProviderId: string | null;
      providers: components["schemas"]["ModelProviderSettingView"][];
      runtimeAvailability: components["schemas"]["ModelProviderRuntimeAvailability"];
      /** Format: date-time */
      updatedAt: string | null;
    };
    GetModelProviderSettingsResponse: {
      settings: components["schemas"]["ModelProviderSettingsSnapshot"];
    };
    ProbeModelProviderRequest: Record<string, never>;
    /** @enum {string} */
    ModelProviderProbeStatus:
      | "ok"
      | "credentialMissing"
      | "authenticationFailed"
      | "rateLimited"
      | "providerError"
      | "unreachable"
      | "invalidResponse"
      | "bindingMismatch";
    ModelProviderProbeModelView: {
      id: string;
      displayName: string | null;
    };
    ProbeModelProviderResponse: {
      /** @enum {string} */
      disposition: "completed" | "replayed";
      providerId: string;
      catalogRevision: number;
      status: components["schemas"]["ModelProviderProbeStatus"];
      models: components["schemas"]["ModelProviderProbeModelView"][] | null;
      modelCount: number | null;
      latencyMs: number;
      retryable: boolean;
      retryAfterMs: number | null;
    };
    AutomationSchedule: {
      /** @enum {string} */
      scheduleType: "daily" | "weekly" | "interval" | "once";
      /** Format: date-time */
      nextRunAt: string;
      intervalSeconds: number;
      time: string;
      weekday: number;
      timezone: string;
    };
    CreateAutomationRequest: {
      threadId: string;
      expectedThreadRevision: number;
      title: string;
      prompt: string;
      agentVersionId: string | null;
      schedule: components["schemas"]["AutomationSchedule"] | null;
    };
    RunAutomationNowRequest: {
      /** @constant */
      expectedAutomationRevision: 1;
      expectedThreadRevision: number;
    };
    /** @description Redacted immutable Automation definition. Tenant, actor, digests and invocation routes are private. */
    AutomationView: {
      automationId: string;
      threadId: string;
      title: string;
      prompt: string;
      agentVersionId: string;
      /** @enum {string} */
      executionMode: "manualOnly" | "scheduled";
      automaticScheduling: boolean;
      schedule: components["schemas"]["AutomationSchedule"];
      /** @constant */
      revision: 1;
      /** Format: date-time */
      createdAt: string;
      /** Format: date-time */
      updatedAt: string;
    };
    AutomationMutationResponse: {
      /** @enum {string} */
      disposition: "committed" | "replayed";
      automation: components["schemas"]["AutomationView"];
    };
    GetAutomationResponse: {
      automation: components["schemas"]["AutomationView"];
    };
    ListAutomationsResponse: {
      data: components["schemas"]["AutomationView"][];
      nextCursor: string | null;
    };
    /** @description Safe public association between one Automation definition and its admitted Run. Private invocation IDs, digests and route bindings are omitted. */
    AutomationInvocationView: {
      automationId: string;
      runId: string;
    };
    /** @description The Run is projected from the canonical Automation invocation result; private origin bindings and route digests are omitted. */
    RunAutomationNowResponse: {
      /** @enum {string} */
      disposition: "committed" | "replayed";
      automation: components["schemas"]["AutomationView"];
      invocation: components["schemas"]["AutomationInvocationView"];
      run: components["schemas"]["RunView"];
    };
    CreateThreadRequest: {
      /** @description Immutable opaque workspace identity. Omission on legacy data is normalized to null. Filesystem paths are never accepted. */
      workspaceId?: string | null;
      title: string | null;
    };
    AppendThreadMessageRequest: {
      expectedRevision: number;
      content: string;
    };
    ForkThreadRequest: {
      expectedRevision: number;
      throughHistorySequence: number | null;
    };
    RollbackThreadRequest: {
      expectedRevision: number;
      numTurns: number;
    };
    ArchiveThreadRequest: {
      expectedRevision: number;
    };
    UnarchiveThreadRequest: {
      expectedRevision: number;
    };
    RenameThreadRequest: {
      expectedRevision: number;
      title: string | null;
    };
    DeleteThreadRequest: {
      expectedRevision: number;
    };
    /** @enum {string} */
    ThreadStatus: "active" | "archived" | "deleted";
    ThreadView: {
      /** @description Immutable opaque workspace identity. Omission on legacy data is normalized to null. Filesystem paths are never accepted. */
      workspaceId?: string | null;
      threadId: string;
      title: string | null;
      /** @description Optional bounded display-only fallback for historical unnamed conversations. Not an authoritative title or a thread revision change. */
      displayTitle?: string;
      status: components["schemas"]["ThreadStatus"];
      revision: number;
      lastMessageSequence: number;
      forkedFromThreadId: string | null;
      forkedThroughHistorySequence: number | null;
      /** Format: date-time */
      createdAt: string;
      /** Format: date-time */
      updatedAt: string;
      /** Format: date-time */
      archivedAt: string | null;
      /** Format: date-time */
      deletedAt: string | null;
    };
    /** @enum {string} */
    ThreadEventType:
      | "thread.created"
      | "thread.message.appended"
      | "thread.forked"
      | "thread.archived"
      | "thread.unarchived"
      | "thread.renamed"
      | "thread.rolled_back"
      | "thread.deleted";
    /** @enum {string} */
    ThreadStandardEventType:
      | "thread.created"
      | "thread.message.appended"
      | "thread.forked"
      | "thread.archived"
      | "thread.unarchived"
      | "thread.renamed"
      | "thread.deleted";
    ThreadStandardEventView: {
      /** @constant */
      schemaVersion: "crewon.thread-event.v0";
      threadId: string;
      eventId: string;
      sequence: number;
      /** Format: date-time */
      occurredAt: string;
      type: components["schemas"]["ThreadStandardEventType"];
    };
    /** @description Redacted durable rollback delivery event. Private marker identifiers, raw history ranges, actor identity and tenancy are never exposed. */
    ThreadRolledBackEventView: {
      threadId: string;
      eventId: string;
      sequence: number;
      /** Format: date-time */
      occurredAt: string;
      /** @constant */
      type: "thread.rolled_back";
      requestedTurns: number;
      removedTurns: number;
    };
    ThreadEventView:
      | components["schemas"]["ThreadStandardEventView"]
      | components["schemas"]["ThreadRolledBackEventView"];
    /** @enum {string} */
    MessageRole: "user" | "assistant" | "system" | "tool";
    ProposedPlanView: {
      /** @constant */
      schemaVersion: "crewon.proposed-plan.v0";
      planId: string;
      threadId: string;
      runId: string;
      messageId: string;
      /** @description Complete public Plan body. The server enforces a 9999-byte UTF-8 hard limit; maxLength is the provider-neutral character upper bound. */
      content: string;
      /** Format: date-time */
      createdAt: string;
    };
    MessageView: {
      messageId: string;
      threadId: string;
      sequence: number;
      role: components["schemas"]["MessageRole"];
      content: string;
      proposedPlan: components["schemas"]["ProposedPlanView"] | null;
      /** Format: date-time */
      createdAt: string;
    };
    ThreadMutationResponse: {
      /** @enum {string} */
      disposition: "committed" | "replayed";
      thread: components["schemas"]["ThreadView"];
    };
    AppendThreadMessageResponse: {
      /** @enum {string} */
      disposition: "committed" | "replayed";
      thread: components["schemas"]["ThreadView"];
      message: components["schemas"]["MessageView"];
    };
    GetThreadResponse: {
      thread: components["schemas"]["ThreadView"];
      /** @description Durable Thread event sequence from the same Store snapshot as thread. Use as Last-Event-ID when attaching Thread SSE. */
      eventSequence: number;
    };
    /** @enum {string} */
    ThreadGoalStatus:
      | "active"
      | "paused"
      | "blocked"
      | "usageLimited"
      | "budgetLimited"
      | "complete";
    /**
     * @description Goal states that a user-facing mutation may request. Runtime and system terminal/limit states are read-only through this API.
     * @enum {string}
     */
    ThreadGoalUserStatus: "active" | "paused";
    ThreadGoalView: {
      threadId: string;
      goalId: string;
      revision: number;
      objective: string;
      status: components["schemas"]["ThreadGoalStatus"];
      tokenBudget: number | null;
      tokensUsed: number;
      /** @description Cumulative whole seconds while this Goal is attributed to a started durable Run. Queued time and idle time between Runs are excluded. */
      timeUsedSeconds: number;
      /** Format: date-time */
      createdAt: string;
      /** Format: date-time */
      updatedAt: string;
    };
    GetThreadGoalResponse: {
      goal: components["schemas"]["ThreadGoalView"] | null;
      /** @description Durable Thread Goal event sequence at the same Store read point as goal. Use it as Last-Event-ID when attaching the Goal event stream. */
      eventSequence: number;
    };
    ThreadGoalTokenBudgetUpdate:
      | {
          /** @constant */
          kind: "keep";
        }
      | {
          /** @constant */
          kind: "set";
          value: number | null;
        };
    SetThreadGoalRequest: {
      expectedRevision: number | null;
      objective: string | null;
      status: components["schemas"]["ThreadGoalUserStatus"] | null;
      tokenBudget: components["schemas"]["ThreadGoalTokenBudgetUpdate"];
    };
    ClearThreadGoalRequest: {
      expectedRevision: number;
    };
    ThreadGoalMutationResponse: {
      /** @enum {string} */
      disposition: "committed" | "replayed";
      goal: components["schemas"]["ThreadGoalView"] | null;
      canceledRun: components["schemas"]["RunView"] | null;
      retainedRun: components["schemas"]["RunView"] | null;
      continuationRun: components["schemas"]["RunView"] | null;
    };
    ThreadGoalEventBaseView: {
      /** @constant */
      schemaVersion: "crewon.thread-goal-event.v0";
      threadId: string;
      eventId: string;
      sequence: number;
      /** Format: date-time */
      occurredAt: string;
    };
    ThreadGoalUpdatedEventView: components["schemas"]["ThreadGoalEventBaseView"] & {
      /** @constant */
      type: "goal.updated";
      data: {
        goal: components["schemas"]["ThreadGoalView"];
      };
    };
    ThreadGoalClearedEventView: components["schemas"]["ThreadGoalEventBaseView"] & {
      /** @constant */
      type: "goal.cleared";
      data: {
        previousGoalId: string;
        previousRevision: number;
      };
    };
    ThreadGoalEventView:
      | components["schemas"]["ThreadGoalUpdatedEventView"]
      | components["schemas"]["ThreadGoalClearedEventView"];
    ListThreadsResponse: {
      data: components["schemas"]["ThreadView"][];
      nextCursor: string | null;
    };
    ListThreadMessagesResponse: {
      data: components["schemas"]["MessageView"][];
      nextCursor: string | null;
    };
    CreateWorkspaceListRequest: {
      expectedThreadRevision: number;
      maxEntries: number;
    };
    WorkspaceOperationActionRequest: {
      expectedOperationRevision: number;
    };
    WorkspaceListEntryView: {
      /** @description A single safe basename, additionally bounded to 255 UTF-8 bytes. Slash, backslash, control, format and line-separator characters are forbidden. Entries use strictly increasing raw UTF-8 byte order. */
      name: string;
      /** @enum {string} */
      kind: "file" | "directory";
    };
    WorkspaceCompletedResultView: {
      /** @constant */
      status: "completed";
      entries: components["schemas"]["WorkspaceListEntryView"][];
      truncated: boolean;
    };
    WorkspaceFailedResultView: {
      /** @constant */
      status: "failed";
      /** @description Stable safe failure code; provider or Device error text is never exposed. */
      code: string;
      retryable: boolean;
    };
    /** @description Redacted Workspace operation projection. It intentionally omits tenancy, actors, digests, provider receipts, Device/workspace/runtime bindings, policy, leases and local paths. */
    WorkspaceOperationView:
      | {
          threadId: string;
          executionId: string;
          revision: number;
          /** @enum {string} */
          status: "pending" | "canceled" | "unknownOutcome";
          result: null;
        }
      | {
          threadId: string;
          executionId: string;
          revision: number;
          /** @constant */
          status: "completed";
          result: components["schemas"]["WorkspaceCompletedResultView"];
        }
      | {
          threadId: string;
          executionId: string;
          revision: number;
          /** @constant */
          status: "failed";
          result: components["schemas"]["WorkspaceFailedResultView"];
        };
    WorkspaceOperationMutationResponse: {
      /** @enum {string} */
      disposition: "committed" | "replayed";
      /** @description Must equal operation.revision. */
      eventSequence: number;
      operation: components["schemas"]["WorkspaceOperationView"];
    };
    GetWorkspaceOperationResponse: {
      operation: components["schemas"]["WorkspaceOperationView"];
      /** @description Durable operation revision from the same Store snapshot as operation. Must equal operation.revision and is the initial Last-Event-ID. */
      eventSequence: number;
    };
    /** @description A response is additionally subject to a 2 MiB UTF-8 JSON hard cap, so a server may return fewer than limit items and a non-null recovery cursor. */
    ListWorkspaceOperationsResponse: {
      /** @description Strictly increasing raw UTF-8 byte lexicographic executionId order. */
      data: components["schemas"]["WorkspaceOperationView"][];
      /** @description When non-null, equals the last returned executionId and proves another page exists. */
      nextAfterExecutionId: string | null;
    };
    WorkspaceOperationEventView: {
      /** @constant */
      schemaVersion: "crewon.workspace-operation-event.v0";
      threadId: string;
      executionId: string;
      /** @description The operation revision and SSE id. */
      sequence: number;
      /** @constant */
      type: "workspace.operation.replaced";
      data: {
        operation: components["schemas"]["WorkspaceOperationView"];
      };
    };
    /**
     * @description Per-Run Tool permission and host sandbox choice. requestApproval keeps durable user gates inside the workspace sandbox. approveForMe automatically approves Tools but retains workspace-only writes and blocks network access. fullAccess automatically approves Tools and permits unrestricted host-file and network access. Omission fails closed to requestApproval.
     * @enum {string}
     */
    ToolPermissionMode: "requestApproval" | "approveForMe" | "fullAccess";
    CreateRunRequest: {
      threadId: string;
      /** @description Optional immutable AgentVersion selection. The server admits it before creating a Run; omission uses the configured default. */
      agentVersionId?: string | null;
      toolPermissionMode?: components["schemas"]["ToolPermissionMode"];
    };
    /** @description Bounded JSON input. Runtime validation additionally limits UTF-8 serialization to 32768 bytes, nesting depth to 8, and total values to 1024. */
    WorkflowInput:
      | null
      | boolean
      | number
      | string
      | unknown[]
      | {
          [key: string]: unknown;
        };
    StartWorkflowRunRequest: {
      workflowVersionId: string;
      threadId: string;
      input: components["schemas"]["WorkflowInput"];
    };
    StartTurnRequest: {
      expectedRevision: number;
      content: string;
      /** @description Requested immutable AgentVersion; null uses the active default. The resolved route is server-owned. */
      agentVersionId: string | null;
      /**
       * @description Atomic Turn intent. Goal creates or updates the persistent Thread Goal; Plan clears an active Goal, retains inactive Goal history, and pins this Run to Plan collaboration mode; ResumeGoal atomically resumes a paused Goal for one bound Run while deferring automatic continuation.
       * @enum {string}
       */
      executionIntent: "none" | "goal" | "plan" | "resumeGoal";
      toolPermissionMode?: components["schemas"]["ToolPermissionMode"];
    };
    CompactThreadRequest: {
      expectedRevision: number;
      /** @description Requested immutable AgentVersion for the compactor; null uses the active default. */
      agentVersionId: string | null;
    };
    CancelRunRequest: {
      expectedRevision: number;
    };
    /** @enum {string} */
    RunStatus:
      | "queued"
      | "running"
      | "waitingApproval"
      | "suspended"
      | "reconciling"
      | "completed"
      | "failed"
      | "canceled";
    RunView: {
      runId: string;
      threadId: string;
      status: components["schemas"]["RunStatus"];
      revision: number;
      lastSequence: number;
      cancelRequested: boolean;
      waitingApproval: null | {
        approvalId: string;
      };
      /** @enum {string} */
      collaborationMode: "default" | "plan";
      /**
       * @description Immutable normalized Run purpose. Legacy persisted Runs are projected as turn.
       * @enum {string}
       */
      purpose: "turn" | "manualCompaction" | "workflow";
      /** @description Exact immutable WorkflowVersion provenance. Required and non-null exactly when purpose is workflow. */
      workflowVersionBinding: null | {
        workflowId: string;
        workflowVersionId: string;
        contentDigest: string;
      };
      goalBinding: null | {
        goalId: string;
        revision: number;
        objectiveDigest: string;
      };
      outputRef: string | null;
      failure: null | {
        code: string;
        retryable: boolean;
      };
      /** Format: date-time */
      createdAt: string;
      /** Format: date-time */
      updatedAt: string;
      /** Format: date-time */
      terminalAt: string | null;
    };
    /** @enum {string} */
    RunPlanStatus:
      | "pending"
      | "inProgress"
      | "completed"
      | "blocked"
      | "canceled";
    RunPlanItemView: {
      itemId: string;
      title: string;
      status: components["schemas"]["RunPlanStatus"];
    };
    /** @description A complete bounded execution-plan snapshot. Item identifiers are unique and at most one item is inProgress. */
    RunPlanView: {
      /** @constant */
      schemaVersion: "crewon.run-plan.v0";
      planId: string;
      revision: number;
      explanation: string | null;
      items: components["schemas"]["RunPlanItemView"][];
      /** Format: date-time */
      createdAt: string;
      /** Format: date-time */
      updatedAt: string;
    };
    GetRunPlanResponse: {
      runId: string;
      /** @description Global durable Run sequence from the same Store snapshot as plan. It is not the Plan revision. */
      eventSequence: number;
      plan: null | components["schemas"]["RunPlanView"];
    };
    RunMutationResponse: {
      /** @enum {string} */
      disposition: "committed" | "replayed";
      run: components["schemas"]["RunView"];
    };
    StartTurnResponse: {
      /** @enum {string} */
      disposition: "committed" | "replayed";
      /**
       * @description Execution intent durably accepted for this turn. Always present on the execution-intent-v1 route and present on the legacy Turn route only when its Accept header includes the crewon-execution-intent-ack=v1 media parameter.
       * @enum {string}
       */
      acceptedExecutionIntent?: "none" | "goal" | "plan" | "resumeGoal";
      thread: components["schemas"]["ThreadView"];
      message: components["schemas"]["MessageView"];
      run: components["schemas"]["RunView"];
    };
    ExecutionIntentCapabilityResponse: {
      /** @constant */
      version: "v1";
    };
    GetRunResponse: {
      run: components["schemas"]["RunView"];
    };
    ListThreadRunsResponse: {
      data: components["schemas"]["RunView"][];
      nextCursor: string | null;
    };
    /** @enum {string} */
    ToolApprovalStatus:
      | "required"
      | "approved"
      | "rejected"
      | "expired"
      | "superseded";
    DecideToolApprovalRequest: {
      expectedRevision: number;
      /** @enum {string} */
      decision: "approved" | "rejected";
      comment: string | null;
    };
    ToolApprovalView: {
      approvalId: string;
      runId: string;
      status: components["schemas"]["ToolApprovalStatus"];
      revision: number;
      /** Format: date-time */
      requiredAt: string;
      /** Format: date-time */
      expiresAt: string | null;
      /** @enum {string|null} */
      decision: "approved" | "rejected" | null;
      comment: string | null;
      /** Format: date-time */
      decidedAt: string | null;
    };
    GetToolApprovalResponse: {
      approval: components["schemas"]["ToolApprovalView"];
    };
    ToolApprovalMutationResponse: {
      /** @enum {string} */
      disposition: "committed" | "replayed";
      approval: components["schemas"]["ToolApprovalView"];
      run: components["schemas"]["RunView"];
    };
    PublishAgentVersionRequest: {
      /** @constant */
      schemaVersion: "crewon.agent-version-source.v0";
      agentVersionId: string;
      runtimeGeneration: string;
      policySnapshotId: string;
      instructions: string | null;
      model: components["schemas"]["AgentVersionModel"];
      execution: components["schemas"]["AgentVersionExecution"];
      resources: components["schemas"]["AgentVersionResources"];
      tools: components["schemas"]["AgentVersionTool"][];
    };
    AgentVersionModel: {
      adapterName: string;
      adapterVersion: string;
      modelId: string;
      contextWindowTokens: number;
      autoCompactAtTokens: number | null;
    };
    AgentVersionExecution: {
      streamMaxRetries: number;
      maxToolRounds: number;
    };
    AgentVersionResources: {
      workspaceRequired: boolean;
      governedContextDigest: string | null;
    };
    AgentVersionTool:
      | components["schemas"]["AgentVersionFunctionTool"]
      | components["schemas"]["AgentVersionCustomTool"];
    AgentVersionFunctionTool: {
      /** @constant */
      schemaVersion: "crewon.tool-definition.v0";
      /** @constant */
      kind: "function";
      name: string;
      description: string;
      /** @enum {string} */
      execution: "serial" | "parallel";
      inputSchema: {
        [key: string]: unknown;
      };
    };
    AgentVersionCustomTool: {
      /** @constant */
      schemaVersion: "crewon.tool-definition.v0";
      /** @constant */
      kind: "custom";
      name: string;
      description: string;
      /** @enum {string} */
      execution: "serial" | "parallel";
      /** @constant */
      inputFormat: "text";
    };
    PublishWorkflowVersionRequest: {
      /** @constant */
      schemaVersion: "crewon.workflow-version-source.v0";
      workflowId: string;
      workflowVersionId: string;
      name: string;
      description: string;
      inputSchema: {
        [key: string]: unknown;
      };
      outputSchema: {
        [key: string]: unknown;
      };
      entryNodeIds: string[];
      outputNodeIds: string[];
      nodes: components["schemas"]["WorkflowNodeDefinition"][];
    };
    WorkflowNodeDefinition: {
      nodeId: string;
      /** @enum {string} */
      kind: "agent" | "humanGate" | "verification";
      title: string;
      instruction: string;
      dependsOn: string[];
      inputSchema: {
        [key: string]: unknown;
      };
      outputSchema: {
        [key: string]: unknown;
      };
      agentVersionId?: string;
      approvalPolicyId?: string;
      verifierAgentVersionId?: string;
    };
    WorkflowVersionView: {
      workflowId: string;
      workflowVersionId: string;
      contentDigest: string;
      name: string;
      description: string;
      inputSchema: {
        [key: string]: unknown;
      };
      outputSchema: {
        [key: string]: unknown;
      };
      entryNodeIds: string[];
      outputNodeIds: string[];
      nodes: components["schemas"]["WorkflowNodeDefinition"][];
      executionOrder: string[];
      /** Format: date-time */
      createdAt: string;
    };
    WorkflowVersionMutationResponse: {
      /** @enum {string} */
      disposition: "registered" | "existing";
      workflowVersion: components["schemas"]["WorkflowVersionView"];
    };
    WorkflowVersionSummaryView: {
      workflowId: string;
      workflowVersionId: string;
      contentDigest: string;
      name: string;
      description: string;
      /** Format: date-time */
      createdAt: string;
    };
    GetWorkflowVersionResponse: {
      workflowVersion: components["schemas"]["WorkflowVersionView"];
    };
    ListWorkflowVersionsResponse: {
      data: components["schemas"]["WorkflowVersionSummaryView"][];
      nextCursor: string | null;
    };
    AgentVersionView: {
      agentVersionId: string;
      contentDigest: string;
      runtimeGeneration: string;
      policySnapshotId: string;
      model: {
        adapterName: string;
        adapterVersion: string;
        modelId: string;
      };
      /** Format: date-time */
      createdAt: string;
    };
    AgentVersionMutationResponse: {
      /** @enum {string} */
      disposition: "registered" | "existing";
      agentVersion: components["schemas"]["AgentVersionView"];
    };
    GetAgentVersionResponse: {
      agentVersion: components["schemas"]["AgentVersionView"];
    };
    ListAgentVersionsResponse: {
      data: components["schemas"]["AgentVersionView"][];
      nextCursor: string | null;
    };
    ActiveAgentVersionCatalogResponse: {
      releaseId: string;
      /** Format: date-time */
      activatedAt: string;
      defaultAgentVersionId: string;
      data: components["schemas"]["AgentVersionView"][];
    };
    ArtifactView: {
      artifactId: string;
      /** @constant */
      kind: "toolOutput";
      mediaType: string;
      /** @enum {string} */
      sensitivity: "public" | "internal" | "workspaceSensitive";
      contentDigest: string;
      byteLength: number;
      source: {
        /** @constant */
        kind: "toolOutput";
        runId: string;
        stepId: string;
        callId: string;
      };
      retention: {
        /** @constant */
        kind: "run";
        /** Format: date-time */
        expiresAt: string;
      };
      encryption: {
        /** @enum {string} */
        scheme: "aes256gcm" | "externalKms";
      };
      scan: {
        /** @enum {string} */
        status: "notRequired" | "pending" | "clean" | "blocked";
        /** Format: date-time */
        scannedAt: string | null;
      };
      /** Format: date-time */
      createdAt: string;
    };
    GetArtifactResponse: {
      artifact: components["schemas"]["ArtifactView"];
    };
    /** @enum {string} */
    ErrorCategory:
      | "authentication"
      | "authorization"
      | "notFound"
      | "conflict"
      | "validation"
      | "rateLimit"
      | "providerUnavailable"
      | "deviceUnavailable"
      | "unknownOutcome"
      | "internal";
    ErrorEnvelope: {
      error: {
        category: components["schemas"]["ErrorCategory"];
        code: string;
        message: string;
        requestId: string;
      };
    };
    RunEventEnvelope: {
      eventId: string;
      runId: string;
      sequence: number;
      /** Format: date-time */
      occurredAt: string;
    };
    RunCreatedEventView: components["schemas"]["RunEventEnvelope"] & {
      /** @constant */
      type: "run.created";
      data: {
        threadId: string;
      };
    };
    RunStartedEventView: components["schemas"]["RunEventEnvelope"] &
      components["schemas"]["EmptyRunEventData"] & {
        /** @constant */
        type: "run.started";
      };
    RunApprovalRequiredEventView: components["schemas"]["RunEventEnvelope"] & {
      /** @constant */
      type: "run.approval.required";
      data: {
        approvalId: string;
      };
    };
    RunResumedEventView: components["schemas"]["RunEventEnvelope"] &
      components["schemas"]["RunReasonEventData"] & {
        /** @constant */
        type: "run.resumed";
      };
    RunSuspendedEventView: components["schemas"]["RunEventEnvelope"] &
      components["schemas"]["RunReasonEventData"] & {
        /** @constant */
        type: "run.suspended";
      };
    RunReconciliationRequiredEventView: components["schemas"]["RunEventEnvelope"] &
      components["schemas"]["EmptyRunEventData"] & {
        /** @constant */
        type: "run.reconciliation.required";
      };
    RunCancelRequestedEventView: components["schemas"]["RunEventEnvelope"] &
      components["schemas"]["EmptyRunEventData"] & {
        /** @constant */
        type: "run.cancel.requested";
      };
    RunCompletedEventView: components["schemas"]["RunEventEnvelope"] & {
      /** @constant */
      type: "run.completed";
      data: {
        outputRef: string | null;
      };
    };
    RunFailedEventView: components["schemas"]["RunEventEnvelope"] & {
      /** @constant */
      type: "run.failed";
      data: {
        code: string;
        retryable: boolean;
      };
    };
    RunCanceledEventView: components["schemas"]["RunEventEnvelope"] &
      components["schemas"]["RunReasonEventData"] & {
        /** @constant */
        type: "run.canceled";
      };
    SegmentStartedEventView: components["schemas"]["RunEventEnvelope"] & {
      /** @constant */
      type: "segment.started";
      data: {
        segmentId: string;
        attempt: number;
      };
    };
    ModelSamplingRetryEventView: components["schemas"]["RunEventEnvelope"] & {
      /** @constant */
      type: "model.sampling.retry";
      data: {
        segmentId: string;
        samplingAttempt: number;
        maxRetries: number;
        code: string;
        discardedOutput: boolean;
      };
    };
    ModelTransportFallbackEventView: components["schemas"]["RunEventEnvelope"] & {
      /** @constant */
      type: "model.transport.fallback";
      data: {
        segmentId: string;
        fromTransport: string;
        toTransport: string;
        code: string;
        discardedOutput: boolean;
      };
    };
    ModelOutputDeltaEventView: components["schemas"]["RunEventEnvelope"] & {
      /** @constant */
      type: "model.output.delta";
      data: {
        segmentId: string;
        delta: string;
      };
    };
    ToolRequestedEventView: components["schemas"]["RunEventEnvelope"] & {
      /** @constant */
      type: "tool.requested";
      data: {
        segmentId: string;
        callId: string;
        /** @enum {string} */
        kind: "function" | "custom";
        name: string;
        /** @description A bounded Tool input preview emitted only by the transcript event view. */
        inputPreview?: string;
        /** @description Whether the transcript Tool input preview omits bytes from the durable input. */
        inputTruncated?: boolean;
      };
    };
    ToolCompletedEventView: components["schemas"]["RunEventEnvelope"] & {
      /** @constant */
      type: "tool.completed";
      data: {
        segmentId: string;
        callId: string;
        /** @enum {string} */
        kind: "function" | "custom";
        name: string;
        isError: boolean;
        outputTruncated: boolean;
        artifactAvailable: boolean;
        workspaceChanges?: components["schemas"]["WorkspaceChangeSummary"];
        /** @description A bounded Tool output preview emitted only by the transcript event view. */
        outputPreview?: string;
      };
    };
    WorkspaceChangeSummary: {
      /** @constant */
      schemaVersion: "crewon.workspace-change-summary.v0";
      paths: string[];
      additions: number;
      deletions: number;
      statsComplete: boolean;
    };
    ThreadTaskChangeLedgerResponse: {
      /** @constant */
      schemaVersion: "crewon.thread-task-change-ledger.v0";
      threadId: string;
      threadRevision: number;
      historySequence: number;
      /** @description Always equals summary.statsComplete. False responses use canonical zero values. */
      complete: boolean;
      summary: components["schemas"]["WorkspaceChangeSummary"];
      /** @description Number of matched native workspace_run_command requested/completed events. */
      eventCount: number;
      /** @description Effective terminal Turn Runs, ordered by their first effective-history reference. */
      includedRunIds: string[];
    };
    ContextCompactedEventView: components["schemas"]["RunEventEnvelope"] & {
      /** @constant */
      type: "context.compacted";
      data: {
        /** @enum {string} */
        mode: "auto" | "manual";
        replacesThroughSequence: number;
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
      };
    };
    RateLimitWindow: {
      usedPercent: number;
      windowMinutes: number | null;
      resetsAt: number | null;
    };
    CreditsSnapshot: {
      hasCredits: boolean;
      unlimited: boolean;
      balance: string | null;
    };
    SpendControlLimitSnapshot: {
      limit: string;
      used: string;
      remainingPercent: number;
      resetsAt: number;
    };
    RateLimitSnapshot: {
      limitId: string | null;
      limitName: string | null;
      primary: components["schemas"]["RateLimitWindow"] | null;
      secondary: components["schemas"]["RateLimitWindow"] | null;
      credits: components["schemas"]["CreditsSnapshot"] | null;
      individualLimit:
        | components["schemas"]["SpendControlLimitSnapshot"]
        | null;
      planType: string | null;
      /** @enum {string|null} */
      rateLimitReachedType:
        | "rate_limit_reached"
        | "workspace_owner_credits_depleted"
        | "workspace_member_credits_depleted"
        | "workspace_owner_usage_limit_reached"
        | "workspace_member_usage_limit_reached"
        | null;
    };
    RateLimitUpdatedEventView: components["schemas"]["RunEventEnvelope"] & {
      /** @constant */
      type: "rate_limit.updated";
      data: {
        segmentId: string;
        snapshot: components["schemas"]["RateLimitSnapshot"];
      };
    };
    UsageRecordedEventView: components["schemas"]["RunEventEnvelope"] & {
      /** @constant */
      type: "usage.recorded";
      data: {
        segmentId: string;
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
      };
    };
    RunGoalAccountingUpdatedEventView: components["schemas"]["RunEventEnvelope"] & {
      /** @constant */
      type: "run.goal.accounting.updated";
      data: {
        goalId: string | null;
        goalRevision: number | null;
        steeringPending: boolean;
      };
    };
    RunGoalSteeringConsumedEventView: components["schemas"]["RunEventEnvelope"] & {
      /** @constant */
      type: "run.goal.steering.consumed";
      data: Record<string, never>;
    };
    RunPlanUpdatedEventView: components["schemas"]["RunEventEnvelope"] & {
      /** @constant */
      type: "run.plan.updated";
      data: {
        plan: components["schemas"]["RunPlanView"];
      };
    };
    SegmentCompletedEventView: components["schemas"]["RunEventEnvelope"] & {
      /** @constant */
      type: "segment.completed";
      data: {
        segmentId: string;
      };
    };
    SegmentCheckpointedEventView: components["schemas"]["RunEventEnvelope"] & {
      /** @constant */
      type: "segment.checkpointed";
      data: {
        segmentId: string;
      };
    };
    SegmentProviderContinuationEventView: components["schemas"]["RunEventEnvelope"] & {
      /** @constant */
      type: "segment.provider_continuation";
      data: {
        segmentId: string;
        sampleIndex: number;
        throughHistorySequence: number;
      };
    };
    SegmentFailedEventView: components["schemas"]["RunEventEnvelope"] & {
      /** @constant */
      type: "segment.failed";
      data: {
        segmentId: string;
        code: string;
        retryable: boolean;
      };
    };
    MessageCompletedEventView: components["schemas"]["RunEventEnvelope"] & {
      /** @constant */
      type: "message.completed";
      data: {
        messageId: string;
        messageSequence: number;
        /** @constant */
        role: "assistant";
      };
    };
    PlanProposedEventView: components["schemas"]["RunEventEnvelope"] & {
      /** @constant */
      type: "plan.proposed";
      data: {
        planId: string;
        messageId: string;
        messageSequence: number;
      };
    };
    RunReasonEventData: {
      data: {
        reasonCode: string;
      };
    };
    EmptyRunEventData: {
      data: Record<string, never>;
    };
    RunEventView:
      | components["schemas"]["RunCreatedEventView"]
      | components["schemas"]["RunStartedEventView"]
      | components["schemas"]["RunApprovalRequiredEventView"]
      | components["schemas"]["RunResumedEventView"]
      | components["schemas"]["RunSuspendedEventView"]
      | components["schemas"]["RunReconciliationRequiredEventView"]
      | components["schemas"]["RunCancelRequestedEventView"]
      | components["schemas"]["RunCompletedEventView"]
      | components["schemas"]["RunFailedEventView"]
      | components["schemas"]["RunCanceledEventView"]
      | components["schemas"]["SegmentStartedEventView"]
      | components["schemas"]["ModelSamplingRetryEventView"]
      | components["schemas"]["ModelTransportFallbackEventView"]
      | components["schemas"]["ModelOutputDeltaEventView"]
      | components["schemas"]["ToolRequestedEventView"]
      | components["schemas"]["ToolCompletedEventView"]
      | components["schemas"]["ContextCompactedEventView"]
      | components["schemas"]["RateLimitUpdatedEventView"]
      | components["schemas"]["UsageRecordedEventView"]
      | components["schemas"]["RunGoalAccountingUpdatedEventView"]
      | components["schemas"]["RunGoalSteeringConsumedEventView"]
      | components["schemas"]["RunPlanUpdatedEventView"]
      | components["schemas"]["SegmentCheckpointedEventView"]
      | components["schemas"]["SegmentCompletedEventView"]
      | components["schemas"]["SegmentProviderContinuationEventView"]
      | components["schemas"]["SegmentFailedEventView"]
      | components["schemas"]["PlanProposedEventView"]
      | components["schemas"]["MessageCompletedEventView"];
    ModelProviderSettingView: {
      providerId: string;
      displayName: string;
      endpoint: string;
      credentialKind: components["schemas"]["ModelProviderCredentialKind"];
      environmentVariable: string | null;
      isActive: boolean;
    };
    GetThreadMessageWindowResponse: {
      /** @constant */
      schemaVersion: "crewon.message-window.v0";
      threadId: string;
      threadRevision: number;
      eventSequence: number;
      headMessageSequence: number;
      data: components["schemas"]["MessageView"][];
      olderCursor: string | null;
      newerCursor: string | null;
    };
    ThreadCatalogResponse: {
      /** @constant */
      schemaVersion: "crewon.thread-catalog.v0";
      data: components["schemas"]["ThreadView"][];
      scannedCount: number;
      olderCursor: string | null;
      newerCursor: string | null;
    };
    GetThreadActiveRunResponse: {
      /** @constant */
      schemaVersion: "crewon.thread-active-run.v0";
      threadId: string;
      run: components["schemas"]["RunView"] | null;
    };
    GetThreadTranscriptWindowResponse: {
      /** @constant */
      schemaVersion: "crewon.transcript-window.v0";
      messageWindow: components["schemas"]["GetThreadMessageWindowResponse"];
      /** @description Exactly one entry per message, in the same order. */
      runBindings: {
        messageId: string;
        runId: string | null;
        /** @enum {string} */
        source: "turnStartReceipt" | "messageCompletedEvent" | "unassociated";
      }[];
    };
    OfficeThreadResponse: {
      officeId: string;
      officeVersionId: string;
      thread: components["schemas"]["ThreadView"] | null;
    };
    OfficeThreadMutationResponse: {
      officeId: string;
      officeVersionId: string;
      thread: components["schemas"]["ThreadView"];
      /** @enum {string} */
      disposition: "created" | "bound" | "existing";
    };
    CreateOfficeThreadRequest: Record<string, never>;
    BindOfficeThreadRequest: {
      threadId: string;
      expectedRevision: number;
    };
    ExtensionCredentialReference: {
      slotId: string;
      credentialBindingId: string;
    };
    SaveExtensionConfigurationRequest: {
      pluginVersion: string;
      expectedRevision: number;
      /** @description Non-secret JSON validated against the exact plugin configuration schema. Total canonical size <=16KiB, depth <=24, nodes <=8192, and nested objects <=256 properties. Secret values belong in credential bindings, not parameters. */
      parameters: {
        [key: string]: unknown;
      };
      /** @description Scoped credential references only; secret values are never accepted. */
      credentialBindings: components["schemas"]["ExtensionCredentialReference"][];
    };
    /** @description enabled requires an explicit deployed crewonKernel AgentVersion; disabled/revoked require a null agentVersionId. No default Agent is changed. */
    SetExtensionActivationRequest: {
      configurationRevision: number;
      expectedRevision: number;
      /** @enum {string} */
      state: "enabled" | "disabled" | "revoked";
      agentVersionId: string | null;
    };
    ExtensionExecutionTarget: {
      /** @constant */
      executionAuthority: "crewonKernel";
      agentVersionId: string;
      agentVersionContentDigest: string;
      materializationDigest: string;
      authorityId: string;
      runtimeGeneration: string;
      policySnapshotId: string;
      workspaceBindingId: string | null;
    };
    ExtensionConfiguration: {
      /** @constant */
      schemaVersion: "crewon.extension-configuration.v0";
      tenantId: string;
      spaceId: string;
      pluginId: string;
      revision: number;
      pluginVersion: string;
      manifestDigest: string;
      implementationDigest: string;
      /** @description Non-secret JSON validated against the exact plugin configuration schema. Total canonical size <=16KiB, depth <=24, nodes <=8192, and nested objects <=256 properties. Secret values belong in credential bindings, not parameters. */
      parameters: {
        [key: string]: unknown;
      };
      /** @description Scoped credential references only; secret values are never accepted. */
      credentialBindings: components["schemas"]["ExtensionCredentialReference"][];
      createdByActorId: string;
      /** Format: date-time */
      createdAt: string;
      contentDigest: string;
    };
    ExtensionActivation: {
      /** @constant */
      schemaVersion: "crewon.extension-activation.v0";
      tenantId: string;
      spaceId: string;
      pluginId: string;
      revision: number;
      configurationRevision: number;
      configurationDigest: string;
      /** @enum {string} */
      state: "enabled" | "disabled" | "revoked";
      target: components["schemas"]["ExtensionExecutionTarget"] | null;
      updatedByActorId: string;
      /** Format: date-time */
      updatedAt: string;
    };
    GetExtensionConfigurationResponse: {
      configuration: components["schemas"]["ExtensionConfiguration"] | null;
    };
    ExtensionConfigurationMutationResponse: {
      /** @enum {string} */
      disposition: "created" | "replayed";
      configuration: components["schemas"]["ExtensionConfiguration"];
    };
    GetExtensionActivationResponse: {
      activation: components["schemas"]["ExtensionActivation"] | null;
    };
    ExtensionActivationMutationResponse: {
      /** @enum {string} */
      disposition: "updated" | "replayed";
      activation: components["schemas"]["ExtensionActivation"];
    };
    ExtensionGenerateTaskIntent: {
      /** @constant */
      kind: "generate";
      /** @description Plugin task JSON validated against the pinned manifest. Total canonical input <=16KiB; depth <=24; nodes <=8192. Runtime and scope fields are supplied by the host. */
      input: {
        [key: string]: unknown;
      };
    };
    ExtensionQueryTaskIntent: {
      /** @constant */
      kind: "query";
      sourceRunId: string;
      operationId: string;
    };
    CreateExtensionTaskRequest: {
      threadId: string;
      expectedThreadRevision: number;
      intent:
        | components["schemas"]["ExtensionGenerateTaskIntent"]
        | components["schemas"]["ExtensionQueryTaskIntent"];
    };
    ExtensionTaskMutationResponse: {
      /** @enum {string} */
      disposition: "committed" | "replayed";
      threadId: string;
      threadRevision: number;
      runId: string;
      messageId: string;
      configurationRevision: number;
    };
    ExtensionCatalogEntry: {
      pluginId: string;
      pluginVersion: string;
      title: string;
      description: string;
      /** @description Detached non-executable JSON schema metadata; canonical size <=24KiB, depth <=24, nodes <=8192. */
      inputSchema: {
        [key: string]: unknown;
      };
      /** @description Detached non-secret configuration schema metadata; canonical size <=24KiB, depth <=24, nodes <=8192. */
      configurationSchema: {
        [key: string]: unknown;
      };
      credentialSlots: {
        id: string;
        title: string;
      }[];
      resultViews: ("text" | "externalOperation" | "externalResult")[];
    };
    ExtensionCatalogResponse: {
      extensions: components["schemas"]["ExtensionCatalogEntry"][];
    };
    ExtensionReadiness:
      | {
          /** @constant */
          outcome: "ready";
          target: components["schemas"]["ExtensionExecutionTarget"];
        }
      | {
          /** @constant */
          outcome: "unavailable";
          /** @enum {string} */
          reasonCode:
            | "extension_runtime_unavailable"
            | "extension_implementation_unavailable"
            | "extension_credential_unavailable"
            | "extension_execution_authority_unsupported";
        };
    ExtensionRuntimeResponse: {
      pluginId: string;
      agentVersionId: string;
      configurationRevision: number;
      readiness: components["schemas"]["ExtensionReadiness"];
    };
    ExtensionTaskImage: {
      /**
       * Format: uri
       * @description HTTPS result reference without credentials or fragment; no media bytes.
       */
      url: string;
      filename: string;
    };
    ExtensionTaskOperation: {
      operationId: string;
      sourceRunId: string;
      /** @enum {string} */
      status:
        | "submitting"
        | "submitted"
        | "queued"
        | "running"
        | "succeeded"
        | "failed"
        | "unknownOutcome";
      /** Format: date-time */
      observedAt: string;
      images: components["schemas"]["ExtensionTaskImage"][];
    };
    ExtensionTaskView: {
      runId: string;
      threadId: string;
      pluginId: string;
      pluginVersion: string;
      configurationRevision: number;
      runStatus: components["schemas"]["RunStatus"];
      sourceRunId: string | null;
      operations: components["schemas"]["ExtensionTaskOperation"][];
      truncated: boolean;
    };
    GetExtensionTaskResponse: {
      task: components["schemas"]["ExtensionTaskView"];
    };
    PluginNamespaceId: string;
    PluginPackageDigest: string;
    /** @description Server-issued opaque reference or action name. No leading/trailing whitespace, Unicode control/format/line/paragraph separator or unpaired surrogate. It never conveys authority by itself. */
    PluginOpaqueId: string;
    /** @description HTTP Idempotency-Key token: 1..128 printable ASCII characters with no whitespace. Unicode and Latin-1 non-ASCII values are rejected before constructing or sending HTTP headers. Internal ledger keys and source references retain separate value rules. */
    PluginIdempotencyKey: string;
    PluginMountRef: string;
    /** @description Decoded package-relative inventory path, at most 256 UTF-8 bytes. No absolute path, empty/dot segment, encoding escape, control/format character or URL. Actual bytes and links require host verification. */
    PluginAssetPath: string;
    PluginPackageView: {
      pluginId: components["schemas"]["PluginNamespaceId"];
      version: string;
      publisherId: components["schemas"]["PluginNamespaceId"];
      packageDigest: components["schemas"]["PluginPackageDigest"];
      /** Format: date-time */
      installedAt: string;
    };
    /** @description Desired durable selection, separate from runtime health. Uninstalled has null digest; enabled/disabled have an installed digest. Server scope and audit identity are private. */
    PluginSelectionView: {
      pluginId: components["schemas"]["PluginNamespaceId"];
      publisherId: components["schemas"]["PluginNamespaceId"];
      revision: number;
      /** @enum {string} */
      state: "enabled" | "disabled" | "uninstalled";
      selectedPackageDigest:
        | components["schemas"]["PluginPackageDigest"]
        | null;
      /** Format: date-time */
      updatedAt: string;
    } & (
      | {
          /** @enum {string} */
          state?: "enabled" | "disabled";
          selectedPackageDigest?: components["schemas"]["PluginPackageDigest"];
        }
      | {
          /** @constant */
          state?: "uninstalled";
          selectedPackageDigest?: null;
        }
    );
    PluginPackageListResponse: {
      packages: components["schemas"]["PluginPackageView"][];
      next: components["schemas"]["PluginPackageDigest"] | null;
    };
    PluginSelectionListResponse: {
      selections: components["schemas"]["PluginSelectionView"][];
      next: components["schemas"]["PluginNamespaceId"] | null;
    };
    GetPluginPackageResponse: {
      package: components["schemas"]["PluginPackageView"] | null;
    };
    GetPluginSelectionResponse: {
      selection: components["schemas"]["PluginSelectionView"] | null;
    };
    InstallPluginPackageRequest: {
      sourceId: components["schemas"]["PluginOpaqueId"];
      expectedPluginId: components["schemas"]["PluginNamespaceId"];
      expectedPackageDigest: components["schemas"]["PluginPackageDigest"];
      expectedSelectionRevision: number | null;
    };
    SelectPluginPackageRequest: {
      /** @enum {string} */
      state: "enabled" | "disabled" | "uninstalled";
      selectedPackageDigest:
        | components["schemas"]["PluginPackageDigest"]
        | null;
      expectedSelectionRevision: number;
    } & (
      | {
          /** @enum {string} */
          state?: "enabled" | "disabled";
          selectedPackageDigest?: components["schemas"]["PluginPackageDigest"];
        }
      | {
          /** @constant */
          state?: "uninstalled";
          selectedPackageDigest?: null;
        }
    );
    PluginInstallationResponse: {
      /** @constant */
      kind: "install";
      /** @enum {string} */
      disposition: "committed" | "replayed";
      package: components["schemas"]["PluginPackageView"];
      selection: components["schemas"]["PluginSelectionView"];
    };
    PluginSelectionMutation: {
      /** @constant */
      kind: "select";
      /** @enum {string} */
      disposition: "committed" | "replayed";
      selection: components["schemas"]["PluginSelectionView"];
    };
    PluginSelectionProjection:
      | {
          /** @constant */
          outcome: "applied";
        }
      | {
          /** @constant */
          outcome: "unchanged";
        }
      | {
          /** @constant */
          outcome: "pending";
          /** @constant */
          reasonCode: "plugin_projection_pending";
        };
    /** @description A replay preserves the original mutation snapshot and returns unchanged projection. A committed mutation returns applied or pending; pending does not imply database rollback. */
    PluginSelectionResponse: {
      mutation: components["schemas"]["PluginSelectionMutation"];
      projection: components["schemas"]["PluginSelectionProjection"];
    } & (
      | {
          mutation?: {
            /** @constant */
            disposition?: "replayed";
          };
          projection?: {
            /** @constant */
            outcome?: "unchanged";
          };
        }
      | {
          mutation?: {
            /** @constant */
            disposition?: "committed";
          };
          projection?: {
            /** @enum {unknown} */
            outcome?: "applied" | "pending";
          };
        }
    );
    PluginPackageEntrypoints:
      | {
          node: string | null;
          ui:
            | (
                | {
                    /** @constant */
                    mode: "trustedModule";
                    path: string;
                  }
                | {
                    /** @constant */
                    mode: "isolatedWeb";
                    path: string;
                  }
              )
            | null;
        }
      | {
          node?: string;
        }
      | {
          ui?: Record<string, never>;
        };
    PluginServiceRequirement: {
      service: components["schemas"]["PluginNamespaceId"];
      apiVersion: string;
      optional: boolean;
    };
    PluginServiceProvision: {
      service: components["schemas"]["PluginNamespaceId"];
      apiVersion: string;
    };
    PluginUiContribution:
      | {
          id: components["schemas"]["PluginNamespaceId"];
          /** @constant */
          kind: "module";
          /** @constant */
          slot: "main.content";
          /** @description At most 160 Unicode scalar values; no control characters. */
          title: string;
        }
      | {
          id: components["schemas"]["PluginNamespaceId"];
          /** @constant */
          kind: "settings";
          /** @constant */
          slot: "settings.section";
          /** @description At most 160 Unicode scalar values; no control characters. */
          title: string;
        }
      | {
          id: components["schemas"]["PluginNamespaceId"];
          /** @constant */
          kind: "result";
          /** @constant */
          slot: "result.view";
          /** @description At most 160 Unicode scalar values; no control characters. */
          title: string;
        };
    PluginPackageFile: {
      /** @description Decoded package-relative inventory path, at most 256 UTF-8 bytes. No absolute path, empty/dot segment, encoding escape, control/format character or URL. Actual bytes and links require host verification. */
      path: string;
      byteLength: number;
      sha256: string;
    };
    /** @description Metadata shape only, at most 256 KiB encoded JSON, depth 16 and 8192 nodes. At least one entrypoint; UI entry requires declared contributions. Paths and services are unique; all referenced artifacts are declared, nonempty entrypoints. Inventory excludes crewon.plugin.json and forbids file/parent conflicts; hashes and actual trust require host verification. */
    PluginPackageDescriptor: {
      /** @constant */
      schemaVersion: "crewon.plugin-package.v1";
      /** @constant */
      hostApi: "crewon.plugin-host.v1";
      pluginId: components["schemas"]["PluginNamespaceId"];
      version: string;
      /** @description At most 160 Unicode scalar values; no control characters. */
      title: string;
      /** @description At most 8192 UTF-8 bytes. */
      description: string;
      publisherId: components["schemas"]["PluginNamespaceId"];
      entrypoints: components["schemas"]["PluginPackageEntrypoints"];
      businessManifestPath: string | null;
      requires: components["schemas"]["PluginServiceRequirement"][];
      provides: components["schemas"]["PluginServiceProvision"][];
      contributions: components["schemas"]["PluginUiContribution"][];
      files: components["schemas"]["PluginPackageFile"][];
    };
    /** @description Finite detached plain JSON, depth <=16, nodes <=8192, valid Unicode. Input <=24 KiB, output <=64 KiB encoded JSON. It does not carry actor/profile authority. */
    PluginUiJsonValue:
      | null
      | boolean
      | number
      | string
      | unknown[]
      | {
          [key: string]: unknown;
        };
    OpenPluginUiMountRequest: {
      pluginId: components["schemas"]["PluginNamespaceId"];
      contributionId: components["schemas"]["PluginNamespaceId"];
      expectedSelectionRevision: number;
      expectedPackageDigest: components["schemas"]["PluginPackageDigest"];
    };
    /** @description Action must be in the host contribution allowlist. This JSON envelope does not authorize arbitrary Node services, Run/Tool execution or charging. */
    InvokePluginUiActionRequest: {
      action: components["schemas"]["PluginOpaqueId"];
      input: components["schemas"]["PluginUiJsonValue"];
    };
    /** @description Shape-only current enabled-selection lease. UI must be trustedModule, contribution module/main.content, approved assets inventory subset includes UI entrypoint. Reference alone is not an authorization grant. The host rechecks actor/profile/selection/authority epoch for every use. */
    PluginUiLease: {
      /** @constant */
      schemaVersion: "crewon.plugin-ui-lease.v1";
      mountRef: components["schemas"]["PluginMountRef"];
      /** Format: date-time */
      expiresAt: string;
      selectionRevision: number;
      packageDigest: components["schemas"]["PluginPackageDigest"];
      descriptor: components["schemas"]["PluginPackageDescriptor"];
      contributionId: components["schemas"]["PluginNamespaceId"];
      publicAssets: components["schemas"]["PluginAssetPath"][];
    };
    PluginUiCatalogItem: {
      descriptor: components["schemas"]["PluginPackageDescriptor"];
      publicAssets: components["schemas"]["PluginAssetPath"][];
      selectionRevision: number;
      packageDigest: components["schemas"]["PluginPackageDigest"];
    };
    /** @description Only enabled trustedModule main.content packages. Cursor belongs to underlying selection page, so filtered unsupported/disabled packages can yield an empty displayed page with nonnull next. */
    PluginUiCatalogResponse: {
      plugins: components["schemas"]["PluginUiCatalogItem"][];
      next: components["schemas"]["PluginNamespaceId"] | null;
    };
    ClosePluginUiMountResponse: {
      /** @constant */
      closed: true;
    };
    InvokePluginUiActionResponse: {
      output: components["schemas"]["PluginUiJsonValue"];
    };
    PluginSourceView: {
      sourceId: components["schemas"]["PluginOpaqueId"];
      pluginId: components["schemas"]["PluginNamespaceId"];
      publisherId: components["schemas"]["PluginNamespaceId"];
      /** @description Exact valid semantic package version. */
      version: string;
      /** @description At most 160 Unicode scalars and 640 UTF-8 bytes; validated like the package descriptor. */
      title: string;
      /** @description At most 8192 UTF-8 bytes; validated like the package descriptor. */
      description: string;
      packageDigest: components["schemas"]["PluginPackageDigest"];
    };
    /** @description Strictly increasing sourceId code-unit order; unique sourceId, digest and pluginId/version; each pluginId has one publisher. Encoded response at most 131072 bytes. */
    PluginSourceListResponse: {
      sources: components["schemas"]["PluginSourceView"][];
      /** @description Last returned sourceId only when a full page has additional rows; otherwise null. */
      next: components["schemas"]["PluginOpaqueId"] | null;
    };
    /** @description S0 short-drama metadata projection. Contains no payer, authority, execution, image or selected-result claim. Stored ownership remains server-authoritative. */
    PublicCreativeProject: {
      /** @description Opaque Unicode identifier, at most 128 UTF-16 units; no surrounding whitespace, control characters, or complete dot path segments. IDs are encoded once in HTTP paths. */
      projectId: string;
      /** @enum {string} */
      kind: "short-drama";
      /** @description At most 160 Unicode scalar values, no surrounding whitespace. */
      title: string;
      revision: number;
      /** @enum {string} */
      state: "active" | "archived";
      latestBriefRevision: number;
      /** Format: date-time */
      createdAt: string;
      /** Format: date-time */
      updatedAt: string;
    };
    PublicProjectBrief: {
      /** @description Opaque Unicode identifier, at most 128 UTF-16 units; no surrounding whitespace, control characters, or complete dot path segments. IDs are encoded once in HTTP paths. */
      projectId: string;
      briefRevision: number;
      /** @description At most 8192 UTF-8 bytes. Preserve confirmed whitespace and line breaks. */
      text: string;
      contentDigest: string;
      /** Format: date-time */
      createdAt: string;
    };
    PublicConceptAsset: {
      /** @description Opaque Unicode identifier, at most 128 UTF-16 units; no surrounding whitespace, control characters, or complete dot path segments. IDs are encoded once in HTTP paths. */
      projectId: string;
      /** @description Opaque Unicode identifier, at most 128 UTF-16 units; no surrounding whitespace, control characters, or complete dot path segments. IDs are encoded once in HTTP paths. */
      assetId: string;
      /** @description At most 160 Unicode scalar values, no surrounding whitespace. */
      name: string;
      revision: number;
      latestAssetRevision: number;
      /** Format: date-time */
      createdAt: string;
      /** Format: date-time */
      updatedAt: string;
    };
    PublicConceptRevision: {
      /** @description Opaque Unicode identifier, at most 128 UTF-16 units; no surrounding whitespace, control characters, or complete dot path segments. IDs are encoded once in HTTP paths. */
      projectId: string;
      /** @description Opaque Unicode identifier, at most 128 UTF-16 units; no surrounding whitespace, control characters, or complete dot path segments. IDs are encoded once in HTTP paths. */
      assetId: string;
      assetRevision: number;
      briefRevision: number;
      briefContentDigest: string;
      /** @description At most 2000 UTF-16 units, preserve the confirmed prompt. */
      prompt: string;
      contentDigest: string;
      /** Format: date-time */
      createdAt: string;
    };
    CreateCreativeProjectRequest: {
      /** @description At most 160 Unicode scalar values, no surrounding whitespace. */
      title: string;
      /** @description At most 8192 UTF-8 bytes. Preserve confirmed whitespace and line breaks. */
      briefText: string;
    };
    RenameCreativeProjectRequest: {
      /** @description At most 160 Unicode scalar values, no surrounding whitespace. */
      title: string;
      expectedProjectRevision: number;
    };
    SetCreativeProjectStateRequest: {
      /** @enum {string} */
      state: "active" | "archived";
      expectedProjectRevision: number;
    };
    AppendProjectBriefRequest: {
      /** @description At most 8192 UTF-8 bytes. Preserve confirmed whitespace and line breaks. */
      text: string;
      expectedProjectRevision: number;
    };
    CreateConceptAssetRequest: {
      /** @description At most 160 Unicode scalar values, no surrounding whitespace. */
      name: string;
      briefRevision: number;
      /** @description At most 2000 UTF-16 units, preserve the confirmed prompt. */
      prompt: string;
      expectedProjectRevision: number;
    };
    AppendConceptAssetRevisionRequest: {
      briefRevision: number;
      /** @description At most 2000 UTF-16 units, preserve the confirmed prompt. */
      prompt: string;
      expectedProjectRevision: number;
      expectedAssetMetadataRevision: number;
    };
    GetCreativeProjectResponse: {
      project: components["schemas"]["PublicCreativeProject"];
    };
    GetProjectBriefResponse: {
      brief: components["schemas"]["PublicProjectBrief"];
    };
    GetConceptAssetResponse: {
      asset: components["schemas"]["PublicConceptAsset"];
    };
    GetConceptRevisionResponse: {
      assetRevision: components["schemas"]["PublicConceptRevision"];
    };
    CreativeProjectMetadataMutationResponse: {
      /** @enum {string} */
      disposition: "committed" | "replayed";
      project: components["schemas"]["PublicCreativeProject"];
    };
    CreativeProjectBriefMutationResponse: {
      /** @enum {string} */
      disposition: "committed" | "replayed";
      project: components["schemas"]["PublicCreativeProject"];
      brief: components["schemas"]["PublicProjectBrief"];
    };
    CreativeProjectConceptMutationResponse: {
      /** @enum {string} */
      disposition: "committed" | "replayed";
      project: components["schemas"]["PublicCreativeProject"];
      asset: components["schemas"]["PublicConceptAsset"];
      assetRevision: components["schemas"]["PublicConceptRevision"];
    };
    /** @description Ordered by updatedAt DESC, projectId DESC in Unicode scalar order. Cursor binds the state filter. Response stays within 60 KiB; when byte-trimmed, continuation identifies the last returned row. */
    CreativeProjectListResponse: {
      projects: components["schemas"]["PublicCreativeProject"][];
      nextCursor: string | null;
    };
    /** @description Ascending revisions strictly after the supplied cursor. Non-null continuation permits another read and does not claim another row exists. Pages may be shortened to the 60 KiB response budget. */
    ProjectBriefListResponse: {
      briefs: components["schemas"]["PublicProjectBrief"][];
      nextAfterBriefRevision: number | null;
    };
    /** @description Ascending asset IDs in Unicode scalar order; continuation permits another read, not an exact hasMore claim. Response at most 60 KiB. */
    ConceptAssetListResponse: {
      assets: components["schemas"]["PublicConceptAsset"][];
      nextAfterAssetId: string | null;
    };
    /** @description Ascending revisions; continuation permits another read, not an exact hasMore claim. Response at most 60 KiB. */
    ConceptRevisionListResponse: {
      revisions: components["schemas"]["PublicConceptRevision"][];
      nextAfterAssetRevision: number | null;
    };
    ConceptGenerationImage: {
      /**
       * Format: uri
       * @description HTTPS result reference without credentials or fragment; no media bytes.
       */
      url: string;
      filename: string;
      /** @description Exact original images[] index; unaffected by response truncation. Never use the displayed array position to identify a saved result. */
      resultIndex: number;
    };
    ConceptGenerationOperation: {
      operationId: string;
      sourceRunId: string;
      /** @enum {string} */
      status:
        | "submitting"
        | "submitted"
        | "queued"
        | "running"
        | "succeeded"
        | "failed"
        | "unknownOutcome";
      /** Format: date-time */
      observedAt: string;
      images: components["schemas"]["ConceptGenerationImage"][];
      operationRevision: number;
    };
    ConceptGenerationTaskView: {
      runId: string;
      threadId: string;
      pluginId: string;
      pluginVersion: string;
      configurationRevision: number;
      runStatus: components["schemas"]["RunStatus"];
      /** @description This projection always describes the original generation Run. */
      sourceRunId: null;
      operations: components["schemas"]["ConceptGenerationOperation"][];
      truncated: boolean;
    };
    PublicConceptGeneration: {
      /** @description Opaque Unicode identifier, at most 128 UTF-16 units; no surrounding whitespace, control characters, or complete dot path segments. IDs are encoded once in HTTP paths. */
      projectId: string;
      /** @description Opaque Unicode identifier, at most 128 UTF-16 units; no surrounding whitespace, control characters, or complete dot path segments. IDs are encoded once in HTTP paths. */
      assetId: string;
      assetRevision: number;
      briefRevision: number;
      /** Format: date-time */
      createdAt: string;
      task: components["schemas"]["ConceptGenerationTaskView"];
    };
    GetConceptGenerationResponse: {
      generation: components["schemas"]["PublicConceptGeneration"] | null;
    };
    ConceptSelectionLocator: {
      projectId: string;
      assetId: string;
    };
    ConceptSelectionSource: {
      projectId: string;
      assetId: string;
      assetRevision: number;
    };
    ConceptSelectionWriteReference: {
      projectId: string;
      assetId: string;
      assetRevision: number;
      expectedProjectRevision: number;
      expectedAssetMetadataRevision: number;
    };
    /** @description At most 24 KiB. Exact original result index and independent selection CAS. The path must agree with reference. Caller cannot supply URL, Run, configuration, account, price or provider reference. Historical input may be selected using current active project and metadata CAS. */
    SelectConceptImageRequest: {
      reference: components["schemas"]["ConceptSelectionWriteReference"];
      operationId: string;
      expectedOperationRevision: number;
      resultIndex: number;
      expectedSelectionRevision: number;
    };
    PublicConceptImageSelection: {
      reference: components["schemas"]["ConceptSelectionSource"];
      operationId: string;
      operationRevision: number;
      resultIndex: number;
      filename: string;
      /**
       * Format: uri
       * @description Server verified HTTPS reference without credentials or fragment; no media bytes.
       */
      url: string;
      /** Format: date-time */
      selectedAt: string;
    };
    CurrentConceptImageSelection: {
      reference: components["schemas"]["ConceptSelectionSource"];
      operationId: string;
      operationRevision: number;
      resultIndex: number;
      filename: string;
      /**
       * Format: uri
       * @description Server verified HTTPS reference without credentials or fragment; no media bytes.
       */
      url: string;
      /** Format: date-time */
      selectedAt: string;
      /** @description Only changed creative input dependencies make a saved selection require confirmation. Rename does not. */
      requiresConfirmation: boolean;
    };
    /** @description At most 24 KiB. Revision zero iff actual current pointer is null. Missing capability/schema is an error, not an empty pointer. */
    GetConceptSelectionResponse: {
      selectionRevision: number;
      current: components["schemas"]["CurrentConceptImageSelection"] | null;
    };
    /** @description At most 24 KiB. Immutable command receipt; selectionRevision equals expectedSelectionRevision + 1. Replay does not overwrite or represent a newer current pointer. Read current pointer separately. */
    SelectConceptImageResponse: {
      /** @enum {string} */
      disposition: "committed" | "replayed";
      selectionRevision: number;
      selection: components["schemas"]["PublicConceptImageSelection"];
    };
    RenewPluginUiMountRequest: {
      /** Format: date-time */
      expectedExpiresAt: string;
    };
    /** @description Strict outline content: unique episode identifiers and at most 16384 canonical JSON UTF-8 bytes. */
    ProjectTextOutlineContent: {
      /** @description At most 160 Unicode scalars / 320 UTF-16 units; already trimmed. */
      title: string;
      /** @description At most 2048 UTF-8 bytes; no lone surrogate, DEL or C0 except TAB/LF/CR. Creative whitespace preserved. */
      logline: string;
      /** @description At most 8192 UTF-8 bytes; no lone surrogate, DEL or C0 except TAB/LF/CR. Creative whitespace preserved. */
      synopsis: string;
      episodes: {
        /** @description Opaque Unicode identifier, exact identity; no surrounding whitespace, controls or URL dot segments. */
        episodeId: string;
        /** @description At most 160 Unicode scalars / 320 UTF-16 units; already trimmed. */
        title: string;
        /** @description At most 8192 UTF-8 bytes; no lone surrogate, DEL or C0 except TAB/LF/CR. Creative whitespace preserved. */
        summary: string;
      }[];
    };
    /** @description Strict script content: unique scene identifiers, every scene has action or dialogue, at most 32768 canonical JSON UTF-8 bytes. */
    ProjectTextScriptContent: {
      /** @description At most 160 Unicode scalars / 320 UTF-16 units; already trimmed. */
      title: string;
      scenes: {
        /** @description Opaque Unicode identifier, exact identity; no surrounding whitespace, controls or URL dot segments. */
        sceneId: string;
        /** @description At most 640 UTF-8 bytes; no lone surrogate, DEL or C0 except TAB/LF/CR. Creative whitespace preserved. */
        location: string;
        /** @description At most 320 UTF-8 bytes; no lone surrogate, DEL or C0 except TAB/LF/CR. Creative whitespace preserved. */
        timeOfDay: string;
        /** @description At most 8192 UTF-8 bytes; no lone surrogate, DEL or C0 except TAB/LF/CR. Creative whitespace preserved. */
        action: string;
        dialogue: {
          /** @description At most 640 UTF-8 bytes; no lone surrogate, DEL or C0 except TAB/LF/CR. Creative whitespace preserved. */
          speaker: string;
          /** @description At most 8192 UTF-8 bytes; no lone surrogate, DEL or C0 except TAB/LF/CR. Creative whitespace preserved. */
          text: string;
        }[];
      }[];
    };
    PublicProjectTextArtifact:
      | {
          /** @description Opaque Unicode identifier, exact identity; no surrounding whitespace, controls or URL dot segments. */
          projectId: string;
          /** @description Opaque Unicode identifier, exact identity; no surrounding whitespace, controls or URL dot segments. */
          artifactId: string;
          revision: number;
          latestContentRevision: number;
          selectedContentRevision: number | null;
          locked: boolean;
          /**
           * Format: date-time
           * @description Canonical UTC ISO timestamp with milliseconds.
           */
          createdAt: string;
          /**
           * Format: date-time
           * @description Canonical UTC ISO timestamp with milliseconds.
           */
          updatedAt: string;
          /** @constant */
          kind: "outline";
          episodeId: null;
        }
      | {
          /** @description Opaque Unicode identifier, exact identity; no surrounding whitespace, controls or URL dot segments. */
          projectId: string;
          /** @description Opaque Unicode identifier, exact identity; no surrounding whitespace, controls or URL dot segments. */
          artifactId: string;
          revision: number;
          latestContentRevision: number;
          selectedContentRevision: number | null;
          locked: boolean;
          /**
           * Format: date-time
           * @description Canonical UTC ISO timestamp with milliseconds.
           */
          createdAt: string;
          /**
           * Format: date-time
           * @description Canonical UTC ISO timestamp with milliseconds.
           */
          updatedAt: string;
          /** @constant */
          kind: "script";
          /** @description Opaque Unicode identifier, exact identity; no surrounding whitespace, controls or URL dot segments. */
          episodeId: string;
        };
    PublicProjectTextRevision:
      | {
          /** @description Opaque Unicode identifier, exact identity; no surrounding whitespace, controls or URL dot segments. */
          projectId: string;
          /** @description Opaque Unicode identifier, exact identity; no surrounding whitespace, controls or URL dot segments. */
          artifactId: string;
          contentRevision: number;
          brief: {
            briefRevision: number;
            contentDigest: string;
          };
          contentDigest: string;
          /**
           * Format: date-time
           * @description Canonical UTC ISO timestamp with milliseconds.
           */
          createdAt: string;
          /** @constant */
          kind: "outline";
          episodeId: null;
          outline: null;
          content: components["schemas"]["ProjectTextOutlineContent"];
        }
      | {
          /** @description Opaque Unicode identifier, exact identity; no surrounding whitespace, controls or URL dot segments. */
          projectId: string;
          /** @description Opaque Unicode identifier, exact identity; no surrounding whitespace, controls or URL dot segments. */
          artifactId: string;
          contentRevision: number;
          brief: {
            briefRevision: number;
            contentDigest: string;
          };
          contentDigest: string;
          /**
           * Format: date-time
           * @description Canonical UTC ISO timestamp with milliseconds.
           */
          createdAt: string;
          /** @constant */
          kind: "script";
          /** @description Opaque Unicode identifier, exact identity; no surrounding whitespace, controls or URL dot segments. */
          episodeId: string;
          outline: {
            /** @description Opaque Unicode identifier, exact identity; no surrounding whitespace, controls or URL dot segments. */
            artifactId: string;
            contentRevision: number;
            contentDigest: string;
          } | null;
          content: components["schemas"]["ProjectTextScriptContent"];
        };
    PublicProjectTextArtifactView: {
      artifact: components["schemas"]["PublicProjectTextArtifact"];
      selectedRevision:
        | components["schemas"]["PublicProjectTextRevision"]
        | null;
      /** @enum {string} */
      dependencyState: "unselected" | "current" | "stale";
      staleReasons: ("brief-changed" | "outline-selection-changed")[];
    };
    SaveProjectOutlineCandidateRequest: {
      expectedArtifactRevision: number;
      briefRevision: number;
      content: components["schemas"]["ProjectTextOutlineContent"];
    };
    SaveProjectScriptCandidateRequest: {
      expectedArtifactRevision: number;
      briefRevision: number;
      outline: {
        /** @description Opaque Unicode identifier, exact identity; no surrounding whitespace, controls or URL dot segments. */
        artifactId: string;
        contentRevision: number;
      } | null;
      content: components["schemas"]["ProjectTextScriptContent"];
    };
    SelectProjectTextRevisionRequest: {
      expectedArtifactRevision: number;
      contentRevision: number;
    };
    SetProjectTextArtifactLockedRequest: {
      expectedArtifactRevision: number;
      locked: boolean;
    };
    GetProjectTextArtifactResponse: {
      view: components["schemas"]["PublicProjectTextArtifactView"] | null;
    };
    GetProjectTextRevisionResponse: {
      contentRevision: components["schemas"]["PublicProjectTextRevision"];
    };
    ProjectTextArtifactListResponse: {
      artifacts: components["schemas"]["PublicProjectTextArtifact"][];
      nextArtifactId: string | null;
    };
    ProjectTextRevisionListResponse: {
      revisions: components["schemas"]["PublicProjectTextRevision"][];
      nextContentRevision: number | null;
    };
    ProjectTextMutationResponse: {
      /** @enum {string} */
      kind: "save-outline" | "save-script" | "select-revision" | "set-lock";
      /** @enum {string} */
      disposition: "committed" | "replayed";
      artifact: components["schemas"]["PublicProjectTextArtifact"];
      contentRevision:
        | components["schemas"]["PublicProjectTextRevision"]
        | null;
    };
  };
  responses: {
    /** @description Stable safe error envelope */
    Error: {
      headers: {
        [name: string]: unknown;
      };
      content: {
        "application/json": components["schemas"]["ErrorEnvelope"];
      };
    };
  };
  parameters: {
    ThreadId: string;
    RunId: string;
    AutomationId: string;
    WorkspaceExecutionId: string;
    ApprovalId: string;
    AgentVersionId: string;
    ArtifactId: string;
    IdempotencyKey: string;
    /** @description Required by the identity adapter for cookie-authenticated mutations. */
    CsrfToken: string;
    /** @description Required for Control mutations that do not permit a credential-mode exception. */
    RequiredCsrfToken: string;
    /** @description Decimal durable event sequence last processed by the client; each event resource has an independent sequence. */
    LastEventId: string;
    /** @description Client view hides bounded transient retry noise; audit preserves every durable event; transcript adds bounded Tool input and output previews for transcript rendering. */
    RunEventView: "client" | "audit" | "transcript";
    /** @description Opt-in Run event extension. run-plan-v1 enables bounded run.plan.updated snapshots; without it those durable events remain hidden while the server cursor still advances. */
    RunEventExtensions: "run-plan-v1";
    /** @description Standard view hides deleted content and emits only its tombstone event; audit requires thread:audit:read and preserves durable history. */
    ThreadHistoryView: "standard" | "audit";
    /** @description Exclusive raw UTF-8 byte lexicographic recovery cursor. Omission is equivalent to null. */
    WorkspaceAfterExecutionId: string | null;
    WorkspaceOperationLimit: number;
    Cursor: string;
    ResourceCursor: string;
    AgentVersionCursor: string;
    Limit: number;
    /** @description One non-empty key of at most 128 UTF-16 units, with no surrounding whitespace, control characters or commas. Comma-separated values are rejected because HTTP adapters may merge repeated headers. Same actor/command/key/input replays the original result; the same key with changed input conflicts. */
    CreativeProjectIdempotencyKey: string;
    /** @description One non-empty key of at most 128 UTF-16 units, with no surrounding whitespace, control characters or commas. Comma-separated values are rejected because HTTP adapters may merge repeated headers. Same actor/command/key/input replays the original result; the same key with changed input conflicts. */
    ProjectTextIdempotencyKey: string;
  };
  requestBodies: never;
  headers: never;
  pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
  getExecutionIntentCapabilityV1: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Execution-intent v1 semantics are available */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ExecutionIntentCapabilityResponse"];
        };
      };
      401: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  getModelProviderSettings: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Authorized non-secret Provider settings snapshot */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["GetModelProviderSettingsResponse"];
        };
      };
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  probeModelProvider: {
    parameters: {
      query?: never;
      header: {
        "Idempotency-Key": components["parameters"]["IdempotencyKey"];
        /** @description Required for Control mutations that do not permit a credential-mode exception. */
        "X-CSRF-Token": components["parameters"]["RequiredCsrfToken"];
      };
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["ProbeModelProviderRequest"];
      };
    };
    responses: {
      /** @description Bounded active Provider probe or its idempotent replay */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ProbeModelProviderResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      409: components["responses"]["Error"];
      500: components["responses"]["Error"];
      503: components["responses"]["Error"];
    };
  };
  listAutomations: {
    parameters: {
      query?: {
        cursor?: components["parameters"]["ResourceCursor"];
        limit?: components["parameters"]["Limit"];
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Authorized manual-only Automation definitions ordered by durable update */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ListAutomationsResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  createAutomation: {
    parameters: {
      query?: never;
      header: {
        "Idempotency-Key": components["parameters"]["IdempotencyKey"];
        /** @description Required for Control mutations that do not permit a credential-mode exception. */
        "X-CSRF-Token": components["parameters"]["RequiredCsrfToken"];
      };
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["CreateAutomationRequest"];
      };
    };
    responses: {
      /** @description An idempotently replayed manual-only Automation definition */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["AutomationMutationResponse"];
        };
      };
      /** @description A newly committed manual-only Automation definition */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["AutomationMutationResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      409: components["responses"]["Error"];
      500: components["responses"]["Error"];
      503: components["responses"]["Error"];
    };
  };
  getAutomation: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        automationId: components["parameters"]["AutomationId"];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Authorized redacted manual-only Automation definition */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["GetAutomationResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  runAutomationNow: {
    parameters: {
      query?: never;
      header: {
        "Idempotency-Key": components["parameters"]["IdempotencyKey"];
        /** @description Required for Control mutations that do not permit a credential-mode exception. */
        "X-CSRF-Token": components["parameters"]["RequiredCsrfToken"];
      };
      path: {
        automationId: components["parameters"]["AutomationId"];
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["RunAutomationNowRequest"];
      };
    };
    responses: {
      /** @description An idempotently replayed canonical Automation invocation Run */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["RunAutomationNowResponse"];
        };
      };
      /** @description A canonical Automation invocation Run admitted atomically */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["RunAutomationNowResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      409: components["responses"]["Error"];
      500: components["responses"]["Error"];
      503: components["responses"]["Error"];
    };
  };
  listThreads: {
    parameters: {
      query?: {
        cursor?: components["parameters"]["ResourceCursor"];
        limit?: components["parameters"]["Limit"];
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Threads ordered by most recent durable update */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ListThreadsResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  createThread: {
    parameters: {
      query?: never;
      header: {
        "Idempotency-Key": components["parameters"]["IdempotencyKey"];
        /** @description Required by the identity adapter for cookie-authenticated mutations. */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["CreateThreadRequest"];
      };
    };
    responses: {
      /** @description An idempotently replayed Thread */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ThreadMutationResponse"];
        };
      };
      /** @description A newly committed Thread */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ThreadMutationResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      409: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  getThread: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        threadId: components["parameters"]["ThreadId"];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Thread projection */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["GetThreadResponse"];
        };
      };
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  getThreadTaskChanges: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        threadId: components["parameters"]["ThreadId"];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Revision-bound Thread task change ledger */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ThreadTaskChangeLedgerResponse"];
        };
      };
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  archiveThread: {
    parameters: {
      query?: never;
      header: {
        "Idempotency-Key": components["parameters"]["IdempotencyKey"];
        /** @description Required for Control mutations that do not permit a credential-mode exception. */
        "X-CSRF-Token": components["parameters"]["RequiredCsrfToken"];
      };
      path: {
        threadId: components["parameters"]["ThreadId"];
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["ArchiveThreadRequest"];
      };
    };
    responses: {
      /** @description Committed or idempotently replayed Thread archive */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ThreadMutationResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      409: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  rollbackThread: {
    parameters: {
      query?: never;
      header: {
        "Idempotency-Key": components["parameters"]["IdempotencyKey"];
        /** @description Required for Control mutations that do not permit a credential-mode exception. */
        "X-CSRF-Token": components["parameters"]["RequiredCsrfToken"];
      };
      path: {
        threadId: components["parameters"]["ThreadId"];
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["RollbackThreadRequest"];
      };
    };
    responses: {
      /** @description An idempotently replayed append-only Thread rollback */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ThreadMutationResponse"];
        };
      };
      /** @description An append-only Thread rollback committed atomically */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ThreadMutationResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      409: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  unarchiveThread: {
    parameters: {
      query?: never;
      header: {
        "Idempotency-Key": components["parameters"]["IdempotencyKey"];
        /** @description Required for Control mutations that do not permit a credential-mode exception. */
        "X-CSRF-Token": components["parameters"]["RequiredCsrfToken"];
      };
      path: {
        threadId: components["parameters"]["ThreadId"];
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["UnarchiveThreadRequest"];
      };
    };
    responses: {
      /** @description Committed or idempotently replayed Thread restore */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ThreadMutationResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      409: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  renameThread: {
    parameters: {
      query?: never;
      header: {
        "Idempotency-Key": components["parameters"]["IdempotencyKey"];
        /** @description Required for Control mutations that do not permit a credential-mode exception. */
        "X-CSRF-Token": components["parameters"]["RequiredCsrfToken"];
      };
      path: {
        threadId: components["parameters"]["ThreadId"];
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["RenameThreadRequest"];
      };
    };
    responses: {
      /** @description Committed or idempotently replayed Thread rename */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ThreadMutationResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      409: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  deleteThread: {
    parameters: {
      query?: never;
      header: {
        "Idempotency-Key": components["parameters"]["IdempotencyKey"];
        /** @description Required for Control mutations that do not permit a credential-mode exception. */
        "X-CSRF-Token": components["parameters"]["RequiredCsrfToken"];
      };
      path: {
        threadId: components["parameters"]["ThreadId"];
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["DeleteThreadRequest"];
      };
    };
    responses: {
      /** @description Committed or idempotently replayed terminal Thread tombstone */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ThreadMutationResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      409: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  streamThreadEvents: {
    parameters: {
      query?: {
        /** @description Standard view hides deleted content and emits only its tombstone event; audit requires thread:audit:read and preserves durable history. */
        view?: components["parameters"]["ThreadHistoryView"];
      };
      header?: {
        /** @description Decimal durable event sequence last processed by the client; each event resource has an independent sequence. */
        "Last-Event-ID"?: components["parameters"]["LastEventId"];
      };
      path: {
        threadId: components["parameters"]["ThreadId"];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Durable Thread event catch-up followed by periodic database polling. SSE id is the decimal Thread event sequence. */
      200: {
        headers: {
          "Cache-Control"?: "no-cache";
          [name: string]: unknown;
        };
        content: {
          "text/event-stream": string;
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  getThreadGoal: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        threadId: components["parameters"]["ThreadId"];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Current persistent Thread Goal, or null when absent */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["GetThreadGoalResponse"];
        };
      };
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  setThreadGoal: {
    parameters: {
      query?: never;
      header: {
        "Idempotency-Key": components["parameters"]["IdempotencyKey"];
        /** @description Required for Control mutations that do not permit a credential-mode exception. */
        "X-CSRF-Token": components["parameters"]["RequiredCsrfToken"];
      };
      path: {
        threadId: components["parameters"]["ThreadId"];
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["SetThreadGoalRequest"];
      };
    };
    responses: {
      /** @description An idempotently replayed Thread Goal mutation */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ThreadGoalMutationResponse"];
        };
      };
      /** @description A newly committed Thread Goal mutation */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ThreadGoalMutationResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      409: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  clearThreadGoal: {
    parameters: {
      query?: never;
      header: {
        "Idempotency-Key": components["parameters"]["IdempotencyKey"];
        /** @description Required for Control mutations that do not permit a credential-mode exception. */
        "X-CSRF-Token": components["parameters"]["RequiredCsrfToken"];
      };
      path: {
        threadId: components["parameters"]["ThreadId"];
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["ClearThreadGoalRequest"];
      };
    };
    responses: {
      /** @description Committed or idempotently replayed Thread Goal clear */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ThreadGoalMutationResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      409: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  setThreadGoalWithExecutionIntentV1: {
    parameters: {
      query?: never;
      header: {
        "Idempotency-Key": components["parameters"]["IdempotencyKey"];
        /** @description Required for Control mutations that do not permit a credential-mode exception. */
        "X-CSRF-Token": components["parameters"]["RequiredCsrfToken"];
      };
      path: {
        threadId: components["parameters"]["ThreadId"];
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["SetThreadGoalRequest"];
      };
    };
    responses: {
      /** @description An idempotently replayed execution-intent v1 Goal mutation */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ThreadGoalMutationResponse"];
        };
      };
      /** @description A newly committed execution-intent v1 Goal mutation */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ThreadGoalMutationResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      409: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  streamThreadGoalEvents: {
    parameters: {
      query?: never;
      header?: {
        /** @description Decimal durable event sequence last processed by the client; each event resource has an independent sequence. */
        "Last-Event-ID"?: components["parameters"]["LastEventId"];
      };
      path: {
        threadId: components["parameters"]["ThreadId"];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Durable catch-up followed by periodic database polling. SSE id is the decimal Thread Goal event sequence; clear events do not terminate the stream. */
      200: {
        headers: {
          "Cache-Control"?: "no-cache";
          [name: string]: unknown;
        };
        content: {
          "text/event-stream": string;
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  listThreadMessages: {
    parameters: {
      query?: {
        cursor?: components["parameters"]["Cursor"];
        limit?: components["parameters"]["Limit"];
        /** @description Standard view hides deleted content and emits only its tombstone event; audit requires thread:audit:read and preserves durable history. */
        view?: components["parameters"]["ThreadHistoryView"];
      };
      header?: never;
      path: {
        threadId: components["parameters"]["ThreadId"];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Ordered Thread messages */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ListThreadMessagesResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  appendThreadMessage: {
    parameters: {
      query?: never;
      header: {
        "Idempotency-Key": components["parameters"]["IdempotencyKey"];
        /** @description Required by the identity adapter for cookie-authenticated mutations. */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path: {
        threadId: components["parameters"]["ThreadId"];
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["AppendThreadMessageRequest"];
      };
    };
    responses: {
      /** @description An idempotently replayed Message append */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["AppendThreadMessageResponse"];
        };
      };
      /** @description A newly committed Message */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["AppendThreadMessageResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      409: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  forkThread: {
    parameters: {
      query?: never;
      header: {
        "Idempotency-Key": components["parameters"]["IdempotencyKey"];
        /** @description Required by the identity adapter for cookie-authenticated mutations. */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path: {
        threadId: components["parameters"]["ThreadId"];
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["ForkThreadRequest"];
      };
    };
    responses: {
      /** @description An idempotently replayed Thread fork */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ThreadMutationResponse"];
        };
      };
      /** @description A newly committed Thread fork */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ThreadMutationResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      409: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  startTurn: {
    parameters: {
      query?: never;
      header: {
        "Idempotency-Key": components["parameters"]["IdempotencyKey"];
        /** @description Required by the identity adapter for cookie-authenticated mutations. */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path: {
        threadId: components["parameters"]["ThreadId"];
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["StartTurnRequest"];
      };
    };
    responses: {
      /** @description An idempotently replayed atomic Turn start */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["StartTurnResponse"];
        };
      };
      /** @description A user Message and Run committed atomically */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["StartTurnResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      409: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  startTurnWithExecutionIntentV1: {
    parameters: {
      query?: never;
      header: {
        "Idempotency-Key": components["parameters"]["IdempotencyKey"];
        /** @description Required by the identity adapter for cookie-authenticated mutations. */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path: {
        threadId: components["parameters"]["ThreadId"];
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["StartTurnRequest"];
      };
    };
    responses: {
      /** @description An idempotently replayed execution-intent Turn start with acceptedExecutionIntent */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["StartTurnResponse"];
        };
      };
      /** @description An execution-intent user Message and Run committed atomically with acceptedExecutionIntent */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["StartTurnResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      409: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  compactThread: {
    parameters: {
      query?: never;
      header: {
        "Idempotency-Key": components["parameters"]["IdempotencyKey"];
        /** @description Required by the identity adapter for cookie-authenticated mutations. */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path: {
        threadId: components["parameters"]["ThreadId"];
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["CompactThreadRequest"];
      };
    };
    responses: {
      /** @description An idempotently replayed manual context compaction Run */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["RunMutationResponse"];
        };
      };
      /** @description A manual context compaction maintenance Run admitted atomically */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["RunMutationResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      409: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  listThreadRuns: {
    parameters: {
      query?: {
        cursor?: components["parameters"]["ResourceCursor"];
        limit?: components["parameters"]["Limit"];
      };
      header?: never;
      path: {
        threadId: components["parameters"]["ThreadId"];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Runs for a Thread ordered by most recent durable update */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ListThreadRunsResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  listOffices: {
    parameters: {
      query?: {
        cursor?: components["parameters"]["ResourceCursor"];
        limit?: components["parameters"]["Limit"];
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Office definitions */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ListOfficesResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  createOffice: {
    parameters: {
      query?: never;
      header: {
        "Idempotency-Key": components["parameters"]["IdempotencyKey"];
        /** @description Required by the identity adapter for cookie-authenticated mutations. */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["CreateOfficeRequest"];
      };
    };
    responses: {
      /** @description Replayed Office definition */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["OfficeMutationResponse"];
        };
      };
      /** @description Created Office definition */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["OfficeMutationResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      409: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  getOffice: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        officeVersionId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Office definition */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["GetOfficeResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  authorizeOfficeRun: {
    parameters: {
      query?: never;
      header?: {
        /** @description Required by the identity adapter for cookie-authenticated mutations. */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path: {
        officeVersionId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["StartOfficeRunRequest"];
      };
    };
    responses: {
      /** @description Authorized immutable Office execution target */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["AuthorizeOfficeRunResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  createRun: {
    parameters: {
      query?: never;
      header: {
        "Idempotency-Key": components["parameters"]["IdempotencyKey"];
        /** @description Required by the identity adapter for cookie-authenticated mutations. */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["CreateRunRequest"];
      };
    };
    responses: {
      /** @description An idempotently replayed Run */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["RunMutationResponse"];
        };
      };
      /** @description A newly committed Run */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["RunMutationResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      409: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  startWorkflowRun: {
    parameters: {
      query?: never;
      header: {
        "Idempotency-Key": components["parameters"]["IdempotencyKey"];
        /** @description Required by the identity adapter for cookie-authenticated mutations. */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["StartWorkflowRunRequest"];
      };
    };
    responses: {
      /** @description The exact idempotently replayed Workflow Run */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["RunMutationResponse"];
        };
      };
      /** @description A Workflow Run admitted with immutable version provenance and durable execution work */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["RunMutationResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      409: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  getRun: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        runId: components["parameters"]["RunId"];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Run projection */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["GetRunResponse"];
        };
      };
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  getRunPlan: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        runId: components["parameters"]["RunId"];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Authoritative Run execution-plan snapshot and its global Run event watermark */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["GetRunPlanResponse"];
        };
      };
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  cancelRun: {
    parameters: {
      query?: never;
      header: {
        "Idempotency-Key": components["parameters"]["IdempotencyKey"];
        /** @description Required by the identity adapter for cookie-authenticated mutations. */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path: {
        runId: components["parameters"]["RunId"];
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["CancelRunRequest"];
      };
    };
    responses: {
      /** @description Committed or replayed cancellation request */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["RunMutationResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      409: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  streamRunEvents: {
    parameters: {
      query?: {
        /** @description Client view hides bounded transient retry noise; audit preserves every durable event; transcript adds bounded Tool input and output previews for transcript rendering. */
        view?: components["parameters"]["RunEventView"];
        /** @description Opt-in Run event extension. run-plan-v1 enables bounded run.plan.updated snapshots; without it those durable events remain hidden while the server cursor still advances. */
        extensions?: components["parameters"]["RunEventExtensions"];
      };
      header?: {
        /** @description Decimal durable event sequence last processed by the client; each event resource has an independent sequence. */
        "Last-Event-ID"?: components["parameters"]["LastEventId"];
      };
      path: {
        runId: components["parameters"]["RunId"];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Durable catch-up followed by a live event stream. SSE id is the decimal Run sequence. */
      200: {
        headers: {
          "Cache-Control"?: "no-cache";
          [name: string]: unknown;
        };
        content: {
          "text/event-stream": string;
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  getToolApproval: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        approvalId: components["parameters"]["ApprovalId"];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Tenant-scoped Tool approval */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["GetToolApprovalResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  decideToolApproval: {
    parameters: {
      query?: never;
      header: {
        "Idempotency-Key": components["parameters"]["IdempotencyKey"];
        /** @description Required by the identity adapter for cookie-authenticated mutations. */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path: {
        approvalId: components["parameters"]["ApprovalId"];
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["DecideToolApprovalRequest"];
      };
    };
    responses: {
      /** @description Committed or replayed Tool approval decision */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ToolApprovalMutationResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      409: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  listWorkspaceListOperations: {
    parameters: {
      query?: {
        /** @description Exclusive raw UTF-8 byte lexicographic recovery cursor. Omission is equivalent to null. */
        afterExecutionId?: components["parameters"]["WorkspaceAfterExecutionId"];
        limit?: components["parameters"]["WorkspaceOperationLimit"];
      };
      header?: never;
      path: {
        threadId: components["parameters"]["ThreadId"];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description A bounded stable recovery page of Workspace operations */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ListWorkspaceOperationsResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  createWorkspaceListOperation: {
    parameters: {
      query?: never;
      header: {
        "Idempotency-Key": components["parameters"]["IdempotencyKey"];
        /** @description Required for Control mutations that do not permit a credential-mode exception. */
        "X-CSRF-Token": components["parameters"]["RequiredCsrfToken"];
      };
      path: {
        threadId: components["parameters"]["ThreadId"];
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["CreateWorkspaceListRequest"];
      };
    };
    responses: {
      /** @description An idempotently replayed Workspace operation mutation */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkspaceOperationMutationResponse"];
        };
      };
      /** @description A newly committed Workspace operation mutation */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkspaceOperationMutationResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      409: components["responses"]["Error"];
      500: components["responses"]["Error"];
      503: components["responses"]["Error"];
    };
  };
  getWorkspaceListOperation: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        threadId: components["parameters"]["ThreadId"];
        executionId: components["parameters"]["WorkspaceExecutionId"];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Atomic Workspace operation snapshot */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["GetWorkspaceOperationResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  reconcileWorkspaceListOperation: {
    parameters: {
      query?: never;
      header: {
        "Idempotency-Key": components["parameters"]["IdempotencyKey"];
        /** @description Required for Control mutations that do not permit a credential-mode exception. */
        "X-CSRF-Token": components["parameters"]["RequiredCsrfToken"];
      };
      path: {
        threadId: components["parameters"]["ThreadId"];
        executionId: components["parameters"]["WorkspaceExecutionId"];
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["WorkspaceOperationActionRequest"];
      };
    };
    responses: {
      /** @description A committed or idempotently replayed reconciliation mutation */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkspaceOperationMutationResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      409: components["responses"]["Error"];
      500: components["responses"]["Error"];
      503: components["responses"]["Error"];
    };
  };
  cancelWorkspaceListOperation: {
    parameters: {
      query?: never;
      header: {
        "Idempotency-Key": components["parameters"]["IdempotencyKey"];
        /** @description Required for Control mutations that do not permit a credential-mode exception. */
        "X-CSRF-Token": components["parameters"]["RequiredCsrfToken"];
      };
      path: {
        threadId: components["parameters"]["ThreadId"];
        executionId: components["parameters"]["WorkspaceExecutionId"];
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["WorkspaceOperationActionRequest"];
      };
    };
    responses: {
      /** @description A committed or idempotently replayed cancellation mutation. A racing terminal winner remains authoritative. */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkspaceOperationMutationResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      409: components["responses"]["Error"];
      500: components["responses"]["Error"];
      503: components["responses"]["Error"];
    };
  };
  streamWorkspaceListOperationEvents: {
    parameters: {
      query?: never;
      header?: {
        /** @description Decimal durable event sequence last processed by the client; each event resource has an independent sequence. */
        "Last-Event-ID"?: components["parameters"]["LastEventId"];
      };
      path: {
        threadId: components["parameters"]["ThreadId"];
        executionId: components["parameters"]["WorkspaceExecutionId"];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Durable catch-up for one Workspace execution. SSE id is the decimal operation revision. The server may close this execution-scoped stream after replaying or emitting a terminal replacement; clients may reconnect with Last-Event-ID without losing a committed revision. */
      200: {
        headers: {
          "Cache-Control"?: "no-cache";
          [name: string]: unknown;
        };
        content: {
          "text/event-stream": string;
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  listWorkflowVersions: {
    parameters: {
      query: {
        workflowId: string;
        cursor?: string;
        limit?: components["parameters"]["Limit"];
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Tenant- and workflow-scoped immutable WorkflowVersions */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ListWorkflowVersionsResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  publishWorkflowVersion: {
    parameters: {
      query?: never;
      header?: {
        /** @description Required by the identity adapter for cookie-authenticated mutations. */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["PublishWorkflowVersionRequest"];
      };
    };
    responses: {
      /** @description An existing identical immutable WorkflowVersion */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkflowVersionMutationResponse"];
        };
      };
      /** @description A newly published immutable WorkflowVersion */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkflowVersionMutationResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      409: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  getWorkflowVersion: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workflowVersionId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Tenant-scoped immutable WorkflowVersion */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["GetWorkflowVersionResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  listAgentVersions: {
    parameters: {
      query?: {
        cursor?: components["parameters"]["AgentVersionCursor"];
        limit?: components["parameters"]["Limit"];
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Tenant-scoped immutable AgentVersions */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ListAgentVersionsResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  publishAgentVersion: {
    parameters: {
      query?: never;
      header?: {
        /** @description Required by the identity adapter for cookie-authenticated mutations. */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["PublishAgentVersionRequest"];
      };
    };
    responses: {
      /** @description An existing identical immutable AgentVersion */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["AgentVersionMutationResponse"];
        };
      };
      /** @description A newly published immutable AgentVersion */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["AgentVersionMutationResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      409: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  getActiveAgentVersionCatalog: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Authorized runnable AgentVersions from the active immutable release */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ActiveAgentVersionCatalogResponse"];
        };
      };
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  getAgentVersion: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        agentVersionId: components["parameters"]["AgentVersionId"];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Tenant-scoped immutable AgentVersion */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["GetAgentVersionResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  getArtifact: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        artifactId: components["parameters"]["ArtifactId"];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Authorized immutable Artifact metadata without storage paths or key identifiers */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["GetArtifactResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  downloadArtifactContent: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        artifactId: components["parameters"]["ArtifactId"];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Authorized, authenticated and digest-verified Artifact bytes */
      200: {
        headers: {
          /** @description Quoted immutable content digest. */
          "ETag"?: string;
          "Content-Disposition"?: "attachment; filename=artifact";
          [name: string]: unknown;
        };
        content: {
          "application/octet-stream": string;
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  liveHealth: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Process liveness */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["HealthResponse"];
        };
      };
    };
  };
  readyHealth: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Control API readiness */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["HealthResponse"];
        };
      };
      503: components["responses"]["Error"];
    };
  };
  getThreadMessageWindow: {
    parameters: {
      query?: {
        cursor?: string;
        limit?: number;
      };
      header?: never;
      path: {
        threadId: components["parameters"]["ThreadId"];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description One consistent message window; body size may reduce the requested number of rows. */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["GetThreadMessageWindowResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      409: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  getThreadCatalog: {
    parameters: {
      query?: {
        cursor?: string;
        limit?: number;
        status?: "active" | "archived";
        search?: string;
        excludeForks?: boolean;
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Bounded catalog with scanned candidate navigation */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ThreadCatalogResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  getThreadActiveRun: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        threadId: components["parameters"]["ThreadId"];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Current Run or null; multiple non-terminal Runs fail closed. */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["GetThreadActiveRunResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  getThreadTranscriptWindow: {
    parameters: {
      query?: {
        cursor?: string;
        limit?: number;
      };
      header?: never;
      path: {
        threadId: components["parameters"]["ThreadId"];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description One consistent message window; body size may reduce the requested number of rows. */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["GetThreadTranscriptWindowResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      409: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  getOfficeThread: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        officeVersionId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Authoritative Office thread association, or unbound */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["OfficeThreadResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      409: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  createOfficeThread: {
    parameters: {
      query?: never;
      header: {
        "Idempotency-Key": components["parameters"]["IdempotencyKey"];
        /** @description Required by the identity adapter for cookie-authenticated mutations. */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path: {
        officeVersionId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["CreateOfficeThreadRequest"];
      };
    };
    responses: {
      /** @description Existing Office thread */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["OfficeThreadMutationResponse"];
        };
      };
      /** @description Atomically created and associated Office thread */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["OfficeThreadMutationResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      409: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  bindOfficeThread: {
    parameters: {
      query?: never;
      header?: {
        /** @description Required by the identity adapter for cookie-authenticated mutations. */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path: {
        officeVersionId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["BindOfficeThreadRequest"];
      };
    };
    responses: {
      /** @description Bound or already associated Office thread */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["OfficeThreadMutationResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      409: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  getExtensionConfiguration: {
    parameters: {
      query?: {
        /** @description Omit for the latest saved revision. Saving does not activate it. */
        revision?: number;
      };
      header?: never;
      path: {
        pluginId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Extension configuration state */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["GetExtensionConfigurationResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      409: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  saveExtensionConfiguration: {
    parameters: {
      query?: never;
      header: {
        "Idempotency-Key": string;
        /** @description Required by the identity adapter for cookie-authenticated mutations. */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path: {
        pluginId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["SaveExtensionConfigurationRequest"];
      };
    };
    responses: {
      /** @description Extension configuration state */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ExtensionConfigurationMutationResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      409: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  getExtensionActivation: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        pluginId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Extension configuration state */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["GetExtensionActivationResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      409: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  setExtensionActivation: {
    parameters: {
      query?: never;
      header: {
        "Idempotency-Key": string;
        /** @description Required by the identity adapter for cookie-authenticated mutations. */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path: {
        pluginId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["SetExtensionActivationRequest"];
      };
    };
    responses: {
      /** @description Extension configuration state */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ExtensionActivationMutationResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      409: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  createExtensionTask: {
    parameters: {
      query?: never;
      header: {
        "Idempotency-Key": string;
        /** @description Required by the identity adapter for cookie-authenticated mutations. */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path: {
        pluginId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["CreateExtensionTaskRequest"];
      };
    };
    responses: {
      /** @description Committed or idempotently replayed task */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ExtensionTaskMutationResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      409: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  listExtensions: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Authorized bounded extension metadata */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ExtensionCatalogResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      409: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  getExtensionRuntime: {
    parameters: {
      query: {
        agentVersionId: string;
        configurationRevision: number;
      };
      header?: never;
      path: {
        pluginId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Authorized bounded extension metadata */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ExtensionRuntimeResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      409: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  getExtensionTask: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        pluginId: string;
        runId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Authorized bounded extension metadata */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["GetExtensionTaskResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      409: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  listPluginPackages: {
    parameters: {
      query?: {
        pluginId?: components["schemas"]["PluginNamespaceId"];
        afterPackageDigest?: components["schemas"]["PluginPackageDigest"];
        /** @description Canonical decimal query value, default 20, maximum 50. Duplicated or unknown query fields are rejected. */
        limit?: number;
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Bounded authorized response; at most 131072 encoded bytes. */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["PluginPackageListResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      409: components["responses"]["Error"];
      413: components["responses"]["Error"];
      500: components["responses"]["Error"];
      503: components["responses"]["Error"];
    };
  };
  getPluginPackage: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        packageDigest: components["schemas"]["PluginPackageDigest"];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Bounded authorized response; at most 131072 encoded bytes. */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["GetPluginPackageResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      409: components["responses"]["Error"];
      413: components["responses"]["Error"];
      500: components["responses"]["Error"];
      503: components["responses"]["Error"];
    };
  };
  listPluginSelections: {
    parameters: {
      query?: {
        afterPluginId?: components["schemas"]["PluginNamespaceId"];
        /** @description Canonical decimal query value, default 20, maximum 50. Duplicated or unknown query fields are rejected. */
        limit?: number;
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Bounded authorized response; at most 131072 encoded bytes. */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["PluginSelectionListResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      409: components["responses"]["Error"];
      413: components["responses"]["Error"];
      500: components["responses"]["Error"];
      503: components["responses"]["Error"];
    };
  };
  getPluginSelection: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        pluginId: components["schemas"]["PluginNamespaceId"];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Bounded authorized response; at most 131072 encoded bytes. */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["GetPluginSelectionResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      409: components["responses"]["Error"];
      413: components["responses"]["Error"];
      500: components["responses"]["Error"];
      503: components["responses"]["Error"];
    };
  };
  selectPluginPackage: {
    parameters: {
      query?: never;
      header: {
        /** @description Required host-validated idempotency key; never part of the JSON body. */
        "Idempotency-Key": components["schemas"]["PluginIdempotencyKey"];
        /** @description Required by the identity adapter for cookie-authenticated mutations. */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path: {
        pluginId: components["schemas"]["PluginNamespaceId"];
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["SelectPluginPackageRequest"];
      };
    };
    responses: {
      /** @description Bounded authorized response; at most 131072 encoded bytes. */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["PluginSelectionResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      409: components["responses"]["Error"];
      413: components["responses"]["Error"];
      500: components["responses"]["Error"];
      503: components["responses"]["Error"];
    };
  };
  installPluginPackage: {
    parameters: {
      query?: never;
      header: {
        /** @description Required host-validated idempotency key; never part of the JSON body. */
        "Idempotency-Key": components["schemas"]["PluginIdempotencyKey"];
        /** @description Required by the identity adapter for cookie-authenticated mutations. */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["InstallPluginPackageRequest"];
      };
    };
    responses: {
      /** @description Bounded authorized response; at most 131072 encoded bytes. */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["PluginInstallationResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      409: components["responses"]["Error"];
      413: components["responses"]["Error"];
      500: components["responses"]["Error"];
      503: components["responses"]["Error"];
    };
  };
  listPluginUiCatalog: {
    parameters: {
      query?: {
        afterPluginId?: components["schemas"]["PluginNamespaceId"];
        /** @description Canonical decimal query value, default 20, maximum 50. Duplicated or unknown query fields are rejected. */
        limit?: number;
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Bounded authorized response; at most 16777216 encoded bytes. */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["PluginUiCatalogResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      409: components["responses"]["Error"];
      413: components["responses"]["Error"];
      500: components["responses"]["Error"];
      503: components["responses"]["Error"];
    };
  };
  openPluginUiMount: {
    parameters: {
      query?: never;
      header?: {
        /** @description Required by the identity adapter for cookie-authenticated mutations. */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["OpenPluginUiMountRequest"];
      };
    };
    responses: {
      /** @description Bounded authorized response; at most 524288 encoded bytes. */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["PluginUiLease"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      409: components["responses"]["Error"];
      413: components["responses"]["Error"];
      500: components["responses"]["Error"];
      503: components["responses"]["Error"];
    };
  };
  validatePluginUiMount: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        mountRef: components["schemas"]["PluginMountRef"];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Bounded authorized response; at most 524288 encoded bytes. */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["PluginUiLease"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      409: components["responses"]["Error"];
      413: components["responses"]["Error"];
      500: components["responses"]["Error"];
      503: components["responses"]["Error"];
    };
  };
  closePluginUiMount: {
    parameters: {
      query?: never;
      header?: {
        /** @description Required by the identity adapter for cookie-authenticated mutations. */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path: {
        mountRef: components["schemas"]["PluginMountRef"];
      };
      cookie?: never;
    };
    requestBody?: {
      content: {
        "application/json": null | Record<string, never>;
      };
    };
    responses: {
      /** @description Bounded authorized response; at most 131072 encoded bytes. */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ClosePluginUiMountResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      409: components["responses"]["Error"];
      413: components["responses"]["Error"];
      500: components["responses"]["Error"];
      503: components["responses"]["Error"];
    };
  };
  invokePluginUiAction: {
    parameters: {
      query?: never;
      header?: {
        /** @description Required by the identity adapter for cookie-authenticated mutations. */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path: {
        mountRef: components["schemas"]["PluginMountRef"];
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["InvokePluginUiActionRequest"];
      };
    };
    responses: {
      /** @description Bounded authorized response; at most 131072 encoded bytes. */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["InvokePluginUiActionResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      409: components["responses"]["Error"];
      413: components["responses"]["Error"];
      500: components["responses"]["Error"];
      503: components["responses"]["Error"];
    };
  };
  getPluginUiAsset: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        mountRef: components["schemas"]["PluginMountRef"];
        /** @description Inventory-relative wildcard path; encode each segment independently. No query. May contain nested segments. */
        assetPath: components["schemas"]["PluginAssetPath"];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Authorized original inventory bytes, at most 32 MiB. Current session, enabled selection, lease and publication policy are checked; never a public static install directory. */
      200: {
        headers: {
          "Cache-Control"?: "no-store";
          "X-Content-Type-Options"?: "nosniff";
          "Cross-Origin-Resource-Policy"?: "same-origin";
          [name: string]: unknown;
        };
        content: {
          "application/octet-stream": string;
          "text/javascript": string;
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      409: components["responses"]["Error"];
      413: components["responses"]["Error"];
      500: components["responses"]["Error"];
      503: components["responses"]["Error"];
    };
  };
  listPluginSources: {
    parameters: {
      query?: {
        afterSourceId?: components["schemas"]["PluginOpaqueId"];
        /** @description Canonical decimal query value, default 50. Duplicated or unknown query fields are rejected. */
        limit?: number;
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Authorized approved-source metadata only; no source directory or installation permission. At most 131072 encoded bytes. */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["PluginSourceListResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      409: components["responses"]["Error"];
      413: components["responses"]["Error"];
      500: components["responses"]["Error"];
      503: components["responses"]["Error"];
    };
  };
  listCreativeProjects: {
    parameters: {
      query?: {
        state?: "active" | "archived" | "all";
        cursor?: string;
        limit?: number;
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Bounded authorized project data (maximum 60 KiB) */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["CreativeProjectListResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  createCreativeProject: {
    parameters: {
      query?: never;
      header: {
        /** @description One non-empty key of at most 128 UTF-16 units, with no surrounding whitespace, control characters or commas. Comma-separated values are rejected because HTTP adapters may merge repeated headers. Same actor/command/key/input replays the original result; the same key with changed input conflicts. */
        "Idempotency-Key": components["parameters"]["CreativeProjectIdempotencyKey"];
        /** @description Required for Control mutations that do not permit a credential-mode exception. */
        "X-CSRF-Token": components["parameters"]["RequiredCsrfToken"];
      };
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["CreateCreativeProjectRequest"];
      };
    };
    responses: {
      /** @description Bounded authorized project data (maximum 60 KiB) */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["CreativeProjectBriefMutationResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      409: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  getCreativeProject: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        projectId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Bounded authorized project data (maximum 60 KiB) */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["GetCreativeProjectResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  renameCreativeProject: {
    parameters: {
      query?: never;
      header: {
        /** @description One non-empty key of at most 128 UTF-16 units, with no surrounding whitespace, control characters or commas. Comma-separated values are rejected because HTTP adapters may merge repeated headers. Same actor/command/key/input replays the original result; the same key with changed input conflicts. */
        "Idempotency-Key": components["parameters"]["CreativeProjectIdempotencyKey"];
        /** @description Required for Control mutations that do not permit a credential-mode exception. */
        "X-CSRF-Token": components["parameters"]["RequiredCsrfToken"];
      };
      path: {
        projectId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["RenameCreativeProjectRequest"];
      };
    };
    responses: {
      /** @description Bounded authorized project data (maximum 60 KiB) */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["CreativeProjectMetadataMutationResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      409: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  setCreativeProjectState: {
    parameters: {
      query?: never;
      header: {
        /** @description One non-empty key of at most 128 UTF-16 units, with no surrounding whitespace, control characters or commas. Comma-separated values are rejected because HTTP adapters may merge repeated headers. Same actor/command/key/input replays the original result; the same key with changed input conflicts. */
        "Idempotency-Key": components["parameters"]["CreativeProjectIdempotencyKey"];
        /** @description Required for Control mutations that do not permit a credential-mode exception. */
        "X-CSRF-Token": components["parameters"]["RequiredCsrfToken"];
      };
      path: {
        projectId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["SetCreativeProjectStateRequest"];
      };
    };
    responses: {
      /** @description Bounded authorized project data (maximum 60 KiB) */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["CreativeProjectMetadataMutationResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      409: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  listProjectBriefs: {
    parameters: {
      query?: {
        afterBriefRevision?: number;
        limit?: number;
      };
      header?: never;
      path: {
        projectId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Bounded authorized project data (maximum 60 KiB) */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ProjectBriefListResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  appendProjectBrief: {
    parameters: {
      query?: never;
      header: {
        /** @description One non-empty key of at most 128 UTF-16 units, with no surrounding whitespace, control characters or commas. Comma-separated values are rejected because HTTP adapters may merge repeated headers. Same actor/command/key/input replays the original result; the same key with changed input conflicts. */
        "Idempotency-Key": components["parameters"]["CreativeProjectIdempotencyKey"];
        /** @description Required for Control mutations that do not permit a credential-mode exception. */
        "X-CSRF-Token": components["parameters"]["RequiredCsrfToken"];
      };
      path: {
        projectId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["AppendProjectBriefRequest"];
      };
    };
    responses: {
      /** @description Bounded authorized project data (maximum 60 KiB) */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["CreativeProjectBriefMutationResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      409: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  getProjectBrief: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        projectId: string;
        briefRevision: number;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Bounded authorized project data (maximum 60 KiB) */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["GetProjectBriefResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  listConceptAssets: {
    parameters: {
      query?: {
        afterAssetId?: string;
        limit?: number;
      };
      header?: never;
      path: {
        projectId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Bounded authorized project data (maximum 60 KiB) */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ConceptAssetListResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  createConceptAsset: {
    parameters: {
      query?: never;
      header: {
        /** @description One non-empty key of at most 128 UTF-16 units, with no surrounding whitespace, control characters or commas. Comma-separated values are rejected because HTTP adapters may merge repeated headers. Same actor/command/key/input replays the original result; the same key with changed input conflicts. */
        "Idempotency-Key": components["parameters"]["CreativeProjectIdempotencyKey"];
        /** @description Required for Control mutations that do not permit a credential-mode exception. */
        "X-CSRF-Token": components["parameters"]["RequiredCsrfToken"];
      };
      path: {
        projectId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["CreateConceptAssetRequest"];
      };
    };
    responses: {
      /** @description Bounded authorized project data (maximum 60 KiB) */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["CreativeProjectConceptMutationResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      409: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  getConceptAsset: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        projectId: string;
        assetId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Bounded authorized project data (maximum 60 KiB) */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["GetConceptAssetResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  listConceptRevisions: {
    parameters: {
      query?: {
        afterAssetRevision?: number;
        limit?: number;
      };
      header?: never;
      path: {
        projectId: string;
        assetId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Bounded authorized project data (maximum 60 KiB) */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ConceptRevisionListResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  appendConceptAssetRevision: {
    parameters: {
      query?: never;
      header: {
        /** @description One non-empty key of at most 128 UTF-16 units, with no surrounding whitespace, control characters or commas. Comma-separated values are rejected because HTTP adapters may merge repeated headers. Same actor/command/key/input replays the original result; the same key with changed input conflicts. */
        "Idempotency-Key": components["parameters"]["CreativeProjectIdempotencyKey"];
        /** @description Required for Control mutations that do not permit a credential-mode exception. */
        "X-CSRF-Token": components["parameters"]["RequiredCsrfToken"];
      };
      path: {
        projectId: string;
        assetId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["AppendConceptAssetRevisionRequest"];
      };
    };
    responses: {
      /** @description Bounded authorized project data (maximum 60 KiB) */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["CreativeProjectConceptMutationResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      409: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  getConceptRevision: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        projectId: string;
        assetId: string;
        assetRevision: number;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Bounded authorized project data (maximum 60 KiB) */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["GetConceptRevisionResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  getConceptGeneration: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        projectId: string;
        assetId: string;
        assetRevision: number;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Bounded authorized project data (maximum 60 KiB) */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["GetConceptGenerationResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  getConceptSelection: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        projectId: string;
        assetId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Bounded selection projection (maximum 24 KiB) */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["GetConceptSelectionResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      409: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  selectConceptImage: {
    parameters: {
      query?: never;
      header: {
        /** @description One non-empty key of at most 128 UTF-16 units, with no surrounding whitespace, control characters or commas. Comma-separated values are rejected because HTTP adapters may merge repeated headers. Same actor/command/key/input replays the original result; the same key with changed input conflicts. */
        "Idempotency-Key": components["parameters"]["CreativeProjectIdempotencyKey"];
      };
      path: {
        projectId: string;
        assetId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["SelectConceptImageRequest"];
      };
    };
    responses: {
      /** @description Bounded selection projection (maximum 24 KiB) */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["SelectConceptImageResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      409: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  renewPluginUiMount: {
    parameters: {
      query?: never;
      header?: {
        /** @description Required by the identity adapter for cookie-authenticated mutations. */
        "X-CSRF-Token"?: components["parameters"]["CsrfToken"];
      };
      path: {
        mountRef: components["schemas"]["PluginMountRef"];
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["RenewPluginUiMountRequest"];
      };
    };
    responses: {
      /** @description Bounded authorized response; at most 524288 encoded bytes. */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["PluginUiLease"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      409: components["responses"]["Error"];
      413: components["responses"]["Error"];
      500: components["responses"]["Error"];
      503: components["responses"]["Error"];
    };
  };
  listProjectTextArtifacts: {
    parameters: {
      query?: {
        afterArtifactId?: string;
        limit?: number;
      };
      header?: never;
      path: {
        projectId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Bounded authorized project text data */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ProjectTextArtifactListResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  getProjectOutline: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        projectId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Bounded authorized project text data */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["GetProjectTextArtifactResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  saveProjectOutlineCandidate: {
    parameters: {
      query?: never;
      header: {
        /** @description One non-empty key of at most 128 UTF-16 units, with no surrounding whitespace, control characters or commas. Comma-separated values are rejected because HTTP adapters may merge repeated headers. Same actor/command/key/input replays the original result; the same key with changed input conflicts. */
        "Idempotency-Key": components["parameters"]["ProjectTextIdempotencyKey"];
        /** @description Required for Control mutations that do not permit a credential-mode exception. */
        "X-CSRF-Token": components["parameters"]["RequiredCsrfToken"];
      };
      path: {
        projectId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["SaveProjectOutlineCandidateRequest"];
      };
    };
    responses: {
      /** @description Bounded authorized project text data */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ProjectTextMutationResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      409: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  getProjectScript: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        projectId: string;
        episodeId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Bounded authorized project text data */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["GetProjectTextArtifactResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  saveProjectScriptCandidate: {
    parameters: {
      query?: never;
      header: {
        /** @description One non-empty key of at most 128 UTF-16 units, with no surrounding whitespace, control characters or commas. Comma-separated values are rejected because HTTP adapters may merge repeated headers. Same actor/command/key/input replays the original result; the same key with changed input conflicts. */
        "Idempotency-Key": components["parameters"]["ProjectTextIdempotencyKey"];
        /** @description Required for Control mutations that do not permit a credential-mode exception. */
        "X-CSRF-Token": components["parameters"]["RequiredCsrfToken"];
      };
      path: {
        projectId: string;
        episodeId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["SaveProjectScriptCandidateRequest"];
      };
    };
    responses: {
      /** @description Bounded authorized project text data */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ProjectTextMutationResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      409: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  getProjectTextArtifact: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        projectId: string;
        artifactId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Bounded authorized project text data */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["GetProjectTextArtifactResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  listProjectTextRevisions: {
    parameters: {
      query?: {
        afterContentRevision?: number;
        limit?: number;
      };
      header?: never;
      path: {
        projectId: string;
        artifactId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Bounded authorized project text data */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ProjectTextRevisionListResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  getProjectTextRevision: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        projectId: string;
        artifactId: string;
        contentRevision: number;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Bounded authorized project text data */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["GetProjectTextRevisionResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  selectProjectTextRevision: {
    parameters: {
      query?: never;
      header: {
        /** @description One non-empty key of at most 128 UTF-16 units, with no surrounding whitespace, control characters or commas. Comma-separated values are rejected because HTTP adapters may merge repeated headers. Same actor/command/key/input replays the original result; the same key with changed input conflicts. */
        "Idempotency-Key": components["parameters"]["ProjectTextIdempotencyKey"];
        /** @description Required for Control mutations that do not permit a credential-mode exception. */
        "X-CSRF-Token": components["parameters"]["RequiredCsrfToken"];
      };
      path: {
        projectId: string;
        artifactId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["SelectProjectTextRevisionRequest"];
      };
    };
    responses: {
      /** @description Bounded authorized project text data */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ProjectTextMutationResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      409: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  setProjectTextArtifactLocked: {
    parameters: {
      query?: never;
      header: {
        /** @description One non-empty key of at most 128 UTF-16 units, with no surrounding whitespace, control characters or commas. Comma-separated values are rejected because HTTP adapters may merge repeated headers. Same actor/command/key/input replays the original result; the same key with changed input conflicts. */
        "Idempotency-Key": components["parameters"]["ProjectTextIdempotencyKey"];
        /** @description Required for Control mutations that do not permit a credential-mode exception. */
        "X-CSRF-Token": components["parameters"]["RequiredCsrfToken"];
      };
      path: {
        projectId: string;
        artifactId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["SetProjectTextArtifactLockedRequest"];
      };
    };
    responses: {
      /** @description Bounded authorized project text data */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ProjectTextMutationResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      409: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
}
