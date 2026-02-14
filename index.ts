import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Crayfish plugin (in-process OpenClaw agent tool)
//
// Core principles (per user decisions):
// - No lobster-style pause/resume.
// - No tokens.
// - No tool-driven LLM calls.
//
// Workflows can include "agent" steps. The tool returns `needs_agent` unless the
// caller supplies `agentOutputs[requestId]`, which is schema-validated.
//
// Exec steps are deterministic subprocesses. This version supports:
// - run.kind="cmd" with {cmd,args[]}
// - io.mode:
//   - "none"  : no structured I/O. stdout is free-form text.
//   - "file"  : validate declared io.in/io.out JSON files (schema optional).
//   - "stream": JSON-in/JSON-out via stdin/stdout with schema validation.
//
// $ref resolution:
// - `$ref` basenames only (no path separators)
// - search roots are per-call: params.ref.schemaPaths[] (RELATIVE to workspace root)

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

type Cond =
  | { op: "eq"; path: string; value: Json }
  | { op: "ne"; path: string; value: Json }
  | { op: "exists"; path: string }
  | { op: "gt"; path: string; value: number }
  | { op: "lt"; path: string; value: number };

type FileContract = {
  path: string; // workspace-relative only
  schema?: Json; // JSON Schema (supports $ref)
};

type StreamInputFrom = {
  stepId: string;
  jsonPath?: string; // default "$"
};

type Step =
  | {
    id: string;
    kind: "exec";
    run: { kind: "cmd"; cmd: string; args?: string[] };
    timeoutMs?: number;
    retries?: number;
    env?: Record<string, string>;
    io?:
    | { mode?: "none" }
    | {
      mode: "file";
      in?: Record<string, FileContract>;
      out?: Record<string, FileContract>;
    }
    | {
      mode: "stream";
      inputFrom?: StreamInputFrom;
      inputSchema?: Json;
      outputSchema?: Json;
    };
  }
  | {
    id: string;
    kind: "agent";
    // Optional metadata for the caller to decide which agent session should produce the JSON for this step.
    // Note: Crayfish does not start agent sessions; it only includes these fields in `needs_agent.requests[]`.
    assigneeAgentId?: string;
    // Optional session policy (used by the caller).
    // Recommended label convention: `wf:<workflowId>:<assigneeAgentId>`.
    session?: {
      mode?: "ephemeral" | "sticky";
      label?: string;
      reset?: boolean;
    };
    prompt: string;
    input: Json;
    schema: Json;
    retries?: number; // 1..5 (hard cap)
  }
  | {
    id: string;
    kind: "if";
    cond: Cond;
    then: Step[];
    else?: Step[];
  };

type Workflow = {
  name?: string;
  version?: number;
  vars?: Record<string, Json>;
  steps: Step[];
};

type RunCtx = {
  vars: Record<string, Json>;
  // stepId -> result payload
  results: Record<string, any>;
  // requestId -> agent output payload (validated against step.schema)
  agentOutputs: Record<string, any>;
  // stepId -> current attempt counter (1-indexed)
  attempts: Record<string, number>;
};

// --- Exec Constants ---
const DEFAULT_EXEC_TIMEOUT_MS = 180000; // 3 minutes

function clamp1to5(n: any, fallback: number) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.min(5, Math.max(1, Math.floor(x)));
}

function getType(v: any) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function safeRefToFilename(ref: string) {
  const r = String(ref || "").trim();
  if (!r || r.includes("/") || r.includes("\\")) return null;
  return r.endsWith(".json") ? r : `${r}.json`;
}

function getWorkspaceRoot(params: any): string {
  return String(params?.__workspaceRoot || process.cwd());
}

function getSchemaDirsFromParams(params: any): string[] {
  const root = getWorkspaceRoot(params);
  const dirsRaw = params?.ref?.schemaPaths;
  const dirs: string[] = Array.isArray(dirsRaw) ? dirsRaw.filter((x: any) => typeof x === "string") : [];
  const out: string[] = [];
  for (const d of dirs) {
    if (!d || d.startsWith("/")) continue; // only relative
    const resolved = path.resolve(root, d);
    if (resolved === root || resolved.startsWith(root + path.sep)) out.push(resolved);
  }
  return Array.from(new Set(out)).slice(0, 10);
}

function resolveRef(params: any, ref: string) {
  const fname = safeRefToFilename(ref);
  if (!fname) throw new Error(`Invalid $ref: ${ref}`);
  const dirs = getSchemaDirsFromParams(params);

  for (const dir of dirs) {
    const p = path.join(dir, fname);
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    }
  }
  throw new Error(`$ref not found: ${ref} (searched: ${dirs.join(", ") || "<empty ref.schemaPaths>"})`);
}

/** Deep-resolve all $ref in a schema tree so the returned schema is fully self-contained. */
function resolveSchemaRefs(params: any, schema: any, seen = new Set<string>()): any {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map((s) => resolveSchemaRefs(params, s, seen));

  if (schema.$ref) {
    const ref = String(schema.$ref);
    if (seen.has(ref)) return schema; // circular – return as-is
    try {
      const resolved = resolveRef(params, ref);
      return resolveSchemaRefs(params, resolved, new Set([...seen, ref]));
    } catch {
      return schema; // unresolvable – return as-is
    }
  }

  const out: any = {};
  for (const [k, v] of Object.entries(schema)) {
    out[k] = v && typeof v === "object" ? resolveSchemaRefs(params, v, seen) : v;
  }
  return out;
}

function validateSchema(params: any, schema: any, value: any, pth = "$", errs: string[] = [], refStack: string[] = []) {
  if (!schema || typeof schema !== "object") return errs;

  if (schema.$ref) {
    const ref = String(schema.$ref);
    if (refStack.includes(ref)) {
      errs.push(`${pth}: circular $ref detected: ${refStack.join(" -> ")} -> ${ref}`);
      return errs;
    }
    try {
      const resolved = resolveRef(params, ref);
      return validateSchema(params, resolved, value, pth, errs, refStack.concat([ref]));
    } catch (e: any) {
      errs.push(`${pth}: ${(e?.message ?? e)}`);
      return errs;
    }
  }

  if (schema.enum) {
    const ok = schema.enum.some((x: any) => JSON.stringify(x) === JSON.stringify(value));
    if (!ok) errs.push(`${pth}: enum mismatch`);
  }

  const allowed = schema.type ? (Array.isArray(schema.type) ? schema.type : [schema.type]) : null;
  const t = getType(value);
  if (allowed && !allowed.includes(t)) {
    errs.push(`${pth}: expected type ${allowed.join("|")}, got ${t}`);
    return errs;
  }

  const objectAllowed = (!allowed && t === "object") || (allowed && allowed.includes("object") && t === "object");
  if (objectAllowed && schema.properties) {
    const req: string[] = schema.required || [];
    for (const k of req) {
      if (!(k in (value || {}))) errs.push(`${pth}: missing required property '${k}'`);
    }
    for (const [k, sub] of Object.entries(schema.properties)) {
      if (value && typeof value === "object" && k in value) {
        validateSchema(params, sub, (value as any)[k], `${pth}.${k}`, errs, refStack);
      }
    }
    if (schema.additionalProperties === false) {
      const allowedKeys = new Set(Object.keys(schema.properties));
      for (const k of Object.keys(value || {})) {
        if (!allowedKeys.has(k)) errs.push(`${pth}: additional property '${k}' not allowed`);
      }
    }
  }

  const arrayAllowed = (!allowed && t === "array") || (allowed && allowed.includes("array") && t === "array");
  if (arrayAllowed && schema.items) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) errs.push(`${pth}: minItems`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) errs.push(`${pth}: maxItems`);
    for (let i = 0; i < value.length; i++) validateSchema(params, schema.items, value[i], `${pth}[${i}]`, errs, refStack);
  }

  return errs;
}

function getPath(obj: any, p: string): any {
  const s = String(p || "").trim();
  if (s === "$") return obj;
  if (!s.startsWith("$.")) return undefined;
  const rest = s.slice(2);
  const toks: Array<string | number> = [];
  let buf = "";
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (ch === ".") {
      if (buf) toks.push(buf), (buf = "");
      continue;
    }
    if (ch === "[") {
      if (buf) toks.push(buf), (buf = "");
      const j = rest.indexOf("]", i);
      if (j === -1) return undefined;
      const idxRaw = rest.slice(i + 1, j).trim();
      if (!/^\d+$/.test(idxRaw)) return undefined;
      toks.push(Number(idxRaw));
      i = j;
      continue;
    }
    buf += ch;
  }
  if (buf) toks.push(buf);

  let cur = obj;
  for (const t of toks) {
    if (cur == null) return undefined;
    if (typeof t === "number") {
      if (!Array.isArray(cur) || t < 0 || t >= cur.length) return undefined;
      cur = cur[t];
    } else {
      if (typeof cur !== "object") return undefined;
      cur = cur[t];
    }
  }
  return cur;
}

function evalCond(cond: Cond, ctx: RunCtx) {
  const root = { vars: ctx.vars, results: ctx.results };
  const v = getPath(root, cond.path);
  if (cond.op === "exists") return v !== undefined && v !== null;
  if (cond.op === "eq") return JSON.stringify(v) === JSON.stringify(cond.value);
  if (cond.op === "ne") return JSON.stringify(v) !== JSON.stringify(cond.value);
  if (cond.op === "gt") return typeof v === "number" && v > cond.value;
  if (cond.op === "lt") return typeof v === "number" && v < cond.value;
  return false;
}

function interpolate(str: string, ctx: RunCtx) {
  return String(str).replace(/\{\{([^}]+)\}\}/g, (_m, expr) => {
    const e = String(expr).trim();
    if (e.startsWith("vars.")) return String(getPath({ vars: ctx.vars }, `$.${e}`) ?? "");
    return "";
  });
}

function interpolateDeep(val: Json, ctx: RunCtx): Json {
  if (typeof val === "string") {
    // Single expression → return raw value (preserves objects/arrays/numbers)
    const m = val.match(/^\{\{([^}]+)\}\}$/);
    if (m) {
      const e = m[1].trim();
      if (e.startsWith("vars.")) return getPath({ vars: ctx.vars }, `$.${e}`) ?? null;
      return null;
    }
    return interpolate(val, ctx);
  }
  if (Array.isArray(val)) return val.map((v) => interpolateDeep(v, ctx));
  if (val !== null && typeof val === "object") {
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(val)) {
      out[k] = interpolateDeep(v as Json, ctx);
    }
    return out;
  }
  return val;
}

function resolveWorkspacePath(params: any, pRel: string) {
  const root = getWorkspaceRoot(params);
  const raw = String(pRel || "");
  if (!raw || raw.startsWith("/")) throw new Error(`Path must be workspace-relative: ${raw}`);
  const resolved = path.resolve(root, raw);
  if (!(resolved === root || resolved.startsWith(root + path.sep))) {
    throw new Error(`Path escapes workspace root: ${raw}`);
  }
  return resolved;
}

function readJsonFile(absPath: string) {
  const txt = fs.readFileSync(absPath, "utf8");
  return JSON.parse(txt);
}

function validateFileContract(params: any, contract: FileContract, ctx: RunCtx, label: string) {
  const pRel = interpolate(contract.path, ctx);
  const pAbs = resolveWorkspacePath(params, pRel);
  const value = readJsonFile(pAbs);
  if (contract.schema) {
    const errs = validateSchema(params, contract.schema, value);
    if (errs.length) throw new Error(`Schema validation failed for ${label} (${pRel}): ${errs.slice(0, 5).join("; ")}`);
  }
  return { pathRel: pRel, pathAbs: pAbs, value };
}

async function execCmd(
  params: any,
  cmd: string,
  args: string[] = [],
  timeoutMs = DEFAULT_EXEC_TIMEOUT_MS,
  stdinText?: string,
  env?: Record<string, string>
) {
  const { spawn } = await import("node:child_process");
  const cwd = getWorkspaceRoot(params);

  return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd,
      env: env ? { ...process.env, ...env } : undefined
    });
    let stdout = "";
    let stderr = "";
    const t = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`exec timeout (exceeded ${timeoutMs}ms)`));
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
    child.on("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(t);
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(`exec failed (${code}): ${stderr.slice(0, 800)}`));
    });

    if (stdinText !== undefined) {
      child.stdin.write(stdinText);
    }
    child.stdin.end();
  });
}

async function runSteps(params: any, steps: Step[], ctx: RunCtx): Promise<any> {
  for (const step of steps) {
    if (!step.id) throw new Error("Step missing id");

    // Resume support: if we already have a successful result for this stepId, skip re-running it.
    if (ctx.results?.[step.id]?.ok === true) {
      continue;
    }

    if (step.kind === "exec") {
      if ((step as any).shell !== undefined) {
        throw new Error(
          `exec(${step.id}): 'shell' is deprecated. Use run: { kind: "cmd", cmd: "bash", args: ["-lc", "<shell>"] }.`
        );
      }
      const retries = clamp1to5(step.retries, 1);
      let lastErr: any = null;
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          const timeoutMs = step.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
          const mode = (step.io as any)?.mode ?? "none";

          if (step.run?.kind !== "cmd" || typeof step.run.cmd !== "string") {
            throw new Error(`exec(${step.id}): run.kind=cmd with cmd string is required`);
          }

          const cmdI = interpolate(step.run.cmd, ctx);
          const argsI = (step.run.args ?? []).map((a) => interpolate(a, ctx));

          let envI: Record<string, string> | undefined;
          if (step.env) {
            envI = {};
            for (const [k, v] of Object.entries(step.env)) {
              envI[k] = interpolate(v, ctx);
            }
          }

          if (mode === "file") {
            const ioIn = (step.io as any).in || {};
            for (const [k, c] of Object.entries(ioIn)) {
              validateFileContract(params, c as any, ctx, `step:${step.id}:in:${k}`);
            }

            const out = await execCmd(params, cmdI, argsI, timeoutMs, undefined, envI);

            const outputs: any = {};
            const ioOut = (step.io as any).out || {};
            for (const [k, c] of Object.entries(ioOut)) {
              const info = validateFileContract(params, c as any, ctx, `step:${step.id}:out:${k}`);
              outputs[k] = { path: info.pathRel };
            }

            ctx.results[step.id] = { kind: "exec", ok: true, mode: "file", stdout: out.stdout.trim(), stderr: out.stderr, outputs };
            lastErr = null;
            break;
          }

          if (mode === "stream") {
            const inputFrom = (step.io as any).inputFrom as StreamInputFrom | undefined;
            let inJson: any = null;
            if (inputFrom?.stepId) {
              const prev = ctx.results[inputFrom.stepId];
              const prevJson = prev?.json;
              if (prevJson === undefined) throw new Error(`exec(${step.id}): stream inputFrom step '${inputFrom.stepId}' has no .json result`);
              const jp = inputFrom.jsonPath || "$";
              inJson = getPath(prevJson, jp);
            }

            const inSchema = (step.io as any).inputSchema;
            if (inSchema) {
              const errs = validateSchema(params, inSchema, inJson);
              if (errs.length) throw new Error(`exec(${step.id}): inputSchema failed: ${errs.slice(0, 5).join("; ")}`);
            }

            const stdinText = JSON.stringify(inJson ?? null);

            const out = await execCmd(params, cmdI, argsI, timeoutMs, stdinText, envI);

            let outJson: any;
            try {
              outJson = JSON.parse(out.stdout);
            } catch {
              throw new Error(`exec(${step.id}): stream mode requires pure JSON on stdout`);
            }

            const outSchema = (step.io as any).outputSchema;
            if (outSchema) {
              const errs = validateSchema(params, outSchema, outJson);
              if (errs.length) throw new Error(`exec(${step.id}): outputSchema failed: ${errs.slice(0, 5).join("; ")}`);
            }

            ctx.results[step.id] = { kind: "exec", ok: true, mode: "stream", stdout: "", stderr: out.stderr, json: outJson };
            lastErr = null;
            break;
          }

          const out = await execCmd(params, cmdI, argsI, timeoutMs, undefined, envI);
          ctx.results[step.id] = { kind: "exec", ok: true, mode: "none", stdout: out.stdout.trim(), stderr: out.stderr };
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          ctx.results[step.id] = { kind: "exec", ok: false, error: String((e as any)?.message ?? e), attempt };
        }
      }
      if (lastErr) throw lastErr;
      continue;
    }

    if (step.kind === "if") {
      const ok = evalCond(step.cond, ctx);
      const branch = ok ? step.then : step.else ?? [];
      const res = await runSteps(params, branch, ctx);
      if (res?.status === "needs_agent") return res;
      continue;
    }

    if (step.kind === "agent") {
      const maxAttempts = clamp1to5(step.retries, 2);
      const attempt = Math.max(1, Math.floor(Number(ctx.attempts[step.id] ?? 1)));
      const runId = String(params?.runId || "");
      if (!runId) throw new Error("Missing runId (required for requestId-based resume)");
      const requestId = `${runId}:${step.id}:${attempt}`;
      const out = ctx.agentOutputs?.[requestId];

      // Resolve templates in prompt and input (supports {{vars.*}})
      const resolvedPrompt = interpolate(step.prompt, ctx);
      const resolvedInput = interpolateDeep(step.input, ctx);
      // Deep-resolve $ref so the returned schema is self-contained for the caller/LLM
      const resolvedSchema = resolveSchemaRefs(params, step.schema);

      if (out === undefined) {
        return {
          ok: true,
          status: "needs_agent",
          requests: [
            {
              requestId,
              stepId: step.id,
              assigneeAgentId: step.assigneeAgentId,
              session: step.session,
              attempt,
              maxAttempts,
              prompt: resolvedPrompt,
              input: resolvedInput,
              schema: resolvedSchema
            }
          ],
          results: ctx.results,
          attempts: ctx.attempts
        };
      }

      const errs = validateSchema(params, step.schema, out);
      if (errs.length) {
        const nextAttempt = attempt + 1;
        ctx.attempts[step.id] = nextAttempt;
        if (nextAttempt > maxAttempts) {
          return { ok: false, error: "agent_output_schema_failed", stepId: step.id, errors: errs.slice(0, 30) };
        }
        const nextRequestId = `${runId}:${step.id}:${nextAttempt}`;
        return {
          ok: true,
          status: "needs_agent",
          requests: [
            {
              requestId: nextRequestId,
              stepId: step.id,
              assigneeAgentId: step.assigneeAgentId,
              session: step.session,
              attempt: nextAttempt,
              maxAttempts,
              prompt: resolvedPrompt,
              input: resolvedInput,
              schema: resolvedSchema,
              retryContext: { validationErrors: errs.slice(0, 30) }
            }
          ],
          results: ctx.results,
          attempts: ctx.attempts
        };
      }

      ctx.results[step.id] = { kind: "agent", ok: true, json: out };
      continue;
    }

    throw new Error(`Unsupported step kind: ${(step as any).kind}`);
  }

  return { ok: true, status: "done", results: ctx.results, attempts: ctx.attempts };
}

// Tool parameters schema
const PARAMETERS_SCHEMA: any = {
  type: "object",
  additionalProperties: false,
  required: ["action", "workflow", "agentId"],
  properties: {
    action: { type: "string", enum: ["run"] },
    runId: { type: "string" },
    agentId: { type: "string" },
    workflow: {
      type: "object",
      additionalProperties: false,
      required: ["steps"],
      properties: {
        name: { type: "string" },
        version: { type: "number" },
        vars: { type: "object" },
        steps: { type: "array", items: {} }
      }
    },
    vars: { type: "object" },
    results: { type: "object" },
    agentOutputs: { type: "object" },
    attempts: { type: "object" },
    ref: {
      type: "object",
      additionalProperties: false,
      properties: {
        schemaPaths: { type: "array", items: { type: "string" } }
      }
    }
  }
};

function resolveWorkspaceRootFromAgentId(api: any, agentId: string): string | null {
  const id = String(agentId || "").trim();
  if (!id) return null;
  const list = api?.config?.agents?.list;
  if (!Array.isArray(list)) return null;
  const agent = list.find((a: any) => a && (a.id === id || a.name === id));
  const ws = agent?.workspace;
  return typeof ws === "string" && ws.startsWith("/") ? ws : null;
}

export default function (api: any) {
  api.registerTool(
    {
      name: "crayfish",
      description:
        "Crayfish: run a JSON workflow (exec(cmd)+io modes, agent, if) with schema-validated convergence retries (<=5).",
      parameters: PARAMETERS_SCHEMA,
      async execute(_id: string, params: any) {
        if (params.action !== "run") {
          return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "Unknown action" }) }] };
        }

        if (!params?.agentId) {
          return {
            content: [{ type: "text", text: JSON.stringify({ ok: false, error: "Missing required field: agentId" }) }]
          };
        }

        const root = resolveWorkspaceRootFromAgentId(api, params.agentId);
        if (!root) {
          return {
            content: [{ type: "text", text: JSON.stringify({ ok: false, error: `Unknown agentId '${params.agentId}'` }) }]
          };
        }

        const runId = String(params.runId || crypto.randomBytes(6).toString("hex"));
        const runtimeParams = { ...params, __workspaceRoot: root, runId };
        const wf: Workflow = params.workflow;

        const embeddedAgentOutputs = (wf.vars as any)?.__agentOutputs;
        const embeddedAttempts = (wf.vars as any)?.__attempts;
        const embeddedResults = (wf.vars as any)?.__results;

        const mergedVars: Record<string, Json> = { ...(wf.vars ?? {}), ...(params.vars ?? {}) };
        delete (mergedVars as any).__agentOutputs;
        delete (mergedVars as any).__attempts;
        delete (mergedVars as any).__results;

        const ctx: RunCtx = {
          vars: mergedVars,
          results: params.results ?? embeddedResults ?? {},
          agentOutputs: params.agentOutputs ?? embeddedAgentOutputs ?? {},
          attempts: params.attempts ?? embeddedAttempts ?? {}
        };

        try {
          const out = await runSteps(runtimeParams, wf.steps as any, ctx);
          return { content: [{ type: "text", text: JSON.stringify({ runId, ...out }) }] };
        } catch (err: any) {
          return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: err?.message || String(err) }) }] };
        }
      }
    },
    { optional: true }
  );
}
