import { useRef, useState } from "react";

export function useAppTerminalState() {
  const [terminalCommand, setTerminalCommand] = useState("git status --short");
  const terminalProcessIdRef = useRef<string | null>(null);

  return {
    setTerminalCommand,
    terminalCommand,
    terminalProcessIdRef,
  };
}
