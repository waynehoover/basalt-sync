/**
 * Taking over a dead lock cannot hand the vault to two callers (R03).
 *
 * Removing a stale lock is a read and then an unlink, and no filesystem here
 * offers them as one operation. So the schedule below was possible: A reads a
 * dead holder and pauses; B reads the same dead holder, removes it, and takes
 * its own live lock; A resumes, unlinks *B's* lock, and takes one too. Both
 * were handed a release function and neither was told it had lost.
 *
 * The previous code re-read the token immediately before unlinking, which
 * narrows that window to a few instructions and does not close it. The comment
 * beside it reasoned the residue away by saying the loser would find a live
 * holder next time round; B never looks again, because B had already succeeded.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { hostname } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { STATE_DIR } from "./config.ts";
import { lockPath, lockVault, midEvict, type LockHolder } from "./lock.ts";

const vaults: string[] = [];
afterEach(async () => {
  midEvict.pause = async () => {};
  while (vaults.length) await rm(vaults.pop()!, { recursive: true, force: true });
});

async function vaultWithDeadLock(): Promise<{ dir: string; dead: LockHolder }> {
  const dir = await mkdtemp(join(tmpdir(), "basalt-lock-"));
  vaults.push(dir);
  await (await import("node:fs/promises")).mkdir(join(dir, STATE_DIR), { recursive: true });
  // A pid that is certainly not running, on this host, which is what a lock
  // left behind by a kill looks like.
  const dead: LockHolder = {
    pid: 2 ** 22,
    host: hostname(),
    command: "sync --watch",
    since: Date.now() - 60_000,
    token: "deadtoken00000000000000000000dead",
  };
  await writeFile(lockPath(dir), JSON.stringify(dead), { mode: 0o600 });
  return { dir, dead };
}

/** Who the lock file says holds it now. */
async function holderOf(dir: string): Promise<LockHolder | undefined> {
  try {
    return JSON.parse(await readFile(lockPath(dir), "utf8")) as LockHolder;
  } catch {
    return undefined;
  }
}

describe("two contenders for one dead lock", () => {
  /**
   * The review's exact schedule, driven rather than raced.
   *
   * A is held at the instant between deciding the lock is dead and removing
   * it, which is where the two-owner interleaving lived. B runs against that.
   * Whatever order they finish in, exactly one may come away holding the
   * vault, and the lock file must name that one.
   *
   * Note what the fix changes about this schedule: B can no longer evict the
   * holder A is evicting, so B cannot get in front. Under the old code it
   * could, and then A's unlink removed B's live lock.
   */
  it("cannot hand the vault to both while one is deciding to evict", async () => {
    const { dir } = await vaultWithDeadLock();

    let releaseA: (() => void) | undefined;
    const aIsInside = new Promise<void>((ready) => {
      midEvict.pause = async () => {
        // Only the first evictor pauses; anybody else must be free to run.
        midEvict.pause = async () => {};
        ready();
        await new Promise<void>((go) => {
          releaseA = go;
        });
      };
    });

    const a = lockVault(dir, "A");
    await aIsInside;
    // B starts while A is holding the decision, and races it from here.
    const b = lockVault(dir, "B");
    // Long enough for B to make several attempts against the paused A.
    await new Promise((r) => setTimeout(r, 40));
    releaseA!();

    const out = await Promise.allSettled([a, b]);
    const won = out.filter((r) => r.status === "fulfilled");
    expect(won.length, `${won.length} of two contenders were handed the same vault`).toBe(1);

    const holder = await holderOf(dir);
    expect(holder, "somebody was handed the lock and the file names nobody").toBeDefined();
    const loser = out.find((r) => r.status === "rejected");
    if (loser?.status === "rejected") {
      expect((loser.reason as Error).message).toMatch(/another basalt|could not take the lock/);
    }
    for (const r of out) if (r.status === "fulfilled") await r.value();
    expect(await holderOf(dir), "the winner's release left the lock behind").toBeUndefined();
  });

  /**
   * The same without the hook: many contenders on one dead lock, all at once.
   *
   * Exactly one may come away with a release function, and the lock file must
   * name that one. Twelve was enough to reproduce the earlier version of this
   * bug on the first run.
   */
  it("hands one dead lock to exactly one of twelve contenders", async () => {
    const { dir } = await vaultWithDeadLock();

    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) => lockVault(dir, `c${i}`)),
    );
    const won = results.filter((r) => r.status === "fulfilled");
    expect(won.length, `${won.length} contenders were handed the same vault`).toBe(1);

    const holder = await holderOf(dir);
    expect(holder, "nobody holds the lock, and one of them thinks it does").toBeDefined();
    for (const r of results) {
      if (r.status === "fulfilled") await r.value();
    }
    expect(await holderOf(dir), "the winner's release left the lock behind").toBeUndefined();
  });

  /** And an eviction marker left behind by a dead evictor does not wedge it. */
  it("recovers from an eviction marker whose own holder is gone", async () => {
    const { dir, dead } = await vaultWithDeadLock();
    const stale: LockHolder = {
      pid: 2 ** 22,
      host: hostname(),
      command: "an evictor that died",
      since: Date.now() - 60_000,
      token: "markertoken000000000000000marker",
    };
    await writeFile(`${lockPath(dir)}.evicting.${dead.token}`, JSON.stringify(stale), {
      mode: 0o600,
    });

    const release = await lockVault(dir, "after");
    expect((await holderOf(dir))?.command).toBe("after");
    await release();
  });
});
