import type { ExtensionReadApplicationService } from "@crewon/application";
import {
  pluginSecurityActor,
  pluginSecurityRecord,
} from "./plugin-security-validation.ts";

/** Preselect an already authorized reader. A denied read never changes lanes. */
export function composeDesktopProjectHistoryTaskReads(
  input: Readonly<{
    metadata: ExtensionReadApplicationService;
    native: Pick<ExtensionReadApplicationService, "getTask">;
    preparedPluginIds: readonly string[];
    assertCurrent(): Promise<void>;
  }>,
): ExtensionReadApplicationService {
  const prepared = new Set(input.preparedPluginIds);
  const metadataTask = input.metadata.getTask.bind(input.metadata);
  const nativeTask = input.native.getTask.bind(input.native);
  const getTask: ExtensionReadApplicationService["getTask"] = async (
    actorInput,
    command,
  ) => {
    const actor = pluginSecurityActor(actorInput);
    const fields = pluginSecurityRecord(command, ["pluginId", "runId"]);
    if (typeof fields.pluginId !== "string" || typeof fields.runId !== "string")
      throw new Error("desktop_project_history_task_identity_invalid");
    const captured = { pluginId: fields.pluginId, runId: fields.runId };
    await input.assertCurrent();
    // Same-namespace old Runs retain the Native reader's existing checks. Only
    // namespaces absent from this issued execution publication use cold history.
    const read = prepared.has(captured.pluginId) ? nativeTask : metadataTask;
    const result = await read(actor, captured);
    await input.assertCurrent();
    return result;
  };
  // The downstream captureMethod reads own data descriptors before prototypes.
  // Keep the original service instance private and expose only its three read
  // methods on an immutable shell with the same class prototype for owner binding.
  return Object.freeze(
    Object.create(Object.getPrototypeOf(input.metadata), {
      getTask: { value: getTask, enumerable: true },
      getCatalog: {
        value: input.metadata.getCatalog.bind(input.metadata),
        enumerable: true,
      },
      getRuntime: {
        value: input.metadata.getRuntime.bind(input.metadata),
        enumerable: true,
      },
    }),
  ) as ExtensionReadApplicationService;
}
