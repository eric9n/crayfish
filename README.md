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

### Option A: clone + link (recommended for dev)

```bash
git clone <YOUR_GITHUB_REPO_URL>
cd crayfish
openclaw plugins install -l .
openclaw plugins enable crayfish
openclaw gateway restart
```

### Option B: clone + copy install

```bash
git clone <YOUR_GITHUB_REPO_URL>
cd crayfish
openclaw plugins install .
openclaw plugins enable crayfish
openclaw gateway restart
```

## Usage

Crayfish exposes one tool:

- `crayfish` with `action: "run"`

See:

- `WORKFLOW_SPEC.md`
- `examples/`

## Agent routing hints (B-scheme)

`kind: "agent"` steps support optional routing hints that are **echoed back** in `needs_agent.requests[]`:

- `assigneeAgentId?: string`
- `session?: { mode?: "ephemeral"|"sticky"; label?: string; reset?: boolean }`

Recommended sticky label convention:

- `wf:<workflowId>:<assigneeAgentId>`

Crayfish does not enforce or implement session spawning; your orchestrator does.

## Skill

This repo includes a helper authoring skill:

- `skills/crayfish-workflows/SKILL.md`

## License

MIT (see `LICENSE`).
