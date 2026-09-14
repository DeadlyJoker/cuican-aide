import type { SkillExecutionInput } from "../../lib/skill/demonstratedSkillClient";
import type {
  BrowserExecutionBridge,
  BrowserGrantScope,
} from "../../lib/browser-execution/browserExecutionGrant";
import { BrowserExecutionAuthorization } from "../browser-execution/BrowserExecutionAuthorization";

export function needsSkillBrowserAuthorization(toolRefs: readonly string[]) {
  return toolRefs.some(
    (ref) =>
      ref === "crewon_browser_act" || ref === "crewon_browser_act_scoped",
  );
}

export function SkillBrowserAuthorization({
  command,
  awaitingChoice,
  busy,
  scope,
  requiredScope,
  parameterNames,
  bridge,
  onProceed,
}: {
  command: SkillExecutionInput;
  awaitingChoice: boolean;
  busy: boolean;
  scope?: BrowserGrantScope;
  requiredScope?: boolean;
  parameterNames?: readonly string[];
  bridge?: BrowserExecutionBridge;
  onProceed: (choice: "perAction" | "authorized") => void;
}) {
  const needsScope =
    requiredScope ||
    command.invocation.requiredToolRefs.includes("crewon_browser_act_scoped");
  return (
    <fieldset className="demonstrated-skill-browser" disabled={busy}>
      <BrowserExecutionAuthorization
        threadId={command.threadId}
        skillVersionRef={command.invocation.skill}
        toolPermissionMode={command.toolPermissionMode}
        scope={scope}
        requiredScope={needsScope}
        parameterNames={
          parameterNames ?? Object.keys(command.invocation.parameters)
        }
        bridge={bridge}
        onAuthorized={
          awaitingChoice ? () => onProceed("authorized") : undefined
        }
      />
      {awaitingChoice && !needsScope ? (
        <button
          className="button compact"
          type="button"
          onClick={() => onProceed("perAction")}
        >
          {command.toolPermissionMode === "approveForMe"
            ? command.purpose === "trial"
              ? "按当前审批设置开始试跑"
              : "按当前审批设置运行"
            : command.purpose === "trial"
              ? "按逐次确认开始试跑"
              : "按逐次确认运行"}
        </button>
      ) : null}
    </fieldset>
  );
}
