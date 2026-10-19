import { types } from "node:util";
import {
  extensionCanonicalJson,
  projectAssetInputFields,
  pluginInstallationDigest,
} from "@crewon/domain";
import type { ProjectReferenceMaterialSourceAdapter } from "@crewon/application";

export type ComfyUiMaterialSourceIdentity = Readonly<{
  pluginId: "crewon.comfyui-krea2" | "crewon.short-drama";
  pluginVersion: string;
  manifestDigest: string;
  implementationDigest: string;
}>;

/** Deployment-reviewed source identity and historical configuration only.
 * The returned path is data, never proof that bytes were read or a prepared input exists.
 */
export function createComfyUiProjectReferenceMaterialAdapter(
  input: Readonly<{ identities: readonly ComfyUiMaterialSourceIdentity[] }>,
): ProjectReferenceMaterialSourceAdapter {
  const raw = fields(input, ["identities"]),
    list = raw.identities;
  if (
    !Array.isArray(list) ||
    types.isProxy(list) ||
    Object.getPrototypeOf(list) !== Array.prototype ||
    list.length < 1 ||
    list.length > 32 ||
    Reflect.ownKeys(list).length !== list.length + 1
  )
    invalid();
  const identities = Array.from({ length: list.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(list, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))
      invalid();
    const r = fields(descriptor.value, [
      "pluginId",
      "pluginVersion",
      "manifestDigest",
      "implementationDigest",
    ]);
    if (
      (r.pluginId !== "crewon.short-drama" &&
        r.pluginId !== "crewon.comfyui-krea2") ||
      typeof r.pluginVersion !== "string" ||
      r.pluginVersion.length > 32 ||
      !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(
        r.pluginVersion,
      )
    )
      invalid();
    return Object.freeze({
      pluginId: r.pluginId,
      pluginVersion: r.pluginVersion,
      manifestDigest: pluginInstallationDigest(r.manifestDigest),
      implementationDigest: pluginInstallationDigest(r.implementationDigest),
    });
  });
  if (
    new Set(identities.map(extensionCanonicalJson)).size !== identities.length
  )
    invalid();
  return Object.freeze({
    deriveReadDestination(
      source: Parameters<
        ProjectReferenceMaterialSourceAdapter["deriveReadDestination"]
      >[0],
    ) {
      const c = source.configuration,
        link = source.resultLink;
      if (
        !identities.some(
          (i) =>
            i.pluginId === c.pluginId &&
            i.pluginVersion === c.pluginVersion &&
            i.manifestDigest === c.manifestDigest &&
            i.implementationDigest === c.implementationDigest,
        ) ||
        c.tenantId !== source.asset.tenantId ||
        c.spaceId !== source.asset.spaceId ||
        c.pluginId !== link.pluginId ||
        c.pluginVersion !== link.pluginVersion ||
        c.revision !== link.configurationRevision ||
        c.contentDigest !== link.configurationDigest ||
        typeof c.parameters.baseUrl !== "string"
      )
        invalid();
      const base = new URL(c.parameters.baseUrl);
      if (
        base.protocol !== "https:" ||
        base.username ||
        base.password ||
        base.search ||
        base.hash ||
        base.pathname !== "/"
      )
        invalid();
      const o = fields(JSON.parse(link.image.providerReferenceJson), [
        "filename",
        "subfolder",
        "type",
      ]);
      if (
        typeof o.filename !== "string" ||
        !o.filename ||
        o.filename.length > 255 ||
        o.filename.trim() !== o.filename ||
        /[\\/\[\]:\u0000-\u001f\u007f\ud800-\udfff]/u.test(o.filename) ||
        o.filename === "." ||
        o.filename === ".." ||
        typeof o.subfolder !== "string" ||
        o.subfolder.length > 512 ||
        o.subfolder.trim() !== o.subfolder ||
        /[\\\[\]:\u0000-\u001f\u007f\ud800-\udfff]/u.test(o.subfolder) ||
        o.subfolder.startsWith("/") ||
        o.subfolder
          .split("/")
          .some(
            (part) =>
              part === "." || part === ".." || (!part && o.subfolder !== ""),
          ) ||
        o.type !== "output" ||
        o.filename !== link.image.filename ||
        extensionCanonicalJson(o) !== link.image.providerReferenceJson
      )
        invalid();
      const output = Object.freeze({
        filename: o.filename,
        subfolder: o.subfolder,
        type: "output" as const,
      });
      const protocol = c.parameters.serviceProtocol;
      if (
        protocol !== undefined &&
        protocol !== "native" &&
        protocol !== "workflow-panel-v1" &&
        protocol !== "workflow-api-v1"
      )
        invalid();
      const viewPath =
        protocol === "workflow-panel-v1" || protocol === "workflow-api-v1"
          ? "/api/comfy/view"
          : "/view";
      const path = `${viewPath}?${new URLSearchParams(output)}`;
      if (new URL(path, base).href !== link.image.url) invalid();
      return Object.freeze({ origin: base.href, path, output });
    },
  });
}

function fields(input: unknown, keys: readonly string[]) {
  if (input !== null && typeof input === "object" && types.isProxy(input))
    invalid();
  return projectAssetInputFields(input, keys);
}
function invalid(): never {
  throw new Error("comfyui_project_material_source_invalid");
}
