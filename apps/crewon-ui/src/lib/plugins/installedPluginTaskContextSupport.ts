import type { ExtensionTaskView, GetThreadResponse } from "@crewon/contracts";
import {
  parseExtensionRunId,
  parseGetExtensionTaskResponse,
} from "@crewon/contracts";
import type { ControlPluginUiModule } from "./controlPluginUiCatalog";
import { pluginUiCatalogIdentity } from "./controlPluginUiSupport";
import type { InstalledPluginTaskReceiptEvent } from "./installedPluginTaskReceipt";
import { readInstalledPluginTaskReceipt } from "./installedPluginTaskReceipt";
import { copyPluginUiJson, uiRecord } from "./pluginUiValidation";
import type {
  InstalledPluginTaskSource,
  InstalledPluginTaskThread,
} from "./useInstalledPluginTaskContext.types";

export const INSTALLED_PLUGIN_TASK_CONTEXT_LIMITS = Object.freeze({
  tasks: 8,
  bytes: 48 * 1024,
  pollMs: 5_000,
});
export const EMPTY_INSTALLED_PLUGIN_TASKS: readonly ExtensionTaskView[] =
  Object.freeze([]);
export function installedPluginUsesTasks(
  module: ControlPluginUiModule,
): boolean {
  return module.plugin.descriptor.requires.some(
    ({ service, apiVersion }) =>
      service === "crewon.tasks" && (apiVersion === "1" || apiVersion === "2"),
  );
}
export function installedPluginTaskModulePin(
  module: ControlPluginUiModule,
): string {
  return JSON.stringify([
    module.key,
    module.mountKey,
    module.contributionId,
    module.plugin,
  ]);
}
export function installedPluginTaskReceiptForModule(
  module: ControlPluginUiModule,
  event: InstalledPluginTaskReceiptEvent,
): boolean {
  return (
    event.lease.descriptor.pluginId === module.plugin.descriptor.pluginId &&
    event.lease.descriptor.publisherId ===
      module.plugin.descriptor.publisherId &&
    event.lease.contributionId === module.contributionId &&
    readInstalledPluginTaskReceipt(event.receipt) !== null
  );
}
export function installedPluginTaskReceiptHasCurrentPin(
  module: ControlPluginUiModule,
  event: InstalledPluginTaskReceiptEvent,
): boolean {
  return (
    installedPluginTaskReceiptForModule(module, event) &&
    pluginUiCatalogIdentity(event.lease) ===
      pluginUiCatalogIdentity(module.plugin)
  );
}
export function installedPluginTaskThread(
  response: GetThreadResponse,
  threadId: string,
  provisional: boolean,
): InstalledPluginTaskThread {
  const record = uiRecord(copyPluginUiJson(response, 16 * 1024));
  const thread = uiRecord(record.thread);
  if (
    Object.keys(record).length !== 2 ||
    !Object.hasOwn(record, "eventSequence") ||
    thread.threadId !== threadId ||
    thread.status !== "active" ||
    typeof thread.revision !== "number" ||
    !Number.isSafeInteger(thread.revision) ||
    thread.revision < 1 ||
    record.eventSequence !== thread.revision
  )
    throw new Error("plugin_task_thread_unavailable");
  return Object.freeze({ threadId, revision: thread.revision, provisional });
}
export function installedPluginTaskRunIds(
  ids: readonly string[],
): readonly string[] {
  const values = copyPluginUiJson(ids, 2048);
  if (!Array.isArray(values) || values.length > 8)
    throw new Error("plugin_task_context_invalid");
  return Object.freeze([
    ...new Set(values.map((id) => parseExtensionRunId(id))),
  ]);
}
export function installedPluginTaskSourceExists(
  tasks: readonly ExtensionTaskView[],
  source: InstalledPluginTaskSource | null,
): boolean {
  return (
    source === null ||
    tasks.some((task) =>
      task.operations.some(
        (operation) =>
          operation.sourceRunId === source.sourceRunId &&
          operation.operationId === source.operationId,
      ),
    )
  );
}

/** Preserve authoritative identifiers; only images/operations at the end may be omitted with an explicit truncation flag. */
export function installedPluginTaskProjection(
  thread: InstalledPluginTaskThread | null,
  values: readonly ExtensionTaskView[],
  source: InstalledPluginTaskSource | null,
  ready = false,
) {
  const tasks = values.slice(0, 8).map((task) => ({
    ...parseGetExtensionTaskResponse({ task }).task,
    operations: task.operations.map((operation) => ({
      ...operation,
      images: [...operation.images],
    })),
  }));
  const projection = () => ({
    taskContextReady: ready,
    ...(thread
      ? { threadId: thread.threadId, expectedThreadRevision: thread.revision }
      : {}),
    tasks,
    ...(source ? source : {}),
  });
  while (
    new TextEncoder().encode(JSON.stringify(projection())).length >
    INSTALLED_PLUGIN_TASK_CONTEXT_LIMITS.bytes
  ) {
    const last = [...tasks]
      .reverse()
      .find((task) => task.operations.length > 0);
    if (!last) throw new Error("plugin_task_projection_limit");
    const operation = last.operations.at(-1)!;
    if (operation.images.length > 0) operation.images.pop();
    else last.operations.pop();
    last.truncated = true;
  }
  const retainedSource = installedPluginTaskSourceExists(tasks, source)
    ? source
    : null;
  const data = copyPluginUiJson(
    {
      taskContextReady: ready,
      ...(thread
        ? { threadId: thread.threadId, expectedThreadRevision: thread.revision }
        : {}),
      tasks,
      ...(retainedSource ? retainedSource : {}),
    },
    INSTALLED_PLUGIN_TASK_CONTEXT_LIMITS.bytes,
  );
  return Object.freeze({
    tasks: Object.freeze(
      tasks.map((task) => parseGetExtensionTaskResponse({ task }).task),
    ),
    source: retainedSource,
    data,
  });
}
