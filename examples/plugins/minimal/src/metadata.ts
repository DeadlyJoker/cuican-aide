/** Change these identities together before distributing your plugin. Versions are opaque labels. */
export const metadata = {
  pluginId: "example.minimal",
  publisherId: "example.publisher",
  version: "1.0.0",
  title: "Minimal service plugin",
  description:
    "A local service with explicit owned cleanup; no model or supplier calls.",
  service: "example.minimal.echo",
  apiVersion: "1",
} as const;
