/**
 * Nothing internal is written outside the vault, whatever `.basalt` is (R11).
 *
 * F24 gave `NodeVault.write` a containment check and the trash a pair of them,
 * and stopped there. The config, the index, the lock and the exclusive-create
 * path all write under `.basalt` and none of them asked. A `.basalt` that is a
 * symlink to somewhere else therefore put this device's recovery material,
 * its index and its lock outside the vault, and no race was needed to arrange
 * it: an ordinary pre-existing filesystem layout does it, which is why this is
 * about accidents as much as about a hostile process.
 */

import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { STATE_DIR, saveConfig, removeIndex, removeState } from "./config.ts";
import { lockVault } from "./lock.ts";
import { NodeVault } from "./vault.ts";
import { generateSecret } from "../core/crypto.ts";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

/** A vault whose `.basalt` is a link to somewhere else entirely. */
async function vaultWithEscapingState(): Promise<{ vault: string; elsewhere: string }> {
  const base = await mkdtemp(join(tmpdir(), "basalt-contain-"));
  dirs.push(base);
  const vault = join(base, "vault");
  const elsewhere = join(base, "elsewhere");
  await mkdir(vault, { recursive: true });
  await mkdir(elsewhere, { recursive: true });
  await symlink(elsewhere, join(vault, STATE_DIR));
  return { vault, elsewhere };
}

const config = () => ({
  url: "ws://example.invalid",
  vaultId: "default",
  device: "d",
  deviceId: "d1",
  deviceSecret: generateSecret(),
  dataKey: generateSecret(),
});

describe("a .basalt that leaves the vault", () => {
  it("is refused by saveConfig, and writes nothing outside", async () => {
    const { vault, elsewhere } = await vaultWithEscapingState();
    await expect(saveConfig(vault, config())).rejects.toThrow(/leaves the vault/);
    expect(await readdir(elsewhere), "the config was written outside the vault").toEqual([]);
  });

  it("is refused by the lock", async () => {
    const { vault, elsewhere } = await vaultWithEscapingState();
    await expect(lockVault(vault, "sync")).rejects.toThrow(/leaves the vault/);
    expect(await readdir(elsewhere), "the lock was taken outside the vault").toEqual([]);
  });

  it("is refused by the index removals", async () => {
    const { vault } = await vaultWithEscapingState();
    await expect(removeIndex(vault)).rejects.toThrow(/leaves the vault/);
    await expect(removeState(vault)).rejects.toThrow(/leaves the vault/);
  });
});

describe("a staging directory that leaves the vault", () => {
  it("is refused by an exclusive create", async () => {
    const base = await mkdtemp(join(tmpdir(), "basalt-contain-"));
    dirs.push(base);
    const vault = join(base, "vault");
    const elsewhere = join(base, "elsewhere");
    await mkdir(join(vault, STATE_DIR), { recursive: true });
    await mkdir(elsewhere, { recursive: true });
    await symlink(elsewhere, join(vault, STATE_DIR, "tmp"));

    const v = new NodeVault(vault);
    await expect(
      v.create("note.md", new TextEncoder().encode("hello"), { mtime: 1000, ctime: 1000 }),
    ).rejects.toThrow(/leaves the vault/);
    expect(
      await readdir(elsewhere),
      "an exclusive create staged its bytes outside the vault",
    ).toEqual([]);
  });
});

describe("an ordinary vault", () => {
  it("is not refused by any of it", async () => {
    const base = await mkdtemp(join(tmpdir(), "basalt-contain-ok-"));
    dirs.push(base);
    const vault = join(base, "vault");
    await mkdir(vault, { recursive: true });

    await saveConfig(vault, config());
    const release = await lockVault(vault, "sync");
    await release();
    const v = new NodeVault(vault);
    expect(
      await v.create("note.md", new TextEncoder().encode("hello"), { mtime: 1000, ctime: 1000 }),
    ).toBe(true);
    await expect(removeState(vault)).resolves.toBeUndefined();
    void writeFile;
  });
});
