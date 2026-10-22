import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  ago, api, serverUrl, setServerUrl, subscribe,
  type Action, type Change, type Job, type Message, type Project, type Schedule, type Session,
} from "./api.ts";

// ---------- routing + live updates ----------

function useHash(): string[] {
  const read = () => (location.hash.replace(/^#\/?/, "") || "sessions").split("/").map(decodeURIComponent);
  const [parts, setParts] = useState(read);
  useEffect(() => {
    const on = () => setParts(read());
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return parts;
}
const go = (...parts: string[]) => { location.hash = `/${parts.map(encodeURIComponent).join("/")}`; };

/** Fetch `path`, refetching whenever `deps` changes (pass the live version to follow the stream). */
function useApi<T>(path: string | null, deps: unknown[] = []): { data: T | undefined; error: string | undefined; reload: () => void } {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true;
    api<T>(path).then((d) => { if (live) { setData(d); setError(undefined); } }).catch((e) => live && setError(e.message));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, n, ...deps]);
  return { data, error, reload: useCallback(() => setN((x) => x + 1), []) };
}

// ---------- shell ----------

export function App() {
  const route = useHash();
  const [version, setVersion] = useState(0);
  const [lastChange, setLastChange] = useState<Change>();
  const [live, setLive] = useState(false);
  const [server, setServer] = useState(serverUrl());
  useEffect(() => subscribe((c) => { setLastChange(c); setVersion((v) => v + 1); }, setLive), [server]);
  const pending = useApi<Action[]>("/actions?status=pending", [version, server]);

  const tabs: [string, string][] = [["sessions", "Sessions"], ["jobs", "Jobs"], ["projects", "Projects"], ["actions", "Approvals"], ["settings", "Settings"]];
  const [view, ...args] = route;
  let body: ReactNode;
  switch (view) {
    case "s": body = <SessionView harness={args[0]!} id={args[1]!} version={version} change={lastChange} />; break;
    case "jobs": body = args[0] ? <JobView id={args[0]} version={version} /> : <Jobs version={version} />; break;
    case "projects": body = args[0] ? <ProjectView id={args[0]} version={version} /> : <Projects />; break;
    case "actions": body = <Actions version={version} />; break;
    case "new": body = <NewSession />; break;
    case "settings": body = <Settings onServer={setServer} version={version} />; break;
    default: body = <Sessions version={version} />;
  }
  return (
    <div className="app">
      <header>
        <a className="brand" href="#/sessions">catapult</a>
        <span className={`dot ${live ? "on" : "off"}`} title={live ? "live" : "disconnected"} />
      </header>
      <nav>
        {tabs.map(([k, label]) => (
          <a key={k} href={`#/${k}`} className={view === k || (k === "sessions" && view === "s") ? "active" : ""}>
            {label}{k === "actions" && pending.data?.length ? <span className="badge">{pending.data.length}</span> : null}
          </a>
        ))}
      </nav>
      <main>{body}</main>
    </div>
  );
}

const Err = ({ e }: { e?: string }) => (e ? <p className="error">{e}</p> : null);
const Pill = ({ v }: { v: string }) => <span className={`pill ${v}`}>{v.replace("_", " ")}</span>;

// ---------- sessions ----------

function Sessions({ version }: { version: number }) {
  const [status, setStatus] = useState("");
  const { data, error } = useApi<Session[]>(`/sessions${status ? `?status=${status}` : ""}`, [version]);
  return (
    <section>
      <div className="bar">
        <h1>Sessions</h1>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">all</option>{["working", "needs_input", "idle", "ended"].map((s) => <option key={s}>{s}</option>)}
        </select>
        <button onClick={() => go("new")}>New</button>
      </div>
      <Err e={error} />
      <ul className="list">
        {data?.map((s) => (
          <li key={`${s.harness}:${s.session_id}`} onClick={() => go("s", s.harness, s.session_id)}>
            <div className="row"><strong>{s.title ?? s.project_id ?? "—"}</strong><Pill v={s.status} /></div>
            <div className="meta">
              {s.harness} · {s.origin} · driver {s.driver}{s.conflict ? " · ⚠ conflict" : ""} · {ago(s.last_event_at)}
              <code>{s.session_id.slice(0, 8)}</code>
            </div>
          </li>
        ))}
        {data?.length === 0 && <li className="empty">No sessions yet.</li>}
      </ul>
    </section>
  );
}

function SessionView({ harness, id, version, change }: { harness: string; id: string; version: number; change?: Change }) {
  // Only refetch the transcript when this session moved.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (change?.sessions.some((s) => s.session_id === id)) setTick((t) => t + 1);
  }, [version]); // eslint-disable-line react-hooks/exhaustive-deps
  const { data, error, reload } = useApi<{ session: Session; total: number; messages: Message[] }>(
    `/sessions/${harness}/${id}/transcript?limit=300`, [tick],
  );
  const [text, setText] = useState("");
  const [note, setNote] = useState<string>();
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [data?.total]);

  const s = data?.session;
  const act = async (fn: () => Promise<string>) => {
    setBusy(true);
    try { setNote(await fn()); reload(); } catch (e) { setNote((e as Error).message); } finally { setBusy(false); }
  };
  const steer = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    void act(async () => {
      const r = await api(`/sessions/${harness}/${id}/message`, { method: "POST", body: { text } });
      setText("");
      return r.via === "live" ? "Sent to the running session." : "Resuming the session as a new job.";
    });
  };
  const canSteer = s && s.driver !== "terminal" && s.origin === "job";
  return (
    <section className="session">
      <div className="bar">
        <h1>{s?.title ?? s?.project_id ?? id.slice(0, 8)}</h1>
        {s && <Pill v={s.status} />}
      </div>
      {s && (
        <p className="meta">
          {s.harness} · {s.origin} · driver {s.driver}{s.cwd ? ` · ${s.cwd}` : ""}
          {s.conflict ? <span className="error"> · transcript is being written by another process</span> : null}
        </p>
      )}
      <Err e={error} />
      <div className="transcript">
        {data && data.total > data.messages.length && <p className="meta">showing the last {data.messages.length} of {data.total}</p>}
        {data?.messages.map((m) => (
          <div key={m.id} className={`msg ${m.role}${m.tool?.isError ? " err" : ""}`}>
            {m.tool ? <><b>{m.tool.name}</b> <span>{m.text}</span></> : m.text}
          </div>
        ))}
        <div ref={end} />
      </div>
      {note && <p className="note">{note}</p>}
      <div className="controls">
        {canSteer ? (
          <form onSubmit={steer}>
            <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Steer this session…" rows={2} />
            <button disabled={busy || !text.trim()}>Send</button>
          </form>
        ) : s && <p className="meta">{s.driver === "terminal" ? "Taken over in a terminal: read-only here." : "Interactive session: read-only here."}</p>}
        {s && (
          <div className="buttons">
            {s.driver !== "terminal" && <button className="ghost" disabled={busy} onClick={() => act(async () => {
              const r = await api(`/sessions/${harness}/${id}/takeover`, { method: "POST" });
              return `Taken over. In a terminal: ${r.command}`;
            })}>Take over</button>}
            {s.driver === "terminal" && <button className="ghost" disabled={busy} onClick={() => act(async () => {
              await api(`/sessions/${harness}/${id}/release`, { method: "POST" });
              return "Handed back.";
            })}>Hand back</button>}
          </div>
        )}
      </div>
    </section>
  );
}

function NewSession() {
  const { data: projects } = useApi<Project[]>("/projects");
  const [project, setProject] = useState("");
  const [harness, setHarness] = useState("");
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string>();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const job = await api<Job>("/sessions", { method: "POST", body: { project_id: project || projects?.[0]?.id, prompt, harness: harness || undefined } });
      go("jobs", job.id);
    } catch (err) { setError((err as Error).message); }
  };
  return (
    <section>
      <h1>New session</h1>
      <form className="stack" onSubmit={submit}>
        <label>Project<select value={project} onChange={(e) => setProject(e.target.value)}>
          {projects?.map((p) => <option key={p.id} value={p.id}>{p.id}</option>)}
        </select></label>
        <label>Harness<select value={harness} onChange={(e) => setHarness(e.target.value)}>
          <option value="">project default</option><option>claude</option><option>pi</option>
        </select></label>
        <label>Prompt<textarea rows={6} value={prompt} onChange={(e) => setPrompt(e.target.value)} /></label>
        <Err e={error} />
        <button disabled={!prompt.trim() || !projects?.length}>Start</button>
      </form>
    </section>
  );
}

// ---------- jobs ----------

function JobRows({ jobs, onCancel }: { jobs?: Job[]; onCancel?: (id: string) => void }) {
  return (
    <ul className="list">
      {jobs?.map((j) => (
        <li key={j.id} onClick={() => go("jobs", j.id)}>
          <div className="row"><strong>{j.worker}</strong><Pill v={j.status} /></div>
          <div className="meta">
            {j.project_id} · {j.tier} · attempt {j.attempts} · {ago(j.updated_at)} <code>{j.id.slice(0, 8)}</code>
            {onCancel && ["queued", "leased", "running", "needs_input"].includes(j.status) &&
              <button className="ghost small" onClick={(e) => { e.stopPropagation(); onCancel(j.id); }}>Cancel</button>}
          </div>
        </li>
      ))}
      {jobs?.length === 0 && <li className="empty">No jobs.</li>}
    </ul>
  );
}

function Jobs({ version }: { version: number }) {
  const [status, setStatus] = useState("");
  const { data, error, reload } = useApi<Job[]>(`/jobs${status ? `?status=${status}` : ""}`, [version]);
  const [err, setErr] = useState<string>();
  const cancel = (id: string) => api(`/jobs/${id}/cancel`, { method: "POST" }).then(reload).catch((e) => setErr(e.message));
  return (
    <section>
      <div className="bar">
        <h1>Jobs</h1>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">all</option>{["queued", "running", "needs_input", "succeeded", "failed", "cancelled"].map((s) => <option key={s}>{s}</option>)}
        </select>
      </div>
      <Err e={error ?? err} />
      <JobRows jobs={data} onCancel={cancel} />
    </section>
  );
}

function JobView({ id, version }: { id: string; version: number }) {
  const { data: j, error } = useApi<Job>(`/jobs/${id}`, [version]);
  return (
    <section>
      <div className="bar"><h1>{j?.worker ?? "Job"}</h1>{j && <Pill v={j.status} />}</div>
      <Err e={error} />
      {j && <>
        <p className="meta">{j.project_id} · {j.tier} · attempt {j.attempts} · created {ago(j.created_at)} <code>{j.id}</code></p>
        {j.error && <p className="error">{j.error}</p>}
        <h2>Runs</h2>
        <ul className="list">
          {j.runs?.map((r) => {
            const art = r.artifact_json ? JSON.parse(r.artifact_json) : {};
            return (
              <li key={r.id} onClick={() => r.session_id && go("s", r.harness, r.session_id)}>
                <div className="row"><strong>{r.harness}</strong>{r.exit_reason ? <Pill v={r.exit_reason} /> : <Pill v="running" />}</div>
                <div className="meta">{ago(r.started_at)}{r.cost_usd != null ? ` · $${r.cost_usd.toFixed(3)}` : ""}{r.session_id ? " · open session →" : ""}</div>
                {art.summary && <p>{art.summary}</p>}
                {art.finalText && <pre className="final">{art.finalText}</pre>}
              </li>
            );
          })}
          {j.runs?.length === 0 && <li className="empty">Not started.</li>}
        </ul>
        <h2>Input</h2>
        <pre>{JSON.stringify(j.input, null, 2)}</pre>
      </>}
    </section>
  );
}

// ---------- projects ----------

function Projects() {
  const { data, error } = useApi<Project[]>("/projects");
  return (
    <section>
      <h1>Projects</h1>
      <Err e={error} />
      <ul className="list">
        {data?.map((p) => (
          <li key={p.id} onClick={() => go("projects", p.id)}>
            <div className="row"><strong>{p.id}</strong><span className="meta">{p.repo_full_name ?? ""}</span></div>
            <div className="meta">{p.local_path}</div>
          </li>
        ))}
        {data?.length === 0 && <li className="empty">No projects. Add one with <code>catapult project add</code>.</li>}
      </ul>
    </section>
  );
}

function ProjectView({ id, version }: { id: string; version: number }) {
  const project = useApi<Project>(`/projects/${id}`);
  const schedules = useApi<Schedule[]>(`/projects/${id}/schedules`);
  const jobs = useApi<Job[]>(`/projects/${id}/jobs`, [version]);
  const [err, setErr] = useState<string>();
  const [worker, setWorker] = useState("groomer");
  const [cron, setCron] = useState("0 8 * * *");
  const run = (fn: () => Promise<unknown>, after: () => void) => fn().then(after).catch((e) => setErr(e.message));
  const babysit = project.data?.settings?.pr_babysitter?.enabled === true;

  return (
    <section>
      <div className="bar"><h1>{id}</h1></div>
      <Err e={project.error ?? err} />
      {project.data && <p className="meta">{project.data.repo_full_name ?? "no repo"} · {project.data.settings?.harness} · {project.data.local_path}</p>}
      {project.data && (
        <label className="toggle">
          <input type="checkbox" checked={babysit} onChange={(e) => run(() => api(`/projects/${id}`, {
            method: "PATCH", body: { config: { pr_babysitter: { ...(project.data!.config.pr_babysitter as object ?? {}), enabled: e.target.checked } } },
          }), project.reload)} />
          PR babysitter
        </label>
      )}

      <h2>Schedules</h2>
      <ul className="list">
        {schedules.data?.map((s) => (
          <li key={s.id} className="static">
            <div className="row">
              <strong>{s.worker}</strong>
              <label className="toggle"><input type="checkbox" checked={!!s.enabled}
                onChange={(e) => run(() => api(`/schedules/${s.id}`, { method: "PATCH", body: { enabled: e.target.checked } }), schedules.reload)} />on</label>
            </div>
            <div className="meta">
              <CronEdit value={s.cron} onSave={(c) => run(() => api(`/schedules/${s.id}`, { method: "PATCH", body: { cron: c } }), schedules.reload)} />
              <button className="ghost small" onClick={() => run(() => api(`/schedules/${s.id}`, { method: "DELETE" }), schedules.reload)}>Delete</button>
            </div>
          </li>
        ))}
        {schedules.data?.length === 0 && <li className="empty">No schedules.</li>}
      </ul>
      <form className="inline" onSubmit={(e) => { e.preventDefault(); run(() => api(`/projects/${id}/schedules`, { method: "POST", body: { worker, cron } }), schedules.reload); }}>
        <input value={worker} onChange={(e) => setWorker(e.target.value)} placeholder="worker" />
        <input value={cron} onChange={(e) => setCron(e.target.value)} placeholder="m h dom mon dow" />
        <button>Add</button>
      </form>

      <h2>Jobs</h2>
      <JobRows jobs={jobs.data} />
    </section>
  );
}

function CronEdit({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => { setV(value); }, [value]);
  return (
    <form className="inline" onSubmit={(e) => { e.preventDefault(); onSave(v); }}>
      <input className="mono" value={v} onChange={(e) => setV(e.target.value)} />
      {v !== value && <button className="small">Save</button>}
    </form>
  );
}

// ---------- approvals ----------

function Actions({ version }: { version: number }) {
  const [status, setStatus] = useState("pending");
  const { data, error, reload } = useApi<Action[]>(`/actions?status=${status}`, [version]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const decide = (id: string, decision: "approved" | "rejected") =>
    api(`/actions/${id}/decision`, { method: "POST", body: { decision } })
      .then((r) => setNotes((n) => ({ ...n, [id]: r.status })))
      .catch((e) => setNotes((n) => ({ ...n, [id]: e.message })))
      .finally(reload);
  return (
    <section>
      <div className="bar">
        <h1>Approvals</h1>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          {["pending", "executed", "rejected", "expired", "approved"].map((s) => <option key={s}>{s}</option>)}
        </select>
      </div>
      <Err e={error} />
      <ul className="list">
        {data?.map((a) => (
          <li key={a.id} className="static">
            <div className="row"><strong>{a.kind.replace(/_/g, " ")}</strong><Pill v={a.status} /></div>
            <div className="meta">{a.project_id} · {ago(a.created_at)}{a.expires_at && a.status === "pending" ? ` · expires in ${Math.max(0, Math.round((a.expires_at - Date.now()) / 3_600_000))}h` : ""}</div>
            <pre className="final">{a.summary}</pre>
            {a.status === "pending" && (
              <div className="buttons">
                <button onClick={() => decide(a.id, "approved")}>Approve</button>
                <button className="ghost" onClick={() => decide(a.id, "rejected")}>Reject</button>
              </div>
            )}
            {notes[a.id] && <p className="note">{notes[a.id]}</p>}
          </li>
        ))}
        {data?.length === 0 && <li className="empty">Nothing {status}.</li>}
      </ul>
    </section>
  );
}

// ---------- settings ----------

function Settings({ onServer, version }: { onServer: (u: string) => void; version: number }) {
  const [url, setUrl] = useState(serverUrl());
  const status = useApi<any>("/status", [version]);
  return (
    <section>
      <h1>Settings</h1>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); setServerUrl(url.trim()); onServer(serverUrl()); status.reload(); }}>
        <label>Server URL<input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="same origin (https://<dev-host>.<tailnet>.ts.net)" /></label>
        <button>Save</button>
      </form>
      <h2>Status</h2>
      <Err e={status.error} />
      {status.data && <>
        <p className="meta">queue: {Object.entries(status.data.queue).map(([k, v]) => `${k} ${v}`).join(", ") || "empty"} · today ${status.data.cost_today_usd.toFixed(2)}{status.data.daily_cap_usd ? ` of $${status.data.daily_cap_usd}` : ""}</p>
        <table>
          <thead><tr><th>worker</th><th>runs</th><th>ok</th><th>median $</th><th>7d $</th></tr></thead>
          <tbody>{status.data.workers.map((w: any) => (
            <tr key={w.worker}><td>{w.worker}</td><td>{w.runs}</td><td>{Math.round(w.success_rate * 100)}%</td><td>{w.median_cost_usd?.toFixed(3) ?? "—"}</td><td>{w.cost_usd_7d.toFixed(2)}</td></tr>
          ))}</tbody>
        </table>
      </>}
    </section>
  );
}
