---
name: context-usage
description: >-
  Inspect real-time Google Antigravity conversation context occupancy (used tokens,
  percentage, remaining capacity, and compaction checkpoints) from local transcript logs.
  Use when the user asks how much context is used, context window usage, token occupancy,
  "上下文用量", "上下文占用", "剩余上下文", or wants to check recent conversations' context usage.
---

# Context Usage Viewer

Inspect exact context window occupancy (`input_tokens + cache_read_tokens`)
from Antigravity's local `transcript.jsonl`, or open the real-time Codex-style
circular gauge panel in the auxiliary side pane.

## Sidecar UI Panel

This plugin ships a real-time Codex-style ring gauge sidecar (`context-usage/context-gauge`).
When the user asks to open the visual ring/panel, or when showing context usage in chat,
surface this clickable pill link so they can open/toggle the live panel with one click:

```markdown
[上下文占用](sidecar://context-usage/context-gauge/)
```

## Steps

1.  If the user ONLY asks to open the visual panel, surface `[上下文占用](sidecar://context-usage/context-gauge/)` directly.
2.  Otherwise, locate the helper script [context-usage.mjs](./scripts/context-usage.mjs) in the same skill directory as this `SKILL.md` and run it with `node` via `run_command`:
    *   **Current conversation (default):** Pass the active `Conversation ID` and `App Data Directory` from `<user_information>`:
        ```bash
        node "<skill-dir>/scripts/context-usage.mjs" --app-data-dir "<app-data-dir>" --conversation "<conversation-id>"
        ```
    *   **Recent conversations overview:** When the user asks to view or compare multiple conversations:
        ```bash
        node "<skill-dir>/scripts/context-usage.mjs" --app-data-dir "<app-data-dir>" --list 5
        ```
    *   **Custom context window limit:** If the user specifies a window limit (e.g. `200k`, `256k`, `1m`), add `--limit <value>`.
    *   **Structured data:** Add `--json` if further processing is needed.
3.  Present the result concisely to the user, focusing **only on context occupancy** (used / limit, percentage, progress bar, remaining space, and compaction count if any), and optionally include the `[上下文占用](sidecar://context-usage/context-gauge/)` pill once if they haven't opened it yet.
4.  If context occupancy is ≥ 80%, suggest running `/compact` to free up the context window.

## Notes

*   Context occupancy is read from the latest `PLANNER_RESPONSE` step as `input_tokens + cache_read_tokens`.
*   Because the current model turn is still in progress while this script executes, the reported number reflects the latest completed planner step in the transcript.
