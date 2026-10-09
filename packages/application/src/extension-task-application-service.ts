import {
  createProjectMediaInputStageTurnFromHost,
  type ProjectMediaInputConversationTask,
  type ProjectMediaInputConversationTaskPreparation,
} from "./project-media-input-conversation-task-support.ts";
import { createExtensionTaskTurn } from "./extension-task-turn.ts";
import type { ProjectMediaGenerationTask } from "./project-media-generation-port.ts";

import {
  createProjectAssetStageTurnFromHost,
  type ProjectAssetConversationTask,
  type ProjectAssetConversationTaskPreparation,
} from "./project-asset-conversation-task-support.ts";
import { commitProjectTextPlanTurnFromHost } from "./extension-task-project-text-plan-support.ts";
import type { ProjectTextPlanTurnCommitAuthority } from "./project-text-plan-store-port.ts";

import {
  createProjectConversationTurnFromHost,
  type ProjectConversationTaskPreparation,
  type ProjectConversationTask,
} from "./project-conversation-task-support.ts";
import type { PluginTaskUnmeteredAuthorityPort } from "./plugin-task-unmetered-authority-port.ts";
import { capturePluginTaskUnmeteredPort } from "./plugin-task-unmetered-support.ts";

import {
  captureProjectGenerationTask,
  capturePublishedProjectGenerationTask,
  type CapturedProjectGenerationTask,
  type ProjectGenerationApplicationPorts,
} from "./project-generation-application-support.ts";
import type { ProjectGenerationReference } from "@crewon/domain";
import type { CreativeProjectCommitAuthority } from "./creative-project-store-port.ts";
import type { CreatePublishedProjectTaskInput } from "./project-generation-execution-authority.ts";
import type { CreatePublishedProjectQueryTaskInput } from "./project-query-execution-authority.ts";
import type { ProjectGenerationReadApplicationService } from "./project-generation-read-application-service.ts";
import {
  getPublishedProjectGenerationReadiness,
  type GetPublishedProjectGenerationReadinessInput,
} from "./project-generation-readiness-application-service.ts";

import {
  type WorkflowSchemaValue,
  type PluginTaskAdmissionPin,
} from "@crewon/domain";

import type { ActorContext, AuthorizationPort } from "./authorization-port.ts";
import type {
  ApplicationClock,
  ApplicationIdGenerator,
  ContentDigester,
} from "./application-runtime-ports.ts";
import type {
  ExtensionCatalogPort,
  ExtensionHostPort,
} from "./extension-host-port.ts";
import type { ExtensionStore } from "./extension-store-port.ts";
import type { ExtensionQueryHostPort } from "./extension-query-host-port.ts";
import type { PluginQueryHostPort } from "./plugin-query-source.ts";
import { PluginQueryTaskApplicationService } from "./plugin-query-task-application-service.ts";
import type { ExternalOperationStore } from "./external-operation-store-port.ts";
import type { RunStore } from "./run-store-port.ts";
import type { ExtensionCreditQuotePort } from "./extension-credit-quote-port.ts";
import { TurnApplicationService } from "./turn-application-service.ts";

import {
  capturePluginTaskCommitAuthority,
  checkedPluginTaskPin,
  type PluginTaskCommitAuthorityPort,
} from "./extension-plugin-task-support.ts";

export type ExtensionTaskIntent =
  | Readonly<{ kind: "generate"; input: WorkflowSchemaValue }>
  | Readonly<{ kind: "query"; sourceRunId: string; operationId: string }>;
export type CreateExtensionTaskCommand = Readonly<{
  pluginId: string;
  threadId: string;
  expectedThreadRevision: number;
  idempotencyKey: string;
  intent: ExtensionTaskIntent;
}>;
type TaskStore = ConstructorParameters<
  typeof TurnApplicationService
>[0]["store"] &
  Pick<RunStore, "loadRunInSpace">;
export type ExtensionTaskApplicationDependencies = Readonly<{
  store: TaskStore;
  extensions: ExtensionStore;
  operations: ExternalOperationStore;
  catalog: ExtensionCatalogPort;
  host: ExtensionHostPort;
  queryHost?: ExtensionQueryHostPort;
  pluginQueryHost?: PluginQueryHostPort;
  authorization: AuthorizationPort;
  clock: ApplicationClock;
  ids: ApplicationIdGenerator;
  digester: ContentDigester;
  creditQuotes?: ExtensionCreditQuotePort;
  unmeteredTasks?: PluginTaskUnmeteredAuthorityPort;
  modelSelection?: import("./plugin-task-model-selection.ts").PluginTaskModelSelectionPort;
  /** Explicit project generation integration; ordinary tasks never read project metadata. */
  creativeProjects?: ProjectGenerationApplicationPorts;
  projectGenerationReads?: ProjectGenerationReadApplicationService;
}>;
type Dependencies = ExtensionTaskApplicationDependencies;

/** Creates an opt-in user Turn through the existing execution authority and one storage transaction. */
export class ExtensionTaskApplicationService {
  readonly #dependencies: Dependencies;
  readonly #unmeteredTasks: PluginTaskUnmeteredAuthorityPort | undefined;
  readonly #turns: TurnApplicationService;
  readonly #taskAdmissionMode: ExtensionHostPort["taskAdmissionMode"];
  constructor(dependencies: Dependencies) {
    this.#dependencies = dependencies;
    this.#unmeteredTasks = capturePluginTaskUnmeteredPort(
      dependencies.unmeteredTasks,
    );
    this.#turns = new TurnApplicationService(dependencies);
    const taskAdmissionMode = dependencies.host.taskAdmissionMode;
    this.#taskAdmissionMode =
      taskAdmissionMode === undefined
        ? undefined
        : taskAdmissionMode.bind(dependencies.host);
  }

  async createTask(
    actorInput: ActorContext,
    input: CreateExtensionTaskCommand,
  ) {
    return this.#createTask(actorInput, input, null);
  }
  /** Dedicated host-issued media qualification; the original public v0 command stays unchanged. */
  createProjectMediaTaskFromHost(
    input: Readonly<{
      actor: ActorContext;
      command: CreateExtensionTaskCommand;
      pin: PluginTaskAdmissionPin;
      task: ProjectMediaGenerationTask;
    }>,
  ) {
    return createExtensionTaskTurn(
      {
        dependencies: this.#dependencies,
        unmeteredTasks: this.#unmeteredTasks,
        turns: this.#turns,
        taskAdmissionMode: this.#taskAdmissionMode,
      },
      {
        actorInput: input.actor,
        input: input.command,
        pin: checkedPluginTaskPin(input.pin),
        mediaTask: input.task,
      },
    );
  }

  /** Internal host-issued authority only. The original v0 HTTP command does not accept this pin. */
  async createTaskFromPlugin(
    actorInput: ActorContext,
    input: CreateExtensionTaskCommand,
    hostDerivedPin: PluginTaskAdmissionPin,
    commitAuthority?: PluginTaskCommitAuthorityPort,
  ) {
    return this.#createTask(
      actorInput,
      input,
      checkedPluginTaskPin(hostDerivedPin),
      capturePluginTaskCommitAuthority(commitAuthority),
    );
  }

  /** Explicit host-qualified project Turn; the user Message remains plain text. */
  async createProjectConversationTurnFromHost(
    actor: ActorContext,
    command: CreateExtensionTaskCommand,
    task: ProjectConversationTask | ProjectConversationTaskPreparation,
  ) {
    return createProjectConversationTurnFromHost({
      actor,
      command,
      task,
      extensions: this.#dependencies.extensions,
      digester: this.#dependencies.digester,
      create: (captured, onStage) =>
        this.#createTask(
          actor,
          command,
          captured.authority.pin,
          null,
          null,
          captured,
          onStage,
        ),
    });
  }

  /** Independently approved media-input preparation; preserves the original Thread/Turn and unmetered admission. */
  createProjectMediaInputStageTurnFromHost(
    actor: ActorContext,
    command: CreateExtensionTaskCommand,
    task:
      | ProjectMediaInputConversationTask
      | ProjectMediaInputConversationTaskPreparation,
  ) {
    return createProjectMediaInputStageTurnFromHost({
      actor,
      command,
      task,
      extensions: this.#dependencies.extensions,
      digester: this.#dependencies.digester,
      create: (captured, onStage) =>
        createExtensionTaskTurn(
          {
            dependencies: this.#dependencies,
            unmeteredTasks: this.#unmeteredTasks,
            taskAdmissionMode: this.#taskAdmissionMode,
            turns: this.#turns,
          },
          {
            actorInput: actor,
            input: command,
            pin: captured.authority.pin,
            mediaInputStage: { task: captured, onStage },
          },
        ),
    });
  }

  /** Independently approved asset candidate stage; never reinterprets a text-stage grant. */
  createProjectAssetStageTurnFromHost(
    actor: ActorContext,
    command: CreateExtensionTaskCommand,
    task:
      | ProjectAssetConversationTask
      | ProjectAssetConversationTaskPreparation,
  ) {
    return createProjectAssetStageTurnFromHost({
      actor,
      command,
      task,
      extensions: this.#dependencies.extensions,
      digester: this.#dependencies.digester,
      create: (captured, onStage) =>
        this.#createTask(
          actor,
          command,
          captured.authority.pin,
          null,
          null,
          null,
          undefined,
          null,
          { task: captured, onStage },
        ),
    });
  }

  async createQueryTaskFromPlugin(
    actor: ActorContext,
    input: CreateExtensionTaskCommand,
    pin: PluginTaskAdmissionPin,
    authority?: PluginTaskCommitAuthorityPort,
  ) {
    return new PluginQueryTaskApplicationService(this.#dependencies).create(
      actor,
      input,
      pin,
      authority,
    );
  }

  /** Independent delegated plan path; the original conversation/UI request shape is unchanged. */
  async createProjectTextPlanTurnFromHost(
    actor: ActorContext,
    command: CreateExtensionTaskCommand,
    task: ProjectConversationTask | ProjectConversationTaskPreparation,
    planAuthority: ProjectTextPlanTurnCommitAuthority,
  ) {
    return commitProjectTextPlanTurnFromHost({
      actor,
      command,
      task,
      planAuthority,
      extensions: this.#dependencies.extensions,
      digester: this.#dependencies.digester,
      create: (captured, onStage, q) =>
        this.#createTask(
          actor,
          command,
          captured.authority.pin,
          null,
          null,
          captured,
          onStage,
          q,
        ),
    });
  }

  createHistoricalPublishedProjectQueryTaskFromPlugin(
    input: import("./project-historical-query-execution-authority.ts").CreateHistoricalPublishedProjectQueryTaskInput,
  ) {
    return new PluginQueryTaskApplicationService(
      this.#dependencies,
    ).createHistoricalPublished(input);
  }

  createPublishedProjectQueryTaskFromPlugin(
    input: CreatePublishedProjectQueryTaskInput,
  ) {
    return new PluginQueryTaskApplicationService(
      this.#dependencies,
    ).createPublished(input);
  }

  /** Internal host-issued project source and authority; the original public task body stays strict. */
  async createProjectTaskFromPlugin(
    actor: ActorContext,
    command: CreateExtensionTaskCommand,
    pin: PluginTaskAdmissionPin,
    reference: ProjectGenerationReference,
    authority: CreativeProjectCommitAuthority,
  ) {
    return this.#createTask(
      actor,
      command,
      checkedPluginTaskPin(pin),
      null,
      captureProjectGenerationTask(reference, authority),
    );
  }

  /** Actual business and execution installation owners; ordinary task bodies cannot provide this qualification. */
  async createPublishedProjectTaskFromPlugin(
    input: CreatePublishedProjectTaskInput,
  ) {
    const captured = capturePublishedProjectGenerationTask(input);
    return this.#createTask(
      captured.actor,
      captured.command,
      captured.executionPin,
      null,
      captured.captured,
    );
  }

  /** Advisory saved-source readiness; no quote, reservation, Node task or Run is created. */
  getPublishedProjectGenerationReadiness(
    input: GetPublishedProjectGenerationReadinessInput,
  ) {
    return getPublishedProjectGenerationReadiness(
      { ...this.#dependencies, unmeteredTasks: this.#unmeteredTasks },
      input,
    );
  }

  async #createTask(
    actorInput: ActorContext,
    input: CreateExtensionTaskCommand,
    pin: PluginTaskAdmissionPin | null,
    commitAuthority: PluginTaskCommitAuthorityPort | null = null,
    projectTask: CapturedProjectGenerationTask | null = null,
    conversation: ProjectConversationTask | null = null,
    onProjectStage?: (
      stage: import("@crewon/domain").ProjectStageRunAdmission,
    ) => void,
    projectTextPlan: ProjectTextPlanTurnCommitAuthority | null = null,
    assetStage: Readonly<{
      task: ProjectAssetConversationTask;
      onStage(
        stage: import("@crewon/domain").ProjectAssetStageRunAdmission,
      ): void;
    }> | null = null,
  ) {
    return createExtensionTaskTurn(
      {
        dependencies: this.#dependencies,
        unmeteredTasks: this.#unmeteredTasks,
        taskAdmissionMode: this.#taskAdmissionMode,
        turns: this.#turns,
      },
      {
        actorInput,
        input,
        pin,
        commitAuthority,
        projectTask,
        conversation,
        onProjectStage,
        projectTextPlan,
        assetStage,
      },
    );
  }
}
