import assert from "node:assert/strict";
import test from "node:test";

import { findOwnedPackagedWindowsProcesses } from "./windows-packaged-processes.mjs";

test("finds only GUI, Node, and guardian processes owned by this installation", () => {
  const root = "C:\\runner\\crewon-installed";
  const app = `${root}\\crewon-ui.exe`;
  assert.deepEqual(
    findOwnedPackagedWindowsProcesses({
      appBinary: app,
      installRoot: root,
      processes: [
        process(101, "crewon-ui.exe", app),
        process(102, "crewon-node.exe", `${root}\\crewon-node.exe`),
        {
          CommandLine:
            '"C:\\runner\\crewon-installed\\crewon-process-guardian.exe" --parent 42',
          ExecutablePath: null,
          Name: "crewon-process-guardian.exe",
          ProcessId: 103,
        },
        process(104, "crewon-ui.exe", "C:\\runner\\other\\crewon-ui.exe"),
        process(105, "node.exe", "C:\\Program Files\\nodejs\\node.exe"),
      ],
    }),
    [
      {
        name: "crewon-ui.exe",
        processId: 101,
      },
      {
        name: "crewon-node.exe",
        processId: 102,
      },
      {
        name: "crewon-process-guardian.exe",
        processId: 103,
      },
    ],
  );
});

function process(processId, name, executablePath) {
  return {
    CommandLine: executablePath,
    ExecutablePath: executablePath,
    Name: name,
    ProcessId: processId,
  };
}
