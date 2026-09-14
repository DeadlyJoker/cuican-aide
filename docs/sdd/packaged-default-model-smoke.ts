/** Uses only the default profile shipped in the installer, with fresh runtime data. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  RuntimeSupervisor,
  runtimePaths,
} from "../../apps/crewon-ui/electron/runtimeSupervisor.ts";
import {
  PACKAGED_DEFAULT_MODEL_FILE,
  PACKAGED_DEFAULT_PROVIDER_ID,
  parsePackagedDefaultModel,
} from "../../apps/crewon-ui/electron/packagedDefaultModel.ts";
import { ControlApiClient } from "../../packages/control-client/src/index.ts";

const resourcesPath = resolve(process.argv[2]);
const evidencePath = resolve(process.argv[3]);
const profile = parsePackagedDefaultModel(
  JSON.parse(
    readFileSync(join(resourcesPath, PACKAGED_DEFAULT_MODEL_FILE), "utf8"),
  ),
);
const dataDirectory = mkdtempSync(
  join(tmpdir(), "crewon-default-model-runtime-"),
);
Object.defineProperty(process, "resourcesPath", {
  value: resourcesPath,
  configurable: true,
});
const runtime = new RuntimeSupervisor({
  dataDirectory,
  paths: runtimePaths({
    packaged: true,
    repositoryRoot: "/unused",
    resourcesPath,
  }),
  repositoryRoot: null,
  provider: () => ({
    providerId: PACKAGED_DEFAULT_PROVIDER_ID,
    endpoint: profile.endpoint,
    modelId: profile.modelId,
    apiKey: profile.apiKey,
  }),
  providerModelCatalog: async () => [profile.modelId],
  agentPlatformApiKeyForOrigin: () => null,
});
try {
  await runtime.start();
  const session = runtime.session();
  const api = new ControlApiClient({
    ...session,
    accessToken: session.sessionToken,
  });
  const offices = await api.listOffices();
  assert.deepEqual(offices.data, []);
  const catalog = await api.getActiveAgentVersionCatalog();
  assert.ok(catalog);
  const { thread } = await api.createThread(
    { title: "Fresh install default model verification" },
    "fresh-default-thread",
  );
  const turn = await api.startTurn(
    thread.threadId,
    {
      expectedRevision: thread.revision,
      content: "请计算 17×23，只回复计算结果，不调用工具。",
      agentVersionId: null,
      executionIntent: "none",
    },
    "fresh-default-turn",
  );
  let run = turn.run;
  const deadline = Date.now() + 90_000;
  while (["queued", "running"].includes(run.status) && Date.now() < deadline) {
    await delay(250);
    ({ run } = await api.getRun(run.runId));
  }
  assert.equal(run.status, "completed");
  const messages = await api.listThreadMessages(thread.threadId);
  const response = messages.data
    .filter((message) => message.role === "assistant")
    .map((message) => message.content)
    .join("\n");
  assert.match(response, /391/);
  await runtime.restart();
  const restarted = runtime.session();
  const reconnected = new ControlApiClient({
    ...restarted,
    accessToken: restarted.sessionToken,
  });
  const afterRestart = await reconnected.getRun(run.runId);
  assert.equal(afterRestart.run.status, "completed");
  await reconnected.listOffices();
  const evidence = {
    result: "passed",
    appVersion: "0.1.7",
    node: process.versions.node,
    electron: process.versions.electron,
    credentialsSource: "installer default profile",
    developerEnvironmentUsed: false,
    existingUserDataUsed: false,
    dataDirectory,
    resourcesPath,
    modelId: profile.modelId,
    endpoint: profile.endpoint,
    teamCatalogReadable: true,
    agentCatalogReadable: true,
    threadId: thread.threadId,
    runId: run.runId,
    runStatus: run.status,
    observedReply: response,
    restartRecovered: true,
  };
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + "\n");
  console.log(
    JSON.stringify({
      result: "passed",
      model: profile.modelId,
      reply: response,
      teamCatalogReadable: true,
    }),
  );
} finally {
  await runtime.stop();
}
