/** Remove Vite's dev-only marker without broadening the installed asset HTTP contract. */
export function normalizePluginUiViteImportPath(path: string): string {
  if (path.length > 1024) return path;
  const match =
    /^\/api\/v1\/plugins\/ui\/mounts\/[A-Za-z0-9_-]{32,128}\/assets\/([^?#]+)\?import$/u.exec(
      path,
    );
  if (!match) return path;
  let decoded: string;
  try {
    const parts = match[1]!.split("/").map((part) => decodeURIComponent(part));
    if (
      parts.some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          part.startsWith("@") ||
          part.includes("/"),
      )
    )
      return path;
    decoded = parts.join("/");
  } catch {
    return path;
  }
  if (
    decoded.length > 256 ||
    new TextEncoder().encode(decoded).byteLength > 256 ||
    /[\\%:?#\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(decoded) ||
    !/\.m?js$/u.test(decoded)
  )
    return path;
  for (const point of decoded) {
    const code = point.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) return path;
  }
  return path.slice(0, -"?import".length);
}
