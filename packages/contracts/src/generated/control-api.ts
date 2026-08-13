// This file is generated from openapi/control-api.v1.json. Do not edit.
export interface paths {
  "/api/v1/local-settings": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["getLocalSettings"];
    put: operations["putLocalSettings"];
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
  "/api/v1/knowledge": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["listKnowledge"];
    put?: never;
    post: operations["createKnowledge"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/knowledge/{knowledgeId}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["getKnowledge"];
    put?: never;
    post?: never;
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
  "/api/v1/offices/{officeVersionId}:runs": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["startOfficeRun"];
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
  "/api/v1/workflow-gates:decide": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["decideWorkflowHumanGate"];
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
    get: operations["listWorkspaceOperations"];
    put?: never;
    post: operations["createWorkspaceList"];
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
    get: operations["getWorkspaceOperation"];
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
    post: operations["reconcileWorkspaceOperation"];
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
    post: operations["cancelWorkspaceOperation"];
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
    /** @description Resume this independent durable stream with Last-Event-ID. The server may close the stream after delivering a terminal operation. */
    get: operations["streamWorkspaceOperationEvents"];
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
  "/api/v1/capabilities": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["listActiveCapabilities"];
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
}
export type webhooks = Record<string, never>;
export interface components {
  schemas: {
    LocalSettings: {
      /** @enum {string} */
      locale: "en" | "zh";
      /** @enum {string} */
      theme: "dark" | "light";
      revision: number;
      /** Format: date-time */
      updatedAt: string | null;
    };
    LocalSettingsResponse: {
      settings: components["schemas"]["LocalSettings"];
    };
    PutLocalSettingsRequest: {
      /** @enum {string} */
      locale: "en" | "zh";
      /** @enum {string} */
      theme: "dark" | "light";
      expectedRevision: number;
    };
    OfficeMember: {
      memberId: string;
      displayName: string;
      agentVersionId: string;
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
    ListOfficesResponse: {
      data: components["schemas"]["Office"][];
      nextCursor: string | null;
    };
    StartOfficeRunRequest: {
      targetId: string;
      threadId: string;
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
    ModelProviderBindingView: {
      providerId: string;
      displayName: string;
      endpoint: string;
      credentialKind: components["schemas"]["ModelProviderCredentialKind"];
      environmentVariable: string | null;
      isActive: boolean;
    };
    ModelProviderSettingsSnapshot: {
      revision: number;
      activeProviderId: string | null;
      providers: components["schemas"]["ModelProviderBindingView"][];
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
    CreateAutomationRequest: {
      threadId: string;
      expectedThreadRevision: number;
      title: string;
      prompt: string;
      agentVersionId: string | null;
    };
    RunAutomationNowRequest: {
      /** @constant */
      expectedAutomationRevision: 1;
      expectedThreadRevision: number;
    };
    CreateKnowledgeRequest: {
      /** @enum {string} */
      kind: "memory" | "source";
      sourceId: string;
      title: string;
      content: string;
    };
    KnowledgeView: {
      /** @constant */
      schemaVersion: "crewon.knowledge.v0";
      knowledgeId: string;
      /** @enum {string} */
      kind: "memory" | "source";
      sourceId: string;
      title: string;
      content: string;
      contentDigest: string;
      /** Format: date-time */
      createdAt: string;
    };
    KnowledgeMutationResponse: {
      /** @enum {string} */
      disposition: "committed" | "replayed";
      knowledge: components["schemas"]["KnowledgeView"];
    };
    GetKnowledgeResponse: {
      knowledge: components["schemas"]["KnowledgeView"];
    };
    ListKnowledgeResponse: {
      data: components["schemas"]["KnowledgeView"][];
      nextCursor: string | null;
    };
    /** @description Redacted immutable manual-only Automation definition. Tenant, actor, schedules, digests and invocation routes are private. */
    AutomationView: {
      automationId: string;
      threadId: string;
      title: string;
      prompt: string;
      agentVersionId: string;
      /** @constant */
      executionMode: "manualOnly";
      /** @constant */
      automaticScheduling: false;
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
      threadId: string;
      title: string | null;
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
    };
    /** @enum {string} */
    ThreadGoalStatus:
      | "active"
      | "paused"
      | "blocked"
      | "usageLimited"
      | "budgetLimited"
      | "complete";
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
      status: components["schemas"]["ThreadGoalStatus"] | null;
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
      /** @description A redacted direct-child name of at most 255 UTF-8 bytes; never a path. */
      name: string;
      /** @enum {string} */
      kind: "file" | "directory";
    };
    WorkspaceCompletedResultView: {
      /** @constant */
      status: "completed";
      /** @description Entries in strict raw UTF-8 byte order. */
      entries: components["schemas"]["WorkspaceListEntryView"][];
      truncated: boolean;
    };
    WorkspaceFailedResultView: {
      /** @constant */
      status: "failed";
      code: string;
      retryable: boolean;
    };
    /** @description Redacted Workspace operation projection. No provider, device, binding, lease, path, principal, policy, or digest internals are exposed. */
    WorkspaceOperationView:
      | {
          threadId: string;
          executionId: string;
          revision: number;
          /** @constant */
          status: "pending";
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
        }
      | {
          threadId: string;
          executionId: string;
          revision: number;
          /** @constant */
          status: "canceled";
          result: null;
        }
      | {
          threadId: string;
          executionId: string;
          revision: number;
          /** @constant */
          status: "unknownOutcome";
          result: null;
        };
    WorkspaceOperationMutationResponse: {
      /** @enum {string} */
      disposition: "committed" | "replayed";
      /** @description Exactly equal to operation.revision. */
      eventSequence: number;
      operation: components["schemas"]["WorkspaceOperationView"];
    };
    GetWorkspaceOperationResponse: {
      operation: components["schemas"]["WorkspaceOperationView"];
      /** @description Atomic cursor exactly equal to operation.revision. */
      eventSequence: number;
    };
    ListWorkspaceOperationsResponse: {
      data: components["schemas"]["WorkspaceOperationView"][];
      nextAfterExecutionId: string | null;
    };
    WorkspaceOperationEventView: {
      /** @constant */
      schemaVersion: "crewon.workspace-operation-event.v0";
      threadId: string;
      executionId: string;
      /** @description Exactly equal to data.operation.revision. */
      sequence: number;
      /** @constant */
      type: "workspace.operation.replaced";
      data: {
        operation: components["schemas"]["WorkspaceOperationView"];
      };
    };
    CreateRunRequest: {
      threadId: string;
      /** @description Optional immutable AgentVersion selection. The server admits it before creating a Run; omission uses the configured default. */
      agentVersionId?: string | null;
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
    DecideWorkflowHumanGateRequest: {
      runId: string;
      /** @description Additionally capped at 256 UTF-8 bytes by the runtime parser. */
      nodeId: string;
      /** @description Additionally capped at 256 UTF-8 bytes by the runtime parser. */
      claimId: string;
      claimEpoch: number;
      /** @description Additionally capped at 256 UTF-8 bytes by the runtime parser. */
      gateRequestId: string;
      /** @enum {string} */
      decision: "approve" | "reject";
    };
    WorkflowHumanGateDecisionResponse: {
      /** @enum {string} */
      disposition: "recorded" | "replay";
      runId: string;
      nodeId: string;
      gateRequestId: string;
    };
    StartTurnRequest: {
      expectedRevision: number;
      content: string;
      /** @description Requested immutable AgentVersion; null uses the active default. The resolved route is server-owned. */
      agentVersionId: string | null;
      /**
       * @description Atomic Turn intent. Goal creates or updates the persistent Thread Goal; Plan clears it and pins this Run to Plan collaboration mode.
       * @enum {string}
       */
      executionIntent: "none" | "goal" | "plan";
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
    RunMutationResponse: {
      /** @enum {string} */
      disposition: "committed" | "replayed";
      run: components["schemas"]["RunView"];
    };
    StartTurnResponse: {
      /** @enum {string} */
      disposition: "committed" | "replayed";
      thread: components["schemas"]["ThreadView"];
      message: components["schemas"]["MessageView"];
      run: components["schemas"]["RunView"];
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
    CapabilitySummaryView: {
      agentVersionId: string;
      agentVersionDigest: string;
      /** @enum {string} */
      kind: "function" | "custom";
      name: string;
      description: string;
      /** @enum {string} */
      execution: "serial" | "parallel";
      /** @enum {string} */
      inputFormat: "jsonSchema" | "text";
    };
    ListActiveCapabilitiesResponse: {
      releaseId: string;
      /** Format: date-time */
      activatedAt: string;
      data: components["schemas"]["CapabilitySummaryView"][];
      nextCursor: string | null;
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
      };
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
      | components["schemas"]["SegmentCheckpointedEventView"]
      | components["schemas"]["SegmentCompletedEventView"]
      | components["schemas"]["SegmentProviderContinuationEventView"]
      | components["schemas"]["SegmentFailedEventView"]
      | components["schemas"]["PlanProposedEventView"]
      | components["schemas"]["MessageCompletedEventView"];
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
    WorkspaceAfterExecutionId: string | null;
    WorkspaceOperationLimit: number;
    ApprovalId: string;
    AgentVersionId: string;
    ArtifactId: string;
    IdempotencyKey: string;
    /** @description Required by the identity adapter for cookie-authenticated mutations. */
    CsrfToken: string;
    /** @description Required for Thread Goal mutations. */
    RequiredCsrfToken: string;
    /** @description Decimal durable event sequence last processed by the client; each event resource has an independent sequence. */
    LastEventId: string;
    /** @description Client view hides bounded transient retry noise; audit preserves every durable event. */
    RunEventView: "client" | "audit";
    /** @description Standard view hides deleted content and emits only its tombstone event; audit requires thread:audit:read and preserves durable history. */
    ThreadHistoryView: "standard" | "audit";
    Cursor: string;
    ResourceCursor: string;
    AgentVersionCursor: string;
    CapabilityCursor: string;
    Limit: number;
  };
  requestBodies: never;
  headers: never;
  pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
  getLocalSettings: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Device-local account and appearance settings */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["LocalSettingsResponse"];
        };
      };
      401: components["responses"]["Error"];
      500: components["responses"]["Error"];
      503: components["responses"]["Error"];
    };
  };
  putLocalSettings: {
    parameters: {
      query?: never;
      header: {
        /** @description Required for Thread Goal mutations. */
        "X-CSRF-Token": components["parameters"]["RequiredCsrfToken"];
      };
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["PutLocalSettingsRequest"];
      };
    };
    responses: {
      /** @description Updated device-local settings */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["LocalSettingsResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      409: components["responses"]["Error"];
      500: components["responses"]["Error"];
      503: components["responses"]["Error"];
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
        /** @description Required for Thread Goal mutations. */
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
  listKnowledge: {
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
      /** @description Scoped Knowledge page */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ListKnowledgeResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
    };
  };
  createKnowledge: {
    parameters: {
      query?: never;
      header: {
        "Idempotency-Key": components["parameters"]["IdempotencyKey"];
        /** @description Required for Thread Goal mutations. */
        "X-CSRF-Token": components["parameters"]["RequiredCsrfToken"];
      };
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["CreateKnowledgeRequest"];
      };
    };
    responses: {
      /** @description Replayed Knowledge record */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["KnowledgeMutationResponse"];
        };
      };
      /** @description Committed Knowledge record */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["KnowledgeMutationResponse"];
        };
      };
      400: components["responses"]["Error"];
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      409: components["responses"]["Error"];
    };
  };
  getKnowledge: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        knowledgeId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Scoped Knowledge record */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["GetKnowledgeResponse"];
        };
      };
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
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
        /** @description Required for Thread Goal mutations. */
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
        /** @description Required for Thread Goal mutations. */
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
  archiveThread: {
    parameters: {
      query?: never;
      header: {
        "Idempotency-Key": components["parameters"]["IdempotencyKey"];
        /** @description Required for Thread Goal mutations. */
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
        /** @description Required for Thread Goal mutations. */
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
        /** @description Required for Thread Goal mutations. */
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
        /** @description Required for Thread Goal mutations. */
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
        /** @description Required for Thread Goal mutations. */
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
        /** @description Required for Thread Goal mutations. */
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
        /** @description Required for Thread Goal mutations. */
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
      /** @description Office versions */
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
      /** @description Replayed Office version */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["OfficeMutationResponse"];
        };
      };
      /** @description Created Office version */
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
      /** @description Office version */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["GetOfficeResponse"];
        };
      };
      401: components["responses"]["Error"];
      403: components["responses"]["Error"];
      404: components["responses"]["Error"];
      500: components["responses"]["Error"];
    };
  };
  startOfficeRun: {
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
        "application/json": components["schemas"]["StartOfficeRunRequest"];
      };
    };
    responses: {
      /** @description Replayed canonical Run */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["RunMutationResponse"];
        };
      };
      /** @description Created canonical Run */
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
  decideWorkflowHumanGate: {
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
        "application/json": components["schemas"]["DecideWorkflowHumanGateRequest"];
      };
    };
    responses: {
      /** @description A durable Human Gate decision or its exact replay */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WorkflowHumanGateDecisionResponse"];
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
        /** @description Client view hides bounded transient retry noise; audit preserves every durable event. */
        view?: components["parameters"]["RunEventView"];
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
  listWorkspaceOperations: {
    parameters: {
      query?: {
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
      /** @description Workspace list operations ordered lexicographically by executionId */
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
  createWorkspaceList: {
    parameters: {
      query?: never;
      header: {
        "Idempotency-Key": components["parameters"]["IdempotencyKey"];
        /** @description Required for Thread Goal mutations. */
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
      /** @description A committed or idempotently replayed Workspace list operation */
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
    };
  };
  getWorkspaceOperation: {
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
      /** @description Atomic Workspace operation and event sequence snapshot */
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
  reconcileWorkspaceOperation: {
    parameters: {
      query?: never;
      header: {
        "Idempotency-Key": components["parameters"]["IdempotencyKey"];
        /** @description Required for Thread Goal mutations. */
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
      /** @description Committed or idempotently replayed Workspace reconciliation */
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
    };
  };
  cancelWorkspaceOperation: {
    parameters: {
      query?: never;
      header: {
        "Idempotency-Key": components["parameters"]["IdempotencyKey"];
        /** @description Required for Thread Goal mutations. */
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
      /** @description Committed or idempotently replayed Workspace cancellation */
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
    };
  };
  streamWorkspaceOperationEvents: {
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
      /** @description Durable catch-up followed by live Workspace operation replacement events */
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
  listActiveCapabilities: {
    parameters: {
      query?: {
        cursor?: components["parameters"]["CapabilityCursor"];
        limit?: components["parameters"]["Limit"];
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Space-authorized, tenant-scoped capabilities projected from the active AgentVersion release */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ListActiveCapabilitiesResponse"];
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
}
