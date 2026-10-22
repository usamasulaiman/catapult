import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";

/** HMAC-SHA256 check of GitHub's X-Hub-Signature-256 header. */
export function verifyGitHubSignature(secret: string, body: string, header: string | undefined): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const want = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  const got = Buffer.from(header);
  return want.length === got.length && timingSafeEqual(want, got);
}

/** Fixed-window limiter: at most `max` requests per `windowMs`. */
export function rateLimiter(max: number, windowMs: number) {
  let windowStart = 0, count = 0;
  return (now = Date.now()) => {
    if (now - windowStart >= windowMs) { windowStart = now; count = 0; }
    return ++count <= max;
  };
}

const PR_EVENTS = new Set(["pull_request", "pull_request_review", "pull_request_review_comment", "pull_request_review_thread", "issue_comment", "check_suite"]);

/**
 * The only routes reachable from the internet (through Funnel), on their own port.
 * A verified event never acts by itself: it nudges the poller, which re-reads GitHub (principle 7).
 */
export function createWebhooks(o: { githubSecret?: string; nudge: (source: string) => void; limit?: () => boolean }) {
  const app = new Hono();
  const allow = o.limit ?? rateLimiter(60, 60_000);
  app.post("/ingest/github", async (c) => {
    if (!allow()) return c.json({ error: "rate limited" }, 429);
    if (!o.githubSecret) return c.json({ error: "not configured" }, 404);
    const body = await c.req.text();
    if (!verifyGitHubSignature(o.githubSecret, body, c.req.header("x-hub-signature-256"))) return c.json({ error: "bad signature" }, 401);
    if (PR_EVENTS.has(c.req.header("x-github-event") ?? "")) o.nudge("github-prs");
    return c.json({ ok: true });
  });
  app.all("*", (c) => c.json({ error: "not found" }, 404));
  return app;
}
