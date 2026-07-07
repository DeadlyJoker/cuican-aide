---
name: crewon-design-reference
description: Use for any CrewON frontend page, apps/crewon-ui implementation, homepage/workspace, Agent conversation, resource library, delivery validation, or UI handoff task. Requires reading the desktop command design artifact before changing or validating CrewON UI.
---

# CrewON Design Reference

Use this skill before implementing, changing, reviewing, or validating CrewON frontend UI.

## Required Design Inputs

Read these files before making UI decisions:

- `artifacts/desktop-command-home-scene-update/desktop-command.html`
- `artifacts/desktop-command-home-scene-update/desktop-command.css`
- `artifacts/desktop-command-home-scene-update/desktop-pages.css`

Read `artifacts/desktop-command-home-scene-update/app.js` when the task involves interactions, palettes, scene switching, command logging, or page transitions.

## Non-Negotiable Homepage Shape

The CrewON homepage/workspace must follow `desktop-command.html#view-command`.

Keep these landmarks visible in the production UI:

- desktop command screen / command workspace shell
- command sidebar with workspace/resource/task navigation
- workspace pill showing the synced Agent team delivery space
- centered Crewon hero for orchestrated Agent teams
- scene tabs: daily work, code development, creative design
- quick scenario actions
- task composer with mode/model/agent/permission controls
- context palette for Agent, Workflow, knowledge, and project context
- slash palette for Skill and MCP selection

Do not keep the old empty Codex-style conversation state as the homepage.

## Platform Data Requirements

CrewON must expose real local agent-platform resources in the workspace, not only in library pages:

- Agent
- Skill
- MCP
- Knowledge base
- Workflow

At least one real resource entry from each available category should be visible on the first screen or in the composer/resource dock. If the backend is unavailable, show a clear synced/loading/error state without replacing the page with a blank empty state.

## Implementation Rules

- Rebuild the design as application components; do not paste the artifact HTML wholesale.
- Prefer `apps/crewon-ui` components and styles over touching `codex-rs`.
- Keep active conversation behavior available for existing threads, but make the no-thread/new-task state a command workspace.
- Preserve existing agent-platform integration and continue using local API proxy defaults.
- Check desktop and narrow widths for overlap, overflow, and hidden primary controls before delivery.

## Delivery Checklist

Before marking frontend work done:

1. Re-open the design artifact and compare the production screen against the required landmarks.
2. Run the CrewON UI tests and build.
3. Start or reuse the local CrewON page and inspect the first screen.
4. Confirm Agent, Skill, MCP, knowledge base, and workflow entries are represented when local data is available.
5. Report any backend or browser limitation explicitly.
