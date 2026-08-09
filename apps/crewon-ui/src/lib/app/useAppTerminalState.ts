import { useRef, useState } from "react";

import {
  appendTerminalOutputChunk,
  appendTerminalOutputNotice,
  emptyTerminalOutputStream,
  startTerminalOutputStream,
  type TerminalOutputStream,
} from "../terminal/terminalOutputStream";

export function useAppTerminalState() {
  const [terminalCommand, setTerminalCommand] = useState("git status --short");
  const [terminalProcessId, setTerminalProcessIdState] = useState<
    string | null
  >(null);
  const terminalProcessIdRef = useRef<string | null>(null);
  /*
   * Output is kept outside `capabilityPanel` so switching workbench tabs no
   * longer discards a live session's stdout.
   */
  const [terminalOutput, setTerminalOutput] = useState<TerminalOutputStream>(
    emptyTerminalOutputStream,
  );

  function setTerminalProcessId(processId: string | null) {
    terminalProcessIdRef.current = processId;
    setTerminalProcessIdState(processId);
    if (processId) {
      setTerminalOutput((stream) =>
        startTerminalOutputStream(stream, processId),
      );
    }
  }

  function appendTerminalOutputDelta(processId: string, chunk: string) {
    setTerminalOutput((stream) =>
      appendTerminalOutputChunk(stream, processId, chunk),
    );
  }

  function appendTerminalOutputLine(notice: string) {
    setTerminalOutput((stream) => appendTerminalOutputNotice(stream, notice));
  }

  return {
    appendTerminalOutputDelta,
    appendTerminalOutputLine,
    setTerminalCommand,
    setTerminalProcessId,
    terminalCommand,
    terminalOutput,
    terminalProcessId,
    terminalProcessIdRef,
  };
}
