import { build } from "vite";
import { join } from "node:path";

const [repository, output] = process.argv.slice(2);
if (!repository || !output) throw new Error("soak_build_arguments_missing");
// The parent runs this in the private fixture directory with a minimal env.
// Product loadEnv('.') sees that empty directory; Vite itself may not load .env.
await build({
  configFile: join(repository, "apps/crewon-ui/vite.config.ts"),
  root: join(repository, "apps/crewon-ui"),
  envDir: false,
  build: { outDir: output },
});
