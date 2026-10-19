type Sink = (line: string) => boolean | void;

/** Public error envelopes only: never inspect or serialize thrown values. */
export function createInstalledPluginHttpErrorDiagnostics(
  enabled: boolean,
  sink: Sink,
) {
  let remaining = 32;
  return (requestId: string, code: string, statusCode: number): void => {
    if (
      !enabled ||
      remaining === 0 ||
      !/^req-[a-zA-Z0-9]{1,48}$/u.test(requestId) ||
      !/^[a-z][a-z0-9_]{0,127}$/u.test(code) ||
      !Number.isInteger(statusCode) ||
      statusCode < 400 ||
      statusCode > 599
    )
      return;
    remaining--;
    try {
      if (
        sink(
          "CREWON_PLUGIN_HTTP_ERROR_DIAGNOSTIC:" +
            JSON.stringify({ requestId, code, statusCode }),
        ) === false
      )
        remaining = 0;
    } catch {
      remaining = 0;
    }
  };
}

export const reportInstalledPluginHttpError =
  createInstalledPluginHttpErrorDiagnostics(
    process.env.CREWON_PLUGIN_INVOCATION_DIAGNOSTICS === "1",
    (line) => process.stderr.write(line + "\n"),
  );
