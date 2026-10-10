# Desktop UI integration

Merge `codex/desktop-ui-polish` at `b9e9334151a98ef0d593a166cb2285c52117c0a2`
into `codex/incremental-extensions` after account transport commit `38048e524`.

The new navigation rail, continuous header, centered search, composer, and
recorded task change review preserve the current account and execution owners.
Registration remains available. Local management can open enterprise login only
with a valid native grant. Search keeps server pagination, loading, error retry,
and full-text results. Installed plugin modules remain in a collapsible resource
group. Goal/Plan keeps the current permission and disabled-reason checks. The
main chat keeps independent model and reasoning controls and its gateway catalog.
Optimistic submissions and classified execution errors retain their current
behavior.

The normal sidebar no longer displays the legacy newer/latest/older pager.
Older history remains accessible through search with explicit result page
navigation. A StrictMode remount now creates a fresh workspace runtime instead
of reusing a closed composition. Desktop workspace IDs and saved thread bindings
remain authoritative. Web does not have native folder authority: its empty state
explains that boundary, and disconnected saved workspace IDs keep their own
conversation groups.

Two pre-existing source worktree changes overlap the UI merge: verification scene
typing in `CommandWorkspace.tsx` and the office example action in
`ControlCommandOfficeRoomAdapter.tsx`. Preserve them as local changes; do not
include them in the merge commit or ship them with this UI update.

The formal desktop staging worktree includes previously installed startup fixes
outside the source HEAD. Preserve its bootstrap, plugin management, supervisor,
main, and startup diagnostic files when synchronizing committed renderer changes.
Build both renderer and desktop host with the public account origin
`https://pim.aicuican.com`, verify package contents, then verify Web before replacing
the installed desktop package. Version for this integration is `0.1.65`.

Account connection reuse and bounded requests are covered separately in
`conversation-stream-recovery-20261010.md`. Public cold TLS connection timeouts
remain an observed external failure; UI integration is not evidence that those
timeouts or model gateway streaming failures have been resolved.
