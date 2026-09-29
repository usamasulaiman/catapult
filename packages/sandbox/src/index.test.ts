import { describe, expect, it } from "vitest";
import { buildSettings, isSandboxed, secretPaths, wrapCommand } from "./index.ts";

const base = { worktree: "/srv/catapult/worktrees/p/j1", home: "/home/dev" };

describe("buildSettings", () => {
  it("trusted gets github, registries and project domains", () => {
    const s = buildSettings({ ...base, tier: "trusted", projectDomains: ["docs.example.com"] });
    expect(s.network.allowedDomains).toEqual(expect.arrayContaining(["github.com", "registry.npmjs.org", "docs.example.com", "api.anthropic.com"]));
  });
  it("untrusted gets only the api and registries, and ignores project domains", () => {
    const s = buildSettings({ ...base, tier: "untrusted", projectDomains: ["evil.example"] });
    expect(s.network.allowedDomains).toContain("api.github.com");
    expect(s.network.allowedDomains).not.toContain("github.com");
    expect(s.network.allowedDomains).not.toContain("evil.example");
  });
  it("only the worktree (not the repo clone) is writable, and secrets are unreadable", () => {
    const s = buildSettings({ ...base, tier: "untrusted" });
    expect(s.filesystem.allowWrite).toContain(base.worktree);
    expect(s.filesystem.allowWrite).not.toContain("/srv/catapult/repos");
    for (const p of secretPaths(base.home)) expect(s.filesystem.denyRead).toContain(p);
  });
  it("untrusted has no shared package caches", () => {
    const s = buildSettings({ ...base, tier: "untrusted" });
    expect(s.filesystem.allowWrite.some((p) => p.includes(".cache"))).toBe(false);
  });
  it("refuses tiers that don't use srt", () => {
    expect(() => buildSettings({ ...base, tier: "unsandboxed" })).toThrow();
  });
});

describe("wrapCommand", () => {
  it("wraps sandboxed tiers and passes others through", () => {
    expect(wrapCommand("trusted", "/s.json", ["pi", "--mode", "rpc"])).toEqual(["srt", "--settings", "/s.json", "--", "pi", "--mode", "rpc"]);
    expect(wrapCommand("unsandboxed", "/s.json", ["pi"])).toEqual(["pi"]);
    expect(isSandboxed("interactive")).toBe(false);
  });
});
