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
- visible workspace pill showing the current synced workspace
- neutral CrewON hero: “让 CrewON 完成你的工作”
- scene tabs: daily work, code, creative design
- scene subtitle and concise capability summary
- quick scenario actions
- compact task composer with resource add, local permission, optional Goal/Plan intent, model, execution target, and send controls
- execution target selector defaulting to `CrewON · 单 Agent`, with existing single Agents and Teams selectable
- scene-specific context palette for office documents/calendar/knowledge, code workspace/issues/logs, and design brief/Figma/brand references
- scene-specific Skill and MCP palette
- concise capability summary and risk state when the selected mode may lead to writes

Do not keep the old empty Codex-style conversation state as the homepage.

Scene and execution target are orthogonal. Switching daily work/code/design must not reset the selected CrewON/Agent/Team target, and selecting an Agent or Team must not change the Scene contract. The homepage selects existing definitions only; creation, editing, membership, and orchestration configuration belong in the resource library.

Do not expose a Scene mode selector on the homepage. The selected Scene and user prompt provide enough intent for Auto mode to infer whether the task is asking, planning, implementing, writing, coordinating, producing, or reviewing. Quick actions may supply an internal mode hint for compatibility, but users should not have to make this redundant choice. Keep explicit mode APIs compatible for resumed threads and older clients.

Keep the composer information architecture explicit:

- Use `+` only for adding real context and capabilities: files/folders, knowledge bases, Skills, and MCP. Do not repeat the current workspace inside this menu; workspace selection already has a dedicated surface.
- On an independent new-task draft, render the workspace surface as a real selector rather than a static label or decorative chevron. Include “无工作空间” even when no known workspace exists, plus unique known workspace paths when available.
- A global “新建任务” starts without an explicit workspace. A workspace-scoped new-conversation action preselects that workspace. Changing the selection must update the draft state and the URL `cwd` when a path is selected; choosing “无工作空间” removes that explicit binding.
- Pass the selected workspace path into thread creation as `cwd`, then group the returned conversation under its `thread.cwd`. For “无工作空间”, omit the explicit `cwd`; describe this as using the default execution environment rather than claiming the backend thread has a nullable working directory.
- Group the `+` menu by resource type and separate File, Knowledge, Skill, and MCP sections visually instead of presenting one undifferentiated list.
- Omit unavailable or disconnected resource entries. Do not place “未连接” placeholders in the primary composer menu.
- Keep Goal and Plan outside the `+` menu as a compact optional segmented control.
- Avoid a decorative container around Goal/Plan. Give the selected option an unmistakable filled or tinted state so the control reads as an actual switch.
- Default Goal/Plan to neither selected. Selecting one deselects the other; selecting the active option again returns to neither.
- Goal creates or updates a persistent thread goal. Plan applies Plan collaboration mode to the next turn and clears an active goal so the two intents remain operationally exclusive.
- Reset the visible Goal/Plan selection after send so execution mode does not become an accidental sticky default.
- Give `+`, `@`, and `/` palettes the same dismissal contract: close on Escape, selection, repeated trigger activation, or pointer interaction outside the palette.

Do not use an Agent-team Hero, make Team the default, label the send action “Agent 小队草稿”, or present Team as a fourth scene. The primary send action is “开始任务”.

## Platform Data Requirements

CrewON must expose real local agent-platform resources in the workspace or composer, not only in library pages:

- Agent
- Skill
- MCP
- Knowledge base
- Workflow

At least one real Skill, MCP, and knowledge resource relevant to the active Scene should be reachable from the composer/resource dock when available. Existing Agent and Team definitions appear in the execution target selector; Workflow remains available through the platform library and relevant task surfaces rather than being forced into every homepage scene. If the backend is unavailable, keep usable local composer actions available, omit unavailable resources, and avoid prominent connection copy that competes with task creation.

## Implementation Rules

- Rebuild the design as application components; do not paste the artifact HTML wholesale.
- Prefer `apps/crewon-ui` components and styles over touching `codex-rs`.
- Keep active conversation behavior available for existing threads, but make the no-thread/new-task state a command workspace.
- Preserve existing agent-platform integration and continue using local API proxy defaults.
- The client requests an execution target ID; the server owns the resolved `single` or `team` strategy. Do not derive Team mode from Scene or a client-side boolean.
- Keep the homepage composer focused on controls that materially change execution: add resources, permission boundary, optional Goal/Plan intent, execution target, model, and send. Do not add prompt-refine, voice, a redundant Scene mode selector, or decorative status copy unless it has a proven working capability and clear user value.
- CrewON and single-Agent targets must not expose multi-agent tools. Team targets are selectable only when the definition, authorization, and Team Runtime are genuinely available; otherwise show a disabled option with the reason.
- Preserve the main conversation for both single and Team execution. Team workers report bounded state/results to the main Agent rather than creating a separate homepage conversation model.
- The initial external-action release is draft-only for sends, shared writes, pushes, publishing, and destructive actions, regardless of execution target.
- Check desktop, low-height, and narrow widths for overlap, overflow, hidden primary controls, and a clipped execution-target selector before delivery.

## Delivery Checklist

Before marking frontend work done:

1. Re-open the design artifact and compare the production screen against the required landmarks.
2. Run the CrewON UI tests and build.
3. Start or reuse the local CrewON page and inspect the first screen.
4. Confirm the default is CrewON single Agent, no visible mode selector exists, and switching Scene preserves the execution target.
5. Confirm the `+` menu contains grouped real file/folder, knowledge, Skill, and MCP entries when available; current workspace and disconnected resources are omitted; `+`, `@`, and `/` close on outside interaction.
6. Confirm Goal and Plan have no unnecessary outer frame, show a clear selected state, default to neither selected, remain mutually exclusive, can be toggled off, and reach the real thread Goal / Plan collaboration APIs.
7. Confirm the three Scenes visibly differ in subtitle, context, quick actions, capabilities, placeholder, and result intent.
8. Confirm Team selection keeps one main conversation and does not turn Team into a fourth scene.
9. Confirm a new task can switch between “无工作空间” and known workspaces, and that thread creation receives the selected `cwd` so the conversation appears under the matching workspace.
10. Report any backend or browser limitation explicitly.
