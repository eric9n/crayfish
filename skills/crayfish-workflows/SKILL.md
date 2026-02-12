---
name: crayfish-workflows
description: Create, edit, and validate Crayfish JSON workflows for OpenClaw pipelines (Heartbeat/Daily). Use when configuring a schema-validated pipeline with step kinds exec/agent/if/forEach/while, $ref schema resolution, per-call ref.schemaPaths, and needs_agent → agentOutputs convergence.
---

# Crayfish pipeline authoring

## Canonical spec + examples (read first)

- Spec: `/root/.openclaw/extensions/crayfish/WORKFLOW_SPEC.md`
- Examples:
  - `/root/.openclaw/extensions/crayfish/examples/heartbeat-skeleton.json`
  - `/root/.openclaw/extensions/crayfish/examples/daily-skeleton.json`

## Output rules (mandatory)

When asked to produce a workflow, output **STRICT JSON only**.

## Workflow contract (minimal)

A workflow must be:

- JSON object with `steps: []`
- Every step has unique `id`
- Step kinds allowed: `exec | agent | if | forEach | while`
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
- `requests[0] = { stepId, prompt, input, schema, attempt, maxAttempts, retryContext?, assigneeAgentId?, session? }`
  - `assigneeAgentId` / `session` are optional routing hints for the caller/orchestrator (Crayfish only echoes them).

Then the caller/orchestrator must:

1) Route the request to the desired agent session (e.g. by `assigneeAgentId`, and optionally using `session.mode/label/reset`).

2) Run the model with a structured envelope:

```json
{
  "task": { "stepId": "...", "attempt": 1, "maxAttempts": 3 },
  "instructions": "<prompt>",
  "input": {"...": "..."},
  "outputSchema": {"$ref": "Verify"},
  "retryContext": {"validationErrors": ["..."]}
}
```

3) Call `crayfish.run` again with:

```json
{
  "agentOutputs": { "<stepId>": {"...": "..."} },
  "attempts": { "<stepId>": 1 }
}
```

## Where to place workflows

Recommended locations:
- `pipeline/workflows/xbot-heartbeat.json`
- `pipeline/workflows/xbot-daily.json`

Keep workflows in the workspace repo so they can be versioned.

## Validation checklist before wiring cron

- `jq -e . <workflow>.json` passes
- `exec` steps are deterministic and write artifacts under a temp dir
- `agent` steps have correct schema refs and retries <= 5
- A dry-run via `tools/invoke` succeeds for an `exec-only` workflow
