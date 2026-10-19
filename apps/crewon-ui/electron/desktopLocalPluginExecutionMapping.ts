import type { DesktopPluginApprovalSettings } from "./desktopPluginBootstrap.ts";
import { composeDesktopLocalProjectAssetV2Approval } from "./desktopLocalProjectAssetV2Approval.ts";
import { composeDesktopLocalShortDramaMediaInputApproval } from "./desktopLocalShortDramaMediaInputs.ts";
import { composeDesktopLocalShortDramaMediaGenerationApproval } from "./desktopLocalShortDramaMediaGenerations.ts";
import { composeDesktopLocalComfyProjectExecutionApproval } from "./desktopLocalComfyProjectExecutionApproval.ts";
import {
  composeDesktopLocalHistoricalProjectQueryApproval,
  type DesktopLocalHistoricalProjectQueryTarget,
} from "./desktopLocalHistoricalProjectQueryApproval.ts";
import type { DesktopInstalledPluginExpectedCatalogEntry } from "./desktopInstalledPluginRuntime.ts";
import type { SetupSnapshot } from "./desktopLocalPluginExecutionSetupSnapshot.ts";

/** One exact prospective approval for both no-write reuse and stopped publication. */
export function composeDesktopLocalPluginExecutionMapping(
  input: Readonly<{
    snapshot: SetupSnapshot;
    entry: DesktopInstalledPluginExpectedCatalogEntry;
    approveMediaGenerations: boolean;
    historyQuery: DesktopLocalHistoricalProjectQueryTarget | null;
  }>,
): DesktopPluginApprovalSettings {
  const source = {
    descriptor: input.snapshot.descriptor,
    packageDigest: input.snapshot.pkg.packageDigest,
    contributionId: "workbench",
  };
  const generationApproval = composeDesktopLocalComfyProjectExecutionApproval({
    approval: input.snapshot.approval,
    source,
    target: {
      descriptor: input.snapshot.descriptor,
      contributionId: "workbench",
      entry: input.entry,
    },
  });
  const inputApproval = composeDesktopLocalShortDramaMediaInputApproval({
    approval: generationApproval,
    descriptor: source.descriptor,
    packageDigest: source.packageDigest,
    declaration: input.snapshot.mediaInputs,
  });
  const mediaApproval = input.approveMediaGenerations
    ? composeDesktopLocalShortDramaMediaGenerationApproval({
        approval: inputApproval,
        packageDigest: source.packageDigest,
      })
    : inputApproval;
  const selfApproval = composeDesktopLocalProjectAssetV2Approval({
    approval: mediaApproval,
    descriptor: source.descriptor,
    packageDigest: source.packageDigest,
  });
  const next =
    input.historyQuery === null
      ? selfApproval
      : composeDesktopLocalHistoricalProjectQueryApproval({
          claim: input.historyQuery,
          approval: selfApproval,
          policy: input.snapshot.policy,
        });
  return next;
}
