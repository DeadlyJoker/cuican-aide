import type { BrowserGrantScope } from "./browserExecutionGrant.ts";

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
        typeof r.target.name !== "string" ||
        r.target.name.length === 0 ||
        r.target.name.length > 120 ||
        typeof r.target.role !== "string" ||
        r.target.role.length > 120
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
