import { build } from "esbuild";

/** Current-source component coverage without writing or replacing an installable package. */
export async function sourceUiDefinition() {
  const compiled = await build({
    entryPoints: [
      new URL("../src/ui.tsx", import.meta.url).pathname.replace(
        /^\/@fs\//u,
        "/",
      ),
    ],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: true,
    jsx: "automatic",
    loader: { ".css": "text", ".png": "dataurl" },
    define: { "process.env.NODE_ENV": '"production"' },
  });
  return (
    await import(
      `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString("base64")}`
    )
  ).default;
}
