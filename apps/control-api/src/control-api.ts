import type {
  AgentVersionApplicationService,
  AgentVersionCatalogApplicationService,
  ArtifactApplicationService,
  AutomationApplicationService,
  ModelProviderSettingsApplicationService,
  ApplicationClock,
  ContentDigester,
  RunApplicationService,
  OfficeApplicationService,
  ThreadApplicationService,
  ThreadCompactionApplicationService,
  ThreadGoalApplicationService,
  ThreadRollbackApplicationService,
  ToolApprovalApplicationService,
  TurnApplicationService,
  WorkspaceListApplicationService,
  WorkspaceOperationQueryService,
  WorkflowVersionApplicationService,
  WorkflowRunApplicationService,
  WorkflowHumanGateApplicationService,
  CommitThreadResult,
  CommitTurnStartResult,
  KnowledgeApplicationService,
} from "@crewon/application";
import {
  AgentVersionError,
  compileAgentVersion,
  createAgentVersionAsset,
  type AgentVersionSource,
} from "@crewon/agent-version";
import {
  ContractValidationError,
  formatCapabilityCursor,
  formatAgentVersionCursor,
  formatAutomationCursor,
  formatMessageCursor,
  formatThreadCursor,
  formatThreadRunCursor,
  formatWorkflowVersionCursor,
  parseAgentVersionId,
  parseAgentVersionListQuery,
  parseCapabilityListQuery,
  parseArchiveThreadRequest,
  parseAppendThreadMessageRequest,
  parseApprovalId,
  parseArtifactId,
  parseAutomationId,
  parseCreateOfficeRequest,
  parseStartOfficeRunRequest,
  parseOfficeVersionId,
  parseOfficeListQuery,
  formatOfficeCursor,
  parseAutomationListQuery,
  parseCancelRunRequest,
  parseCompactThreadRequest,
  parseClearThreadGoalRequest,
  parseCreateRunRequest,
  parseStartWorkflowRunRequest,
  parseDecideWorkflowHumanGateRequest,
  parseCreateAutomationRequest,
  parseCreateThreadRequest,
  parseDecideToolApprovalRequest,
  parseDeleteThreadRequest,
  parseForkThreadRequest,
  parseIdempotencyKey,
  parseLastEventSequence,
  parseMessageListQuery,
  parseProbeModelProviderRequest,
  parsePutLocalSettingsRequest,
  parseRenameThreadRequest,
  parseRollbackThreadRequest,
  parsePublishAgentVersionRequest,
  parseRunId,
  parseRunEventViewMode,
  parseRunAutomationNowRequest,
  parseSetThreadGoalRequest,
  parseStartTurnRequest,
  parseThreadId,
  parseThreadHistoryView,
  parseThreadListQuery,
  parseThreadRunListQuery,
  parseUnarchiveThreadRequest,
  parseCreateWorkspaceListRequest,
  parseWorkspaceExecutionId,
  parseWorkspaceOperationActionRequest,
  parseWorkspaceOperationLastEventSequence,
  parseWorkspaceOperationListQuery,
  parseWorkspaceNativeReadonlyControlRequest,
  parsePublishWorkflowVersionRequest,
  parseWorkflowVersionId,
  parseWorkflowVersionListQuery,
  parseCreateKnowledgeRequest,
  parseKnowledgeId,
  parseKnowledgeListQuery,
  formatKnowledgeCursor,
  type AgentVersionMutationResponse,
  type ActiveAgentVersionCatalogResponse,
  type AppendThreadMessageResponse,
  type AutomationMutationResponse,
  type GetAgentVersionResponse,
  type GetArtifactResponse,
  type GetAutomationResponse,
  type GetModelProviderSettingsResponse,
  type GetRunResponse,
  type GetThreadResponse,
  type GetThreadGoalResponse,
  type GetToolApprovalResponse,
  type ListThreadRunsResponse,
  type ListThreadsResponse,
  type ListThreadMessagesResponse,
  type ListAgentVersionsResponse,
  type ListActiveCapabilitiesResponse,
  type ListAutomationsResponse,
  type ProbeModelProviderResponse,
  type RunMutationResponse,
  type WorkflowHumanGateDecisionResponse,
  type RunAutomationNowResponse,
  type StartTurnResponse,
  type ThreadMutationResponse,
  type ToolApprovalMutationResponse,
  type GetWorkspaceOperationResponse,
  type WorkspaceNativeReadonlyRequest,
  type WorkspaceNativeReadonlyResponse,
  type ListWorkspaceOperationsResponse,
  type WorkspaceOperationMutationResponse,
  type WorkflowVersionMutationResponse,
  type GetWorkflowVersionResponse,
  type ListWorkflowVersionsResponse,
  type JsonValue,
  type KnowledgeMutationResponse,
  type GetKnowledgeResponse,
  type ListKnowledgeResponse,
  type OfficeMutationResponse,
  type GetOfficeResponse,
  type ListOfficesResponse,
} from "@crewon/contracts";
import Fastify, { type FastifyInstance } from "fastify";

import { projectCapabilities } from "./capability-projection.ts";

import {
  errorResponse,
  notFoundResponse,
  readinessErrorResponse,
  WorkspaceControlUnavailableError,
  LocalSettingsUnavailableError,
} from "./control-api-errors.ts";
import type {
  ControlApiIdentityPort,
  ControlApiReadinessPort,
  RunRouteResolverPort,
} from "./control-api-ports.ts";
import { requestContext } from "./request-context.ts";
import { RunEventHub } from "./run-event-hub.ts";
import { streamRunEvents } from "./run-event-stream.ts";
import {
  IntervalThreadEventPoller,
  streamThreadEvents,
  type ThreadEventPoller,
} from "./thread-event-stream.ts";
import {
  IntervalThreadGoalEventPoller,
  streamThreadGoalEvents,
  type ThreadGoalEventPoller,
} from "./thread-goal-event-stream.ts";
import { projectAgentVersion } from "./agent-version-projection.ts";
import { projectArtifact } from "./artifact-projection.ts";
import {
  projectAutomation,
  projectAutomationInvocation,
  projectAutomationMutation,
} from "./automation-projection.ts";
import { projectRun } from "./run-projection.ts";
import {
  projectMessage,
  projectThread,
  projectThreadGoal,
  projectThreadGoalMutation,
} from "./thread-projection.ts";
import { projectToolApproval } from "./tool-approval-projection.ts";
import {
  pausedAdmissionResponse,
  type ProcessLocalActivationGate,
} from "./paused-admission.ts";
import { ProviderProbeIdempotencyCoordinator } from "./provider-probe-idempotency.ts";
import type { ControlProviderProbeService } from "./provider-probe-worker-client.ts";
import {
  projectModelProviderProbe,
  projectModelProviderSettings,
  type ProviderRuntimeRouteAvailability,
} from "./provider-settings-projection.ts";
import {
  projectWorkspaceOperationList,
  projectWorkspaceOperationMutation,
  projectWorkspaceOperationSnapshot,
} from "./workspace-operation-projection.ts";
import {
  IntervalWorkspaceOperationEventPoller,
  streamWorkspaceOperationEvents,
  type WorkspaceOperationEventPoller,
} from "./workspace-operation-event-stream.ts";
import {
  projectWorkflowVersion,
  projectWorkflowVersionSummary,
} from "./workflow-version-projection.ts";

export type ControlApiDependencies = Readonly<{
  localSettings?: Readonly<{
    get(): {
      locale: "en" | "zh";
      theme: "dark" | "light";
      revision: number;
      updatedAt: string | null;
    };
    put(input: {
      locale: "en" | "zh";
      theme: "dark" | "light";
      expectedRevision: number;
    }): {
      locale: "en" | "zh";
      theme: "dark" | "light";
      revision: number;
      updatedAt: string | null;
    };
  }> | null;
  application: RunApplicationService;
  offices?: OfficeApplicationService | null;
  threads: ThreadApplicationService;
  goals: ThreadGoalApplicationService;
  turns: TurnApplicationService;
  compactions: ThreadCompactionApplicationService;
  rollbacks: ThreadRollbackApplicationService;
  approvals: ToolApprovalApplicationService;
  agentVersions: AgentVersionApplicationService;
  workflowVersions: WorkflowVersionApplicationService;
  workflowRuns?: Pick<WorkflowRunApplicationService, "startWorkflowRun"> | null;
  workflowHumanGates?: Pick<
    WorkflowHumanGateApplicationService,
    "decide"
  > | null;
  agentVersionCatalogs: AgentVersionCatalogApplicationService;
  artifacts: ArtifactApplicationService;
  automations: AutomationApplicationService;
  knowledge?: KnowledgeApplicationService;
  providerSettings: Pick<ModelProviderSettingsApplicationService, "get">;
  providerProbes: Pick<ControlProviderProbeService, "probe">;
  providerRuntimeAvailability: ProviderRuntimeRouteAvailability;
  workspaceQueries: WorkspaceOperationQueryService;
  workspaceLists: WorkspaceListApplicationService | null;
  workspaceReadonly?: Readonly<{
    executeReadonly(
      input: WorkspaceNativeReadonlyRequest,
      signal: AbortSignal,
    ): Promise<WorkspaceNativeReadonlyResponse>;
  }> | null;
  agentVersionDigester: ContentDigester;
  workflowVersionDigester: ContentDigester;
  clock: ApplicationClock;
  identity: ControlApiIdentityPort;
  routeResolver: RunRouteResolverPort;
  readiness: ControlApiReadinessPort;
  eventHub: RunEventHub;
  outboxWakeup: OutboxWakeupPort;
  threadGoalEventPoller?: ThreadGoalEventPoller;
  threadEventPoller?: ThreadEventPoller;
  workspaceOperationEventPoller?: WorkspaceOperationEventPoller;
  heartbeatIntervalMs?: number | null;
  activationGate?: ProcessLocalActivationGate;
}>;

export interface OutboxWakeupPort {
  /** Best-effort non-rejecting wake-up; durable scanning remains authoritative. */
  wake(): Promise<void>;
}

function projectKnowledge(
  record: Awaited<ReturnType<KnowledgeApplicationService["get"]>>,
) {
  const {
    tenantId: _tenantId,
    spaceId: _spaceId,
    ownerActorId: _ownerActorId,
    ...view
  } = record;
  return view;
}

function requiredKnowledge(
  service: KnowledgeApplicationService | undefined,
): KnowledgeApplicationService {
  if (service === undefined) throw new Error("knowledge_unavailable");
  return service;
}

const MANUAL_ONLY_AUTOMATION_SCHEDULE = {
  scheduleType: "once",
  nextRunAt: "9999-12-31T23:59:59Z",
  intervalSeconds: 0,
  time: "00:00",
  weekday: 0,
  timezone: "UTC",
} as const;

export function buildControlApi(
  dependencies: ControlApiDependencies,
): FastifyInstance {
  validateHeartbeatInterval(dependencies.heartbeatIntervalMs);
  const threadGoalEventPoller =
    dependencies.threadGoalEventPoller ?? new IntervalThreadGoalEventPoller();
  const threadEventPoller =
    dependencies.threadEventPoller ?? new IntervalThreadEventPoller();
  const workspaceOperationEventPoller =
    dependencies.workspaceOperationEventPoller ??
    new IntervalWorkspaceOperationEventPoller();
  const providerProbeIdempotency = new ProviderProbeIdempotencyCoordinator(
    dependencies.providerProbes,
  );
  const app = Fastify({
    bodyLimit: 64 * 1024,
    logger: false,
    trustProxy: false,
  });

  const activationGate = dependencies.activationGate;
  if (activationGate !== undefined) {
    app.addHook("onRequest", async (request, reply) => {
      if (!activationGate.admitRequest(request.method, request.url)) {
        return reply
          .code(503)
          .type("application/json; charset=utf-8")
          .send(pausedAdmissionResponse(request.id));
      }
    });
  }

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-request-id", request.id);
    if (!reply.hasHeader("cache-control")) {
      reply.header("cache-control", "no-store");
    }
    return payload;
  });

  app.setErrorHandler((error, request, reply) => {
    const mapped = errorResponse(error, request.id);
    void reply.code(mapped.statusCode).send(mapped.body);
  });

  app.setNotFoundHandler((request, reply) => {
    const mapped = notFoundResponse(request.id);
    void reply.code(mapped.statusCode).send(mapped.body);
  });

  app.get("/api/v1/local-settings", async (request) => {
    await dependencies.identity.resolveActor(requestContext(request));
    if (dependencies.localSettings == null)
      throw new LocalSettingsUnavailableError();
    return { settings: dependencies.localSettings.get() };
  });

  app.put<{ Body: unknown }>("/api/v1/local-settings", async (request) => {
    await dependencies.identity.resolveActor(requestContext(request));
    if (dependencies.localSettings == null)
      throw new LocalSettingsUnavailableError();
    const body = parsePutLocalSettingsRequest(request.body);
    return {
      settings: dependencies.localSettings.put(body),
    };
  });

  app.get("/api/v1/health/live", async () => ({ status: "ok" as const }));

  app.get<{ Querystring: Record<string, unknown> }>(
    "/api/v1/knowledge",
    async (request) => {
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      const query = parseKnowledgeListQuery({ ...request.query });
      const page = await requiredKnowledge(dependencies.knowledge).list(actor, {
        before:
          query.before === null
            ? null
            : {
                createdAt: query.before.updatedAt,
                knowledgeId: query.before.resourceId,
              },
        limit: query.limit,
      });
      const response: ListKnowledgeResponse = {
        data: page.data.map(projectKnowledge),
        nextCursor:
          page.next === null ? null : formatKnowledgeCursor(page.next),
      };
      return response;
    },
  );
  app.get<{ Params: { knowledgeId: string } }>(
    "/api/v1/knowledge/:knowledgeId",
    async (request) => {
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      const response: GetKnowledgeResponse = {
        knowledge: projectKnowledge(
          await requiredKnowledge(dependencies.knowledge).get(
            actor,
            parseKnowledgeId(request.params.knowledgeId),
          ),
        ),
      };
      return response;
    },
  );
  app.post<{ Body: unknown }>("/api/v1/knowledge", async (request, reply) => {
    const actor = await dependencies.identity.resolveActor(
      requestContext(request),
    );
    const body = parseCreateKnowledgeRequest(request.body);
    const result = await requiredKnowledge(dependencies.knowledge).create(
      actor,
      {
        ...body,
        idempotencyKey: parseIdempotencyKey(request.headers["idempotency-key"]),
      },
    );
    const response: KnowledgeMutationResponse = {
      disposition: result.disposition,
      knowledge: projectKnowledge(result.record),
    };
    return reply
      .code(result.disposition === "committed" ? 201 : 200)
      .send(response);
  });

  app.get("/api/v1/health/ready", async (request, reply) => {
    try {
      await dependencies.readiness.checkReady();
      return { status: "ok" as const };
    } catch {
      const mapped = readinessErrorResponse(request.id);
      return reply.code(mapped.statusCode).send(mapped.body);
    }
  });

  app.get<{ Querystring: Record<string, unknown> }>(
    "/api/v1/automations",
    async (request) => {
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      const query = parseAutomationListQuery({ ...request.query });
      const definitions = await dependencies.automations.listAutomations(
        actor,
        {
          before:
            query.before === null
              ? null
              : {
                  updatedAt: query.before.updatedAt,
                  automationId: query.before.resourceId,
                },
          limit: query.limit,
        },
      );
      const data = definitions.map(projectAutomation);
      const last = data.at(-1);
      const response: ListAutomationsResponse = {
        data,
        nextCursor:
          data.length === query.limit && last !== undefined
            ? formatAutomationCursor({
                updatedAt: last.updatedAt,
                automationId: last.automationId,
              })
            : null,
      };
      return response;
    },
  );

  app.get("/api/v1/model-provider-settings", async (request) => {
    const actor = await dependencies.identity.resolveActor(
      requestContext(request),
    );
    const view = await dependencies.providerSettings.get(actor);
    const response: GetModelProviderSettingsResponse = {
      settings: projectModelProviderSettings(
        view,
        dependencies.providerRuntimeAvailability,
      ),
    };
    return response;
  });

  app.post<{ Body: unknown }>(
    "/api/v1/model-provider-settings/probe",
    async (request) => {
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      const probeRequest = parseProbeModelProviderRequest(request.body);
      const idempotencyKey = parseIdempotencyKey(
        request.headers["idempotency-key"],
      );
      const requestAbort = requestAbortSignal(request.raw);
      try {
        const result = await providerProbeIdempotency.probe(
          actor,
          {
            key: idempotencyKey,
            fingerprint: `model-provider-probe.v1:${JSON.stringify(probeRequest)}`,
          },
          requestAbort.signal,
        );
        const response: ProbeModelProviderResponse = projectModelProviderProbe(
          result.result,
          result.disposition,
        );
        return response;
      } finally {
        requestAbort.dispose();
      }
    },
  );

  app.post<{ Body: unknown }>("/api/v1/automations", async (request, reply) => {
    const actor = await dependencies.identity.resolveActor(
      requestContext(request),
    );
    const body = parseCreateAutomationRequest(request.body);
    const result = await dependencies.automations.createAutomation(actor, {
      kind: "automation.create",
      idempotencyKey: parseIdempotencyKey(request.headers["idempotency-key"]),
      threadId: body.threadId,
      expectedThreadRevision: body.expectedThreadRevision,
      title: body.title,
      prompt: body.prompt,
      requestedAgentVersionId: body.agentVersionId,
      schedule: MANUAL_ONLY_AUTOMATION_SCHEDULE,
    });
    const response: AutomationMutationResponse = projectAutomationMutation({
      disposition: result.disposition,
      definition: result.record.definition,
    });
    return reply
      .code(result.disposition === "committed" ? 201 : 200)
      .send(response);
  });

  app.get<{ Params: { automationId: string } }>(
    "/api/v1/automations/:automationId",
    async (request) => {
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      const definition = await dependencies.automations.getAutomation(
        actor,
        parseAutomationId(request.params.automationId),
      );
      const response: GetAutomationResponse = {
        automation: projectAutomation(definition),
      };
      return response;
    },
  );

  app.post<{ Params: { automationId: string }; Body: unknown }>(
    "/api/v1/automations/:automationId([^:]+)::run-now",
    async (request, reply) => {
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      const body = parseRunAutomationNowRequest(request.body);
      const result = await dependencies.automations.runAutomationNow(actor, {
        kind: "automation.runNow",
        idempotencyKey: parseIdempotencyKey(request.headers["idempotency-key"]),
        automationId: parseAutomationId(request.params.automationId),
        expectedAutomationRevision: body.expectedAutomationRevision,
        expectedThreadRevision: body.expectedThreadRevision,
      });
      wakeOutbox(dependencies.outboxWakeup);
      const response: RunAutomationNowResponse =
        projectAutomationInvocation(result);
      return reply
        .code(result.disposition === "committed" ? 201 : 200)
        .send(response);
    },
  );

  app.post<{ Body: unknown }>("/api/v1/threads", async (request, reply) => {
    const actor = await dependencies.identity.resolveActor(
      requestContext(request),
    );
    const body = parseCreateThreadRequest(request.body);
    const result = await dependencies.threads.createThread(actor, {
      kind: "thread.create",
      idempotencyKey: parseIdempotencyKey(request.headers["idempotency-key"]),
      title: body.title,
    });
    const response: ThreadMutationResponse = {
      disposition: result.disposition,
      thread: projectThread(result.state),
    };
    return reply
      .code(result.disposition === "committed" ? 201 : 200)
      .send(response);
  });

  app.get<{ Querystring: Record<string, unknown> }>(
    "/api/v1/threads",
    async (request) => {
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      const query = parseThreadListQuery({ ...request.query });
      const threads = await dependencies.threads.listThreads(actor, {
        before:
          query.before === null
            ? null
            : {
                updatedAt: query.before.updatedAt,
                threadId: query.before.resourceId,
              },
        limit: query.limit,
      });
      const data = threads.map(projectThread);
      const last = data.at(-1);
      const response: ListThreadsResponse = {
        data,
        nextCursor:
          data.length === query.limit && last !== undefined
            ? formatThreadCursor({
                updatedAt: last.updatedAt,
                threadId: last.threadId,
              })
            : null,
      };
      return response;
    },
  );

  app.get<{ Params: { threadId: string } }>(
    "/api/v1/threads/:threadId",
    async (request) => {
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      const state = await dependencies.threads.getThread(
        actor,
        parseThreadId(request.params.threadId),
      );
      const response: GetThreadResponse = { thread: projectThread(state) };
      return response;
    },
  );

  app.post<{ Params: { threadId: string }; Body: unknown }>(
    "/api/v1/threads/:threadId([^:]+)::archive",
    async (request, reply) => {
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      const body = parseArchiveThreadRequest(request.body);
      const result = await dependencies.threads.archiveThread(actor, {
        kind: "thread.archive",
        threadId: parseThreadId(request.params.threadId),
        expectedRevision: body.expectedRevision,
        idempotencyKey: parseIdempotencyKey(request.headers["idempotency-key"]),
      });
      const response: ThreadMutationResponse = {
        disposition: result.disposition,
        thread: projectThread(result.state),
      };
      return reply.code(200).send(response);
    },
  );

  app.post<{ Params: { threadId: string }; Body: unknown }>(
    "/api/v1/threads/:threadId([^:]+)::rollback",
    async (request, reply) => {
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      const body = parseRollbackThreadRequest(request.body);
      const result = await dependencies.rollbacks.rollbackThread(actor, {
        kind: "thread.rollback",
        threadId: parseThreadId(request.params.threadId),
        expectedRevision: body.expectedRevision,
        numTurns: body.numTurns,
        idempotencyKey: parseIdempotencyKey(request.headers["idempotency-key"]),
      });
      const response: ThreadMutationResponse = {
        disposition: result.disposition,
        thread: projectThread(result.state),
      };
      return reply
        .code(result.disposition === "committed" ? 201 : 200)
        .send(response);
    },
  );

  app.post<{ Params: { threadId: string }; Body: unknown }>(
    "/api/v1/threads/:threadId([^:]+)::unarchive",
    async (request, reply) => {
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      const body = parseUnarchiveThreadRequest(request.body);
      const result = await dependencies.threads.unarchiveThread(actor, {
        kind: "thread.unarchive",
        threadId: parseThreadId(request.params.threadId),
        expectedRevision: body.expectedRevision,
        idempotencyKey: parseIdempotencyKey(request.headers["idempotency-key"]),
      });
      return reply.code(200).send(threadMutationResponse(result));
    },
  );

  app.post<{ Params: { threadId: string }; Body: unknown }>(
    "/api/v1/threads/:threadId([^:]+)::rename",
    async (request, reply) => {
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      const body = parseRenameThreadRequest(request.body);
      const result = await dependencies.threads.renameThread(actor, {
        kind: "thread.rename",
        threadId: parseThreadId(request.params.threadId),
        expectedRevision: body.expectedRevision,
        title: body.title,
        idempotencyKey: parseIdempotencyKey(request.headers["idempotency-key"]),
      });
      return reply.code(200).send(threadMutationResponse(result));
    },
  );

  app.post<{ Params: { threadId: string }; Body: unknown }>(
    "/api/v1/threads/:threadId([^:]+)::delete",
    async (request, reply) => {
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      const body = parseDeleteThreadRequest(request.body);
      const result = await dependencies.threads.deleteThread(actor, {
        kind: "thread.delete",
        threadId: parseThreadId(request.params.threadId),
        expectedRevision: body.expectedRevision,
        idempotencyKey: parseIdempotencyKey(request.headers["idempotency-key"]),
      });
      return reply.code(200).send(threadMutationResponse(result));
    },
  );

  app.get<{
    Params: { threadId: string };
    Querystring: Record<string, unknown>;
  }>("/api/v1/threads/:threadId/events", async (request, reply) => {
    const actor = await dependencies.identity.resolveActor(
      requestContext(request),
    );
    await streamThreadEvents({
      request,
      reply,
      application: dependencies.threads,
      actor,
      threadId: parseThreadId(request.params.threadId),
      afterSequence: parseLastEventSequence(request.headers["last-event-id"]),
      view: parseThreadHistoryView(request.query.view),
      poller: threadEventPoller,
      heartbeatIntervalMs:
        dependencies.heartbeatIntervalMs === undefined
          ? 15_000
          : dependencies.heartbeatIntervalMs,
    });
  });

  app.post<{ Params: { threadId: string }; Body: unknown }>(
    "/api/v1/threads/:threadId/workspace-list",
    async (request, reply) => {
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      const body = parseCreateWorkspaceListRequest(request.body);
      const idempotencyKey = parseIdempotencyKey(
        request.headers["idempotency-key"],
      );
      const workspaceLists = requireWorkspaceLists(dependencies.workspaceLists);
      const requestAbort = requestAbortSignal(request.raw);
      try {
        const result = await workspaceLists.executeWorkspaceList(
          actor,
          {
            kind: "workspaceList.execute",
            idempotencyKey,
            threadId: parseThreadId(request.params.threadId),
            expectedRevision: body.expectedThreadRevision,
            maxEntries: body.maxEntries,
          },
          requestAbort.signal,
        );
        const response: WorkspaceOperationMutationResponse =
          projectWorkspaceOperationMutation(result);
        return reply
          .code(result.disposition === "committed" ? 201 : 200)
          .send(response);
      } finally {
        requestAbort.dispose();
      }
    },
  );

  app.get<{
    Params: { threadId: string };
    Querystring: Record<string, unknown>;
  }>("/api/v1/threads/:threadId/workspace-list", async (request) => {
    const actor = await dependencies.identity.resolveActor(
      requestContext(request),
    );
    const threadId = parseThreadId(request.params.threadId);
    const query = parseWorkspaceOperationListQuery({ ...request.query });
    const page = await dependencies.workspaceQueries.listOperations(actor, {
      threadId,
      afterExecutionId: query.afterExecutionId,
      limit: query.limit,
    });
    const response: ListWorkspaceOperationsResponse =
      projectWorkspaceOperationList(page, {
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        threadId,
        afterExecutionId: query.afterExecutionId,
        limit: query.limit,
      });
    return response;
  });

  app.get<{ Params: { threadId: string; executionId: string } }>(
    "/api/v1/threads/:threadId/workspace-list/:executionId",
    async (request) => {
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      const snapshot = await dependencies.workspaceQueries.getSnapshot(actor, {
        threadId: parseThreadId(request.params.threadId),
        executionId: parseWorkspaceExecutionId(request.params.executionId),
      });
      const response: GetWorkspaceOperationResponse =
        projectWorkspaceOperationSnapshot(snapshot);
      return response;
    },
  );

  app.post<{ Params: { threadId: string }; Body: unknown }>(
    "/api/v1/threads/:threadId/workspace-readonly",
    async (request, reply) => {
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      const threadId = parseThreadId(request.params.threadId);
      await dependencies.threads.getThread(actor, threadId);
      const service = dependencies.workspaceReadonly;
      if (service == null)
        throw new Error("workspace_native_readonly_unavailable");
      const body = parseWorkspaceNativeReadonlyControlRequest(request.body);
      const requestAbort = requestAbortSignal(request.raw);
      try {
        return reply.code(200).send(
          await service.executeReadonly(
            {
              ...body,
              tenantId: actor.tenantId,
              spaceId: actor.spaceId,
            },
            requestAbort.signal,
          ),
        );
      } finally {
        requestAbort.dispose();
      }
    },
  );

  for (const phase of ["reconcile", "cancel"] as const) {
    app.post<{
      Params: { threadId: string; executionId: string };
      Body: unknown;
    }>(
      `/api/v1/threads/:threadId/workspace-list/:executionId([^:]+)::${phase}`,
      async (request, reply) => {
        const actor = await dependencies.identity.resolveActor(
          requestContext(request),
        );
        const body = parseWorkspaceOperationActionRequest(request.body);
        const idempotencyKey = parseIdempotencyKey(
          request.headers["idempotency-key"],
        );
        const workspaceLists = requireWorkspaceLists(
          dependencies.workspaceLists,
        );
        const requestAbort = requestAbortSignal(request.raw);
        try {
          const threadId = parseThreadId(request.params.threadId);
          const executionId = parseWorkspaceExecutionId(
            request.params.executionId,
          );
          const result =
            phase === "reconcile"
              ? await workspaceLists.reconcileWorkspaceList(
                  actor,
                  {
                    kind: "workspaceList.reconcile",
                    idempotencyKey,
                    threadId,
                    executionId,
                    expectedOperationRevision: body.expectedOperationRevision,
                  },
                  requestAbort.signal,
                )
              : await workspaceLists.cancelWorkspaceList(
                  actor,
                  {
                    kind: "workspaceList.cancel",
                    idempotencyKey,
                    threadId,
                    executionId,
                    expectedOperationRevision: body.expectedOperationRevision,
                  },
                  requestAbort.signal,
                );
          return reply
            .code(200)
            .send(projectWorkspaceOperationMutation(result));
        } finally {
          requestAbort.dispose();
        }
      },
    );
  }

  app.get<{ Params: { threadId: string; executionId: string } }>(
    "/api/v1/threads/:threadId/workspace-list/:executionId/events",
    async (request, reply) => {
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      await streamWorkspaceOperationEvents({
        request,
        reply,
        application: dependencies.workspaceQueries,
        actor,
        threadId: parseThreadId(request.params.threadId),
        executionId: parseWorkspaceExecutionId(request.params.executionId),
        afterSequence: parseWorkspaceOperationLastEventSequence(
          request.headers["last-event-id"],
        ),
        poller: workspaceOperationEventPoller,
        heartbeatIntervalMs:
          dependencies.heartbeatIntervalMs === undefined
            ? 15_000
            : dependencies.heartbeatIntervalMs,
      });
    },
  );

  app.get<{ Params: { threadId: string } }>(
    "/api/v1/threads/:threadId/goal",
    async (request) => {
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      const snapshot = await dependencies.goals.getGoal(
        actor,
        parseThreadId(request.params.threadId),
      );
      const response: GetThreadGoalResponse = {
        goal: snapshot.goal === null ? null : projectThreadGoal(snapshot.goal),
        eventSequence: snapshot.eventSequence,
      };
      return response;
    },
  );

  app.put<{ Params: { threadId: string }; Body: unknown }>(
    "/api/v1/threads/:threadId/goal",
    async (request, reply) => {
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      const body = parseSetThreadGoalRequest(request.body);
      const result = await dependencies.goals.setGoal(actor, {
        kind: "thread.goal.set",
        threadId: parseThreadId(request.params.threadId),
        idempotencyKey: parseIdempotencyKey(request.headers["idempotency-key"]),
        expectedRevision: body.expectedRevision,
        objective: body.objective,
        status: body.status,
        tokenBudget: body.tokenBudget,
      });
      wakeOutbox(dependencies.outboxWakeup);
      return reply
        .code(result.disposition === "committed" ? 201 : 200)
        .send(projectThreadGoalMutation(result));
    },
  );

  app.delete<{ Params: { threadId: string }; Body: unknown }>(
    "/api/v1/threads/:threadId/goal",
    async (request, reply) => {
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      const body = parseClearThreadGoalRequest(request.body);
      const result = await dependencies.goals.clearGoal(actor, {
        kind: "thread.goal.clear",
        threadId: parseThreadId(request.params.threadId),
        idempotencyKey: parseIdempotencyKey(request.headers["idempotency-key"]),
        expectedRevision: body.expectedRevision,
      });
      wakeOutbox(dependencies.outboxWakeup);
      return reply.code(200).send(projectThreadGoalMutation(result));
    },
  );

  app.get<{ Params: { threadId: string } }>(
    "/api/v1/threads/:threadId/goal/events",
    async (request, reply) => {
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      await streamThreadGoalEvents({
        request,
        reply,
        application: dependencies.goals,
        actor,
        threadId: parseThreadId(request.params.threadId),
        afterSequence: parseLastEventSequence(request.headers["last-event-id"]),
        poller: threadGoalEventPoller,
        heartbeatIntervalMs:
          dependencies.heartbeatIntervalMs === undefined
            ? 15_000
            : dependencies.heartbeatIntervalMs,
      });
    },
  );

  app.post<{ Params: { threadId: string }; Body: unknown }>(
    "/api/v1/threads/:threadId/messages",
    async (request, reply) => {
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      const body = parseAppendThreadMessageRequest(request.body);
      const result = await dependencies.threads.appendMessage(actor, {
        kind: "thread.message.append",
        idempotencyKey: parseIdempotencyKey(request.headers["idempotency-key"]),
        threadId: parseThreadId(request.params.threadId),
        expectedRevision: body.expectedRevision,
        role: "user",
        content: body.content,
      });
      const message = result.messages[0];
      if (message === undefined || result.messages.length !== 1) {
        throw new Error("thread_message_commit_invalid");
      }
      const response: AppendThreadMessageResponse = {
        disposition: result.disposition,
        thread: projectThread(result.state),
        message: projectMessage(message),
      };
      return reply
        .code(result.disposition === "committed" ? 201 : 200)
        .send(response);
    },
  );

  app.get<{
    Params: { threadId: string };
    Querystring: Record<string, unknown>;
  }>("/api/v1/threads/:threadId/runs", async (request) => {
    const actor = await dependencies.identity.resolveActor(
      requestContext(request),
    );
    const threadId = parseThreadId(request.params.threadId);
    await dependencies.threads.getThread(actor, threadId);
    const query = parseThreadRunListQuery({ ...request.query });
    const runs = await dependencies.application.listThreadRuns(actor, {
      threadId,
      before:
        query.before === null
          ? null
          : {
              updatedAt: query.before.updatedAt,
              runId: query.before.resourceId,
            },
      limit: query.limit,
    });
    const data = runs.map(projectRun);
    const last = data.at(-1);
    const response: ListThreadRunsResponse = {
      data,
      nextCursor:
        data.length === query.limit && last !== undefined
          ? formatThreadRunCursor({
              updatedAt: last.updatedAt,
              runId: last.runId,
            })
          : null,
    };
    return response;
  });

  app.post<{ Params: { threadId: string }; Body: unknown }>(
    "/api/v1/threads/:threadId/turns",
    async (request, reply) => {
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      const threadId = parseThreadId(request.params.threadId);
      const body = parseStartTurnRequest(request.body);
      const idempotencyKey = parseIdempotencyKey(
        request.headers["idempotency-key"],
      );
      const command = {
        kind: "turn.start" as const,
        idempotencyKey,
        threadId,
        expectedThreadRevision: body.expectedRevision,
        content: body.content,
        requestedAgentVersionId: body.agentVersionId,
        executionIntent: body.executionIntent,
      };
      const replay = await dependencies.turns.replayTurn(actor, command);
      if (replay !== null) {
        wakeOutbox(dependencies.outboxWakeup);
        return reply.code(200).send(projectTurnStart(replay));
      }
      const route = await dependencies.routeResolver.resolveRoute({
        actor,
        threadId,
        agentVersionId: body.agentVersionId,
      });
      const result = await dependencies.turns.startTurn(actor, {
        ...command,
        route,
      });
      wakeOutbox(dependencies.outboxWakeup);
      return reply
        .code(result.disposition === "committed" ? 201 : 200)
        .send(projectTurnStart(result));
    },
  );

  app.post<{ Params: { threadId: string }; Body: unknown }>(
    "/api/v1/threads/:threadId([^:]+)::compact",
    async (request, reply) => {
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      const threadId = parseThreadId(request.params.threadId);
      const body = parseCompactThreadRequest(request.body);
      const idempotencyKey = parseIdempotencyKey(
        request.headers["idempotency-key"],
      );
      const command = {
        kind: "thread.compact" as const,
        idempotencyKey,
        threadId,
        expectedThreadRevision: body.expectedRevision,
        requestedAgentVersionId: body.agentVersionId,
      };
      const replay = await dependencies.compactions.replay(actor, command);
      if (replay !== null) {
        wakeOutbox(dependencies.outboxWakeup);
        const response: RunMutationResponse = {
          disposition: replay.disposition,
          run: projectRun(replay.state),
        };
        return reply.code(200).send(response);
      }
      const route = await dependencies.routeResolver.resolveRoute({
        actor,
        threadId,
        agentVersionId: body.agentVersionId,
      });
      const result = await dependencies.compactions.start(actor, {
        ...command,
        route,
      });
      wakeOutbox(dependencies.outboxWakeup);
      const response: RunMutationResponse = {
        disposition: result.disposition,
        run: projectRun(result.state),
      };
      return reply
        .code(result.disposition === "committed" ? 201 : 200)
        .send(response);
    },
  );

  app.get<{
    Params: { threadId: string };
    Querystring: Record<string, unknown>;
  }>("/api/v1/threads/:threadId/messages", async (request) => {
    const actor = await dependencies.identity.resolveActor(
      requestContext(request),
    );
    const query = parseMessageListQuery({
      cursor: request.query.cursor,
      limit: request.query.limit,
      view: request.query.view,
    });
    const messages = await dependencies.threads.listMessages(actor, {
      threadId: parseThreadId(request.params.threadId),
      afterSequence: query.afterSequence,
      limit: query.limit,
      view: query.view,
    });
    const data = messages.map(projectMessage);
    const response: ListThreadMessagesResponse = {
      data,
      nextCursor:
        data.length === query.limit && data.at(-1) !== undefined
          ? formatMessageCursor(data.at(-1)?.sequence ?? 0)
          : null,
    };
    return response;
  });

  app.post<{ Params: { threadId: string }; Body: unknown }>(
    "/api/v1/threads/:threadId/forks",
    async (request, reply) => {
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      const body = parseForkThreadRequest(request.body);
      const result = await dependencies.threads.forkThread(actor, {
        kind: "thread.fork",
        idempotencyKey: parseIdempotencyKey(request.headers["idempotency-key"]),
        sourceThreadId: parseThreadId(request.params.threadId),
        expectedSourceRevision: body.expectedRevision,
        throughHistorySequence: body.throughHistorySequence,
      });
      const response: ThreadMutationResponse = {
        disposition: result.disposition,
        thread: projectThread(result.state),
      };
      return reply
        .code(result.disposition === "committed" ? 201 : 200)
        .send(response);
    },
  );

  app.post<{ Body: unknown }>("/api/v1/runs", async (request, reply) => {
    const actor = await dependencies.identity.resolveActor(
      requestContext(request),
    );
    const body = parseCreateRunRequest(request.body);
    const idempotencyKey = parseIdempotencyKey(
      request.headers["idempotency-key"],
    );
    const route = await dependencies.routeResolver.resolveRoute({
      actor,
      threadId: body.threadId,
      agentVersionId: body.agentVersionId ?? null,
    });
    const result = await dependencies.application.createRun(actor, {
      kind: "run.create",
      idempotencyKey,
      threadId: body.threadId,
      route,
    });
    wakeOutbox(dependencies.outboxWakeup);
    const response: RunMutationResponse = {
      disposition: result.disposition,
      run: projectRun(result.state),
    };
    return reply
      .code(result.disposition === "committed" ? 201 : 200)
      .send(response);
  });

  app.post<{ Body: unknown }>("/api/v1/offices", async (request, reply) => {
    if (dependencies.offices == null)
      throw new WorkspaceControlUnavailableError();
    const actor = await dependencies.identity.resolveActor(
      requestContext(request),
    );
    const body = parseCreateOfficeRequest(request.body);
    const result = await dependencies.offices.create(actor, {
      idempotencyKey: parseIdempotencyKey(request.headers["idempotency-key"]),
      officeId: body.officeId ?? null,
      expectedRevision: body.expectedRevision,
      title: body.title,
      members: body.members,
      executionTargets: body.executionTargets,
    });
    const response: OfficeMutationResponse = {
      disposition: result.disposition,
      office: result.definition,
    };
    return reply
      .code(result.disposition === "created" ? 201 : 200)
      .send(response);
  });

  app.get<{ Params: { officeVersionId: string } }>(
    "/api/v1/offices/:officeVersionId",
    async (request) => {
      if (dependencies.offices == null)
        throw new WorkspaceControlUnavailableError();
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      const office = await dependencies.offices.get(
        actor,
        parseOfficeVersionId(request.params.officeVersionId),
      );
      const response: GetOfficeResponse = { office };
      return response;
    },
  );

  app.get<{ Querystring: unknown }>("/api/v1/offices", async (request) => {
    if (dependencies.offices == null)
      throw new WorkspaceControlUnavailableError();
    const actor = await dependencies.identity.resolveActor(
      requestContext(request),
    );
    const query = parseOfficeListQuery(request.query);
    const data = await dependencies.offices.list(actor, query);
    const last = data.at(-1);
    const response: ListOfficesResponse = {
      data,
      nextCursor:
        last === undefined || data.length < query.limit
          ? null
          : formatOfficeCursor({
              createdAt: last.createdAt,
              officeVersionId: last.officeVersionId,
            }),
    };
    return response;
  });

  app.post<{ Params: { officeVersionId: string }; Body: unknown }>(
    "/api/v1/offices/:officeVersionId([^:]+)::runs",
    async (request, reply) => {
      if (dependencies.offices == null)
        throw new WorkspaceControlUnavailableError();
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      const body = parseStartOfficeRunRequest(request.body);
      const target = await dependencies.offices.authorizeRun(
        actor,
        parseOfficeVersionId(request.params.officeVersionId),
        body.targetId,
      );
      const route = await dependencies.routeResolver.resolveRoute({
        actor,
        threadId: body.threadId,
        agentVersionId: target.agentVersionId,
      });
      const result = await dependencies.application.createRun(actor, {
        kind: "run.create",
        idempotencyKey: parseIdempotencyKey(request.headers["idempotency-key"]),
        threadId: body.threadId,
        route,
      });
      wakeOutbox(dependencies.outboxWakeup);
      const response: RunMutationResponse = {
        disposition: result.disposition,
        run: projectRun(result.state),
      };
      return reply
        .code(result.disposition === "committed" ? 201 : 200)
        .send(response);
    },
  );

  app.post<{ Body: unknown }>(
    "/api/v1/workflow-runs",
    async (request, reply) => {
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      const body = parseStartWorkflowRunRequest(request.body);
      if (dependencies.workflowRuns == null) {
        throw new WorkspaceControlUnavailableError();
      }
      const result = await dependencies.workflowRuns.startWorkflowRun(actor, {
        kind: "workflowRun.start",
        idempotencyKey: parseIdempotencyKey(request.headers["idempotency-key"]),
        workflowVersionId: body.workflowVersionId,
        threadId: body.threadId,
        input: body.input as JsonValue,
      });
      wakeOutbox(dependencies.outboxWakeup);
      const response: RunMutationResponse = {
        disposition: result.run.disposition,
        run: projectRun(result.run.state),
      };
      return reply
        .code(result.run.disposition === "committed" ? 201 : 200)
        .send(response);
    },
  );

  app.post<{ Body: unknown }>(
    "/api/v1/workflow-gates:decide",
    async (request) => {
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      const body = parseDecideWorkflowHumanGateRequest(request.body);
      if (dependencies.workflowHumanGates == null) {
        throw new WorkspaceControlUnavailableError();
      }
      const result = await dependencies.workflowHumanGates.decide(actor, {
        kind: "workflowHumanGate.decide",
        idempotencyKey: parseIdempotencyKey(request.headers["idempotency-key"]),
        ...body,
      });
      wakeOutbox(dependencies.outboxWakeup);
      const response: WorkflowHumanGateDecisionResponse = {
        disposition: result.disposition,
        runId: result.runId,
        nodeId: result.nodeId,
        gateRequestId: result.gateRequestId,
      };
      return response;
    },
  );

  app.post<{ Body: unknown }>(
    "/api/v1/workflow-versions",
    { bodyLimit: 1024 * 1024 },
    async (request, reply) => {
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      const body = parsePublishWorkflowVersionRequest(request.body);
      const result = await dependencies.workflowVersions.publish(
        actor,
        body as unknown as import("@crewon/domain").WorkflowVersionSource,
      );
      const response: WorkflowVersionMutationResponse = {
        disposition: result.disposition,
        workflowVersion: projectWorkflowVersion(
          result.asset,
          dependencies.workflowVersionDigester,
        ),
      };
      return reply
        .code(result.disposition === "registered" ? 201 : 200)
        .send(response);
    },
  );

  app.get<{ Querystring: Record<string, unknown> }>(
    "/api/v1/workflow-versions",
    async (request) => {
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      const query = parseWorkflowVersionListQuery({ ...request.query });
      const assets = await dependencies.workflowVersions.list(actor, {
        workflowId: query.workflowId,
        after:
          query.afterWorkflowVersionId === null
            ? null
            : {
                workflowId: query.workflowId,
                workflowVersionId: query.afterWorkflowVersionId,
              },
        limit: query.limit,
      });
      const data = assets.map((asset) =>
        projectWorkflowVersionSummary(
          asset,
          dependencies.workflowVersionDigester,
        ),
      );
      const response: ListWorkflowVersionsResponse = {
        data,
        nextCursor:
          data.length === query.limit && data.at(-1) !== undefined
            ? formatWorkflowVersionCursor(
                query.workflowId,
                data.at(-1)!.workflowVersionId,
              )
            : null,
      };
      return response;
    },
  );

  app.get<{ Params: { workflowVersionId: string } }>(
    "/api/v1/workflow-versions/:workflowVersionId",
    async (request) => {
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      const asset = await dependencies.workflowVersions.get(
        actor,
        parseWorkflowVersionId(request.params.workflowVersionId),
      );
      const response: GetWorkflowVersionResponse = {
        workflowVersion: projectWorkflowVersion(
          asset,
          dependencies.workflowVersionDigester,
        ),
      };
      return response;
    },
  );

  app.post<{ Body: unknown }>(
    "/api/v1/agent-versions",
    { bodyLimit: 1024 * 1024 },
    async (request, reply) => {
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      const body = parsePublishAgentVersionRequest(request.body);
      let version;
      try {
        version = compileAgentVersion(
          body as unknown as AgentVersionSource,
          dependencies.agentVersionDigester,
        );
      } catch (error) {
        if (error instanceof AgentVersionError) {
          throw new ContractValidationError(error.code);
        }
        throw error;
      }
      const createdAt = dependencies.clock.now();
      const result = await dependencies.agentVersions.publish(
        actor,
        createAgentVersionAsset({
          tenantId: actor.tenantId,
          version,
          createdAt,
        }),
      );
      const response: AgentVersionMutationResponse = {
        disposition: result.disposition,
        agentVersion: projectAgentVersion(
          result.asset,
          dependencies.agentVersionDigester,
        ),
      };
      return reply
        .code(result.disposition === "registered" ? 201 : 200)
        .send(response);
    },
  );

  app.get<{
    Querystring: Record<string, unknown>;
  }>("/api/v1/agent-versions", async (request) => {
    const actor = await dependencies.identity.resolveActor(
      requestContext(request),
    );
    const query = parseAgentVersionListQuery({ ...request.query });
    const assets = await dependencies.agentVersions.list(actor, query);
    const data = assets.map((asset) =>
      projectAgentVersion(asset, dependencies.agentVersionDigester),
    );
    const response: ListAgentVersionsResponse = {
      data,
      nextCursor:
        data.length === query.limit && data.at(-1) !== undefined
          ? formatAgentVersionCursor(data.at(-1)?.agentVersionId ?? "")
          : null,
    };
    return response;
  });

  app.get("/api/v1/agent-versions/active", async (request) => {
    const actor = await dependencies.identity.resolveActor(
      requestContext(request),
    );
    const catalog = await dependencies.agentVersionCatalogs.getActive(actor);
    const response: ActiveAgentVersionCatalogResponse = {
      releaseId: catalog.releaseId,
      activatedAt: catalog.activatedAt,
      defaultAgentVersionId: catalog.defaultAgentVersionId,
      data: catalog.assets.map((asset) =>
        projectAgentVersion(asset, dependencies.agentVersionDigester),
      ),
    };
    return response;
  });

  app.get<{ Querystring: Record<string, unknown> }>(
    "/api/v1/capabilities",
    async (request) => {
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      const query = parseCapabilityListQuery({ ...request.query });
      const catalog = await dependencies.agentVersionCatalogs.getActive(actor);
      if (query.releaseId !== null && query.releaseId !== catalog.releaseId) {
        throw new ContractValidationError("capability_catalog_changed");
      }
      const projected = projectCapabilities(
        catalog.assets,
        dependencies.agentVersionDigester,
      );
      const start =
        query.afterKey === null
          ? 0
          : projected.findIndex((item) => item.key > query.afterKey!);
      const pageStart = start < 0 ? projected.length : start;
      const page = projected.slice(pageStart, pageStart + query.limit);
      const last = page.at(-1);
      const hasMore =
        last !== undefined && projected.some((item) => item.key > last.key);
      const response: ListActiveCapabilitiesResponse = {
        releaseId: catalog.releaseId,
        activatedAt: catalog.activatedAt,
        data: page.map((item) => item.value),
        nextCursor:
          hasMore && last !== undefined
            ? formatCapabilityCursor({
                releaseId: catalog.releaseId,
                afterKey: last.key,
              })
            : null,
      };
      return response;
    },
  );

  app.get<{ Params: { agentVersionId: string } }>(
    "/api/v1/agent-versions/:agentVersionId",
    async (request) => {
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      const asset = await dependencies.agentVersions.get(
        actor,
        parseAgentVersionId(request.params.agentVersionId),
      );
      const response: GetAgentVersionResponse = {
        agentVersion: projectAgentVersion(
          asset,
          dependencies.agentVersionDigester,
        ),
      };
      return response;
    },
  );

  app.get<{ Params: { runId: string } }>(
    "/api/v1/runs/:runId",
    async (request) => {
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      const runId = parseRunId(request.params.runId);
      const state = await dependencies.application.getRun(actor, runId);
      const response: GetRunResponse = { run: projectRun(state) };
      return response;
    },
  );

  app.get<{ Params: { artifactId: string } }>(
    "/api/v1/artifacts/:artifactId",
    async (request) => {
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      const artifact = await dependencies.artifacts.getArtifact(
        actor,
        parseArtifactId(request.params.artifactId),
      );
      const response: GetArtifactResponse = {
        artifact: projectArtifact(artifact),
      };
      return response;
    },
  );

  app.get<{ Params: { artifactId: string } }>(
    "/api/v1/artifacts/:artifactId/content",
    async (request, reply) => {
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      const artifact = await dependencies.artifacts.readArtifact(
        actor,
        parseArtifactId(request.params.artifactId),
      );
      return reply
        .header("content-disposition", "attachment; filename=artifact")
        .header("etag", `"${artifact.record.contentDigest}"`)
        .type(artifact.record.mediaType)
        .send(Buffer.from(artifact.content));
    },
  );

  app.post<{ Params: { runId: string }; Body: unknown }>(
    "/api/v1/runs/:runId([^:]+)::cancel",
    async (request, reply) => {
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      const runId = parseRunId(request.params.runId);
      const body = parseCancelRunRequest(request.body);
      const idempotencyKey = parseIdempotencyKey(
        request.headers["idempotency-key"],
      );
      const result = await dependencies.application.transitionRun(actor, {
        kind: "run.requestCancel",
        runId,
        expectedRevision: body.expectedRevision,
        idempotencyKey,
      });
      wakeOutbox(dependencies.outboxWakeup);
      const response: RunMutationResponse = {
        disposition: result.disposition,
        run: projectRun(result.state),
      };
      return reply.code(200).send(response);
    },
  );

  app.get<{ Params: { approvalId: string } }>(
    "/api/v1/tool-approvals/:approvalId",
    async (request) => {
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      const approval = await dependencies.approvals.getApproval(
        actor,
        parseApprovalId(request.params.approvalId),
      );
      const response: GetToolApprovalResponse = {
        approval: projectToolApproval(approval),
      };
      return response;
    },
  );

  app.post<{ Params: { approvalId: string }; Body: unknown }>(
    "/api/v1/tool-approvals/:approvalId([^:]+)::decide",
    async (request, reply) => {
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      const body = parseDecideToolApprovalRequest(request.body);
      const result = await dependencies.approvals.decideApproval(actor, {
        kind: "toolApproval.decide",
        approvalId: parseApprovalId(request.params.approvalId),
        expectedRevision: body.expectedRevision,
        idempotencyKey: parseIdempotencyKey(request.headers["idempotency-key"]),
        decision: body.decision,
        comment: body.comment,
      });
      wakeOutbox(dependencies.outboxWakeup);
      const response: ToolApprovalMutationResponse = {
        disposition: result.disposition,
        approval: projectToolApproval(result.approval),
        run: projectRun(result.run),
      };
      return reply.code(200).send(response);
    },
  );

  app.get<{
    Params: { runId: string };
    Querystring: Record<string, unknown>;
  }>("/api/v1/runs/:runId/events", async (request, reply) => {
    const actor = await dependencies.identity.resolveActor(
      requestContext(request),
    );
    await streamRunEvents({
      request,
      reply,
      application: dependencies.application,
      actor,
      eventHub: dependencies.eventHub,
      runId: parseRunId(request.params.runId),
      afterSequence: parseLastEventSequence(request.headers["last-event-id"]),
      view: parseRunEventViewMode(request.query.view),
      heartbeatIntervalMs:
        dependencies.heartbeatIntervalMs === undefined
          ? 15_000
          : dependencies.heartbeatIntervalMs,
    });
  });

  return app;
}

function requestAbortSignal(
  request: NodeJS.EventEmitter & { aborted: boolean },
): {
  signal: AbortSignal;
  dispose(): void;
} {
  const abort = new AbortController();
  const aborted = () => abort.abort(new Error("control_request_aborted"));
  if (request.aborted) aborted();
  else request.once("aborted", aborted);
  return {
    signal: abort.signal,
    dispose: () => request.off("aborted", aborted),
  };
}

function threadMutationResponse(
  result: CommitThreadResult,
): ThreadMutationResponse {
  return {
    disposition: result.disposition,
    thread: projectThread(result.state),
  };
}

function projectTurnStart(result: CommitTurnStartResult): StartTurnResponse {
  const message = result.messages[0];
  if (message === undefined || result.messages.length !== 1) {
    throw new Error("turn_start_commit_invalid");
  }
  return {
    disposition: result.disposition,
    thread: projectThread(result.threadState),
    message: projectMessage(message),
    run: projectRun(result.runState),
  };
}

function wakeOutbox(outboxWakeup: OutboxWakeupPort): void {
  void outboxWakeup.wake().catch(() => {
    // HTTP success is already durable; periodic scanning is the retry path.
  });
}

function requireWorkspaceLists(
  workspaceLists: WorkspaceListApplicationService | null,
): WorkspaceListApplicationService {
  if (workspaceLists === null) {
    throw new WorkspaceControlUnavailableError();
  }
  return workspaceLists;
}

function validateHeartbeatInterval(value: number | null | undefined): void {
  if (
    value !== undefined &&
    value !== null &&
    (!Number.isSafeInteger(value) || value < 1_000)
  ) {
    throw new Error("heartbeat_interval_invalid");
  }
}
