import { createHash } from "node:crypto";
export const PLUGIN_UI_CODE_CACHE_HEADER = "x-crewon-plugin-ui-assets";
export const PLUGIN_UI_CODE_CACHE_MODE = "entry-bytes.v1";

/** Revalidation follows the original authenticated mount asset read, never precedes it. */
export async function pluginUiCodeResponse(
  response: Response,
  conditional: string | null,
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
    return new Response(null, { status: 304, headers });
  }
  return new Response(bytes, { status: 200, headers });
}
