import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateLegacyTraces } from "./migrate-traces.js";

describe("migrateLegacyTraces", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "lattice-traces-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("renames *.md.md to *.md", async () => {
    await writeFile(join(dir, "session_abc.md.md"), "x");
    const n = await migrateLegacyTraces(dir);
    expect(n).toBe(1);
    expect(await readdir(dir)).toEqual(["session_abc.md"]);
  });

  it("leaves correctly-named files untouched", async () => {
    await writeFile(join(dir, "good.md"), "x");
    const n = await migrateLegacyTraces(dir);
    expect(n).toBe(0);
    expect(await readdir(dir)).toEqual(["good.md"]);
  });

  it("does not clobber an existing target", async () => {
    await writeFile(join(dir, "dup.md.md"), "legacy");
    await writeFile(join(dir, "dup.md"), "current");
    const n = await migrateLegacyTraces(dir);
    expect(n).toBe(0);
    const files = (await readdir(dir)).sort();
    expect(files).toEqual(["dup.md", "dup.md.md"]);
  });

  it("is idempotent and a no-op on a missing dir", async () => {
    expect(await migrateLegacyTraces(join(dir, "nope"))).toBe(0);
    await writeFile(join(dir, "a.md.md"), "x");
    expect(await migrateLegacyTraces(dir)).toBe(1);
    expect(await migrateLegacyTraces(dir)).toBe(0); // second run: nothing left
  });
});
