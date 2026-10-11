import type { PluginInstallationStore } from "@crewon/application";
import type { PluginProfileScope } from "@crewon/domain";
import type { PluginCompositionHostService } from "@crewon/contracts/plugins";
import type {
  PluginActivationCandidate,
  PluginNodeHostServiceRegistration,
} from "@crewon/plugin-host";
import type { InstalledPluginRunContext } from "./installed-plugin-run-context.ts";
import type { PluginTaskAdmissionProbe } from "./installed-plugin-run-runtime.ts";
import type { InstalledPluginExecutionIoDependencies } from "./installed-plugin-execution-io-config.ts";
import type { InstalledPluginMediaExecutionDependencies } from "./installed-plugin-media-execution.ts";
import type { InstalledPluginProjectToolsDependencies } from "./installed-plugin-project-tools.ts";
import type { InstalledPluginProjectFoundationToolsDependencies } from "./installed-plugin-project-foundation-tools.ts";
import type { InstalledPluginProjectOutlineToolsDependencies } from "./installed-plugin-project-outline-tools.ts";
import type { InstalledPluginProjectMediaInputToolsDependencies } from "./installed-plugin-project-media-input-tools.ts";
import type { InstalledPluginCompositionAuthority } from "./installed-plugin-composition-authority.ts";

export type InstalledPluginRuntimeResolverDependencies = Readonly<{
  contexts: InstalledPluginRunContext;
  admissions: Required<
    Pick<
      PluginTaskAdmissionProbe,
      "pluginAdmissionVersion" | "loadPluginTaskAdmission"
    >
  > &
    Pick<
      PluginTaskAdmissionProbe,
      "pluginQueryAdmissionVersion" | "loadPluginQueryTaskAdmission"
    >;
  installations: PluginInstallationStore;
  installRoot: string;
  authorizePackage(
    input: Readonly<{
      candidate: PluginActivationCandidate;
      scope: PluginProfileScope;
      purpose: "submit" | "observe";
    }>,
    signal: AbortSignal,
  ): Promise<"allow" | "deny">;
  maximumRuntimes?: number;
  /** Explicit host implementation versions; missing support keeps composed execution closed. */
  compositionExecution?: Readonly<{
    hostServiceMetadata: readonly PluginCompositionHostService[];
    /** Actual trusted Host ports, paired with deployment metadata; never package/request declarations. */
    hostServices?: readonly PluginNodeHostServiceRegistration[];
    /** Actual live deployment authority. Absence preserves existing non-Native host contracts. */
    assertCurrentAuthority?: InstalledPluginCompositionAuthority;
  }>;
  executionIo?: InstalledPluginExecutionIoDependencies;
  projectTools?: InstalledPluginProjectToolsDependencies;
  projectFoundationTools?: InstalledPluginProjectFoundationToolsDependencies;
  projectOutlineTools?: InstalledPluginProjectOutlineToolsDependencies;
  projectMedia?: InstalledPluginMediaExecutionDependencies;
  projectMediaInputs?: InstalledPluginProjectMediaInputToolsDependencies;
}>;
