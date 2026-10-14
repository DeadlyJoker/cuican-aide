import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

// Vite already owns this parser; no product/runtime dependency is introduced.
const require = createRequire(import.meta.url);
const viteRequire = createRequire(require.resolve("vite/package.json"));
const lexer = viteRequire("es-module-lexer");
const LAZY_FEATURE_CHUNK = /^(?:mermaid|xlsx)(?:-|\.)/u;
const STARTUP_JS_LIMIT_BYTES = 512 * 1024;

function attributes(tag) {
  const result = new Map();
  for (const match of tag.matchAll(
    /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gu,
  ))
    result.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4]);
  return result;
}

function builtAssetPath(directory, importer, specifier) {
  if (!specifier || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(specifier))
    throw Error("startup_build_external_module_denied");
  const path = specifier.split(/[?#]/u, 1)[0];
  // Vite can emit either relative URLs or an explicit deployment base.
  const normalized = path.startsWith("/")
    ? path.replace(/^.*\/assets\//u, "assets/").replace(/^\//u, "")
    : path;
  const target = resolve(
    path.startsWith("/") ? directory : dirname(importer),
    normalized,
  );
  const nested = relative(directory, target);
  if (
    !nested ||
    nested === ".." ||
    nested.startsWith(".." + sep) ||
    isAbsolute(nested)
  )
    throw Error("startup_build_asset_path_invalid");
  return target;
}

/** Traverse browser-eager static imports and modulepreloads in the built output.
 * Dynamic imports remain lazy. This catches a preload helper accidentally
 * captured by a feature chunk even when HTML preload filtering hides it.
 */
export async function verifyStartupBuild(outputDirectory) {
  const directory = resolve(outputDirectory);
  const htmlPath = resolve(directory, "index.html");
  const html = await readFile(htmlPath, "utf8");
  const entries = [];
  for (const match of html.matchAll(/<script\b[^>]*>/giu)) {
    const data = attributes(match[0]);
    const type = data.get("type");
    if (type?.endsWith("-module"))
      throw Error("startup_build_module_type_rewritten");
    if (type !== "module" || !data.get("src")) continue;
    if (data.get("data-cfasync") !== "false")
      throw Error("startup_build_cloudflare_exclusion_missing");
    entries.push(builtAssetPath(directory, htmlPath, data.get("src")));
  }
  if (!entries.length) throw Error("startup_build_entrypoint_missing");
  const roots = [...entries];
  for (const match of html.matchAll(/<link\b[^>]*>/giu)) {
    const data = attributes(match[0]);
    if (data.get("rel") === "modulepreload" && data.get("href"))
      roots.push(builtAssetPath(directory, htmlPath, data.get("href")));
  }

  await lexer.init;
  const eager = new Map();
  const pending = [...new Set(roots)];
  while (pending.length) {
    const path = pending.shift();
    if (eager.has(path)) continue;
    const file = relative(directory, path).replaceAll(sep, "/");
    if (LAZY_FEATURE_CHUNK.test(file.split("/").at(-1)))
      throw Error("startup_build_lazy_feature_eager:" + file);
    const bytes = await readFile(path);
    eager.set(path, bytes.length);
    const [imports] = lexer.parse(bytes.toString("utf8"));
    for (const item of imports) {
      // d=-1 is a static import/export; dynamic import and import.meta differ.
      if (item.d !== -1 || !item.n) continue;
      pending.push(builtAssetPath(directory, path, item.n));
    }
  }
  const eagerBytes = [...eager.values()].reduce((sum, bytes) => sum + bytes, 0);
  if (eagerBytes > STARTUP_JS_LIMIT_BYTES)
    throw Error("startup_build_eager_javascript_budget_exceeded");
  return {
    entries: entries.map((path) =>
      relative(directory, path).replaceAll(sep, "/"),
    ),
    eagerChunks: [...eager.keys()].map((path) =>
      relative(directory, path).replaceAll(sep, "/"),
    ),
    eagerBytes,
    javascriptLimitBytes: STARTUP_JS_LIMIT_BYTES,
    cloudflareEntryExcluded: true,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const report = await verifyStartupBuild(process.argv[2] ?? "dist");
  console.log(JSON.stringify({ startupBuildVerified: true, ...report }));
}
