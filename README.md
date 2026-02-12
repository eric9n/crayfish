# Crayfish (OpenClaw plugin)

Crayfish is an in-process **OpenClaw Gateway plugin** that provides a single agent tool: `crayfish`.

It executes a small **JSON workflow language** with step kinds:

- `exec` (deterministic subprocess)
- `agent` (schema-validated JSON output produced by an agent outside the tool)
- `if`, `forEach`, `while`

Key design properties:

- `agent` steps return `status: "needs_agent"` with a `requests[]` array; the caller must produce a JSON output and then call `crayfish.run` again with `agentOutputs`.
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

Add this to your `openclaw.json` (or use the Control UI):

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
- `plugins.allow` / `plugins.deny` are optional plugin load allow/deny lists. If you use them, ensure `crayfish` is allowed and not denied.
- Config changes require a **Gateway restart**.

### 2) Allow the `crayfish` tool

Choose one:

Global allowlist:

```json5
{
  "tools": {
    "allow": ["crayfish"]
  }
}
```

Per-agent allowlist:

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

## Agent step metadata (optional)

`kind: "agent"` steps may include optional metadata that is echoed back in `needs_agent.requests[]`:

- `assigneeAgentId?: string`
- `session?: { mode?: "ephemeral"|"sticky"; label?: string; reset?: boolean }`

Suggested sticky label convention:

- `wf:<workflowId>:<assigneeAgentId>`

## Skill

This repo includes a helper authoring skill:

- `skills/crayfish-workflows/SKILL.md`

## License

MIT (see `LICENSE`).
