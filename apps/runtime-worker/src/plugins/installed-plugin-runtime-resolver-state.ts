import type {
  PluginActivationCandidate,
  PluginExecutionPackageFailureOwner,
} from "@crewon/plugin-host";
import type {
  InstalledPluginRuntimeResidentLifetime,
  InstalledPluginRuntimePrepared as Prepared,
} from "./installed-plugin-runtime-resident.ts";
import type { InstalledPluginProjectServices } from "./installed-plugin-project-services.ts";
import type { PluginExecutionIoOwner } from "./plugin-execution-io.ts";

export type Resident = InstalledPluginRuntimeResidentLifetime & {
  compositionAuthorization:
    | ((purpose: "submit" | "observe", signal: AbortSignal) => Promise<void>)
    | null;
  candidate: PluginActivationCandidate;
  prepared: Prepared;
  projectTools: InstalledPluginProjectServices | null;
  io: PluginExecutionIoOwner | null;
};
export type Entry = {
  key: string;
  ready: Promise<Resident> | null;
  resident: Resident | null;
  failureOwner: PluginExecutionPackageFailureOwner | null;
  users: number;
  published: boolean;
  closing: boolean;
  closeTask: Promise<void> | null;
  waitForUsers: (() => void) | null;
};
