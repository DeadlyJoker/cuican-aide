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
  bridge,
  onProceed,
}: {
  command: SkillExecutionInput;
  awaitingChoice: boolean;
  busy: boolean;
  scope?: BrowserGrantScope;
  bridge?: BrowserExecutionBridge;
  onProceed: (choice: "perAction" | "authorized") => void;
}) {
  return (
    <fieldset className="demonstrated-skill-browser" disabled={busy}>
      <BrowserExecutionAuthorization
        threadId={command.threadId}
        skillVersionRef={command.invocation.skill}
        scope={scope}
        bridge={bridge}
        onAuthorized={
          awaitingChoice ? () => onProceed("authorized") : undefined
        }
      />
      {awaitingChoice ? (
        <button
          className="button compact"
          type="button"
          onClick={() => onProceed("perAction")}
        >
          {command.purpose === "trial"
            ? "按逐次确认开始试跑"
            : "按逐次确认运行"}
        </button>
      ) : null}
    </fieldset>
  );
}
