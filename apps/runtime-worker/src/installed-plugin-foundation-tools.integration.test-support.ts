import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import {
  ProjectConversationApplicationService,
  CreativeProjectApplicationService,
  ProjectFoundationApplicationService,
  ThreadApplicationService,
  type CreativeProjectAuthorizationPort,
  type ProjectConversationCommitAuthority,
} from "@crewon/application";
import {
  parseExtensionManifest,
  parsePluginTaskAdmissionPin,
  type WorkflowValueSchema,
  type WorkflowSchemaValue,
} from "@crewon/domain";
import {
  PROJECT_FOUNDATION_TOOL_OPERATIONS,
  PROJECT_FOUNDATION_TOOL_RESPONSE_LIMITS,
} from "@crewon/contracts/project-foundation-tools";
import type { ModelTransportPort } from "@crewon/agent-kernel";
import {
  businessExecutionFixture,
  actor,
  digester,
} from "./installed-plugin-business-execution.integration.test-support.ts";
import { businessManifest } from "./installed-plugin-business.test-support.ts";
import { extensionToolDefinitions } from "./extensions/extension-tool-catalog.ts";
import {
  createCommand,
  preparedSource,
} from "../../../packages/application/src/project-foundation-application-test-support.ts";

const string = (maxLength: number): WorkflowValueSchema => ({
  type: "string",
  maxLength,
  enum: null,
});
const integer = (minimum: number, maximum: number): WorkflowValueSchema => ({
  type: "integer",
  minimum,
  maximum,
});
const object = (
  properties: Record<string, WorkflowValueSchema>,
  required = Object.keys(properties),
): WorkflowValueSchema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const source = {
  projectId: string(128),
  sourceRevision: integer(1, 10000),
  sourceDigest: string(71),
};
const schemas = {
  readScope: object({}),
  getFoundation: object({ projectId: string(128) }),
  getSource: object(source),
  readSourcePage: object({
    ...source,
    startOffset: integer(0, 20000000),
    limit: integer(1, 1024),
  }),
  listSourceChapters: object(
    {
      ...source,
      afterStartOffset: integer(0, 20000000),
      limit: integer(1, 16),
    },
    [...Object.keys(source), "limit"],
  ),
  getProposal: object({
    projectId: string(128),
    proposalRevision: integer(1, 10000),
    proposalDigest: string(71),
    startOffset: integer(0, 8192),
    limit: integer(1, 1024),
  }),
  listProposals: object({
    projectId: string(128),
    afterProposalRevision: integer(0, 10000),
    limit: integer(1, 4),
  }),
  saveProposal: object({
    projectId: string(128),
    expectedFoundationRevision: integer(1, 10000),
    expectedProposalRevision: integer(0, 10000),
    kind: {
      type: "string",
      maxLength: 24,
      enum: ["novel-adaptation", "creative-plan"],
    },
    text: string(8192),
  }),
};
export const foundationFixtureManifest = parseExtensionManifest({
  ...businessManifest,
  task: {
    instructions:
      "Read bounded project facts and save only a candidate; human confirmation is separate.",
    inputSchema: object({ prompt: string(2000) }),
  },
  tools: Object.entries(PROJECT_FOUNDATION_TOOL_OPERATIONS).map(
    ([method, operationId]) => ({
      operationId,
      adapterId: "crewon.project-foundation-tools",
      description: "Independent Foundation " + method,
      inputSchema: schemas[method as keyof typeof schemas],
      outputSchema: object({ value: string(9999) }),
      execution: "serial",
      effect: method === "saveProposal" ? "mutation" : "readOnly",
      recovery: method === "saveProposal" ? "reconcilable" : "replaySafe",
      capability: method === "saveProposal" ? "project.write" : "project.read",
    }),
  ),
});

/** Installed ESM calls only its published host ABI; it imports no Worker/Store/Application internals. */
function nodeSource() {
  const methods = Object.fromEntries(
    Object.entries(PROJECT_FOUNDATION_TOOL_OPERATIONS).map(([method, op]) => [
      "example_professional__" + op,
      method,
    ]),
  );
  return `export default {apiVersion:'crewon.plugin-host.v1',pluginId:'example.professional',setup(host){
  const service=host.services.getOptional('crewon.project-foundation-tools','1');
  host.services.get('crewon.execution','1').register({create(context){
    let retained=null;const methods=${JSON.stringify(methods)},limits=${JSON.stringify(PROJECT_FOUNDATION_TOOL_RESPONSE_LIMITS)};
    const run=async(command,signal)=>{signal.throwIfAborted();const method=methods[command.name];if(!method||!service)throw new Error('fixture_foundation_service_unavailable');
      const response=await service[method]({command,request:JSON.parse(command.input)});
      retained={status:'completed',executionId:command.executionId,providerReceiptId:'fixture-foundation/'+command.executionId,result:{schemaVersion:'crewon.tool-result.v0',callId:command.callId,output:JSON.stringify({value:JSON.stringify(response)}),isError:false,artifactRef:null}};return retained;};
    return {definitions(){return ${JSON.stringify(extensionToolDefinitions(foundationFixtureManifest))}},
      executionPolicy(kind,name){const method=methods[name],op=${JSON.stringify(PROJECT_FOUNDATION_TOOL_OPERATIONS)}[method];if(kind!=='function'||!method)throw new Error('fixture_foreign_tool');return {effect:method==='saveProposal'?'mutation':'readOnly',recovery:method==='saveProposal'?'reconcilable':'replaySafe',resourceBindingId:context.run.bindingDigest,credentialBindingId:null,executionTarget:{kind:'control',bindingId:'fixture-foundation'},capability:method==='saveProposal'?'project.write':'project.read',approvalRequirement:'none',limits:{timeoutMs:30000,maxOutputBytes:limits[op],maxArtifactBytes:limits[op]}}},
      execute:run,reconcile:run,cancel(command){return Promise.resolve({status:'unknownOutcome',executionId:command.executionId,providerReceiptId:null})},
      acknowledgeExecutionResult(ack){if(retained&&ack.executionId===retained.executionId&&ack.providerReceiptId===retained.providerReceiptId){retained=null;return true}return false},
      readRetainedExecutionResult(q){return retained&&q.executionId===retained.executionId?retained:null},retainedExecutionResults(){return []},scanRetainedExecutionResults(){return []},canRetire(){return retained===null},close(){retained=null}};
  }});}};`;
}

export type FoundationWorkerFixtureOptions = Readonly<{
  configured?: boolean;
  backend?: "sqlite" | "postgres";
  packageDirectory?: string;
  configurationParameters?: Readonly<Record<string, WorkflowSchemaValue>>;
  projectKind?: "foundation-novel" | "legacy-v0";
  maxToolRounds?: number;
}>;

export async function foundationWorkerFixture(
  t: TestContext,
  transport: () => ModelTransportPort,
  options: FoundationWorkerFixtureOptions = {},
) {
  let allowed = true,
    checks = 0;
  const authorization: CreativeProjectAuthorizationPort = {
    authorize: async () => ({ outcome: "allow" }),
  };
  const common = {
    authorization,
    clock: { now: () => new Date().toISOString() },
    ids: { nextId: () => randomUUID() },
    digester,
  };
  const f = await businessExecutionFixture(t, options.backend ?? "sqlite", {
    ...(options.packageDirectory === undefined
      ? {
          packageFixture: {
            manifest: foundationFixtureManifest,
            node: nodeSource(),
            requires: [
              { service: "crewon.execution", apiVersion: "1", optional: false },
              {
                service: "crewon.project-foundation-tools",
                apiVersion: "1",
                optional: true,
              },
            ],
          },
        }
      : { packageDirectory: options.packageDirectory }),
    ...(options.configurationParameters === undefined
      ? {}
      : {
          configurationParameters: options.configurationParameters,
        }),
    taskAction: { contributionId: "workbench", action: "project.execute" },
    projectConversationQuotes: true,
    taskInput: { prompt: "Read this project" },
    createTransport: transport,
    maxToolRounds: options.maxToolRounds ?? 16,
    taskClock: common.clock,
    projectTools: { version: "crewon.project-tools.v1", authorization },
    ...(options.configured === false
      ? {}
      : {
          projectFoundationTools: {
            version: "crewon.project-foundation-tools.v1" as const,
            authorization,
            authorizeService: async (_admission, signal) => {
              signal.throwIfAborted();
              checks++;
              if (!allowed)
                throw new Error(
                  "fixture_independent_foundation_permission_denied",
                );
            },
            createFoundations: ({ store }) =>
              new ProjectFoundationApplicationService({
                ...common,
                projects: store.creativeProjectStore(),
                store: store.projectFoundationStore(),
                sourcePreparation: {
                  loadPrepared: async () => {
                    throw new Error("fixture_upload_not_available_in_node");
                  },
                },
              }),
          },
        }),
  });
  const projects = f.store.creativeProjectStore(),
    foundation = f.store.projectFoundationStore({
      sourceAdmission: "trusted-internal-recipe",
    }),
    conversations = f.store.projectConversationStore();
  await projects.migrate();
  await foundation.migrate();
  await f.store.projectTextStore().migrate();
  await conversations.migrate();
  // Explicit internal recipe seeds the source for a Run test. This is not an upload/adoption test.
  const app = new ProjectFoundationApplicationService({
    ...common,
    projects,
    store: foundation,
    sourceAdmission: "trusted-internal-recipe",
    sourcePreparation: {
      loadPrepared: async () => preparedSource("upload-1", actor),
    },
  });
  const command = createCommand("novel");
  const labels = Array.from(
    { length: 48 },
    (_, i) => `${i}:` + "a".repeat(156),
  );
  const created =
    options.projectKind === "legacy-v0"
      ? await new CreativeProjectApplicationService({
          ...common,
          store: projects,
        }).createProject(actor, {
          title: "Original v0 discussion",
          briefText:
            "Read the original brief; no Foundation has been created for this project.",
          idempotencyKey: "foundation-fixture-legacy-v0",
        })
      : await app.createProject(actor, {
          ...command,
          parameters: {
            ...command.parameters,
            adaptation: {
              strategy: "core",
              retainedCharacters: labels,
              retainedScenes: [],
            },
          },
        });
  const selection = await f.installations.loadSelection({
    scope: f.scope,
    pluginId: f.entry.registration.identity.pluginId,
  });
  assert.ok(selection);
  const pkg = await f.installations.loadPackage({
    scope: f.scope,
    packageDigest: selection.selectedPackageDigest!,
  });
  assert.ok(pkg);
  const pin = parsePluginTaskAdmissionPin({
    ...actor,
    ...f.scope,
    ...f.entry.registration.identity,
    selectionRevision: selection.revision,
    contributionId: "workbench",
    action: "project.execute",
    authorityEpoch: "genuine-foundation-fixture",
  });
  const authority: ProjectConversationCommitAuthority = {
    version: "crewon.project-conversation-commit.v1",
    actor,
    installation: {
      ...f.scope,
      ...f.entry.registration.identity,
      selectionRevision: selection.revision,
    },
    pin,
    selection,
    package: pkg,
    assertCurrent: async () => {
      assert.deepEqual(
        await f.installations.loadSelection({
          scope: f.scope,
          pluginId: pin.pluginId,
        }),
        selection,
      );
    },
    assertTransactionCurrent: async () => {},
    assertActive() {},
  };
  const threads = new ThreadApplicationService({
    ...common,
    authorization: { authorize: async () => ({ outcome: "allow" as const }) },
    store: f.store,
    workspaceAdmission: { admit: async () => {} },
  });
  const conversationApp = new ProjectConversationApplicationService({
    ...common,
    conversations,
    threads,
    threadStore: f.store,
    projects,
    texts: f.store.projectTextStore(),
    tasks: f.tasks,
  });
  const bound = await conversationApp.createConversation(
    actor,
    {
      projectId: created.project.projectId,
      workspaceId: "foundation-workspace",
      title: "Foundation discussion",
      idempotencyKey: "foundation-conversation",
    },
    authority,
  );
  const start = async (key = "foundation-original-turn") => {
    const thread = await f.store.loadThread({
      tenantId: actor.tenantId,
      threadId: bound.binding.threadId,
    });
    assert.ok(thread);
    return conversationApp.startProjectTurn(
      actor,
      {
        projectId: created.project.projectId,
        threadId: bound.binding.threadId,
        expectedThreadRevision: thread.revision,
        expectedBindingRevision: bound.binding.revision,
        content: "Read the source and save a candidate for my confirmation.",
        idempotencyKey: key,
        stage: { kind: "discussion" },
      },
      authority,
    );
  };
  return {
    ...f,
    created,
    app,
    bound,
    start,
    get checks() {
      return checks;
    },
    denyFoundation() {
      allowed = false;
    },
  };
}
