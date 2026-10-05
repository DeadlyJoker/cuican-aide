import type { ProjectHistoricalQueryUiCodec } from "./project-historical-query-ui-client";
import type { ProjectHistoricalQueryHostContext } from "./plugin-project-historical-queries-service";

export declare const projectHistoricalQueryCodec: ProjectHistoricalQueryUiCodec;
export declare function parseProjectHistoricalQueryHostContext(
  input: unknown,
): ProjectHistoricalQueryHostContext;
