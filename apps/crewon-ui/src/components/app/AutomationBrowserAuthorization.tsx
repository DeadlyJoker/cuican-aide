import type { AutomationView } from "@crewon/contracts";
import { useId, useState } from "react";
import { BrowserExecutionAuthorization } from "../browser-execution/BrowserExecutionAuthorization";
import { needsSkillBrowserAuthorization } from "../skill/SkillBrowserAuthorization";
import "./AutomationBrowserAuthorization.css";

export function AutomationBrowserAuthorization({
  definition,
}: {
  definition: AutomationView;
}) {
  const invocation = definition.skillInvocation;
  if (
    !invocation ||
    !needsSkillBrowserAuthorization(invocation.requiredToolRefs)
  ) {
    return null;
  }
  const identity = JSON.stringify([
    definition.automationId,
    definition.threadId,
    invocation.skill,
    invocation.requiredToolRefs,
    definition.toolPermissionMode ?? "requestApproval",
  ]);
  return <AuthorizationEntry key={identity} definition={definition} />;
}

function AuthorizationEntry({ definition }: { definition: AutomationView }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const invocation = definition.skillInvocation!;
  const needsScope = invocation.requiredToolRefs.includes(
    "crewon_browser_act_scoped",
  );
  return (
    <div className="automation-browser-authorization">
      <button
        className="button compact"
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((current) => !current)}
      >
        {open ? "收起浏览器授权" : "浏览器授权"}
      </button>
      {open ? (
        <div id={panelId} className="automation-browser-authorization-panel">
          <p>
            授权绑定此日程的任务。重启应用或接管浏览器后，请重新授权；授权完成后可执行日程或等待下次安排。
          </p>
          <BrowserExecutionAuthorization
            threadId={definition.threadId}
            skillVersionRef={invocation.skill}
            toolPermissionMode={definition.toolPermissionMode}
            requiredScope={needsScope}
            parameterNames={Object.keys(invocation.parameters)}
          />
        </div>
      ) : null}
    </div>
  );
}
