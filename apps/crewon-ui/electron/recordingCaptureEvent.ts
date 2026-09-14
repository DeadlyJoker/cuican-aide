import type { RecordingSourceEvent } from "../src/lib/desktop/recordingBridge.ts";
import { safeRecordingText } from "./recordingPrivacy.ts";
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("recording_event_invalid");
  return value as Record<string, unknown>;
};
export function recordingCaptureEvent(raw: unknown): RecordingSourceEvent {
  const data = object(raw);
  if (
    Object.keys(data).sort().join(",") !==
      "input,kind,layout,reason,screenshotSafe,target" ||
    typeof data.screenshotSafe !== "boolean"
  )
    throw new Error("recording_event_invalid");
  const event = data as unknown as RecordingSourceEvent;
  if (event.reason !== null && safeRecordingText(event.reason) === null)
    throw new Error("recording_event_invalid");
  if (event.input !== null) {
    const input = object(event.input);
    if (!["input", "select"].includes(event.kind))
      throw new Error("recording_event_invalid");
    if (input.classification === "runtime-required") {
      if (Object.keys(input).length !== 1)
        throw new Error("recording_event_invalid");
    } else if (
      !["ordinary", "parameter-candidate"].includes(
        String(input.classification),
      ) ||
      Object.keys(input).sort().join(",") !== "classification,value"
    )
      throw new Error("recording_event_invalid");
  }
  if (!["click", "input", "select", "unsupported"].includes(event.kind))
    throw new Error("recording_event_invalid");
  if (event.target) {
    const target = object(event.target);
    if (
      Object.keys(target).sort().join(",") !==
        "accessibleName,description,role,selector,tag" ||
      (target.role !== null && safeRecordingText(target.role) === null)
    )
      throw new Error("recording_target_invalid");
    if (
      typeof target.selector !== "string" ||
      target.selector.length > 512 ||
      !/^[a-z0-9 >:()\-]+$/i.test(target.selector)
    )
      throw new Error("recording_target_invalid");
    if (
      safeRecordingText(target.description) === null ||
      safeRecordingText(target.tag) === null
    )
      throw new Error("recording_target_invalid");
    if (
      target.accessibleName !== null &&
      safeRecordingText(target.accessibleName) === null
    )
      throw new Error("recording_target_invalid");
  }
  if (
    event.input &&
    event.input.classification !== "runtime-required" &&
    safeRecordingText(event.input.value) === null
  )
    throw new Error("recording_input_invalid");
  return event;
}
