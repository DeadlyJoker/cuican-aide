import type { DatabaseSync } from "node:sqlite";
import type { PluginProjectWorkspaceNativeRegistrationStore } from "@crewon/application";
import { SqlitePluginProjectWorkspaceStore } from "./sqlite-plugin-project-workspace-store.ts";
/** One original parent connection and lifecycle; creating a port performs no migration or allocation. */
export function sqliteProjectWorkspacePorts(
  input: Readonly<{ database: DatabaseSync; assertOpen(): void }>,
) {
  const namespaces = new SqlitePluginProjectWorkspaceStore(input);
  const nativeRegistration: PluginProjectWorkspaceNativeRegistrationStore =
    Object.freeze({
      recordFromNativeObservation:
        namespaces.recordFromNativeObservation.bind(namespaces),
    });
  return Object.freeze({
    reads: namespaces.readonlyView(),
    migrate: namespaces.migrate.bind(namespaces),
    recordFromPluginUi: namespaces.recordFromPluginUi.bind(namespaces),
    nativeRegistration,
  });
}
