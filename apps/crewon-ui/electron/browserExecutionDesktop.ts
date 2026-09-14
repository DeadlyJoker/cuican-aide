import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createBrowserExecutionAuthority } from "./browserExecutionAuthority.ts";
import { BrowserExecutionHost } from "./browserExecutionHost.ts";
import { startBrowserExecutionTransport } from "./browserExecutionTransport.ts";
import type { RecordingExecutionAccess } from "./recordingExecutionSession.ts";
import type { ControlRuntimeSession } from "./runtimeSupervisor.ts";

/** Connect the existing recording view to the current local Control authority. */
export async function startDesktopBrowserExecution(options: {
  sessions: RecordingExecutionAccess;
  session: () => ControlRuntimeSession;
  dataDirectory: string;
  moduleDirectory: string;
}) {
  const host = new BrowserExecutionHost({
    sessions: options.sessions,
    authority: createBrowserExecutionAuthority(options.session),
    dataDirectory: options.dataDirectory,
    inspectionBundle: readFileSync(
      join(options.moduleDirectory, "browser-execution-inspection.js"),
      "utf8",
    ),
  });
  try {
    const transport = await startBrowserExecutionTransport(host);
    let closing: Promise<void> | undefined;
    return {
      host,
      connection: { url: transport.url, token: transport.token },
      close(): Promise<void> {
        if (!closing) {
          host.close();
          closing = transport.close();
        }
        return closing;
      },
    };
  } catch (error) {
    host.close();
    throw error;
  }
}
