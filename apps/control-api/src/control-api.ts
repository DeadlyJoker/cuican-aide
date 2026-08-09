import type {
  AgentVersionApplicationService,
  AgentVersionCatalogApplicationService,
  ArtifactApplicationService,
  ApplicationClock,
  ContentDigester,
  RunApplicationService,
  ThreadApplicationService,
  ThreadCompactionApplicationService,
  ThreadGoalApplicationService,
  ThreadRollbackApplicationService,
  ToolApprovalApplicationService,
  TurnApplicationService,
  CommitThreadResult,
  CommitTurnStartResult,
} from "@crewon/application";
import {
  AgentVersionError,
  compileAgentVersion,
  createAgentVersionAsset,
  type AgentVersionSource,
} from "@crewon/agent-version";
import {
  ContractValidationError,
  formatAgentVersionCursor,
  formatMessageCursor,
  formatThreadCursor,
  formatThreadRunCursor,
  parseAgentVersionId,
  parseAgentVersionListQuery,
  parseArchiveThreadRequest,
  parseAppendThreadMessageRequest,
  parseApprovalId,
  parseArtifactId,
  parseCancelRunRequest,
  parseCompactThreadRequest,
  parseClearThreadGoalRequest,
  parseCreateRunRequest,
  parseCreateThreadRequest,
  parseDecideToolApprovalRequest,
  parseDeleteThreadRequest,
  parseForkThreadRequest,
  parseIdempotencyKey,
  parseLastEventSequence,
  parseMessageListQuery,
  parseRenameThreadRequest,
  parseRollbackThreadRequest,
  parsePublishAgentVersionRequest,
  parseRunId,
  parseRunEventViewMode,
  parseSetThreadGoalRequest,
  parseStartTurnRequest,
  parseThreadId,
  parseThreadHistoryView,
  parseThreadListQuery,
  parseThreadRunListQuery,
  parseUnarchiveThreadRequest,
  type AgentVersionMutationResponse,
  type ActiveAgentVersionCatalogResponse,
  type AppendThreadMessageResponse,
  type GetAgentVersionResponse,
  type GetArtifactResponse,
  type GetRunResponse,
  type GetThreadResponse,
  type GetThreadGoalResponse,
  type GetToolApprovalResponse,
  type ListThreadRunsResponse,
  type ListThreadsResponse,
  type ListThreadMessagesResponse,
  type ListAgentVersionsResponse,
  type RunMutationResponse,
  type StartTurnResponse,
  type ThreadMutationResponse,
  type ToolApprovalMutationResponse,
} from "@crewon/contracts";
import Fastify, { type FastifyInstance } from "fastify";

import {
  errorResponse,
  notFoundResponse,
  readinessErrorResponse,
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
import { projectRun } from "./run-projection.ts";
import {
  projectMessage,
  projectThread,
  projectThreadGoal,
  projectThreadGoalMutation,
} from "./thread-projection.ts";
import { projectToolApproval } from "./tool-approval-projection.ts";

export type ControlApiDependencies = Readonly<{
  application: RunApplicationService;
  threads: ThreadApplicationService;
  goals: ThreadGoalApplicationService;
  turns: TurnApplicationService;
  compactions: ThreadCompactionApplicationService;
  rollbacks: ThreadRollbackApplicationService;
  approvals: ToolApprovalApplicationService;
  agentVersions: AgentVersionApplicationService;
  agentVersionCatalogs: AgentVersionCatalogApplicationService;
  artifacts: ArtifactApplicationService;
  agentVersionDigester: ContentDigester;
  clock: ApplicationClock;
  identity: ControlApiIdentityPort;
  routeResolver: RunRouteResolverPort;
  readiness: ControlApiReadinessPort;
  eventHub: RunEventHub;
  outboxWakeup: OutboxWakeupPort;
  threadGoalEventPoller?: ThreadGoalEventPoller;
  threadEventPoller?: ThreadEventPoller;
  heartbeatIntervalMs?: number | null;
}>;

export interface OutboxWakeupPort {
  /** Best-effort non-rejecting wake-up; durable scanning remains authoritative. */
  wake(): Promise<void>;
}

export function buildControlApi(
  dependencies: ControlApiDependencies,
): FastifyInstance {
  validateHeartbeatInterval(dependencies.heartbeatIntervalMs);
  const threadGoalEventPoller =
    dependencies.threadGoalEventPoller ?? new IntervalThreadGoalEventPoller();
  const threadEventPoller =
    dependencies.threadEventPoller ?? new IntervalThreadEventPoller();
  const app = Fastify({
    bodyLimit: 64 * 1024,
    logger: false,
    trustProxy: false,
  });

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

  app.get("/api/v1/health/live", async () => ({ status: "ok" as const }));

  app.get("/api/v1/health/ready", async (request, reply) => {
    try {
      await dependencies.readiness.checkReady();
      return { status: "ok" as const };
    } catch {
      const mapped = readinessErrorResponse(request.id);
      return reply.code(mapped.statusCode).send(mapped.body);
    }
  });

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

function validateHeartbeatInterval(value: number | null | undefined): void {
  if (
    value !== undefined &&
    value !== null &&
    (!Number.isSafeInteger(value) || value < 1_000)
  ) {
    throw new Error("heartbeat_interval_invalid");
  }
}
