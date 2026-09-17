import type { ProcessMetric } from "electron";
import type { startSoakMetrics } from "./metrics.ts";
import type { processRuntimeLogStatus } from "../../electron/processRuntimeLogs.ts";
import type { SOAK_RENDERER_MEMORY_OBSERVATION } from "./renderer-memory.ts";

export type SoakDesktopState = {
  pid: number;
  visible: boolean;
  main: ReturnType<ReturnType<typeof startSoakMetrics>["snapshot"]>;
  processes: ProcessMetric[];
  logging?: ReturnType<typeof processRuntimeLogStatus>;
  /** Missing in historical fixtures whose performance.memory samples may be cached. */
  rendererMemory?: typeof SOAK_RENDERER_MEMORY_OBSERVATION;
  renderer: {
    url: string;
    hidden: boolean;
    ready: string;
    timeOrigin: number;
    nodes: number;
    heap: { used: number; total: number } | null;
    composer: boolean;
    login: boolean;
    threads: { id: string; selected: boolean; title: string }[];
  };
};
