/** Periodic pollers (the source of truth; webhooks only call nudge to run one sooner). Runs never overlap. */
export class Sources {
  private entries = new Map<string, { everyMs: number; nextAt: number; running: boolean; run: () => Promise<unknown> }>();

  add(name: string, everyMs: number, run: () => Promise<unknown>, now = Date.now()): void {
    this.entries.set(name, { everyMs, nextAt: now, running: false, run });
  }

  /** Run `name` on the next tick. Returns false for an unknown source. */
  nudge(name: string): boolean {
    const e = this.entries.get(name);
    if (e) e.nextAt = 0;
    return !!e;
  }

  get names(): string[] { return [...this.entries.keys()]; }

  tick(now = Date.now()): Promise<void>[] {
    const started: Promise<void>[] = [];
    for (const [name, e] of this.entries) {
      if (e.running || now < e.nextAt) continue;
      e.running = true;
      e.nextAt = now + e.everyMs;
      started.push(e.run()
        .catch((err) => console.error(`source ${name}:`, (err as Error).message))
        .then(() => { e.running = false; }));
    }
    return started;
  }
}
