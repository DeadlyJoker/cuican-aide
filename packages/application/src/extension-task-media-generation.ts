import {
  extensionCanonicalJson,
  type ExtensionRunBinding,
  type PluginTaskAdmissionPin,
  type WorkflowSchemaValue,
} from "@crewon/domain";
import type { ActorContext } from "./authorization-port.ts";
import type { CreateExtensionTaskCommand } from "./extension-task-application-service.ts";
import type {
  ExtensionStore,
  ExtensionMutationReceipt,
} from "./extension-store-port.ts";
import type { ProjectMediaGenerationTask } from "./project-media-generation-port.ts";
import {
  mediaInputData,
  mediaInputDigest,
  mediaInputSame,
} from "./project-media-input-record.ts";
import { materialPreparationFields } from "./project-material-preparation-record.ts";
import { projectMediaInputBound } from "./project-media-input-application-authority.ts";
import {
  MEDIA_GENERATION_ACTION,
  parseProjectMediaGenerationReference,
  parseProjectMediaGenerationLink,
  projectMediaGenerationTaskInput,
  captureProjectMediaGenerationAuthority,
  assertProjectMediaGenerationCurrent,
  assertProjectMediaGenerationActive,
  mediaGenerationFail as fail,
} from "./project-media-generation-record.ts";

/** Dedicated host qualification. Byte observations happen before the original Store transaction. */
export function projectMediaGenerationTaskAdmission(
  input: Readonly<{
    task: ProjectMediaGenerationTask;
    actor: ActorContext;
    command: CreateExtensionTaskCommand;
    pin: PluginTaskAdmissionPin;
    extensions: ExtensionStore;
  }>,
) {
  const { actor, command, pin, extensions } = input;
  if (
    extensions.projectMediaGenerationVersion !==
      "crewon.project-media-generation-link.v1" ||
    typeof extensions.loadProjectMediaGenerationLink !== "function"
  )
    fail("unavailable");
  if (
    pin.pluginId !== "crewon.short-drama" ||
    pin.action !== MEDIA_GENERATION_ACTION ||
    command.pluginId !== pin.pluginId ||
    command.intent.kind !== "generate"
  )
    fail("task_invalid");
  const taskFields = materialPreparationFields(input.task, [
    "reference",
    "authority",
    "preflight",
  ]);
  const reference = parseProjectMediaGenerationReference(taskFields.reference),
    authority = captureProjectMediaGenerationAuthority(
      taskFields.authority,
      actor,
      reference,
    ),
    preflight = Object.freeze({
      assertNewInput: projectMediaInputBound<
        ProjectMediaGenerationTask["preflight"]["assertNewInput"]
      >(taskFields.preflight, "assertNewInput"),
      assertDispatchCurrent: projectMediaInputBound<
        ProjectMediaGenerationTask["preflight"]["assertDispatchCurrent"]
      >(taskFields.preflight, "assertDispatchCurrent"),
    }),
    load = extensions.loadProjectMediaGenerationLink.bind(extensions),
    expected = projectMediaGenerationTaskInput(reference);
  if (!mediaInputSame(mediaInputData(command.intent.input), expected))
    fail("input_mismatch");
  return Object.freeze({
    reference,
    commitOptions: Object.freeze({
      projectMediaGenerationAuthority: authority,
    }),
    assertCurrent: () =>
      assertProjectMediaGenerationCurrent(authority, "before"),
    assertActive: () => assertProjectMediaGenerationActive(authority),
    receipt(base: ExtensionMutationReceipt): ExtensionMutationReceipt {
      return Object.freeze({
        ...base,
        requestDigest: mediaInputDigest({
          schemaVersion: "crewon.project-media-generation-command.v1",
          base,
          reference,
        }),
      });
    },
    async assertNewInput(taskInput: WorkflowSchemaValue) {
      if (!mediaInputSame(taskInput, expected)) fail("input_mismatch");
      await preflight.assertNewInput(taskInput);
      await assertProjectMediaGenerationCurrent(authority, "before");
    },
    async assertDispatchCurrent() {
      await preflight.assertDispatchCurrent();
      await assertProjectMediaGenerationCurrent(authority, "before");
    },
    async assertSaved(
      binding: ExtensionRunBinding,
      receipt: ExtensionMutationReceipt,
    ) {
      const raw = await load({
        tenantId: binding.tenantId,
        spaceId: binding.spaceId,
        runId: binding.runId,
      });
      if (!raw) fail("link_missing");
      const link = parseProjectMediaGenerationLink(raw);
      if (
        !mediaInputSame(link.reference, reference) ||
        !mediaInputSame(link.actor, actor) ||
        !mediaInputSame(link.binding, binding) ||
        extensionCanonicalJson(link.receipt) !== extensionCanonicalJson(receipt)
      )
        fail("replay_conflict");
    },
  });
}
