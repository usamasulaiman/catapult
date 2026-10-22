#!/usr/bin/env node
// catapult CLI. `serve` runs the orchestrator; everything else talks to it over HTTP.
import { loadConfig } from "./config.ts";

const config = loadConfig();
const base = process.env.CATAPULT_URL ?? `http://${config.host}:${config.port}`;

async function call(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(() => { throw new Error(`cannot reach catapult at ${base} (is 'catapult serve' running?)`); });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

export function table(rows: Record<string, unknown>[], cols: string[]): string {
  const cell = (r: Record<string, unknown>, c: string) => String(r[c] ?? "");
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => cell(r, c).length)));
  const line = (f: (i: number) => string) => cols.map((_, i) => f(i).padEnd(w[i]!)).join("  ").trimEnd();
  return [line((i) => cols[i]!.toUpperCase()), ...rows.map((r) => line((i) => cell(r, cols[i]!)))].join("\n");
}

const flag = (args: string[], name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const usage = `usage: catapult <command>
  serve                                   run the orchestrator
  project add <id> <path> [--repo o/r] [--harness claude|pi] [--branch main] [--unsandboxed-ok] [--babysit]
  project set <id> <key> <json>            e.g. project set web pr_babysitter '{"enabled":true,"max_rounds":3}'
  run <worker> --project <id> [--prompt <text>] [--tier trusted|untrusted|unsandboxed]
  jobs [--project <id>] [--status <s>]
  cancel <job>
  sessions [--project <id>] [--status <s>]
  takeover <harness> <session>
  release <harness> <session>
  schedule add <project> <worker> "<cron>"
  transcript <harness> <session> [--limit n]
  steer <harness> <session> <text>
  actions [--status pending]
  approve <action> | reject <action>
  status`;

async function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "serve": {
      const { serve } = await import("./server.ts");
      return serve(config);
    }
    case "project": {
      if (rest[0] === "set" && rest[1] && rest[2] && rest[3] !== undefined) {
        await call("PATCH", `/projects/${rest[1]}`, { config: { [rest[2]]: JSON.parse(rest[3]) } });
        return console.log(`set ${rest[2]} on ${rest[1]}`);
      }
      if (rest[0] !== "add" || !rest[1] || !rest[2]) throw new Error(usage);
      const cfg: Record<string, unknown> = {};
      if (flag(rest, "harness")) cfg.harness = flag(rest, "harness");
      if (rest.includes("--unsandboxed-ok")) cfg.unsandboxed_ok = true;
      if (rest.includes("--babysit")) cfg.pr_babysitter = { enabled: true };
      await call("POST", "/projects", { id: rest[1], local_path: rest[2], repo_full_name: flag(rest, "repo"), default_branch: flag(rest, "branch"), config: cfg });
      return console.log(`added project ${rest[1]}`);
    }
    case "run": {
      const project = flag(rest, "project");
      if (!rest[0] || !project) throw new Error(usage);
      const prompt = flag(rest, "prompt");
      const job = await call("POST", "/jobs", { project_id: project, worker: rest[0], tier: flag(rest, "tier"), input: prompt ? { prompt } : {} });
      return console.log(job.id);
    }
    case "jobs": {
      const q = new URLSearchParams();
      for (const k of ["project", "status"]) if (flag(rest, k)) q.set(k, flag(rest, k)!);
      const rows = (await call("GET", `/jobs?${q}`)).map((j: any) => ({ ...j, id: j.id.slice(0, 8) }));
      return console.log(table(rows, ["id", "project_id", "worker", "tier", "status", "attempts"]));
    }
    case "cancel": {
      if (!rest[0]) throw new Error(usage);
      await call("POST", `/jobs/${rest[0]}/cancel`);
      return console.log("cancelled");
    }
    case "sessions": {
      const q = new URLSearchParams();
      for (const k of ["project", "status"]) if (flag(rest, k)) q.set(k, flag(rest, k)!);
      const rows = (await call("GET", `/sessions?${q}`)).map((s: any) => ({ ...s, session_id: s.session_id.slice(0, 12) }));
      return console.log(table(rows, ["harness", "session_id", "project_id", "origin", "status", "driver"]));
    }
    case "takeover": {
      if (!rest[0] || !rest[1]) throw new Error(usage);
      return console.log((await call("POST", `/sessions/${rest[0]}/${rest[1]}/takeover`)).command);
    }
    case "release": {
      if (!rest[0] || !rest[1]) throw new Error(usage);
      await call("POST", `/sessions/${rest[0]}/${rest[1]}/release`);
      return console.log("released");
    }
    case "schedule": {
      if (rest[0] !== "add" || !rest[1] || !rest[2] || !rest[3]) throw new Error(usage);
      const r = await call("POST", `/projects/${rest[1]}/schedules`, { worker: rest[2], cron: rest[3] });
      return console.log(r.id);
    }
    case "transcript": {
      if (!rest[0] || !rest[1]) throw new Error(usage);
      const r = await call("GET", `/sessions/${rest[0]}/${rest[1]}/transcript?limit=${flag(rest, "limit") ?? 50}`);
      for (const m of r.messages) console.log(`${m.role === "tool" ? `  [${m.tool.name}${m.tool.isError ? " error" : ""}]` : `${m.role}:`} ${m.text}`);
      return;
    }
    case "steer": {
      if (!rest[0] || !rest[1] || !rest[2]) throw new Error(usage);
      const r = await call("POST", `/sessions/${rest[0]}/${rest[1]}/message`, { text: rest.slice(2).join(" ") });
      return console.log(r.via === "live" ? "sent to the running session" : `resuming as job ${r.job}`);
    }
    case "actions": {
      const rows = (await call("GET", `/actions?status=${flag(rest, "status") ?? "pending"}`))
        .map((a: any) => ({ ...a, summary: String(a.summary ?? "").split("\n")[0]!.slice(0, 60) }));
      return console.log(table(rows, ["id", "kind", "project_id", "status", "summary"]));
    }
    case "approve":
    case "reject": {
      if (!rest[0]) throw new Error(usage);
      const r = await call("POST", `/actions/${rest[0]}/decision`, {
        decision: cmd === "approve" ? "approved" : "rejected", channel: "cli", approver: process.env.USER ?? "cli",
      });
      return console.log(r.status);
    }
    case "status": {
      const r = await call("GET", "/status");
      console.log(`queue: ${Object.entries(r.queue).map(([k, v]) => `${k} ${v}`).join(", ") || "empty"}`);
      console.log(`cost today: $${r.cost_today_usd.toFixed(2)}${r.daily_cap_usd ? ` of $${r.daily_cap_usd}` : ""}`);
      return console.log(table(r.workers.map((w: any) => ({ ...w, success_rate: `${Math.round(w.success_rate * 100)}%`, median_cost_usd: w.median_cost_usd?.toFixed(3) ?? "" })),
        ["worker", "runs", "success_rate", "median_cost_usd", "cost_usd_7d"]));
    }
    default:
      console.log(usage);
      process.exitCode = cmd ? 2 : 0;
  }
}

if (import.meta.filename === process.argv[1]) {
  main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });
}
