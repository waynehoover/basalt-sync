/**
 * The vault lock, and the three ways it could be handed to two processes (F07).
 *
 * It is the only thing standing between two `basalt` processes and two engines
 * writing notes, config and index over each other from state neither saw. So
 * the property under everything here is the same one: two callers never both
 * come back holding it.
 *
 * The faults were an empty file, an unconditional delete and an identity that
 * is not one. Taking it used to create the file with `wx` and write the holder
 * afterwards, which left a window in which the lock existed and said nothing;
 * a competitor read that, called it corrupt, deleted it and took a lock
 * somebody was holding. Stale takeover read the holder and then deleted
 * whatever was at the path, which need not still be that holder. And release
 * matched on pid and host, which the operating system reuses.
 */

import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { STATE_DIR } from "./config.ts";
import { alive, lockPath, lockVault, midPublish } from "./lock.ts";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function vault(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "basalt-lock-"));
  dirs.push(dir);
  return dir;
}

/** A pid that is certainly not running, for the stale-holder cases. */
function deadPid(): number {
  for (let pid = 4_000_000; pid > 100; pid -= 7919) {
    if (!alive(pid)) return pid;
  }
  throw new Error("every pid on this machine is alive, which cannot be");
}

describe("taking the vault lock", () => {
  it("hands it to exactly one of many callers at once", async () => {
    const dir = await vault();
    const results = await Promise.allSettled(
      Array.from({ length: 24 }, (_, i) => lockVault(dir, `command ${i}`)),
    );
    const winners = results.filter((r) => r.status === "fulfilled");
    expect(winners.length, `${winners.length} callers were all told they hold the vault`).toBe(1);
    for (const loser of results.filter((r) => r.status === "rejected")) {
      expect((loser as PromiseRejectedResult).reason.message).toMatch(/another basalt/);
    }
  });

  it("never leaves the lock file present without a holder in it", async () => {
    // The empty window, which is what let a competitor delete a live lock.
    // Sampled as hard as this event loop allows while an acquisition runs.
    const dir = await vault();
    await mkdir(join(dir, STATE_DIR), { recursive: true });
    const path = lockPath(dir);

    let sampling = true;
    const empty: string[] = [];
    const sampler = (async () => {
      while (sampling) {
        try {
          const text = await readFile(path, "utf8");
          if (text === "" || !text.includes('"token"')) empty.push(JSON.stringify(text));
        } catch {
          // Not there yet, which is a lock nobody is misreading.
        }
      }
    })();

    for (let i = 0; i < 40; i++) {
      const release = await lockVault(dir, "sync");
      await release();
    }
    sampling = false;
    await sampler;
    expect(empty, `the lock was readable with no holder in it: ${empty.join(", ")}`).toEqual([]);
  });

  it("does not hand the lock to a competitor that arrives mid-acquisition", async () => {
    // The reproduced fault, made deterministic. The old implementation created
    // the lock file empty and wrote the holder afterwards; a competitor that
    // arrived in between read nothing, decided the file was corrupt, deleted
    // it and took a lock somebody already held. Both callers then believed
    // they owned the vault.
    //
    // The seam is that same instant. Nothing is at the path yet now, because
    // the holder is built under a private name and linked into place, and a
    // link either creates the name or fails.
    const dir = await vault();
    // The competitor takes the lock during that instant and keeps it, which
    // is what a second `basalt` process does: it is not going to hand it back
    // while the first is still deciding.
    let theirs: (() => Promise<void>) | undefined;
    midPublish.pause = async () => {
      midPublish.pause = async () => {};
      theirs = await lockVault(dir, "the competitor").catch(() => undefined);
    };

    const mine = await lockVault(dir, "sync --watch").then(
      (r) => r,
      () => undefined,
    );

    expect(theirs, "the competitor could not take a lock nobody held").toBeDefined();
    expect(
      mine,
      "both callers were told they hold the vault, and the competitor is still holding it",
    ).toBeUndefined();

    if (mine !== undefined) await mine();
    if (theirs !== undefined) await theirs();
    midPublish.pause = async () => {};
  });

  it("takes over a lock whose holder has died, once", async () => {
    const dir = await vault();
    await mkdir(join(dir, STATE_DIR), { recursive: true });
    await writeFile(
      lockPath(dir),
      JSON.stringify({
        pid: deadPid(),
        host: (await import("node:os")).hostname(),
        command: "sync --watch",
        since: Date.now() - 1000,
        token: "a stale token",
      }),
    );

    // Every contender wants the same abandoned lock, which is what a machine
    // looks like after a crash and a cron job.
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) => lockVault(dir, `after the crash ${i}`)),
    );
    const winners = results.filter((r) => r.status === "fulfilled");
    expect(
      winners.length,
      `${winners.length} contenders took over the same dead holder's lock`,
    ).toBe(1);
  });

  it("refuses while a holder on this host is alive", async () => {
    const dir = await vault();
    const release = await lockVault(dir, "sync --watch");
    await expect(lockVault(dir, "sync")).rejects.toThrow(/another basalt is using this vault/);
    await release();
    // And it is free again afterwards.
    await (
      await lockVault(dir, "sync")
    )();
  });
});

describe("releasing the vault lock", () => {
  it("removes only its own, not whatever is at the path", async () => {
    // What a stale takeover leaves: our lock is gone and somebody else's is
    // there under the same name. Matching on pid and host let a release
    // remove it, because the operating system reuses pids.
    const dir = await vault();
    const release = await lockVault(dir, "sync");
    const theirs = JSON.stringify({
      pid: process.pid,
      host: (await import("node:os")).hostname(),
      command: "somebody else",
      since: Date.now(),
      token: "not our token",
    });
    await writeFile(lockPath(dir), theirs);

    await release();

    const after = await readFile(lockPath(dir), "utf8");
    expect(after, "the release removed a lock that was not its own").toBe(theirs);
  });

  it("leaves nothing behind when it is its own", async () => {
    const dir = await vault();
    const release = await lockVault(dir, "sync");
    await release();
    await expect(readFile(lockPath(dir), "utf8")).rejects.toThrow(/ENOENT/);
  });
});
