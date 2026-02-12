# Crayfish Workflow Spec (v0.1)

Purpose: define a **JSON workflow language** executed by the OpenClaw in-process tool `crayfish`.

Crayfish is a **scheduler + validator + convergence loop**. It does **not** call LLMs directly.
Instead, LLM judgment happens in the **agent context** via `kind: "agent"` steps.

## 0) Key properties

- **Tool name**: `crayfish`
- **Action**: `run`
- **No tokens / no pause-resume** (explicitly rejected)
- **Retries are hard-capped at 5**
  - `exec.retries` in `[1..5]`
  - `agent.retries` in `[1..5]`
  - `while.maxIters` in `[1..5]`

## 1) How an `agent` step works (core contract)

Crayfish supports steps that require structured output produced by the current agent.

Workflow declares:
- `prompt`: instructions (must demand STRICT JSON)
- `input`: structured input payload
- `schema`: JSON Schema for the agent output (supports `$ref`)
- `retries`: max attempts (1–5)

Runtime behavior:
1) If caller does **not** provide `agentOutputs[stepId]`:
   - Crayfish returns `status: "needs_agent"` with a `requests[]` array.
   - Each request MAY include `assigneeAgentId` and `session` (if declared on the `agent` step) as optional metadata for the caller.
2) Caller (the agent) generates JSON and calls `crayfish.run` again with:
   - `agentOutputs: { [stepId]: <json> }`
   - `attempts: { [stepId]: <attemptNumber> }` (start at 1)
3) Crayfish validates output against `schema`:
   - If valid: stores into `results[stepId]` and continues.
   - If invalid: returns `needs_agent` again, including:
     - `retryContext.validationErrors[]`
     - incremented `attempt`
   - If attempts exceed `retries`: returns `{ ok:false, error:"agent_output_schema_failed" }`.

This achieves **schema-validated convergence loops** without the tool ever calling an LLM.

## 2) Workflow JSON structure

```json
{
  "name": "heartbeat",
  "version": 1,
  "vars": {
    "tmp": "/tmp/xbot"
  },
  "steps": [
    { "id": "fetch", "kind": "exec", "shell": "echo hi" }
  ]
}
```

### Top-level fields
- `name` (string, optional)
- `version` (number, optional)
- `vars` (object, optional): static variables available to template interpolation
- `steps` (array, required): list of steps

## 3) Context model: vars/results/locals

During execution, expressions may reference three namespaces:
- `vars`: workflow variables (merged from workflow.vars and invocation vars)
- `results`: outputs from prior steps by id
- `locals`: loop locals (from forEach)

These namespaces are accessible in conditions via JSON paths (see below).

## 4) Step kinds

### `$ref` support for schemas

Crayfish supports `schema: {"$ref":"Name"}` or `{"$ref":"Name.json"}`.

Resolver rules (security, per project policy):
- `$ref` must be a **basename** (no `/` or `\\`).
- Search roots are provided **per call** via tool args:
  - `ref.schemaPaths: string[]`
- Each entry in `ref.schemaPaths` must be a **relative path** (must NOT start with `/`).
- Each entry is resolved relative to the **workspace root** of `agentId`.
  - `agentId` is **required** for `crayfish.run`.
  - Crayfish maps `agentId` → `api.config.agents.list[].workspace`.
- Resolved paths must remain inside the workspace root (no path traversal).
- There is **no global default** schema path.

### 4.1) `exec`

Runs a deterministic subprocess command (`cmd` + `args`).

Schema:
```json
{
  "id": "fetch",
  "kind": "exec",
  "shell": "echo hello",
  "timeoutMs": 180000,
  "retries": 2,
  "io": {
    "in": {
      "raw": { "path": "data/raw.json", "schema": { "$ref": "TweetsMerged" } }
    },
    "out": {
      "norm": { "path": "data/norm.json", "schema": { "$ref": "TweetsNorm" } }
    }
  }
}
```

- `run.kind` must be `cmd`.
- `run.cmd` is the executable; `run.args` are argv.

#### I/O modes

`exec.io.mode` selects how steps pass data:

- `mode: "none"` (default)
  - no structured I/O
  - stdout is free-form text

- `mode: "file"`
  - validate declared JSON files:
    - **before** running: `io.in.*`
    - **after** running: `io.out.*`
  - each file contract has:
    - `path` (workspace-relative, no leading `/`)
    - optional `schema` (if omitted, only JSON parse is enforced)

- `mode: "stream"`
  - JSON-in/JSON-out via stdin/stdout
  - **stdout MUST be pure JSON** (no logs)
  - optional `inputFrom` to take JSON from `results[stepId].json`
  - optional `inputSchema` / `outputSchema`

Returns (in `results[id]`):
- `ok`
- `stderr`
- `mode`
- `stdout` (only for mode none/file)
- `json` (only for mode stream)

Template interpolation:
- inside file contract `path` strings
- inside `exec.run.cmd` and every string in `exec.run.args`

Supported expressions:
- `{{vars.X}}`
- `{{locals.Y}}`

Example:
```json
{ "id":"mk", "kind":"exec", "shell":"mkdir -p '{{vars.tmp}}'" }
```

### 4.2) `agent`

Requests a schema-validated JSON output from the agent.

Optional step metadata:
- `assigneeAgentId` (string, optional): echoed back in `needs_agent.requests[]` so the **caller** can select which agent session should handle this step. If omitted, the caller may default to its current agent.
- `session` (object, optional): session policy echoed back in `needs_agent.requests[]`.
  - `mode`: "ephemeral" | "sticky" (default: caller decides)
  - `label`: recommended sticky label (convention: `wf:<workflowId>:<assigneeAgentId>`)
  - `reset`: boolean; if true, the caller should reset/recreate the sticky session before running

Schema:
```json
{
  "id": "verify",
  "kind": "agent",
  "assigneeAgentId": "musk",
  "session": { "mode": "sticky", "label": "wf:123:musk" },
  "prompt": "Output STRICT JSON ...",
  "input": { "clusters": [] },
  "schema": { "type":"object", "properties": {"ok":{"type":"boolean"}}, "required":["ok"], "additionalProperties":false },
  "retries": 3
}
```

### 4.3) `if`

Branch based on a condition.

Schema:
```json
{
  "id": "gate",
  "kind": "if",
  "cond": { "op": "exists", "path": "$.results.fetch" },
  "then": [ ...steps... ],
  "else": [ ...steps... ]
}
```

### 4.4) `forEach`

Loop over an array found at `listPath`.

Schema:
```json
{
  "id": "loop",
  "kind": "forEach",
  "listPath": "$.results.cluster.json.clusters",
  "itemVar": "cluster",
  "body": [ ...steps... ]
}
```

- Each iteration sets `locals[ itemVar ] = currentItem`.

### 4.5) `while`

Runs `body` until `until` becomes true, or `maxIters` reached.

Schema:
```json
{
  "id": "converge",
  "kind": "while",
  "maxIters": 3,
  "until": { "op": "exists", "path": "$.results.verify" },
  "body": [ ...steps... ]
}
```

Note: `maxIters` is hard-capped to 5.

## 5) Condition language

Condition object (`cond` / `until`) supports:
- `exists`: `{ op:"exists", path:"$.results.a" }`
- `eq`: `{ op:"eq", path:"$.vars.mode", value:"daily" }`
- `ne`: `{ op:"ne", path:"$.locals.cluster.id", value:"x" }`
- `gt`: `{ op:"gt", path:"$.results.score", value": 0.7 }`
- `lt`: `{ op:"lt", path:"$.results.score", value": 0.2 }`

### Paths
Paths must start with `$.`.
Supported tokens:
- dot keys: `$.results.fetch`
- numeric indexes: `$.results.items[0]`

Namespaces are available under the root:
- `$.vars.*`
- `$.results.*`
- `$.locals.*`

## 6) Invocation shape (tool call)

Crayfish tool call args:

```json
{
  "action": "run",
  "workflow": { ... },
  "vars": { ... },
  "agentOutputs": { "verify": { ... } },
  "attempts": { "verify": 1 }
}
```

- `vars` overrides/extends workflow.vars.
- `agentOutputs` provides agent-step outputs by step id.
- `attempts` carries attempt counters for agent steps.

## 7) Minimal example (exec → agent → exec)

Workflow:
```json
{
  "name": "agent-test",
  "version": 1,
  "steps": [
    {"id":"a","kind":"exec","shell":"echo pre"},
    {
      "id":"v",
      "kind":"agent",
      "prompt":"Return STRICT JSON {foo:string} only.",
      "input": {"x":1},
      "schema": {
        "type":"object",
        "additionalProperties": false,
        "required":["foo"],
        "properties": {"foo":{"type":"string"}}
      },
      "retries": 3
    },
    {"id":"b","kind":"exec","shell":"echo post"}
  ]
}
```

Run 1 (no agentOutputs): returns `needs_agent`.

Run 2 (with agentOutputs):
```json
{
  "action":"run",
  "workflow": { ... },
  "agentOutputs": { "v": {"foo":"bar"} },
  "attempts": { "v": 1 }
}
```

## 8) Authoring + runtime guidelines for LLMs (important)

### 8.1 Write workflows (LLM authoring rules)

When an LLM writes a workflow JSON:
- Output **JSON only**, no markdown.
- Every step must have unique `id`.
- Keep `exec.shell` deterministic and safe.
- Put all LLM judgment into `agent` steps, with:
  - strict output schema (prefer `$ref`)
  - retries <= 5
  - a short `prompt` describing *what to do* (do NOT paste the schema into the prompt).

### 8.2 Structured-input method A (recommended for agent steps)

Do **not** embed the schema into the `prompt` string. Instead, the agent should pass a structured payload to the model that includes:
- `instructions` (the step prompt)
- `input`
- `outputSchema`
- `retryContext` (if present)

Recommended model input envelope:

```json
{
  "task": { "stepId": "verify", "attempt": 1, "maxAttempts": 3 },
  "instructions": "<requests[0].prompt>",
  "input": { "...": "..." },
  "outputSchema": { "$ref": "Verify" },
  "retryContext": { "validationErrors": ["..."] }
}
```

Model output requirements (system-level rules suggested):
- Output **STRICT JSON only** (no markdown, no explanation).
- Output MUST validate against `outputSchema`.
- If `retryContext.validationErrors` exists, fix them first.

---

Status: v0.1 (MVP). Next planned additions: richer interpolation, explicit artifact files, stricter static validation of steps.
