import {
  ApplicationError,
  type ActorContext,
  type PluginInstallationAuthorizationAction,
} from "@crewon/application";
import type { PluginProfileScope } from "@crewon/domain";
import type { DesktopPluginAuthority } from "./desktop-plugin-authority.ts";
import { installationSame } from "./production-plugin-installation-runtime-support.ts";

export type DesktopPluginAuthorityRequest = Readonly<{
  actor: ActorContext;
  scope: PluginProfileScope;
  action: PluginInstallationAuthorizationAction;
  pluginId: string | null;
  packageDigest: string | null;
}>;

/** Refreshes the original Native authority around asynchronous profile reads.
 * The operation is the actual queue-owned context, not a renderer permission DTO.
 */
export async function refreshDesktopPluginInstallationAuthority(
  input: Readonly<{
    request: DesktopPluginAuthorityRequest;
    authority: DesktopPluginAuthority;
    operation: { epoch: string | null };
    assertCurrent(): void;
  }>,
): Promise<string> {
  const { request, authority, operation } = input;
  input.assertCurrent();
  const current = await authority.profile(request.actor);
  input.assertCurrent();
  if (!installationSame(current, request.scope))
    denied("plugin_profile_changed");
  const before = await authority.epoch(request);
  input.assertCurrent();
  const after = await authority.profile(request.actor);
  input.assertCurrent();
  if (!installationSame(after, request.scope)) denied("plugin_profile_changed");
  const epoch = await authority.epoch(request);
  input.assertCurrent();
  const final = await authority.profile(request.actor);
  input.assertCurrent();
  if (!installationSame(final, request.scope)) denied("plugin_profile_changed");
  if (
    before !== epoch ||
    (operation.epoch !== null && operation.epoch !== epoch)
  )
    denied("plugin_installation_authority_changed");
  operation.epoch = epoch;
  return epoch;
}
function denied(code: string): never {
  throw new ApplicationError("authorization", code);
}
