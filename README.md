# Crayfish (OpenClaw plugin)

Crayfish is an in-process **OpenClaw Gateway plugin** that provides a single agent tool: `crayfish`.

It executes a small **JSON workflow language** with step kinds:

- `exec` (deterministic subprocess)
- `agent` (schema-validated JSON output produced by an agent outside the tool)
- `if`, `forEach`, `while`

Key design properties:

- Crayfish **never calls LLMs**.
- `agent` steps return `status: "needs_agent"` with a `requests[]` array; the caller/orchestrator must route the request to an agent session and then call `crayfish.run` again with `agentOutputs`.
- Retries/iters are hard-capped at **<= 5**.

## Install (from GitHub)

### Option A: one-time install (copies into ~/.openclaw/extensions)

```bash
git clone https://github.com/eric9n/crayfish.git
cd crayfish
openclaw plugins install .
openclaw plugins enable crayfish
openclaw gateway restart
```

### Option B: dev install (link mode; pulls updates via `git pull`)

```bash
git clone https://github.com/eric9n/crayfish.git
cd crayfish
openclaw plugins install -l .
openclaw plugins enable crayfish
openclaw gateway restart
```

## Minimal working config

You need **both**: (1) enable the plugin, and (2) allow the `crayfish` tool.

### 1) Enable plugin

Open your `openclaw.json` (or use the Control UI) and add:

```json5
{
  "plugins": {
    "entries": {
      "crayfish": { "enabled": true }
    }
  }
}
```

Notes:
- `plugins.enabled` exists, but it defaults to enabled in most setups. You only need to set it if you previously disabled plugins globally.
- `plugins.allow` / `plugins.deny` are optional plugin load allow/deny lists. If you use them, ensure `crayfish` is allowed and not denied.
- Config changes require a **Gateway restart**.

## Plugin config

This plugin currently has **no global config** (its `configSchema` is an empty object). If you want a placeholder for future options, you may still include:

```json5
{
  "plugins": {
    "entries": {
      "crayfish": { "enabled": true, "config": {} }
    }
  }
}
```

### 2) Allow the `crayfish` tool

Tool usage is controlled by tool policy. Choose one:

Global allowlist example:

```json5
{
  "tools": {
    "allow": ["crayfish"]
  }
}
```

Per-agent allowlist example:

```json5
{
  "agents": {
    "list": [
      {
        "id": "primary",
        "tools": {
          "allow": ["crayfish"]
        }
      }
    ]
  }
}
```

## Usage

Crayfish exposes one tool:

- `crayfish` with `action: "run"`

See:

- `WORKFLOW_SPEC.md`
- `examples/`

## Agent step routing (optional)

For `kind: "agent"` steps, Crayfish may include optional **routing metadata** in `needs_agent.requests[]`. This helps the *caller/orchestrator* decide **which agent session** should produce the JSON.

Supported optional fields (Crayfish only echoes them; it does not spawn sessions):

- `assigneeAgentId?: string` — which agent should handle this step
- `session?: { mode?: "ephemeral"|"sticky"; label?: string; reset?: boolean }` — session reuse policy hint

If you use sticky sessions, a good label convention is:

- `wf:<workflowId>:<assigneeAgentId>`

## Skill

This repo includes a helper authoring skill:

- `skills/crayfish-workflows/SKILL.md`

## License

MIT (see `LICENSE`).
