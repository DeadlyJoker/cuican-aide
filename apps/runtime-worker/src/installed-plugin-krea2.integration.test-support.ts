import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { ModelTransportPort } from "@crewon/agent-kernel";
import type { PluginToolRuntimeContext } from "@crewon/plugin-sdk/node";
import type {
  PinnedHttpRequest,
  PinnedHttpResponse,
} from "./pinned-node-http.ts";
import type { InstalledPluginExecutionIoConfig } from "./plugins/installed-plugin-execution-io-config.ts";
import {
  businessExecutionFixture,
  actor,
  scope,
} from "./installed-plugin-business-execution.integration.test-support.ts";

export const KREA_SUBMIT = "crewon_comfyui_krea2__submit";
export const KREA_OBSERVE = "crewon_comfyui_krea2__observe";
export const kreaPrompt =
  "A photorealistic ceramic teapot beside a sunlit window.";
export const kreaService = "https://krea-fixture.example/";

type Submission = {
  prompt_id: string;
  client_id: string;
  extra_data: { crewon_request_id: string };
  prompt: Record<
    string,
    { class_type: string; inputs: Record<string, unknown> }
  >;
};
function response(body: unknown): PinnedHttpResponse {
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify(body)),
  };
}

/** Named protocol/model fixtures. Actual installation, Run admission, dispatch authority, IO and Stores remain real. */
export async function kreaExecutionFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
  options: Readonly<{
    loseAcceptance?: boolean;
    queryTasks?: boolean;
  }> = {},
) {
  const packageDirectory = process.env.CREWON_TEST_KREA_PLUGIN_DIR;
  assert.ok(
    packageDirectory,
    "the independently built Krea2 package is required",
  );
  const requests: PinnedHttpRequest[] = [];
  const contexts: PluginToolRuntimeContext[] = [];
  const submissions: Submission[] = [];
  const models: { tools: string[]; input: unknown }[] = [];
  let dnsRequests = 0;
  const model = (): ModelTransportPort => ({
    adapterName: "fixture-installed-krea-model",
    adapterVersion: "1",
    modelId: "fixture",
    async *stream(request) {
      const names = request.tools.map((tool) => tool.name);
      models.push({ tools: names, input: structuredClone(request.input) });
      if (!names.includes(KREA_SUBMIT)) {
        assert.deepEqual(names, ["get_goal", "create_goal", "update_plan"]);
        yield { type: "output.delta", delta: "original-default-answer" };
      } else {
        assert.deepEqual(names, [
          KREA_SUBMIT,
          KREA_OBSERVE,
          "get_goal",
          "create_goal",
          "update_plan",
        ]);
        const user = [...request.input.items]
          .reverse()
          .find((item) => item.type === "message" && item.role === "user");
        const task = user?.type === "message" ? JSON.parse(user.content) : null;
        const isQuery = task?.kind === "query";
        if (!isQuery)
          assert.ok(JSON.stringify(request.input).includes(kreaPrompt));
        const last = [...request.input.items]
          .reverse()
          .find((item) => item.type === "tool_result");
        if (!last && isQuery)
          yield {
            type: "tool.call",
            kind: "function",
            callId: "krea-query-observe",
            name: KREA_OBSERVE,
            input: JSON.stringify({ operationId: task.operationId }),
          };
        else if (!last)
          yield {
            type: "tool.call",
            kind: "function",
            callId: "krea-submit",
            name: KREA_SUBMIT,
            input: JSON.stringify({ prompt: kreaPrompt }),
          };
        else if (last.callId === "krea-submit") {
          const accepted = JSON.parse(last.output) as {
            operationId: string;
            submission: string;
          };
          assert.equal(accepted.submission, "accepted");
          if (options.queryTasks)
            yield {
              type: "output.delta",
              delta: "生成任务已提交：" + accepted.operationId,
            };
          else
            yield {
              type: "tool.call",
              kind: "function",
              callId: "krea-observe",
              name: KREA_OBSERVE,
              input: JSON.stringify({ operationId: accepted.operationId }),
            };
        } else {
          const observed = JSON.parse(last.output) as {
            status: string;
            images: { url: string }[];
          };
          assert.equal(observed.status, "succeeded");
          yield { type: "output.delta", delta: "图片已生成：" };
          yield { type: "output.delta", delta: observed.images[0]!.url };
        }
      }
      yield { type: "completed", checkpoint: null };
    },
  });
  const executionIo: InstalledPluginExecutionIoConfig = {
    resolveNetwork: async (context, signal) => {
      signal.throwIfAborted();
      assert.equal(context.identity.pluginId, "crewon.comfyui-krea2");
      assert.deepEqual(context.scope, scope);
      assert.deepEqual(context.configuration.parameters, {
        baseUrl: kreaService,
      });
      contexts.push(context);
      return {
        baseUrlParameter: "baseUrl",
        paths: [
          { method: "POST", path: "/prompt" },
          { method: "GET", operationPathPrefix: "/history/" },
          { method: "GET", path: "/queue" },
        ],
      };
    },
    dns: {
      resolveAll: async (hostname) => {
        assert.equal(hostname, "krea-fixture.example");
        dnsRequests++;
        return [{ address: "8.8.8.8", family: 4 }];
      },
    },
    transport: {
      request: async (request, signal) => {
        signal.throwIfAborted();
        assert.equal(
          request.target.endpoint.origin,
          new URL(kreaService).origin,
        );
        assert.equal(request.target.address, "8.8.8.8");
        assert.equal(request.maxRequestBytes, 128 * 1024);
        assert.equal(request.maxResponseBytes, 1024 * 1024);
        requests.push(request);
        if (request.method === "POST") {
          assert.equal(request.target.endpoint.pathname, "/prompt");
          const submission = JSON.parse(
            Buffer.from(request.body!).toString(),
          ) as Submission;
          assert.equal(submission.prompt_id, submission.client_id);
          assert.equal(
            submission.prompt_id,
            submission.extra_data.crewon_request_id,
          );
          submissions.push(submission);
          if (options.loseAcceptance)
            throw new Error("fixture_comfy_reply_lost_after_acceptance");
          return response({ prompt_id: submission.prompt_id, node_errors: {} });
        }
        const id = submissions[0]?.prompt_id;
        assert.ok(
          id,
          "the provider fixture receives a real POST before history can contain a result",
        );
        assert.equal(request.target.endpoint.pathname, "/history/" + id);
        assert.equal(request.body, undefined);
        return response({
          [id]: {
            status: { completed: true, status_str: "success" },
            outputs: {
              "29": {
                images: [
                  {
                    filename: "krea-installed.png",
                    subfolder: "fixture",
                    type: "output",
                  },
                ],
              },
            },
          },
        });
      },
    },
  };
  const f = await businessExecutionFixture(t, backend, {
    packageDirectory,
    ...(options.queryTasks && process.env.CREWON_TEST_KREA_PLUGIN_V2_DIR
      ? { upgradePackageDirectory: process.env.CREWON_TEST_KREA_PLUGIN_V2_DIR }
      : {}),
    configurationParameters: { baseUrl: kreaService },
    createTransport: model,
    taskInput: { prompt: kreaPrompt },
    taskAction: { contributionId: "studio", action: "image.generate" },
    executionIo,
    installedQueryHost: options.queryTasks === true,
  });
  return {
    ...f,
    requests,
    submissions,
    contexts,
    models,
    dnsRequests: () => dnsRequests,
  };
}

export async function assertKreaEvidence(
  f: Awaited<ReturnType<typeof kreaExecutionFixture>>,
  accepted: Awaited<
    ReturnType<Awaited<ReturnType<typeof f.prepareTask>>["create"]>
  >,
) {
  const binding = accepted.binding;
  const listed = await f.operations.listExternalOperations({
    tenantId: actor.tenantId,
    runId: binding.runId,
    bindingDigest: binding.bindingDigest,
    limit: 16,
  });
  assert.equal(listed.truncated, false);
  assert.equal(listed.operations.length, 1);
  const operation = listed.operations[0]!;
  assert.equal(operation.status, "succeeded");
  assert.equal(operation.operationId, f.submissions[0]!.prompt_id);
  assert.equal(operation.providerOperationId, operation.operationId);
  assert.equal(operation.tenantId, actor.tenantId);
  assert.equal(operation.runId, binding.runId);
  assert.equal(operation.bindingDigest, binding.bindingDigest);
  assert.ok(operation.revision >= 2);
  assert.match(operation.resultJson!, /krea-installed\.png/u);
  const events = await f.store.listRunEvents(binding, 0, 128);
  const completed = events.filter((event) => event.type === "tool.completed");
  assert.equal(completed.length, 2);
  const submitReceipt = await f.store.loadToolExecutionReceiptByAction({
    tenantId: actor.tenantId,
    runId: binding.runId,
    actionDigest: operation.actionDigest,
  });
  assert.ok(submitReceipt);
  assert.equal(submitReceipt.status, "completed");
  assert.equal(submitReceipt.executionId, operation.executionId);
  assert.equal(submitReceipt.idempotencyKey, operation.idempotencyKey);
  assert.equal(submitReceipt.providerReceiptId, operation.operationId);
  assert.ok(submitReceipt.actionIntent);
  assert.equal(submitReceipt.actionIntent.tool.name, KREA_SUBMIT);
  const deltas = events
    .filter((event) => event.type === "model.output.delta")
    .map((event) => event.data.delta)
    .join("");
  assert.match(deltas, /图片已生成：https:\/\/krea-fixture\.example\/view\?/u);
  const messages = await f.store.listMessages(binding, 0, 128);
  assert.ok(
    messages.some(
      (message) =>
        message.role === "assistant" &&
        message.content.includes("krea-installed.png"),
    ),
  );
  assert.equal((await f.store.loadRunInSpace(binding))?.status, "completed");
  assert.equal(
    f.requests.filter((request) => request.method === "POST").length,
    1,
  );
  assert.equal(f.submissions.length, 1);
  const graph = f.submissions[0]!.prompt;
  assert.equal(graph["29"]!.class_type, "SaveImage");
  assert.equal(
    graph["29"]!.inputs.filename_prefix,
    "crewon-" + operation.operationId,
  );
  assert.deepEqual(graph["29"]!.inputs.images, ["54", 0]);
  assert.equal(graph["51"]!.inputs.text, kreaPrompt);
  assert.equal(graph["49"]!.inputs.megapixels, 1);
  assert.equal(graph["53"]!.inputs.seed, 769068639772876);
  assert.ok(f.dnsRequests() > 0);
  assert.ok(
    f.contexts.every(
      (context) =>
        context.identity.packageDigest === f.pkg.installed.packageDigest &&
        context.run.runId === binding.runId,
    ),
  );
  assert.equal(await f.count("plugin_task_admissions"), 1);
  assert.equal(await f.count("plugin_credit_reservations"), 1);
  assert.equal(f.controls.quotes, 1);
  const account = await f.credits.getAccount(f.creditScope);
  assert.equal(account?.reservedCredits, "30");
  assert.equal(account?.availableCredits, "970");
  assert.equal(account?.spentCredits, "0");
  return { operation, events, submitReceipt };
}
