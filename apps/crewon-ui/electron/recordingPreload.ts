import { contextBridge, ipcRenderer } from "electron";
import type { RecordingBridge } from "../src/lib/desktop/recordingBridge.ts";
const invoke = <T>(method: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(`crewon:recording:${method}`, ...args) as Promise<T>;
export const recordingBridge: RecordingBridge = {
  open: () => invoke("open"),
  handoff: () => invoke("handoff"),
  state: () => invoke("state"),
  start: (url) => invoke("start", url),
  navigate: (url) => invoke("navigate", url),
  control: (request) => invoke("control", request),
  edit: (request) => invoke("edit", request),
  select: (id) => invoke("select", id),
  remove: (id) => invoke("remove", id),
  export: () => invoke("export"),
  evidence: (id) => invoke("evidence", id),
  bounds: (value) => invoke("bounds", value),
};
contextBridge.exposeInMainWorld("crewonRecording", recordingBridge);
