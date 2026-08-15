---
name: start-plan
description: Use when the user wants to spend their free ZCode Start Plan trial quota (ZCode Start Plan, zcode-plan trial, "试用额度", GLM-5.3/GLM-5-Turbo free tier) instead of the configured Coding Plan / API key, or when model calls fail with "captcha verify failed" (code 3007) and the user asks to use the desktop-app trial from the CLI. Covers checking trial entitlement, listing trial models, delegated generation via the start_plan_generate MCP tool, and completing the one-time Aliyun captcha bridge.
---

# ZCode Start Plan (free trial quota)

## Overview

This skill routes generation work to the free "ZCode Start Plan" trial that ships with new Z.ai accounts. The trial is served by `https://zcode.z.ai/api/v1/zcode-plan/anthropic` (NOT `api.z.ai`), authenticates with the shared ZCode JWT from `zcode login`, and requires an Aliyun captcha token attached to each request. The plugin's MCP server implements all of that; never call these endpoints directly with plain HTTP tools.

## Prerequisites

- The user ran `zcode login` (OAuth) on this machine, so `~/.zcode/v2/credentials.json` contains the shared JWT. If missing, tell the user to run `zcode login` first; do NOT ask them to paste tokens.

## Workflow

1. Check entitlement with the `start_plan_status` MCP tool.
   - `entitled: true` → continue.
   - `entitled: false` → the account has no active trial; tell the user the trial is unavailable and offer to fall back to the normal configured model.
2. Pick the model from `models` (typical: `GLM-5.3`, `GLM-5-Turbo`).
3. Call `start_plan_generate` with the prompt (and optional `system`, `max_tokens`).
   - On first use (or after a 3007 captcha failure) the server opens a one-time browser tab for the Aliyun captcha. Tell the user to complete it in the opened tab; the tool call waits, usually ≤ 2 minutes.
4. Return the generated `text` to the user. Mention that the call consumed trial quota if `usage` is present.

## Failure handling

- `code 3007` "captcha verify failed": retry once — the server automatically reacquires a captcha param and retries; if it fails again, suggest the `start_plan_captcha` tool to run the bridge interactively.
- `3008/3009/3010` "Start Plan busy": the server retries automatically with backoff; if it still fails, tell the user the free tier is congested and offer to retry later or use the normal model.
- Credential errors: user must re-run `zcode login`.

## Notes

- This only affects delegated generation calls made through this skill. The main conversation model is unchanged; do not promise otherwise.
- The trial resets daily and is intended for light evaluation — avoid sending entire files or huge prompts.
