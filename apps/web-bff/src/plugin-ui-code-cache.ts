import { createHash } from "node:crypto";
export const PLUGIN_UI_CODE_CACHE_HEADER = "x-crewon-plugin-ui-assets";
export const PLUGIN_UI_CODE_CACHE_MODE = "entry-bytes.v1";
export const PLUGIN_UI_CODE_CACHE_REVALIDATION_MODE = "entry-bytes.v2";
export const PLUGIN_UI_CODE_UNCHANGED_HEADER = "x-crewon-plugin-ui-entry";

/** Revalidation follows the original authenticated mount asset read, never precedes it. */
export async function pluginUiCodeResponse(
  response: Response,
  conditional: string | null,
  mode: "entry-bytes.v1" | "entry-bytes.v2" = "entry-bytes.v1",
): Promise<Response> {
  if (
    response.status !== 200 ||
    !/^(application|text)\/javascript(?:;|$)/iu.test(
      response.headers.get("content-type") ?? "",
    )
  )
    return response;
  const bytes = await response.arrayBuffer();
  const tag = `"sha256:${createHash("sha256").update(new Uint8Array(bytes)).digest("hex")}"`;
  const headers = new Headers(response.headers);
  headers.set("cache-control", "private, no-cache");
  headers.set("etag", tag);
  const unchanged =
    conditional !== null &&
    conditional.length <= 128 &&
    conditional.replace(/^W\//u, "").trim() === tag;
  if (unchanged) {
    headers.delete("content-length");
    if (mode === PLUGIN_UI_CODE_CACHE_REVALIDATION_MODE) {
      // This is an application-owned byte cache, not the browser HTTP cache.
      // Return an explicit empty 200 so a browser cannot consume/rewrite 304.
      headers.set(PLUGIN_UI_CODE_UNCHANGED_HEADER, "unchanged.v2");
      headers.set("cache-control", "no-store");
      headers.set("content-length", "0");
      return new Response(null, { status: 200, headers });
    }
    return new Response(null, { status: 304, headers });
  }
  return new Response(bytes, { status: 200, headers });
}
