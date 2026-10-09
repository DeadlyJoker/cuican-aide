# Minimal independent service plugin

Use Node.js 24 and pnpm 10. This template is a local Node service; it does not create a page, Agent tool, task or external request. It demonstrates explicit service publication and owned cleanup. Add UI or execution capabilities through their separate declared contracts after this lifecycle works.

From the generated directory, install the distributed SDK tarball and the pinned build tools:

```sh
pnpm add -D /absolute/path/crewon-plugin-sdk-0.1.2.tgz
pnpm install
pnpm build
pnpm exec crewon-plugin check ./dist/1.0.0
```

The check command must be installed separately from the plugin tools tarball, in this project or a parent development project. Change `src/metadata.ts` before distribution: plugin ID, publisher, version and service identity are declared once and reused by the Node entry and descriptor producer. The producer bundles the public SDK and license files, hashes actual bytes, and rejects dependencies outside this independent directory. No runtime workspace dependencies remain.

The default version output uses a three-number version solely to bound its local filesystem path. The host protocol treats versions as opaque identifiers. Build replaces that version's generated `dist` directory; source files remain separate. Installation and activation still require host approval, and service consumers must explicitly declare their dependency. This template is never automatically installed in a user profile.
