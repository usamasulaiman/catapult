// API client. The server URL defaults to this page's origin (served by the orchestrator through
// `tailscale serve`); the desktop app stores one because it loads the UI from its own bundle.
const KEY = "catapult.server";

export function serverUrl(): string {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved) return saved.replace(/\/$/, "");
  } catch {}
  return location.protocol.startsWith("http") ? "" : "http://127.0.0.1:7700";
}
export function setServerUrl(url: string): void {
  try { url ? localStorage.setItem(KEY, url) : localStorage.removeItem(KEY); } catch {}
}

export async function api<T = any>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(serverUrl() + path, {
    method: init?.method ?? "GET",
    headers: init?.body === undefined ? undefined : { "content-type": "application/json" },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data as T;
}

export interface Project { id: string; repo_full_name: string | null; default_branch: string; local_path: string; config: Record<string, unknown>; settings?: Record<string, any> }
export interface Job { id: string; project_id: string; worker: string; tier: string; status: string; attempts: number; error: string | null; input: any; created_at: number; updated_at: number; runs?: Run[] }
export interface Run { id: string; harness: string; session_id: string | null; started_at: number; ended_at: number | null; exit_reason: string | null; cost_usd: number | null; artifact_json: string | null }
export interface Session { harness: string; session_id: string; project_id: string | null; cwd: string | null; origin: string; status: string; driver: string; conflict: number; title: string | null; last_event_at: number }
export interface Schedule { id: string; project_id: string; worker: string; cron: string; enabled: number }
export interface Action { id: string; kind: string; project_id: string | null; summary: string | null; status: string; payload: any; expires_at: number | null; created_at: number }
export interface Message { id: string; role: "user" | "assistant" | "tool"; text: string; tool?: { name: string; isError?: boolean }; ts?: string }

export type Change = { jobs: Partial<Job>[]; sessions: Partial<Session>[]; actions: boolean };

/** Subscribe to the server's change stream; reconnects with backoff. Returns an unsubscribe function. */
export function subscribe(onChange: (c: Change) => void, onState: (live: boolean) => void): () => void {
  let es: EventSource | undefined, closed = false, delay = 1000;
  const connect = () => {
    es = new EventSource(`${serverUrl()}/stream`);
    es.onopen = () => { delay = 1000; onState(true); };
    es.addEventListener("change", (e) => onChange(JSON.parse((e as MessageEvent).data)));
    es.onerror = () => {
      onState(false);
      es?.close();
      if (!closed) setTimeout(connect, (delay = Math.min(delay * 2, 30_000)));
    };
  };
  connect();
  return () => { closed = true; es?.close(); };
}

export const ago = (ms: number) => {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};
