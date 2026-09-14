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
export function parseBrowserGrantScope(
  value: BrowserGrantScope,
): BrowserGrantScope {
  if (
    !value ||
    Object.keys(value).sort().join() !== "origins,rules,skillVersionRef" ||
    !value.skillVersionRef ||
    Object.keys(value.skillVersionRef).sort().join() !==
      "contentDigest,skillId,versionId" ||
    !/^[a-f0-9]{64}$/.test(
      value.skillVersionRef.contentDigest.replace(/^sha256:/, ""),
    ) ||
    ![value.skillVersionRef.skillId, value.skillVersionRef.versionId].every(
      (v) => typeof v === "string" && /^[A-Za-z0-9._:-]{1,256}$/.test(v),
    )
  )
    return deny();
  if (
    !Array.isArray(value.origins) ||
    value.origins.length < 1 ||
    value.origins.length > 8 ||
    !value.origins.every((o) => {
      try {
        const u = new URL(o);
        return (
          ["http:", "https:"].includes(u.protocol) &&
          u.origin === o &&
          !u.username &&
          !u.password
        );
      } catch {
        return false;
      }
    })
  )
    return deny();
  if (
    !Array.isArray(value.rules) ||
    value.rules.length < 1 ||
    value.rules.length > 32
  )
    return deny();
  for (const r of value.rules) {
    if (
      !r ||
      Object.keys(r).some(
        (k) => !["action", "target", "value", "urlTemplate"].includes(k),
      )
    )
      return deny();
    if (r.action === "navigate") {
      if (
        typeof r.urlTemplate !== "string" ||
        r.urlTemplate.length > 2048 ||
        r.target !== undefined ||
        r.value !== undefined
      )
        return deny();
      const literal = r.urlTemplate.replace(/\{[A-Za-z0-9_]+\}/g, "value");
      try {
        if (!value.origins.includes(new URL(literal).origin)) return deny();
      } catch {
        return deny();
      }
    } else {
      if (
        !["click", "fill", "select", "download"].includes(r.action) ||
        r.urlTemplate !== undefined ||
        !r.target ||
        Object.keys(r.target).sort().join() !== "name,role" ||
        ![r.target.name, r.target.role].every(
          (v) => typeof v === "string" && v.length > 0 && v.length <= 120,
        )
      )
        return deny();
      if (["fill", "select"].includes(r.action)) {
        if (
          !r.value ||
          Object.keys(r.value).length !== 1 ||
          !("literal" in r.value || "parameter" in r.value)
        )
          return deny();
        const v = "literal" in r.value ? r.value.literal : r.value.parameter;
        if (typeof v !== "string" || v.length > 512) return deny();
      } else if (r.value !== undefined) return deny();
    }
  }
  return structuredClone(value);
}
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
