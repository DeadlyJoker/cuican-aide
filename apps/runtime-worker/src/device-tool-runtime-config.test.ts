import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import {
  loadDeviceToolRuntime,
  parseDeviceToolRuntimeConfig,
} from "./device-tool-runtime-config.ts";

test("loads a strict Device Tool deployment with open mTLS and Ed25519 adapters", async (context) => {
  const fixture = files(context);
  const config = validConfig(fixture);
  writeFileSync(fixture.config, JSON.stringify(config), "utf8");
  const runtime = loadDeviceToolRuntime(fixture.config);

  assert.deepEqual(runtime.definitions(), [config.tools[0]?.definition]);
  assert.deepEqual(runtime.executionPolicy("function", "read_file"), config.tools[0]?.policy);
  await runtime.close?.();
});

test("binds the native Tool definition to the released AgentVersion catalog", async (context) => {
  const fixture = files(context);
  const config = validConfig(fixture);
  writeFileSync(fixture.config, JSON.stringify(config), "utf8");

  assert.throws(
    () =>
      loadDeviceToolRuntime(fixture.config, [
        { ...config.tools[0]!.definition, description: "catalog drift" },
      ]),
    hasMessage("device_tool_agent_version_mismatch"),
  );
  const runtime = loadDeviceToolRuntime(fixture.config, [
    config.tools[0]!.definition,
  ]);
  await runtime.close?.();
});

test("rejects ambient fields, unknown bindings and every non-raw native capability", () => {
  const fixture = placeholderFiles();
  const valid = validConfig(fixture);
  assert.throws(
    () => parseDeviceToolRuntimeConfig({ ...valid, bearerToken: "secret" }),
    hasMessage("device_tool_runtime_config_invalid"),
  );
  assert.throws(
    () =>
      parseDeviceToolRuntimeConfig({
        ...valid,
        tools: [
          {
            ...valid.tools[0],
            policy: {
              ...valid.tools[0]!.policy,
              executionTarget: { kind: "device", bindingId: "missing" },
            },
          },
        ],
      }),
    hasMessage("device_tool_policy_invalid"),
  );
  assert.throws(
    () =>
      parseDeviceToolRuntimeConfig({
        ...valid,
        tools: [
          {
            ...valid.tools[0],
            policy: {
              ...valid.tools[0]!.policy,
              effect: "mutation",
              recovery: "reconcilable",
              capability: "workspace.write",
              approvalRequirement: "perAction",
            },
          },
        ],
      }),
    hasMessage("device_tool_policy_invalid"),
  );
  for (const definition of [
    { ...valid.tools[0]!.definition, name: "run_shell" },
    {
      schemaVersion: "crewon.tool-definition.v0" as const,
      kind: "custom" as const,
      name: "read_file",
      description: "Raw input cannot bypass the native allowlist.",
      execution: "serial" as const,
      inputFormat: "text" as const,
    },
  ]) {
    assert.throws(
      () =>
        parseDeviceToolRuntimeConfig({
          ...valid,
          tools: [{ ...valid.tools[0], definition }],
        }),
      hasMessage("device_tool_native_allowlist_invalid"),
    );
  }
  assert.throws(
    () =>
      parseDeviceToolRuntimeConfig({
        ...valid,
        gateway: { ...valid.gateway, endpoint: "http://gateway.invalid" },
      }),
    hasMessage("device_gateway_config_invalid"),
  );
  assert.throws(
    () =>
      parseDeviceToolRuntimeConfig({
        ...valid,
        tools: [
          {
            ...valid.tools[0],
            definition: {
              ...valid.tools[0]!.definition,
              execution: "sometimes",
            },
          },
        ],
      }),
    hasMessage("device_tool_native_allowlist_invalid"),
  );
});

function files(context: TestContext) {
  const directory = mkdtempSync(path.join(tmpdir(), "crewon-device-tool-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const keys = generateKeyPairSync("ed25519");
  const privateKey = path.join(directory, "signing-key.pem");
  const tlsKey = path.join(directory, "worker-key.pem");
  const tlsCert = path.join(directory, "worker-cert.pem");
  const tlsCa = path.join(directory, "ca.pem");
  writeFileSync(
    privateKey,
    keys.privateKey.export({ type: "pkcs8", format: "pem" }),
  );
  writeFileSync(tlsKey, "fixture-worker-key", "utf8");
  writeFileSync(tlsCert, "fixture-worker-cert", "utf8");
  writeFileSync(tlsCa, "fixture-ca", "utf8");
  return {
    config: path.join(directory, "device.json"),
    privateKey,
    tlsKey,
    tlsCert,
    tlsCa,
  };
}

function placeholderFiles() {
  return {
    config: "/config/device.json",
    privateKey: "/secrets/signing.pem",
    tlsKey: "/secrets/worker-key.pem",
    tlsCert: "/secrets/worker-cert.pem",
    tlsCa: "/secrets/ca.pem",
  };
}

function validConfig(fixture: ReturnType<typeof placeholderFiles>) {
  return {
    schemaVersion: "crewon.device-tool-runtime.v0" as const,
    gateway: {
      endpoint: "https://device-gateway.internal:8443",
      tlsKeyPath: fixture.tlsKey,
      tlsCertPath: fixture.tlsCert,
      tlsCaPath: fixture.tlsCa,
      servername: "device-gateway.internal",
      requestTimeoutMs: 35_000,
    },
    signing: {
      keyId: "control-key-1",
      privateKeyPath: fixture.privateKey,
      authorizationTtlMs: 60_000,
    },
    bindings: [{ bindingId: "device-binding-1", deviceId: "device-1" }],
    tools: [
      {
        definition: {
          schemaVersion: "crewon.tool-definition.v0" as const,
          kind: "function" as const,
          name: "read_file",
          description: "Reads one bounded workspace file.",
          execution: "serial" as const,
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              schemaVersion: { const: "crewon.device-filesystem-read-arguments.v0" },
              workspaceIncarnationId: { type: "string" },
              relativePathSegments: {
                type: "array",
                items: { type: "string" },
                minItems: 1,
              },
              encoding: { const: "utf8" },
            },
            required: [
              "schemaVersion",
              "workspaceIncarnationId",
              "relativePathSegments",
              "encoding",
            ],
          },
        },
        policy: {
          effect: "readOnly" as const,
          recovery: "replaySafe" as const,
          resourceBindingId: null,
          credentialBindingId: null,
          executionTarget: {
            kind: "device" as const,
            bindingId: "device-binding-1",
          },
          capability: "workspace.read_file.raw_tool.v0",
          approvalRequirement: "none" as const,
          limits: {
            timeoutMs: 30_000,
            maxOutputBytes: 64 * 1024,
            maxArtifactBytes: 16 * 1024 * 1024,
          },
        },
      },
    ],
  };
}

function hasMessage(message: string): (error: unknown) => boolean {
  return (error) => error instanceof Error && error.message === message;
}
