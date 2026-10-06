import { createHash } from "node:crypto";
import { types } from "node:util";
import {
  ExtensionTaskApplicationService,
  materialPreparationFields,
  mediaInputActor,
  mediaInputSame,
  mediaGenerationFail as fail,
  projectMediaGenerationTaskInput,
  projectMediaInputBound,
  pluginTaskReceiptKey,
  type ActorContext,
  type ProjectMediaGenerationTask,
} from "@crewon/application";
import {
  projectAssetId,
  projectAssetRevision,
  parsePluginTaskAdmission,
  parsePluginTaskAdmissionPin,
  type PluginTaskAdmission,
  type PluginTaskAdmissionPin,
} from "@crewon/domain";
import { SqliteExtensionStore, PostgresExtensionStore } from "@crewon/store";
import { ProjectMediaGenerationTaskPreparer } from "./project-media-generation-task-preparer.ts";

/** Logical user intent shared by page and Agent adapters. No provider or deployment fields. */
export type GenerateProjectMediaCommand = Readonly<{
  projectId: string;
  mediaInputId: string;
  inputRevision: number;
  expectedInputRevision: number;
  executionId: string;
  threadId: string;
  expectedThreadRevision: number;
  idempotencyKey: string;
}>;
type AdmissionResolver = Readonly<{
  /** Trusted host policy, independently checked for new and replayed executions. */
  resolve(
    input: Readonly<{
      actor: ActorContext;
      command: GenerateProjectMediaCommand;
      previous: PluginTaskAdmission | null;
      signal: AbortSignal;
    }>,
  ): Promise<PluginTaskAdmissionPin>;
}>;

/** Coordinates existing preparation and the original TaskCore. Owns no database or executor. */
export class ProjectMediaGenerationCommands {
  readonly #profileId: string;
  readonly #prepare: ProjectMediaGenerationTaskPreparer["prepareTask"];
  readonly #restore: ProjectMediaGenerationTaskPreparer["restoreAcceptedTask"];
  readonly #create: ExtensionTaskApplicationService["createProjectMediaTaskFromHost"];
  readonly #lookup: SqliteExtensionStore["loadPluginTaskAdmissionByReceipt"];
  readonly #resolve: AdmissionResolver["resolve"];
  readonly #closing = new AbortController();
  readonly #pending = new Set<Promise<unknown>>();
  #closed = false;

  constructor(
    input: Readonly<{
      profileId: string;
      preparer: ProjectMediaGenerationTaskPreparer;
      tasks: ExtensionTaskApplicationService;
      extensions: SqliteExtensionStore | PostgresExtensionStore;
      admissions: AdmissionResolver;
    }>,
  ) {
    const proto =
      input.extensions instanceof SqliteExtensionStore
        ? SqliteExtensionStore.prototype
        : input.extensions instanceof PostgresExtensionStore
          ? PostgresExtensionStore.prototype
          : null;
    if (
      !proto ||
      !(input.preparer instanceof ProjectMediaGenerationTaskPreparer) ||
      !(input.tasks instanceof ExtensionTaskApplicationService) ||
      [input.preparer, input.tasks, input.extensions].some((value) =>
        types.isProxy(value),
      )
    )
      fail("dependency_invalid");
    this.#profileId = projectAssetId(input.profileId);
    this.#prepare =
      ProjectMediaGenerationTaskPreparer.prototype.prepareTask.bind(
        input.preparer,
      );
    this.#restore =
      ProjectMediaGenerationTaskPreparer.prototype.restoreAcceptedTask.bind(
        input.preparer,
      );
    // The original Control Core installs an immutable wrapper on this genuine
    // instance to track physical mutations through shutdown. Calling the
    // prototype directly skips that owner; retain the issued wrapper instead.
    const create = Object.getOwnPropertyDescriptor(
      input.tasks,
      "createProjectMediaTaskFromHost",
    );
    if (
      create !== undefined &&
      (!("value" in create) ||
        typeof create.value !== "function" ||
        create.writable ||
        create.configurable)
    )
      fail("dependency_invalid");
    this.#create = (
      create?.value ??
      ExtensionTaskApplicationService.prototype.createProjectMediaTaskFromHost
    ).bind(input.tasks);
    this.#lookup = proto.loadPluginTaskAdmissionByReceipt.bind(
      input.extensions,
    );
    this.#resolve = projectMediaInputBound(input.admissions, "resolve");
  }

  generate(
    actorInput: ActorContext,
    input: GenerateProjectMediaCommand,
    options: Readonly<{ signal: AbortSignal }>,
  ) {
    if (this.#closed) fail("closed");
    const fields = materialPreparationFields(options, ["signal"]);
    if (!(fields.signal instanceof AbortSignal)) fail("task_invalid");
    const signal = AbortSignal.any([fields.signal, this.#closing.signal]);
    signal.throwIfAborted();
    const task = this.#generate(
      mediaInputActor(actorInput),
      parseCommand(input),
      signal,
    );
    this.#pending.add(task);
    void task.then(
      () => this.#pending.delete(task),
      () => this.#pending.delete(task),
    );
    return task;
  }

  async #generate(
    actor: ActorContext,
    command: GenerateProjectMediaCommand,
    signal: AbortSignal,
  ) {
    const raw = await this.#lookup({
      ...actor,
      profileId: this.#profileId,
      pluginId: "crewon.short-drama",
      idempotencyKey: pluginTaskReceiptKey(
        {
          actor,
          profileId: this.#profileId,
          pluginId: "crewon.short-drama",
          idempotencyKey: command.idempotencyKey,
        },
        {
          sha256: (value) =>
            "sha256:" + createHash("sha256").update(value).digest("hex"),
        },
      ),
    });
    signal.throwIfAborted();
    const previous = raw === null ? null : parsePluginTaskAdmission(raw);
    if (
      previous &&
      (previous.threadId !== command.threadId ||
        previous.action !== "media.generate")
    )
      fail("replay_conflict");
    const pin = parsePluginTaskAdmissionPin(
      await this.#resolve({ actor, command, previous, signal }),
    );
    signal.throwIfAborted();
    if (
      !mediaInputSame(
        {
          tenantId: pin.tenantId,
          spaceId: pin.spaceId,
          principalId: pin.principalId,
          actorId: pin.actorId,
        },
        actor,
      ) ||
      pin.profileId !== this.#profileId ||
      pin.pluginId !== "crewon.short-drama" ||
      pin.action !== "media.generate"
    )
      fail("owner_mismatch");
    const {
        projectId,
        mediaInputId,
        inputRevision,
        expectedInputRevision,
        executionId,
      } = command,
      selectors = {
        projectId,
        mediaInputId,
        inputRevision,
        expectedInputRevision,
        executionId,
      };
    const task: ProjectMediaGenerationTask = previous
      ? await this.#restore(
          actor,
          {
            tenantId: actor.tenantId,
            spaceId: actor.spaceId,
            runId: previous.runId,
          },
          { signal },
        )
      : await this.#prepare(actor, selectors, { signal });
    const reference = task.reference;
    if (
      !mediaInputSame(selectors, {
        projectId: reference.projectId,
        mediaInputId: reference.mediaInputId,
        inputRevision: reference.inputRevision,
        expectedInputRevision: reference.expectedInputRevision,
        executionId: reference.executionId,
      })
    )
      fail("replay_conflict");
    signal.throwIfAborted();
    // TaskCore verifies the full original command digest and admission; a receipt lookup is never proof of replay.
    // Once committed, retain its known outcome even if close/abort arrives before delivery.
    return this.#create({
      actor,
      pin,
      task,
      command: {
        pluginId: "crewon.short-drama",
        threadId: command.threadId,
        expectedThreadRevision: command.expectedThreadRevision,
        idempotencyKey: command.idempotencyKey,
        intent: {
          kind: "generate",
          input: projectMediaGenerationTaskInput(reference),
        },
      },
    });
  }

  async close() {
    this.#closed = true;
    this.#closing.abort();
    await Promise.allSettled([...this.#pending]);
  }
}

function parseCommand(input: unknown): GenerateProjectMediaCommand {
  const f = materialPreparationFields(input, [
    "projectId",
    "mediaInputId",
    "inputRevision",
    "expectedInputRevision",
    "executionId",
    "threadId",
    "expectedThreadRevision",
    "idempotencyKey",
  ]);
  return Object.freeze({
    projectId: projectAssetId(f.projectId),
    mediaInputId: projectAssetId(f.mediaInputId),
    inputRevision: projectAssetRevision(f.inputRevision),
    expectedInputRevision: projectAssetRevision(f.expectedInputRevision),
    executionId: projectAssetId(f.executionId),
    threadId: projectAssetId(f.threadId),
    expectedThreadRevision: projectAssetRevision(f.expectedThreadRevision),
    idempotencyKey: projectAssetId(f.idempotencyKey),
  });
}
