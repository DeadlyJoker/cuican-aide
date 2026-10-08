import { defineConfig, mergeConfig } from "vitest/config";
import { createRequire } from "node:module";
import viteConfig from "./vite.config";
const require = createRequire(import.meta.url);

export default defineConfig(async (environment) =>
  mergeConfig(await viteConfig(environment), {
    // Source component tests share their renderer; independently built plugin bundles keep their own React.
    resolve: {
      dedupe: ["react", "react-dom"],
      alias: [
        "react",
        "react/jsx-runtime",
        "react/jsx-dev-runtime",
        "react-dom",
        "react-dom/client",
      ].map((name) => ({
        find: new RegExp(`^${name.replaceAll("/", "\\/")}$`, "u"),
        replacement: require.resolve(name),
      })),
    },
    test: { setupFiles: ["./test/native-web-api-setup.ts"] },
  }),
);
