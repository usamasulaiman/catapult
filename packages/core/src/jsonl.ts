/**
 * Split a byte/string stream into JSONL records on "\n" only (strip a trailing "\r").
 * Deliberately not Node's readline: it also splits on U+2028/U+2029, which are legal inside JSON strings.
 */
export class LineSplitter {
  private buf = "";
  push(chunk: string): string[] {
    this.buf += chunk;
    const out: string[] = [];
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      let line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line) out.push(line);
    }
    return out;
  }
  flush(): string[] {
    const rest = this.buf.replace(/\r$/, "");
    this.buf = "";
    return rest ? [rest] : [];
  }
}

/** Parse a JSONL line; returns undefined for non-JSON noise instead of throwing. */
export function parseLine(line: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(line);
    return v && typeof v === "object" && !Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Single-consumer async queue used to expose process output as an AsyncIterable. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private closed = false;
  push(item: T): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false });
    else this.items.push(item);
  }
  close(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}
