import type { TestContext } from "node:test";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { InMemoryArtifactStore } from "@crewon/artifacts";
import { ControlApiClient, streamRunEvents } from "@crewon/control-client";
import type { RunEventView } from "@crewon/contracts";
import { sqliteWorkflowDeploymentFixture } from "../src/sqlite-workflow-deployment.test-support.ts";
import { createStandaloneTeamTaskControlApi } from "../src/standalone-team-task-control-api.ts";
import {
  originalTask,
  prepare,
} from "../src/team-turn-application.test-support.ts";
import { ControlThreadRuntime } from "../../crewon-ui/src/lib/control-runtime/controlThreadRuntime.ts";

function testContext(
  cleanups: Array<() => void | Promise<unknown>>,
): TestContext {
  return {
    after(callback: () => void | Promise<unknown>) {
      cleanups.push(callback);
    },
  } as unknown as TestContext;
}

test("durable Team UI runtime completes through real standalone Control HTTP and Worker SSE", async () => {
  const cleanups: Array<() => void | Promise<unknown>> = [];
  const server = await sqliteWorkflowDeploymentFixture(
    testContext(cleanups),
    {},
  );
  const worker = await server.worker();
  worker.start();
  const runtime = await createStandaloneTeamTaskControlApi({
    databasePath: server.databasePath,
    actor: server.actor,
    defaultAgentVersionId: server.base.route.agentVersionId,
    artifactStore: new InMemoryArtifactStore(),
    artifactEncryptionKeyId: "durable-team-ui-integration-test",
    sessionToken: server.token,
    csrfToken: server.token,
    allowedOrigins: [server.origin],
    heartbeatIntervalMs: null,
    outboxScanIntervalMs: null,
    automationScanIntervalMs: null,
    artifactRetention: null,
  });
  const baseUrl = await runtime.app.listen({ host: "127.0.0.1", port: 0 });
  const client = new ControlApiClient({
    baseUrl,
    accessToken: server.token,
    csrfToken: server.token,
    origin: server.origin,
  });
  const prepared = await prepare(client, true);
  const started: string[] = [];
  const events: RunEventView[] = [];
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const ui = new ControlThreadRuntime(
    {
      client,
      teamExecutionMode: "durableTask",
      reconnectDelay: async () => {},
      eventStream: async function* (_client, { runId, afterSequence, signal }) {
        for await (const event of streamRunEvents(client, {
          runId,
          afterSequence,
          view: "client",
          signal,
        })) {
          events.push(event);
          yield event;
        }
      },
    },
    {
      onThread() {},
      onTextDelta() {},
      onToolItem() {},
      onRunSettled() {
        settle();
      },
      onStreamError() {},
      onTurnStarted: (_threadId, turn) => {
        started.push(turn.id);
      },
    },
  );

  try {
    const result = await ui.startTurn(
      prepared.thread.threadId,
      originalTask,
      [],
      {
        scene: {
          sceneId: "office",
          mode: "coordinate",
          executionTarget: {
            kind: "team",
            id: prepared.plan.officeVersionId,
          },
        },
      },
    );

    if (started.length !== 1) throw new Error("durable_team_ui_start_missing");
    if (result.turn.id !== started[0])
      throw new Error("durable_team_ui_turn_identity_invalid");
    await Promise.race([
      settled,
      delay(10_000).then(() => {
        throw new Error("durable_team_ui_settlement_timeout");
      }),
    ]);
    if (!events.some((event) => event.type === "run.completed"))
      throw new Error("durable_team_ui_terminal_event_missing");

    const messages = await client.listThreadMessages(prepared.thread.threadId, {
      cursor: null,
      limit: 100,
    });
    const userMessages = messages.data.filter(
      (message) => message.content === originalTask,
    );
    if (userMessages.length !== 1)
      throw new Error("durable_team_ui_duplicate_user_message");
    if (!messages.data.some((message) => message.role === "assistant"))
      throw new Error("durable_team_ui_assistant_message_missing");
  } finally {
    ui.close();
    await runtime.app.close();
    for (const close of cleanups.reverse()) await close();
  }
});
