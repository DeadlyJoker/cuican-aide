import { mkdirSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  ApplicationError,
  qualifyPluginProjectWorkspacePreparation,
} from "@crewon/application";
import { issuePluginProjectWorkspaceHostObservation } from "@crewon/application/host-project-workspaces";
import {
  LocalWorkspaceAuthority,
  LocalWorkspaceProjectAllocator,
} from "@crewon/store/host-workspace-management";
import type { ProjectConversationNativeProvisioning } from "./project-conversation-native-provisioning.ts";

/** One original registry for the long-lived Control owner. Paths never cross the UI or conversation protocol. */
export function createProductionProjectWorkspaceProvisioning(
  input: Readonly<{
    installRoot: string;
    registration: ProjectConversationNativeProvisioning["registration"];
    assertActive(): void;
  }>,
) {
  const directory = join(input.installRoot, ".host-project-workspaces");
  let authority: LocalWorkspaceAuthority | undefined;
  let directoryIdentity: Readonly<{ dev: number; ino: number }> | undefined;
  const assertDirectoryCurrent = () => {
    const stat = lstatSync(directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      realpathSync(directory) !== directory ||
      (stat.mode & 0o777) !== 0o700 ||
      (process.getuid && stat.uid !== process.getuid()) ||
      (directoryIdentity &&
        (stat.dev !== directoryIdentity.dev ||
          stat.ino !== directoryIdentity.ino))
    )
      invalid();
    return stat;
  };
  const management = () => {
    input.assertActive();
    if (authority) {
      assertDirectoryCurrent();
      return authority;
    }
    if (!isAbsolute(directory) || resolve(directory) !== directory) invalid();
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = assertDirectoryCurrent();
    directoryIdentity = { dev: stat.dev, ino: stat.ino };
    authority = new LocalWorkspaceAuthority(directory);
    return authority;
  };
  return Object.freeze({
    registration: input.registration,
    async observe(preparation) {
      const source = qualifyPluginProjectWorkspacePreparation(preparation);
      await source.assertCurrent();
      input.assertActive();
      const allocator = new LocalWorkspaceProjectAllocator(
        management(),
        source.owner,
      );
      const allocated = allocator.provision();
      if (
        allocated.workspaceId !== source.expectedWorkspaceId ||
        allocated.phase !== "registered" ||
        allocated.observation !== "registered" ||
        allocated.failureCode !== null
      )
        invalid();
      await source.assertCurrent();
      return issuePluginProjectWorkspaceHostObservation(
        preparation,
        () => {
          assertDirectoryCurrent();
          return allocator.inspect();
        },
        input.assertActive,
      );
    },
  } satisfies ProjectConversationNativeProvisioning);
}
function invalid(): never {
  throw new ApplicationError(
    "conflict",
    "project_conversation_host_workspace_unavailable",
  );
}
