import type { ProcessMetric } from "electron";
import type { startSoakMetrics } from "./metrics.ts";

export type SoakDesktopState = {
  pid: number;
  visible: boolean;
  main: ReturnType<ReturnType<typeof startSoakMetrics>["snapshot"]>;
  processes: ProcessMetric[];
  renderer: {
    url: string;
    hidden: boolean;
    ready: string;
    nodes: number;
    heap: { used: number; total: number } | null;
    composer: boolean;
    login: boolean;
    threads: { id: string; selected: boolean; title: string }[];
  };
};
