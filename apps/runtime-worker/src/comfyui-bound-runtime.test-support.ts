import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { TestContext } from "node:test";
import {
  CurrentExtensionExecutionAuthorization,
  type ActorContext,
  type AuthorizationPort,
} from "@crewon/application";
import {
  extensionCanonicalJson,
  type ExtensionActivation,
  type ExtensionConfiguration,
  type ExtensionRunBinding,
} from "@crewon/domain";
import type { ToolExecutionResolution } from "@crewon/tool-broker";
import {
  activation,
  configuration,
  digest,
  extensionFixture,
  receipt,
  runInput,
  scope,
  target,
} from "../../../packages/store/src/extension-store.test-support.ts";
import { BoundComfyToolRuntime } from "./extensions/comfyui-bound-runtime.ts";
import { comfyManifest } from "./extensions/comfyui-manifest.ts";
import type { PinnedHttpRequest } from "./pinned-node-http.ts";

export { target };
export const actor: ActorContext = {
  tenantId: scope.tenantId,
  spaceId: scope.spaceId,
  actorId: "actor-1",
  principalId: "principal-1",
};
export const signal = () => new AbortController().signal;
export const publicDns = {
  resolveAll: async () => [{ address: "8.8.8.8", family: 4 as const }],
};
export function output(
  value: ToolExecutionResolution,
): Record<string, unknown> {
  assert.equal(value.status, "completed");
  if (value.status !== "completed") throw new Error("not completed");
  return JSON.parse(value.result.output) as Record<string, unknown>;
}

/** Real SQLite config/activation/Run persistence; synthetic deployment identity and HTTP/model only. */
export async function boundComfyFixture(t: TestContext) {
  const f = await extensionFixture(t, "sqlite");
  await f.seedDeployment();
  const manifest = comfyManifest();
  const registration = {
    manifest,
    manifestDigest: `sha256:${createHash("sha256").update(extensionCanonicalJson(manifest)).digest("hex")}`,
    implementationDigest: digest,
  };
  const config = configuration({
    pluginVersion: manifest.version,
    manifestDigest: registration.manifestDigest,
    parameters: { baseUrl: "https://comfy.example/" },
  });
  await f.first.store.saveExtensionConfiguration({
    configuration: config,
    expectedRevision: 0,
    receipt: receipt("config-1"),
  });
  await f.first.store.saveExtensionActivation({
    activation: activation(config),
    expectedRevision: 0,
    receipt: receipt("activation-1"),
  });
  const requests: PinnedHttpRequest[] = [];
  const permissions: Parameters<AuthorizationPort["authorize"]>[0][] = [];
  const controls: {
    allowed: boolean;
    actor: ActorContext | null;
    authorize?: AuthorizationPort["authorize"];
    respond?: (
      request: PinnedHttpRequest,
      signal: AbortSignal,
    ) => Promise<unknown>;
  } = { allowed: true, actor };
  const authorization: AuthorizationPort = {
    authorize: async (request) => {
      permissions.push(request);
      return (
        controls.authorize?.(request) ??
        (controls.allowed
          ? { outcome: "allow" }
          : { outcome: "deny", reasonCode: "revoked" })
      );
    },
  };
  const access = new CurrentExtensionExecutionAuthorization({
    authorization,
    resolveActor: async () => controls.actor,
  });
  const options = {
    configuration: config,
    target,
    registration,
    extensions: f.first.store,
    runs: f.first.parent,
    operations: f.operations,
    access,
    approvalRequirement: "none" as const,
    dns: publicDns,
    transport: {
      request: async (request: PinnedHttpRequest, signal: AbortSignal) => {
        requests.push(request);
        const id = request.target.endpoint.pathname.split("/").at(-1)!;
        const response = controls.respond
          ? await controls.respond(request, signal)
          : request.method === "POST"
            ? {
                prompt_id: (
                  JSON.parse(Buffer.from(request.body!).toString()) as {
                    prompt_id: string;
                  }
                ).prompt_id,
              }
            : {
                [id]: {
                  status: { completed: true, status_str: "success" },
                  outputs: {
                    "29": {
                      images: [
                        {
                          filename: `${id}.png`,
                          subfolder: "",
                          type: "output",
                        },
                      ],
                    },
                  },
                },
              };
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: Buffer.from(JSON.stringify(response)),
        };
      },
    },
  };
  const runtimes: BoundComfyToolRuntime[] = [];
  const runtime = (
    patch: Partial<ConstructorParameters<typeof BoundComfyToolRuntime>[0]> = {},
  ) => {
    const value = new BoundComfyToolRuntime({ ...options, ...patch });
    runtimes.push(value);
    return value;
  };
  t.after(async () => {
    await Promise.all(runtimes.map((value) => value.close()));
  });
  const state = async (
    state: ExtensionActivation["state"],
    configOverride = config,
  ) => {
    const previous = (await f.first.store.loadExtensionActivation(scope))!;
    return (
      await f.first.store.saveExtensionActivation({
        activation: activation(configOverride, {
          revision: previous.revision + 1,
          state,
          target: state === "enabled" ? target : null,
        }),
        expectedRevision: previous.revision,
        receipt: receipt(`activation-${previous.revision + 1}`),
      })
    ).activation;
  };
  const addRun = async (
    id = "run-1",
    source: ExtensionRunBinding["source"] = null,
    boundConfig: ExtensionConfiguration = config,
  ) => {
    const input = runInput(id, {
      configurationRevision: boundConfig.revision,
      configurationDigest: boundConfig.contentDigest,
      source,
    });
    await f.prepare(input);
    const selected = (await f.first.store.loadExtensionActivation(scope))!;
    const saved = await f.first.store.commitExtensionRun({
      ...input,
      expectedActivationRevision: selected.revision,
    });
    return saved.binding;
  };
  return {
    ...f,
    config,
    registration,
    options,
    runtime,
    state,
    addRun,
    requests,
    controls,
    permissions,
    authorization,
  };
}
