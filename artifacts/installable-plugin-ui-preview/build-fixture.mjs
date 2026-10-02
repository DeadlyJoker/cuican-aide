import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(join(repository, "apps/crewon-ui/package.json"));
const { build } = await import(require.resolve("esbuild"));

/** Actual external development and SDK installation. This is a deterministic fixture, not a vendor API. */
export async function buildIndependentUiPackages(ownedRoot) {
  const development = join(ownedRoot, "development");
  await mkdir(development, { mode: 0o700 });
  execFileSync("pnpm", ["pack", "--pack-destination", development], {
    cwd: join(repository, "packages/plugin-sdk"),
    stdio: "pipe",
    timeout: 60000,
  });
  const tarball = (await readdir(development)).find((name) =>
    name.endsWith(".tgz"),
  );
  assert.ok(tarball);
  await writeFile(
    join(development, "package.json"),
    JSON.stringify({
      name: "external-ui-plugin-fixture",
      private: true,
      type: "module",
      dependencies: { "@crewon/plugin-sdk": `file:./${tarball}` },
    }),
  );
  execFileSync(
    "pnpm",
    [
      "install",
      "--offline",
      "--ignore-scripts",
      "--config.minimumReleaseAge=0",
    ],
    {
      cwd: development,
      stdio: "pipe",
      timeout: 60000,
    },
  );
  await writeFile(
    join(development, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        lib: ["ES2022", "DOM"],
        types: [],
        skipLibCheck: false,
      },
      include: ["source/*.ts"],
    }),
  );
  const outputs = [];
  for (const version of ["1.0.0", "2.0.0"]) {
    const source = join(development, "source");
    await mkdir(source, { recursive: true });
    await writeFile(
      join(source, "helper.ts"),
      `export function heading(version: string) { return "独立插件 · v" + version; }`,
    );
    await writeFile(
      join(source, "node.ts"),
      `
      import { definePlugin } from "@crewon/plugin-sdk/node";
      export default definePlugin({ apiVersion: "crewon.plugin-host.v1", pluginId: "example.ui-story",
        setup(context) { let count = 0; return context.services.provide("example.ui-counter", "1", {
          increment() { return { version: ${JSON.stringify(version)}, count: ++count }; }
        }); }
      });
    `,
    );
    await writeFile(
      join(source, "ui.ts"),
      `
      import { defineUiPlugin } from "@crewon/plugin-sdk/ui";
      import type { PluginUiProps } from "@crewon/plugin-sdk/ui";
      import { heading } from "./helper.js";
      export default defineUiPlugin({ apiVersion: "crewon.plugin-ui.v1", pluginId: "example.ui-story",
        mount(root, props, services) {
          let disposed = false;
          const document = root.ownerDocument;
          const title = document.createElement("h2");
          title.textContent = heading(${JSON.stringify(version)});
          const description = document.createElement("p");
          const button = document.createElement("button"); button.textContent = "调用插件能力";
          const result = document.createElement("output"); result.setAttribute("aria-live", "polite");
          root.dataset.independentPluginVersion = ${JSON.stringify(version)};
          Object.assign(root.style, { padding: "24px", border: "1px solid var(--border)", borderRadius: "12px", color: "inherit", font: "inherit" });
          Object.assign(button.style, { padding: "8px 12px", color: "inherit", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "6px" });
          root.append(title, description, button, result);
          function update(next: PluginUiProps) {
            if (disposed) throw new Error("disposed");
            description.textContent = typeof next.data === "string" ? next.data : "模块投影";
            root.dataset.pluginTheme = next.theme.mode;
          }
          update(props);
          button.onclick = async () => {
            try { const response = await services.invoke("counter.increment", { delta: 1 }, {});
              if (!disposed) result.textContent = JSON.stringify(response);
            } catch { if (!disposed) result.textContent = "调用已被拒绝"; }
          };
          return { update, dispose() {
            disposed = true; button.onclick = null; root.replaceChildren();
            document.dispatchEvent(new CustomEvent("independent-ui-fixture-disposed", { detail: ${JSON.stringify(version)} }));
          } };
        }
      });
    `,
    );
    execFileSync(
      process.execPath,
      [
        require.resolve("typescript/bin/tsc"),
        "-p",
        join(development, "tsconfig.json"),
      ],
      {
        cwd: development,
        stdio: "inherit",
        timeout: 60000,
      },
    );
    const distribution = join(development, `package-${version}`);
    await mkdir(distribution);
    const uiBuild = await build({
      absWorkingDir: development,
      entryPoints: [join(source, "ui.ts"), join(source, "helper.ts")],
      outdir: join(distribution, "ui"),
      bundle: true,
      splitting: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      chunkNames: "chunks/[name]-[hash]",
      metafile: true,
      sourcemap: false,
    });
    const nodeBuild = await build({
      absWorkingDir: development,
      entryPoints: [join(source, "node.ts")],
      outfile: join(distribution, "node.mjs"),
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node24",
      metafile: true,
      sourcemap: false,
    });
    for (const output of [uiBuild, nodeBuild]) {
      for (const input of Object.keys(output.metafile.inputs)) {
        const within = relative(development, resolve(development, input));
        assert.ok(
          !isAbsolute(within) &&
            within !== ".." &&
            !within.startsWith(`..${sep}`),
          input,
        );
      }
      for (const value of Object.values(output.metafile.outputs))
        assert.ok(
          value.imports.every((item) => !item.external),
          "external runtime dependency",
        );
    }
    const files = [];
    async function inventory(directory) {
      for (const item of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, item.name);
        if (item.isDirectory()) await inventory(path);
        else {
          const bytes = await readFile(path);
          files.push({
            path: relative(distribution, path).split(sep).join("/"),
            byteLength: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          });
        }
      }
    }
    await inventory(distribution);
    await writeFile(
      join(distribution, "crewon.plugin.json"),
      JSON.stringify({
        schemaVersion: "crewon.plugin-package.v1",
        hostApi: "crewon.plugin-host.v1",
        pluginId: "example.ui-story",
        version,
        title: "独立界面插件",
        description: "A deterministic independently built UI fixture.",
        publisherId: "example.publisher",
        entrypoints: {
          node: "node.mjs",
          ui: { path: "ui/ui.js", mode: "trustedModule" },
        },
        businessManifestPath: null,
        requires: [],
        provides: [{ service: "example.ui-counter", apiVersion: "1" }],
        contributions: [
          {
            id: "studio",
            kind: "module",
            slot: "main.content",
            title: "独立插件验证",
          },
        ],
        files,
      }),
    );
    outputs.push({
      version,
      directory: distribution,
      uiFiles: files.filter((file) => file.path.startsWith("ui/")),
    });
  }
  return {
    development,
    packages: outputs,
    removeDevelopment: () => rm(development, { recursive: true, force: true }),
  };
}
