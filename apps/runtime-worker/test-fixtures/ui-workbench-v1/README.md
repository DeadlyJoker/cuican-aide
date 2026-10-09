# UI-only v1 compatibility fixture

Test-only snapshot of the UI-only example at CrewON commit `5a187d75c`. It preserves the installed module lifecycle and interactions exercised by the existing Worker integration tests: public asset integrity, local edits, version history, theme updates, dialogs/timers, upgrade/disable revocation, account and host DOM preservation, and zero execution writes.

The current short-drama business plugin is version 47 and is not this fixture. Do not use this directory in a production release, catalog or installation source. Its historical `crewon.short-drama` namespace and versions 1/2 are retained only to test the original installed package contract; they make no claim about current short-drama functionality.

The official Worker test producer copies this self-contained source outside the repository, installs the packed public SDK, and builds both versions. The development source is removed before consumer tests. No host implementation is imported, no external provider is called, and no user plugin is enabled. Keep the original interaction assertions intact; current business behavior has separate integration coverage.

The separate `projects` build profile uses version 3 and declares the seven project bridge services required by Native approval. It has no Node entrypoint or business manifest, and grants no execution authority by itself. It supplies the UI-only source for the real Native generation transaction test; that test separately approves its execution target. The preview versions 1/2 keep their empty service requirements and original interaction assertions.
