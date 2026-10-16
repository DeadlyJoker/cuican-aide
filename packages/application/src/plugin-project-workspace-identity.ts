import {
  pluginProjectWorkspaceIdentityInput,
  type PluginProjectWorkspaceOwner,
} from "@crewon/domain";
import type { ContentDigester } from "./application-runtime-ports.ts";
import { ApplicationError } from "./application-error.ts";

/** Stable persisted identity; physical hashing is supplied by the owning host. */
export function pluginProjectWorkspaceId(
  owner: PluginProjectWorkspaceOwner,
  digester: ContentDigester,
): string {
  const digest = digester.sha256(pluginProjectWorkspaceIdentityInput(owner));
  if (!/^sha256:[a-f0-9]{64}$/u.test(digest))
    throw new ApplicationError(
      "internal",
      "plugin_project_workspace_digest_invalid",
    );
  return `workspace-project-${digest.slice(7)}`;
}
