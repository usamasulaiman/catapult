import { describe, expect, it } from "vitest";
import { AsyncQueue, LineSplitter, parseLine } from "./jsonl.ts";

describe("LineSplitter", () => {
  it("handles records split across chunks and CRLF", () => {
    const s = new LineSplitter();
    expect(s.push('{"a":1}\n{"b"')).toEqual(['{"a":1}']);
    expect(s.push(':2}\r\n')).toEqual(['{"b":2}']);
  });
  it("does not split on U+2028/U+2029 inside a record", () => {
    const rec = JSON.stringify({ t: "a b c" });
    expect(new LineSplitter().push(rec + "\n")).toEqual([rec]);
  });
  it("flush returns an unterminated tail", () => {
    const s = new LineSplitter();
    s.push('{"x":1}');
    expect(s.flush()).toEqual(['{"x":1}']);
  });
});

describe("parseLine", () => {
  it("ignores noise", () => {
    expect(parseLine("warning: foo")).toBeUndefined();
    expect(parseLine("[1]")).toBeUndefined();
    expect(parseLine('{"a":1}')).toEqual({ a: 1 });
  });
});

describe("AsyncQueue", () => {
  it("delivers queued and later items then ends on close", async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    const got: number[] = [];
    const p = (async () => { for await (const x of q) got.push(x); })();
    q.push(2); q.close();
    await p;
    expect(got).toEqual([1, 2]);
  });
});
