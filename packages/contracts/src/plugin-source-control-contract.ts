import { PLUGIN_PACKAGE_LIMITS } from "./plugin-package-contract.ts";
import {
  MAX_PLUGIN_CONTROL_RESPONSE_BYTES,
  parsePluginControlPackageDigest,
  parsePluginControlPluginId,
} from "./plugin-control-contract.ts";
import {
  copyPluginControlJson,
  pluginControlArray,
  pluginControlFail,
  pluginControlLimit,
  pluginControlOpaqueId,
  pluginControlRecord,
  pluginControlVersion,
} from "./plugin-control-contract-support.ts";

/** Public metadata only. Source paths, profile authority and install permission remain host-owned. */
export type PluginSourceView = Readonly<{
  sourceId: string;
  pluginId: string;
  publisherId: string;
  version: string;
  title: string;
  description: string;
  packageDigest: string;
}>;
export type PluginSourceListQuery = Readonly<{
  afterSourceId: string | null;
  limit: number;
}>;
export type PluginSourceListResponse = Readonly<{
  sources: readonly PluginSourceView[];
  next: string | null;
}>;

/** HTTP values are strings; an omitted cursor is represented by null in the copied query. */
export function parsePluginSourceListQuery(
  input: unknown,
): PluginSourceListQuery {
  const value = pluginControlRecord(input, ["afterSourceId", "limit"], {
    optional: ["afterSourceId", "limit"],
    query: true,
  });
  let limit = 50;
  if (Object.hasOwn(value, "limit")) {
    if (typeof value.limit !== "string" || !/^[1-9][0-9]?$/u.test(value.limit))
      pluginControlFail("plugin_control_limit_invalid");
    limit = pluginControlLimit(Number(value.limit));
  }
  return Object.freeze({
    afterSourceId: Object.hasOwn(value, "afterSourceId")
      ? pluginControlOpaqueId(value.afterSourceId)
      : null,
    limit,
  });
}

export function parsePluginSourceView(input: unknown): PluginSourceView {
  const value = pluginControlRecord(
    copyPluginControlJson(input, {
      maxBytes: MAX_PLUGIN_CONTROL_RESPONSE_BYTES,
    }),
    [
      "sourceId",
      "pluginId",
      "publisherId",
      "version",
      "title",
      "description",
      "packageDigest",
    ],
  );
  const title = sourceText(value.title, PLUGIN_PACKAGE_LIMITS.titleScalars * 4);
  if (
    [...title].length > PLUGIN_PACKAGE_LIMITS.titleScalars ||
    /[\p{Cc}\p{Zl}\p{Zp}]/u.test(title)
  )
    pluginControlFail("plugin_control_source_title_invalid");
  return Object.freeze({
    sourceId: pluginControlOpaqueId(value.sourceId),
    pluginId: parsePluginControlPluginId(value.pluginId),
    publisherId: parsePluginControlPluginId(value.publisherId),
    version: pluginControlVersion(value.version),
    title,
    description: sourceText(
      value.description,
      PLUGIN_PACKAGE_LIMITS.descriptionBytes,
    ),
    packageDigest: parsePluginControlPackageDigest(value.packageDigest),
  });
}

export function parsePluginSourceListResponse(
  input: unknown,
  context: PluginSourceListQuery,
): PluginSourceListResponse {
  const fields = pluginControlRecord(context, ["afterSourceId", "limit"]);
  const after =
    fields.afterSourceId === null
      ? null
      : pluginControlOpaqueId(fields.afterSourceId);
  const limit = pluginControlLimit(fields.limit);
  const value = pluginControlRecord(
    copyPluginControlJson(input, {
      maxBytes: MAX_PLUGIN_CONTROL_RESPONSE_BYTES,
    }),
    ["sources", "next"],
  );
  const sources = pluginControlArray(value.sources, limit).map(
    parsePluginSourceView,
  );
  const versions = new Set<string>();
  const digests = new Set<string>();
  const publishers = new Map<string, string>();
  let previous = after;
  for (const source of sources) {
    if (previous !== null && source.sourceId <= previous)
      pluginControlFail("plugin_control_page_order_invalid");
    previous = source.sourceId;
    const version = `${source.pluginId}@${source.version}`;
    if (
      versions.has(version) ||
      digests.has(source.packageDigest) ||
      (publishers.has(source.pluginId) &&
        publishers.get(source.pluginId) !== source.publisherId)
    )
      pluginControlFail("plugin_control_source_identity_conflict");
    versions.add(version);
    digests.add(source.packageDigest);
    publishers.set(source.pluginId, source.publisherId);
  }
  const next = value.next === null ? null : pluginControlOpaqueId(value.next);
  if (next !== null && (sources.length !== limit || next !== previous))
    pluginControlFail("plugin_control_page_cursor_invalid");
  return Object.freeze({ sources: Object.freeze(sources), next });
}

/** Matches descriptor text bounds and character rules without constructing an executable descriptor. */
function sourceText(input: unknown, maximumBytes: number): string {
  if (
    typeof input !== "string" ||
    !input ||
    input.length > maximumBytes ||
    input !== input.trim() ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\p{Cf}]/u.test(input) ||
    new TextEncoder().encode(input).byteLength > maximumBytes
  )
    pluginControlFail("plugin_control_source_text_invalid");
  return input;
}
