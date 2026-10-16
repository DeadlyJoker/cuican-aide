import path from "node:path";
import type { ImportBoundary } from "./package-boundary-types.ts";

/** Combine explicit declarations without losing an existing CLI exception. */
export function mergeFileImports(
  previous: ImportBoundary["allowedFileImports"] = {},
  additional: ImportBoundary["allowedFileImports"] = {},
): Readonly<Record<string, readonly string[]>> {
  return Object.fromEntries(
    [...new Set([...Object.keys(previous), ...Object.keys(additional)])].map(
      (file) => [
        file,
        [...new Set([...(previous[file] ?? []), ...(additional[file] ?? [])])],
      ],
    ),
  );
}

export function boundaryAllowsImport(
  boundary: ImportBoundary,
  relativeFile: string,
  specifier: string,
): boolean {
  return (
    (boundary.allowedExactBareImports ?? []).includes(specifier) ||
    boundary.allowedBareImports.some(
      (allowed) =>
        specifier === allowed ||
        (allowed.endsWith(":") && specifier.startsWith(allowed)) ||
        specifier.startsWith(`${allowed}/`),
    ) ||
    (
      boundary.allowedFileImports?.[relativeFile.split(path.sep).join("/")] ??
      []
    ).includes(specifier)
  );
}

export function isTestSource(file: string): boolean {
  return (
    file.endsWith(".test.ts") ||
    file.endsWith(".test.tsx") ||
    file.endsWith(".test-support.ts") ||
    file.endsWith(".test-support.tsx")
  );
}

/** Renderer code uses public package entrypoints; sibling host/dev source stays outside its relative graph. */
export function rendererImportEscapesSource(
  sourceDirectory: string,
  file: string,
  specifier: string,
): boolean {
  if (!specifier.startsWith(".")) return false;
  const target = path.resolve(path.dirname(file), specifier);
  const root = path.resolve(sourceDirectory);
  return target !== root && !target.startsWith(root + path.sep);
}

export function isForbiddenRendererImport(specifier: string): boolean {
  return [
    "node:",
    "@crewon/application",
    "@crewon/control-api",
    "@crewon/store",
    "@crewon/media-runtime",
    "@crewon/plugin-sdk/node",
    "@crewon/plugin-host",
    "fastify",
    "uuid",
  ].some((prefix) => specifier.startsWith(prefix));
}

export function importSpecifiers(source: string): string[] {
  const patterns = [
    /\bfrom\s+["']([^"']+)["']/g,
    /\bimport\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bexport\s+(?:\*|\{[^}]*\})\s+from\s+["']([^"']+)["']/g,
  ];
  return [
    ...new Set(
      patterns.flatMap((pattern) =>
        [...source.matchAll(pattern)].map((match) => match[1]),
      ),
    ),
  ];
}

/** Test fixtures may use Node, but must never become reachable from the renderer entrypoint. */
export function rendererTestSourceDependencies(
  entryFile: string,
  sourceByFile: ReadonlyMap<string, string>,
): string[] {
  const violations: string[] = [];
  const visited = new Set<string>();
  const pending = [entryFile];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    const source = sourceByFile.get(file);
    if (source === undefined) continue;
    for (const specifier of importSpecifiers(source)) {
      if (!specifier.startsWith(".")) continue;
      const base = path.resolve(path.dirname(file), specifier);
      const typedBase = base.replace(/\.jsx?$/, "");
      const dependency = [
        base,
        `${base}.ts`,
        `${base}.tsx`,
        `${typedBase}.ts`,
        `${typedBase}.tsx`,
        path.join(base, "index.ts"),
        path.join(base, "index.tsx"),
      ].find((candidate) => sourceByFile.has(candidate));
      if (dependency === undefined) continue;
      if (isTestSource(dependency)) {
        violations.push(`${file} -> ${specifier}`);
      } else {
        pending.push(dependency);
      }
    }
  }
  return violations.sort();
}
