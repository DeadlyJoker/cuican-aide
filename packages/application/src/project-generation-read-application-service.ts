import { assertPluginTaskFunding } from "@crewon/domain";
import { parsePluginUiJsonValue } from "@crewon/contracts/plugins";
import {
  creativeProjectOpaqueId,
  creativeProjectRevision,
  extensionCanonicalJson,
  parseExtensionRunBinding,
  parseProjectGenerationLink,
  reduceRunLifecycleEvent,
  type ConceptAssetRevision,
  type ProjectGenerationLink,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type { ActorContext } from "./authorization-port.ts";
import type { ContentDigester } from "./application-runtime-ports.ts";
import { CreativeProjectApplicationService } from "./creative-project-application-service.ts";
import { ExtensionReadApplicationService } from "./extension-read-application-service.ts";
import type {
  ExtensionStore,
  CommitExtensionTurnResult,
} from "./extension-store-port.ts";
import {
  creativeActor,
  creativeInput,
  creativeOwner,
  creativeRecord,
  creativeStored,
} from "./creative-project-application-support.ts";
import { assertCommittedRun } from "./plugin-ui-committed-task-support.ts";

export type GetConceptGenerationQuery = Readonly<{
  projectId: string;
  assetId: string;
  assetRevision: number;
}>;
type Task = Awaited<ReturnType<ExtensionReadApplicationService["getTask"]>>;
export type ConceptGenerationReadResult = null | Readonly<{
  link: ProjectGenerationLink;
  task: Task;
}>;
export type ProjectGenerationReadApplicationDependencies = Readonly<{
  projects: CreativeProjectApplicationService;
  tasks: ExtensionReadApplicationService;
  extensions: ExtensionStore;
  digester: ContentDigester;
}>;

/** Read an authorized saved source through its immutable original task, without execution or billing. */
export class ProjectGenerationReadApplicationService {
  readonly #getConceptRevision: CreativeProjectApplicationService["getConceptRevision"];
  readonly #getTask: ExtensionReadApplicationService["getTask"];
  readonly #loadLink: NonNullable<
    ExtensionStore["loadProjectGenerationLinkBySource"]
  >;
  readonly #loadReceipt: ExtensionStore["loadExtensionTurnReceipt"];
  readonly #digester: ContentDigester;

  constructor(dependencies: ProjectGenerationReadApplicationDependencies) {
    const fields = dependencyFields(dependencies);
    if (
      !(fields.projects instanceof CreativeProjectApplicationService) ||
      !(fields.tasks instanceof ExtensionReadApplicationService) ||
      fields.extensions === null ||
      typeof fields.extensions !== "object" ||
      fields.extensions.projectGenerationReadVersion !==
        "crewon.project-generation-read.v1"
    )
      throw new ApplicationError(
        "internal",
        "project_generation_read_unavailable",
      );
    this.#getConceptRevision = captureMethod(
      fields.projects,
      "getConceptRevision",
    );
    this.#getTask = captureMethod(fields.tasks, "getTask");
    this.#loadLink = captureMethod(
      fields.extensions,
      "loadProjectGenerationLinkBySource",
    );
    this.#loadReceipt = captureMethod(
      fields.extensions,
      "loadExtensionTurnReceipt",
    );
    this.#digester = Object.freeze({
      sha256: captureMethod<ContentDigester["sha256"]>(
        fields.digester,
        "sha256",
      ),
    });
  }

  async getConceptGeneration(
    actorInput: ActorContext,
    queryInput: GetConceptGenerationQuery,
  ): Promise<ConceptGenerationReadResult> {
    const actor = creativeActor(actorInput);
    const query = creativeInput(() => {
      const value = creativeRecord(queryInput, [
        "projectId",
        "assetId",
        "assetRevision",
      ]);
      return Object.freeze({
        projectId: creativeProjectOpaqueId(value.projectId),
        assetId: creativeProjectOpaqueId(value.assetId),
        assetRevision: creativeProjectRevision(value.assetRevision),
      });
    });
    const source = await this.#getConceptRevision(actor, query);
    const stored = await readStorage(() =>
      this.#loadLink(Object.freeze({ owner: creativeOwner(actor), ...query })),
    );
    if (stored === null) {
      const finalSource = await this.#getConceptRevision(actor, query);
      creativeStored(() => assertSameSource(source, finalSource));
      return null;
    }
    const link = creativeStored(() => {
      const value = parseProjectGenerationLink(stored, this.#digester);
      assertSource(value, actor, query, source);
      return value;
    });
    const target = Object.freeze({
      pluginId: link.binding.pluginId,
      runId: link.binding.runId,
    });
    const task = await this.#getTask(actor, target);
    creativeStored(() => assertTask(task, link, this.#digester));
    const receipt = await readStorage(() =>
      this.#loadReceipt(
        Object.freeze({
          tenantId: actor.tenantId,
          spaceId: actor.spaceId,
          pluginId: link.binding.pluginId,
          receipt: link.receipt,
        }),
      ),
    );
    creativeStored(() => assertReceipt(receipt, link, source, this.#digester));
    // Recheck the source after all provenance awaits and return the final current Run state.
    const finalSource = await this.#getConceptRevision(actor, query);
    const finalTask = await this.#getTask(actor, target);
    const settledSource = await this.#getConceptRevision(actor, query);
    creativeStored(() => {
      assertSameSource(source, finalSource);
      assertSameSource(source, settledSource);
      assertSource(link, actor, query, finalSource);
      assertSource(link, actor, query, settledSource);
      assertTask(finalTask, link, this.#digester);
    });
    return Object.freeze({ link, task: finalTask });
  }
}

async function readStorage<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw new ApplicationError(
      "internal",
      "creative_project_store_result_invalid",
      { cause: error },
    );
  }
}

function assertSource(
  link: ProjectGenerationLink,
  actor: ActorContext,
  query: GetConceptGenerationQuery,
  source: ConceptAssetRevision,
) {
  if (
    link.tenantId !== actor.tenantId ||
    link.spaceId !== actor.spaceId ||
    link.ownerPrincipalId !== actor.principalId ||
    link.projectId !== query.projectId ||
    link.reference.projectId !== query.projectId ||
    link.reference.assetId !== query.assetId ||
    link.reference.assetRevision !== query.assetRevision ||
    link.assetContentDigest !== source.contentDigest ||
    link.briefRevision !== source.briefRevision ||
    link.briefContentDigest !== source.briefContentDigest
  )
    throw new Error("project_generation_source_identity_mismatch");
}
function assertSameSource(
  first: ConceptAssetRevision,
  last: ConceptAssetRevision,
) {
  if (extensionCanonicalJson(first) !== extensionCanonicalJson(last))
    throw new Error("project_generation_source_changed");
}
function assertTask(
  task: Task,
  link: ProjectGenerationLink,
  digester: ContentDigester,
) {
  const binding = parseExtensionRunBinding(task.binding, digester);
  if (extensionCanonicalJson(binding) !== extensionCanonicalJson(link.binding))
    throw new Error("project_generation_task_binding_mismatch");
  assertCommittedRun(task.run, binding);
}
function assertReceipt(
  input: CommitExtensionTurnResult | null,
  link: ProjectGenerationLink,
  source: ConceptAssetRevision,
  digester: ContentDigester,
) {
  if (input === null) throw new Error("project_generation_receipt_missing");
  const receipt = parsePluginUiJsonValue(
    input,
  ) as unknown as CommitExtensionTurnResult;
  if (
    receipt.schemaVersion !== "crewon.extension-turn-admission.v0" ||
    extensionCanonicalJson(
      parseExtensionRunBinding(receipt.binding, digester),
    ) !== extensionCanonicalJson(link.binding)
  )
    throw new Error("project_generation_receipt_identity_mismatch");
  assertPluginTaskFunding(
    {
      creditAdmission: receipt.creditAdmission,
      unmeteredAdmission: receipt.unmeteredAdmission,
      binding: link.binding,
      receipt: link.receipt,
      principalId: link.ownerPrincipalId,
    },
    digester,
  );
  const event = receipt.run.events[0];
  if (receipt.run.events.length !== 1 || event?.type !== "run.created")
    throw new Error("project_generation_receipt_run_invalid");
  const original = reduceRunLifecycleEvent(null, event);
  assertCommittedRun(original, link.binding);
  if (
    extensionCanonicalJson(original) !==
      extensionCanonicalJson(receipt.run.state) ||
    extensionCanonicalJson(receipt.turn.runState) !==
      extensionCanonicalJson(original) ||
    extensionCanonicalJson(receipt.turn.runEvents) !==
      extensionCanonicalJson(receipt.run.events) ||
    receipt.turn.threadState.tenantId !== link.tenantId ||
    receipt.turn.threadState.spaceId !== link.spaceId ||
    receipt.turn.threadState.threadId !== link.binding.threadId ||
    receipt.turn.messages.length !== 1 ||
    receipt.turn.messages[0]!.content !==
      extensionCanonicalJson({ prompt: source.prompt }) ||
    link.binding.inputDigest !==
      digester.sha256(extensionCanonicalJson({ prompt: source.prompt }))
  )
    throw new Error("project_generation_receipt_source_mismatch");
}

function dependencyFields(input: ProjectGenerationReadApplicationDependencies) {
  if (
    input === null ||
    typeof input !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    throw new ApplicationError(
      "internal",
      "project_generation_read_dependencies_invalid",
    );
  const keys = ["projects", "tasks", "extensions", "digester"] as const;
  if (Reflect.ownKeys(input).length !== keys.length)
    throw new ApplicationError(
      "internal",
      "project_generation_read_dependencies_invalid",
    );
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(input, key);
    if (!field?.enumerable || !Object.hasOwn(field, "value"))
      throw new ApplicationError(
        "internal",
        "project_generation_read_dependencies_invalid",
      );
  }
  return Object.fromEntries(
    keys.map((key) => [
      key,
      Object.getOwnPropertyDescriptor(input, key)!.value,
    ]),
  ) as ProjectGenerationReadApplicationDependencies;
}
function captureMethod<T extends (...args: never[]) => unknown>(
  owner: unknown,
  key: string,
): T {
  if (
    owner === null ||
    (typeof owner !== "object" && typeof owner !== "function")
  )
    throw new ApplicationError(
      "internal",
      "project_generation_read_port_invalid",
    );
  for (
    let current = owner;
    current !== null;
    current = Object.getPrototypeOf(current)
  ) {
    const field = Object.getOwnPropertyDescriptor(current, key);
    if (field === undefined) continue;
    if (!Object.hasOwn(field, "value") || typeof field.value !== "function")
      break;
    return Function.prototype.bind.call(field.value, owner) as T;
  }
  throw new ApplicationError(
    "internal",
    "project_generation_read_port_invalid",
  );
}
