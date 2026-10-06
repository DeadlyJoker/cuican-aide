import {
  materialPreparationFields,
  materialPreparationDigester,
  projectMediaInputBound,
  mediaInputSame,
  mediaGenerationFail as fail,
  assertProjectMediaGenerationCurrent,
  assertProjectMediaGenerationActive,
  type ActorContext,
  type ProjectMediaGenerationTask,
} from "@crewon/application";
import {
  parsePluginTaskAdmissionPin,
  parseProjectConversationBinding,
  type PluginTaskAdmissionPin,
  type ProjectConversationBinding,
} from "@crewon/domain";

/** Private live host evidence. No part of this object is accepted from a page or model. */
export type ProjectMediaGenerationAdmission = Readonly<{
  pin: PluginTaskAdmissionPin;
  conversation: ProjectConversationBinding | null;
  assertCurrent(): Promise<void>;
  /** Policy/lifetime only. The Store checks conversation and Thread on its original connection. */
  assertTransactionCurrent(): Promise<void>;
  assertActive(): void;
}>;

export function captureProjectMediaGenerationAdmission(
  input: ProjectMediaGenerationAdmission,
  actor: ActorContext,
  command: Readonly<{ projectId: string; threadId: string }>,
): ProjectMediaGenerationAdmission {
  const f = materialPreparationFields(input, [
    "pin",
    "conversation",
    "assertCurrent",
    "assertTransactionCurrent",
    "assertActive",
  ]);
  const pin = parsePluginTaskAdmissionPin(f.pin);
  const conversation =
    f.conversation === null
      ? null
      : parseProjectConversationBinding(
          f.conversation,
          materialPreparationDigester,
        );
  if (
    conversation !== null &&
    (!mediaInputSame(conversation.owner, actor) ||
      conversation.projectId !== command.projectId ||
      conversation.threadId !== command.threadId ||
      conversation.profileId !== pin.profileId ||
      conversation.currentInstallation.pluginId !== pin.pluginId ||
      conversation.state !== "active")
  )
    fail("conversation_mismatch");
  return Object.freeze({
    pin,
    conversation,
    assertCurrent: projectMediaInputBound<
      ProjectMediaGenerationAdmission["assertCurrent"]
    >(input, "assertCurrent"),
    assertTransactionCurrent: projectMediaInputBound<
      ProjectMediaGenerationAdmission["assertTransactionCurrent"]
    >(input, "assertTransactionCurrent"),
    assertActive: projectMediaInputBound<
      ProjectMediaGenerationAdmission["assertActive"]
    >(input, "assertActive"),
  });
}
export function assertMediaAdmissionActive(a: ProjectMediaGenerationAdmission) {
  const result: unknown = a.assertActive();
  if (result === undefined) return;
  try {
    void Promise.prototype.then.call(
      result,
      () => {},
      () => {},
    );
  } catch {
    /* No arbitrary thenables. */
  }
  fail("authority_invalid");
}
export async function assertMediaAdmissionCurrent(
  a: ProjectMediaGenerationAdmission,
  phase: "before" | "transaction" = "before",
) {
  assertMediaAdmissionActive(a);
  if (
    (await (phase === "before"
      ? a.assertCurrent()
      : a.assertTransactionCurrent())) !== undefined
  )
    fail("authority_invalid");
  assertMediaAdmissionActive(a);
}
export function bindProjectMediaGenerationAdmission(
  task: ProjectMediaGenerationTask,
  admission: ProjectMediaGenerationAdmission,
): ProjectMediaGenerationTask {
  const active = () => {
    assertMediaAdmissionActive(admission);
    assertProjectMediaGenerationActive(task.authority);
  };
  const current = async (phase: "before" | "transaction") => {
    await assertMediaAdmissionCurrent(admission, phase);
    await assertProjectMediaGenerationCurrent(task.authority, phase);
    await assertMediaAdmissionCurrent(admission, phase);
  };
  return Object.freeze({
    reference: task.reference,
    authority: Object.freeze({
      ...task.authority,
      ...(admission.conversation === null
        ? {}
        : { conversation: admission.conversation }),
      assertCurrent: () => current("before"),
      assertTransactionCurrent: () => current("transaction"),
      assertActive: active,
    }),
    preflight: Object.freeze({
      assertNewInput: async (
        input: Parameters<typeof task.preflight.assertNewInput>[0],
      ) => {
        await current("before");
        await task.preflight.assertNewInput(input);
        await current("before");
      },
      assertDispatchCurrent: async () => {
        await current("before");
        await task.preflight.assertDispatchCurrent();
        await current("before");
      },
    }),
  });
}
