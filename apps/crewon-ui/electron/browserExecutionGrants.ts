import type { BrowserActInput } from "@crewon/contracts";
import type {
  BrowserGrantScope,
  BrowserSkillRef,
} from "../src/lib/browser-execution/browserExecutionGrant.ts";
export type BrowserRunIdentity = {
  runId: string;
  threadId: string;
  active: boolean;
  workspaceBindingId: string | null;
  skill: { ref: BrowserSkillRef; parameters: Record<string, unknown> } | null;
};
const deny = (): never => {
  throw new Error("requires_explicit_approval");
};
export { parseBrowserGrantScope } from "../src/lib/browser-execution/browserGrantScope.ts";
function parameter(parameters: Record<string, unknown>, key: string): string {
  const value = parameters[key];
  if (
    !["string", "number", "boolean"].includes(typeof value) ||
    String(value).length > 512
  )
    return deny();
  return String(value);
}
export function assertBrowserGrantAllows(
  scope: BrowserGrantScope,
  identity: BrowserRunIdentity,
  input: BrowserActInput,
  currentUrl: string,
  target: { role: string; name: string } | null,
  authorizedPageUrl: string,
): void {
  const skill = identity.skill;
  if (
    !skill ||
    ["skillId", "versionId", "contentDigest"].some(
      (k) =>
        skill.ref[k as keyof BrowserSkillRef] !==
        scope.skillVersionRef[k as keyof BrowserSkillRef],
    )
  )
    return deny();
  if (!scope.origins.includes(new URL(currentUrl).origin)) return deny();
  const approvedPages = [
    authorizedPageUrl,
    ...scope.rules
      .filter((r) => r.action === "navigate")
      .map((r) =>
        r.urlTemplate!.replace(/\{([A-Za-z0-9_]+)\}/g, (_, key: string) =>
          encodeURIComponent(parameter(skill.parameters, key)),
        ),
      ),
  ];
  if (
    input.action !== "navigate" &&
    !approvedPages.some(
      (url) => new URL(url).toString() === new URL(currentUrl).toString(),
    )
  )
    return deny();
  const allowed = scope.rules.some((r) => {
    if (r.action !== input.action) return false;
    if (r.action === "navigate") {
      const url = r.urlTemplate!.replace(
        /\{([A-Za-z0-9_]+)\}/g,
        (_, k: string) => encodeURIComponent(parameter(skill.parameters, k)),
      );
      return (
        "url" in input &&
        new URL(url).toString() === input.url &&
        scope.origins.includes(new URL(url).origin)
      );
    }
    if (
      !target ||
      r.target?.role !== target.role ||
      r.target?.name !== target.name
    )
      return false;
    if (r.value)
      return (
        ("literal" in r.value
          ? r.value.literal
          : parameter(skill.parameters, r.value.parameter)) ===
        ("value" in input ? input.value : undefined)
      );
    return true;
  });
  if (!allowed) return deny();
}
