import {
  parseProjectSourceUploadPartLocator,
  parseProjectSourceUploadRequest,
} from "@crewon/contracts/project-source-uploads";
import { committedTaskContext } from "./plugin-ui-committed-task-support.ts";
import { PROJECT_SOURCE_UPLOAD_PLUGIN_ACTIONS } from "./project-source-upload-plugin-commit-authority.ts";
import type { PluginUiActionContext } from "./plugin-ui-ports.ts";

/** Raw bytes are never part of this snapshot. Its independent locator requires a real raw invocation. */
export function projectSourceUploadActionContext(input: PluginUiActionContext) {
  const base = committedTaskContext(input);
  const request =
    base.context.action ===
    PROJECT_SOURCE_UPLOAD_PLUGIN_ACTIONS["projectSourceUpload:write"]
      ? Object.freeze({
          action:
            PROJECT_SOURCE_UPLOAD_PLUGIN_ACTIONS["projectSourceUpload:write"],
          input: parseProjectSourceUploadPartLocator(base.context.input),
        })
      : parseProjectSourceUploadRequest({
          action: base.context.action,
          input: base.context.input,
        });
  const context = Object.freeze({
    ...base.context,
    action: request.action,
    input: request.input,
  });
  return Object.freeze({
    context,
    pin: base.pin,
    request,
    fingerprint: JSON.stringify(context),
  });
}
