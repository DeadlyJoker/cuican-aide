# Built-in task packs

`@crewon/capability-packs` is a private, dependency-free TypeScript package for trusted, bundled task templates. It is **not** a third-party plugin installer, execution engine, authorization system, or artifact store.

## Implemented boundary

- An exact `crewon.task-pack.v0` schema and `crewon.task-draft.v0` host compatibility tag. Unknown fields, incompatible tags, duplicate identities/settings, non-empty requested capabilities, and executable contributions are rejected.
- Immutable manifests addressed by ID and exact numeric version. The registry can retain multiple versions; the built-in host currently registers only `crewon.meeting-notes@0.1.0`.
- Enum-only business preferences, copied and validated before use. UI persistence is scoped to the signed-in user, browser origin, pack ID, and version. Materials and credentials are never preferences.
- Explicit preparation of user-visible text containing the template identity, SHA-256 definition digest, saved configuration, instructions, and numbered source material. The digest is provenance metadata, not a signature or authorization proof.
- Source limits of 16,000 UTF-8 bytes and 200 lines. Each template instruction is limited to 4,000 bytes, with at most eight 500-byte preference instructions. JSON serialization preserves material as data; it does not guarantee model resistance to prompt injection.

The Settings UI renders declared enum fields and prepares an **unsent** task draft. It refuses to replace an existing draft, pending attachment, or current sending task. The user inspects and sends the draft through existing UI controls. Execution target, model, approvals, streaming, and conversation persistence stay with the existing host. A fresh draft does not necessarily inherit the previous task's execution choices; the user must check them before sending. The workbench previews actual conversation output and explicitly does not claim it is a saved file.

## Entry points

```ts
import {
  bundledTaskPacks,
  taskPackDefaults,
  prepareTaskPack,
} from "@crewon/capability-packs";

const pack = bundledTaskPacks.require("crewon.meeting-notes", "0.1.0");
const prepared = await prepareTaskPack({
  packId: pack.id,
  packVersion: pack.version,
  configuration: taskPackDefaults(pack),
  source: "2026-09-09: Lin will send the draft by 2026-09-11.",
});
// Display prepared.prompt for the user to inspect. Do not auto-submit it.
```

Adding a bundled pack requires a reviewed source change, explicit registry registration, UI wording review, contract tests, and GUI quality cases. No filesystem paths, URLs, npm packages, or remote scripts are dynamically loaded. The current material-entry UI is meeting-specific; generalize its declared input description when adding a second business pack, rather than mislabeling another workflow as a meeting.

## Deliberately not implemented

There is no install/enable/upgrade/rollback API, organization grant, remote package discovery, dependency resolver, custom JavaScript view, runtime permission override, model-specific profile, or durable business artifact schema. A prepared prompt can be edited by the user; it is not an immutable server execution snapshot. In-memory version lookup tests do not prove persistent upgrade or rollback behavior.

Before remote plugins or write-capable packs, separately implement and review durable Control authorization/version snapshots, Worker adapter binding, credential leases, receipts/reconciliation, and artifact contracts. Keep PIM unchanged. See [the architecture analysis](../../docs/plugin-extensibility.md).

## Verification

Use Node.js 24 and pnpm 10:

```sh
pnpm --filter @crewon/capability-packs typecheck
pnpm --filter @crewon/capability-packs test
pnpm --filter @crewon/ui test
```

Business effectiveness is evaluated through GUI-submitted synthetic scenarios, separately from schema and component checks. Single-model observations do not establish cross-model quality or reduced internal reasoning rounds.
