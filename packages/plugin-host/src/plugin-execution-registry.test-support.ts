import type { TestContext } from "node:test";
import type {
  PluginIdentity,
  PluginToolRuntimeContext,
} from "@crewon/plugin-sdk/node";
import { preparedPackage } from "./plugin-node-preparation.test-support.ts";

export const executionRequirement = {
  service: "crewon.execution",
  apiVersion: "1",
  optional: false,
};

export const runtimeSource = `({
  definitions(){return []},executionPolicy(){return null},
  async execute(command){return {status:'completed',executionId:command.executionId,providerReceiptId:'fixture-receipt',result:{schemaVersion:'crewon.tool-result.v0',callId:command.callId,output:'installed-factory:'+ctx.identity.version,isError:false,artifactRef:null}}},
  async reconcile(command){return this.execute(command)},
  async cancel(command){return {status:'canceled',executionId:command.executionId,providerReceiptId:null}},
  canRetire(){return true},async close(){record('runtime-close')}
})`;

export const factorySetup = `const execution=ctx.services.get('crewon.execution','1');
execution.register({create(input){record('factory:'+input.identity.version);return ${runtimeSource}}});`;

export async function executionPackage(
  t: TestContext,
  input: Parameters<typeof preparedPackage>[1] = {},
) {
  return preparedPackage(t, {
    ...input,
    requires: [executionRequirement, ...(input.requires ?? [])],
    setup: input.setup ?? factorySetup,
  });
}

export function executionContext(
  identity: PluginIdentity,
): PluginToolRuntimeContext {
  const digest = `sha256:${"a".repeat(64)}`;
  return Object.freeze({
    identity,
    scope: Object.freeze({
      tenantId: "fixture-tenant",
      spaceId: "fixture-space",
      profileId: "fixture-profile",
    }),
    run: Object.freeze({
      runId: "fixture-run",
      threadId: "fixture-thread",
      bindingDigest: digest,
      inputDigest: digest,
      source: null,
    }),
    configuration: Object.freeze({
      revision: 1,
      contentDigest: digest,
      parameters: Object.freeze({}),
      credentialBindings: Object.freeze([]),
    }),
    target: Object.freeze({
      executionAuthority: "crewonKernel",
      agentVersionId: "fixture-agent-version",
      agentVersionContentDigest: digest,
      materializationDigest: digest,
      authorityId: "fixture-authority",
      runtimeGeneration: "fixture-generation",
      policySnapshotId: "fixture-policy",
      workspaceBindingId: null,
    }),
  });
}
