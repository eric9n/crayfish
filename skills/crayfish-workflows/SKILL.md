---
name: crayfish-workflows
description: Create, edit, and validate Crayfish JSON workflows for OpenClaw pipelines (Heartbeat/Daily). Use when configuring a schema-validated pipeline with step kinds exec/agent/if, $ref schema resolution, per-call ref.schemaPaths, and needs_agent → agentOutputs convergence.
---

# Crayfish pipeline authoring

## Canonical spec + examples (read first)

- Spec: `/root/.openclaw/extensions/crayfish/WORKFLOW_SPEC.md`
- Examples:
  - `/root/.openclaw/extensions/crayfish/examples/heartbeat-skeleton.json`
  - `/root/.openclaw/extensions/crayfish/examples/daily-skeleton.json`
  - `/root/.openclaw/extensions/crayfish/examples/full-capability-showcase.json`

## Output rules (mandatory)

When asked to produce a workflow, output **STRICT JSON only**.

## Workflow contract (minimal)

A workflow must be:

- JSON object with `steps: []`
- Every step has unique `id`
- Step kinds allowed: `exec | agent | if`
- Retries/iters hard cap: **<= 5**

## $ref rules (project policy)

- Use `schema: {"$ref":"Verify"}` or `{"$ref":"Analysis"}`
- `$ref` must be a basename (no path separators)
- Provide resolver roots per call via tool args:

```json
{
  "ref": { "schemaPaths": ["pipeline/schema"] }
}
```

Each schemaPath must be **relative to workspace root** (no leading `/`).

## needs_agent method A (structured input)

Crayfish never calls an LLM.

If it returns:

- `status: "needs_agent"`
- `requests[0] = { requestId, stepId, prompt, files, input, schema, attempt, maxAttempts, retryContext?, assigneeAgentId?, session? }`
  - `requestId` format: `<runId>:<stepId>:<attempt>` (used as key in `agentOutputs`).
  - `files`: Array of absolute file paths (resolved from `attachments` in step definition).
  - `schema` is **fully resolved** (all `$ref` expanded). The caller receives a self-contained JSON Schema.
  - `assigneeAgentId` / `session` are optional metadata for the caller (Crayfish only echoes them).

Then the caller must:

1) Select an agent session to produce the JSON (optionally using `assigneeAgentId` and `session.mode/label/reset`).

2) Run the model with a structured envelope:

```json
{
  "task": { "stepId": "...", "attempt": 1, "maxAttempts": 3 },
  "instructions": "<request.prompt>",
  "files": [ "/path/to/file1.pdf" ],
  "input": "<request.input>",
  "outputSchema": "<request.schema (fully resolved)>",
  "retryContext": "<request.retryContext if present>"
}
```

3) Call `crayfish.run` again with:

```json
{
  "agentOutputs": { "<requestId>": {"...": "..."} },
  "attempts": { "<stepId>": 1 },
  "results": { "<priorStepId>": { ... } }
}
```

## Session best practices (prevent zombie sessions)

Crayfish does **not** create or manage sessions — it only echoes `session` metadata in `needs_agent.requests[]`. The caller/OpenClaw manages session lifecycle. Follow these rules to avoid zombie sessions:

### Rule 1: Same agent = same sticky label

When a workflow has multiple `agent` steps targeting the same `assigneeAgentId`, use the **same `label`** to reuse one session:

```json
{
  "id": "verify",
  "kind": "agent",
  "assigneeAgentId": "analyst",
  "session": { "mode": "sticky", "label": "wf:heartbeat:analyst", "reset": true },
  ...
},
{
  "id": "analyze",
  "kind": "agent",
  "assigneeAgentId": "analyst",
  "session": { "mode": "sticky", "label": "wf:heartbeat:analyst" },
  ...
}
```

- First step: `"reset": true` → clean state.
- Subsequent steps: same label, no reset → reuse context.

### Rule 2: Label naming convention

Use `wf:<workflowName>:<assigneeAgentId>` for predictable, globally unique labels.

### Rule 3: Prefer sticky over ephemeral

- `sticky` + shared label → **1 session per agent per workflow** (recommended).
- `ephemeral` → new session per request, caller must destroy after use.
- No `session` field → caller decides (risky, may create unbounded sessions).

### Rule 4: Limit distinct assigneeAgentIds

Each distinct `assigneeAgentId` in a workflow may create a separate session. Keep the number small (1–3 agents per workflow).

## Where to place workflows

Recommended locations:
- `pipeline/workflows/xbot-heartbeat.json`
- `pipeline/workflows/xbot-daily.json`

Keep workflows in the workspace repo so they can be versioned.

## Validation checklist before wiring cron

- `jq -e . <workflow>.json` passes
- `exec` steps are deterministic and write artifacts under a temp dir
- `agent` steps have correct schema refs and retries <= 5
- `agent` steps sharing an `assigneeAgentId` use the same `session.label`
- A dry-run via `tools/invoke` succeeds for an `exec-only` workflow

