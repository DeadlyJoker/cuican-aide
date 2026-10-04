import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { settle } from "./ui.test-support.mjs";
import { deferred } from "./persistent-ui.test-support.mjs";

const plugin = fileURLToPath(new URL("../", import.meta.url));

/** Compile current product sources in memory; never replace a released plugin artifact. */
export async function sourceModule(path) {
  const result = await build({
    absWorkingDir: plugin,
    entryPoints: [path],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    jsx: "automatic",
    write: false,
    loader: { ".css": "text", ".png": "dataurl" },
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "silent",
  });
  return import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString("base64")}`
  );
}

export const actualController = () =>
  sourceModule(`${plugin}src/workbench/ConceptGenerationController.ts`);
export const actualUi = () => sourceModule(`${plugin}src/ui.tsx`);

export const source = Object.freeze({
  projectId: "watcher test project /中文",
  assetId: "watcher test concept /%2F",
  assetRevision: 1,
});
export const operationId = "00000000-0000-0000-0000-000000000001";
export const image = Object.freeze({
  url: "https://supplier.test/view?filename=stored-observation.png",
  filename: "stored-observation.png",
  resultIndex: 0,
});

/** Public stored projection, not an execution, provider or paid-admission fixture. */
export function record(locator = source, overrides = {}) {
  const runId = overrides.runId ?? "original-accepted-run";
  return {
    ...locator,
    briefRevision: 1,
    createdAt: "2026-10-04T00:00:00.000Z",
    task: {
      runId,
      threadId: "original-accepted-thread",
      pluginId: "crewon.comfyui-krea2",
      pluginVersion: "2.0.0",
      configurationRevision: 3,
      runStatus: "queued",
      sourceRunId: null,
      operations: [],
      truncated: false,
      ...overrides,
    },
  };
}

export function operation(status, { revision = 1, images = [] } = {}) {
  return {
    operationId,
    sourceRunId: "original-accepted-run",
    status,
    observedAt: "2026-10-04T00:00:01.000Z",
    operationRevision: revision,
    images,
  };
}

export function receipt(generation = record(), runId = generation.task.runId) {
  return {
    disposition: "committed",
    threadId: generation.task.threadId,
    threadRevision: 8,
    runId,
    messageId: `message-${runId}`,
    configurationRevision: generation.task.configurationRevision,
  };
}

export function reads(initial = record()) {
  let current = initial;
  const calls = [];
  const gates = [];
  const client = {
    async getConceptGeneration(locator, { signal }) {
      calls.push({ locator: structuredClone(locator), signal });
      const gate = gates.shift();
      if (gate) return await gate.promise;
      return { generation: structuredClone(current) };
    },
  };
  return {
    client,
    calls,
    set(value) {
      current = value;
    },
    hold() {
      const gate = deferred();
      gates.push(gate);
      return gate;
    },
  };
}

export function clock(t) {
  t.mock.timers.enable({
    apis: ["Date", "setTimeout"],
    now: Date.UTC(2026, 9, 4),
  });
  return {
    async tick(milliseconds) {
      t.mock.timers.tick(milliseconds);
      await settle();
    },
  };
}

export async function watch(Controller, fixture, t, locator = source) {
  const controller = new Controller(fixture.client);
  t.after(() => controller.dispose());
  controller.setVisible(true);
  controller.bind(locator, true);
  await settle();
  return controller;
}
