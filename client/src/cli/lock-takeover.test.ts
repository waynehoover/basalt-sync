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

import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

  /**
   * The recovery of the recovery mechanism (R20).
   *
   * The eviction marker gives one process the exclusive right to remove one
   * dead lock. The first version of it had the same shape as the bug it was
   * closing: a marker left behind by an evictor that died had to be cleaned up
   * by somebody, and cleaning it up was a read followed by an unlink, so two
   * contenders could each end up believing they held the right and both go on
   * to take the vault.
   *
   * The schedule the review used: a dead lock and an abandoned marker; A
   * pauses having decided; B removes the old marker, takes its own, and pauses
   * having read the dead lock; A resumes, deletes B's marker, evicts and
   * acquires; B resumes its stale unlink and acquires too.
   *
   * No marker is removed by judgement now: the name carries a time window, so
   * an abandoned one from an earlier window is not a name anybody is using and
   * removing it takes nobody's exclusion away.
   */
  it("hands the vault to one contender even when an evictor died mid-eviction", async () => {
    const { dir, dead } = await vaultWithDeadLock();

    // An abandoned marker from an earlier window, exactly as a crash leaves.
    const earlier = Math.floor(Date.now() / 60_000) - 5;
    const abandoned: LockHolder = {
      pid: 2 ** 22,
      host: hostname(),
      command: "an evictor that died",
      since: Date.now() - 600_000,
      token: "markertoken000000000000000marker",
    };
    await writeFile(
      `${lockPath(dir)}.evicting.${dead.token}.${earlier}`,
      JSON.stringify(abandoned),
      {
        mode: 0o600,
      },
    );

    // Several contenders at once, against that state.
    const out = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) => lockVault(dir, `c${i}`)),
    );
    const won = out.filter((r) => r.status === "fulfilled");
    expect(
      won.length,
      `${won.length} contenders were handed the same vault past an abandoned marker`,
    ).toBe(1);

    const holder = await holderOf(dir);
    expect(holder, "somebody holds the vault and the file names nobody").toBeDefined();
    for (const r of out) if (r.status === "fulfilled") await r.value();

    // And the debris is gone, so takeover is not wedged for the next run.
    const left = (await readdir(join(dir, STATE_DIR))).filter((n) => n.includes(".evicting."));
    expect(left, `eviction markers were left behind: ${JSON.stringify(left)}`).toEqual([]);
  });

  /**
   * A marker somebody may still be holding is never removed by judgement
   * (R20).
   *
   * This is the invariant that makes the eviction right worth having, and the
   * one the first version broke. Recovering an abandoned marker meant reading
   * who held it and then unlinking its path, which is a check followed by a
   * destructive act on a name: two contenders could each remove what they took
   * to be stale, each end up holding "the" right, and both go on to take the
   * vault.
   *
   * So nothing decides whether a marker is alive. A marker in the current
   * window is left alone whatever it says about itself, which costs at most
   * one window of waiting after a crash, and one from a window that has passed
   * is not a name anybody can be using.
   *
   * The cost is asserted here too, because it is the price of the safety and
   * somebody should be able to see it: while such a marker exists, takeover
   * does not happen and every contender is refused.
   */
  it("does not remove an eviction marker from the window in progress", async () => {
    const { dir, dead } = await vaultWithDeadLock();
    const now = Math.floor(Date.now() / 60_000);
    const marker = `${lockPath(dir)}.evicting.${dead.token}.${now}`;
    // A marker whose holder is plainly gone. Under the old rule that was
    // enough to remove it; under this one it is not, because "plainly gone"
    // is a judgement and two processes can make it at once.
    await writeFile(
      marker,
      JSON.stringify({
        pid: 2 ** 22,
        host: hostname(),
        command: "an evictor that died a moment ago",
        since: Date.now(),
        token: "markertoken000000000000000marker",
      }),
      { mode: 0o600 },
    );

    const out = await Promise.allSettled(
      Array.from({ length: 4 }, (_, i) => lockVault(dir, `c${i}`)),
    );
    const won = out.filter((r) => r.status === "fulfilled");
    for (const r of out) if (r.status === "fulfilled") await r.value();

    expect(
      won.length,
      "somebody evicted past a marker that another process could still be holding",
    ).toBe(0);
    expect(
      await readFile(marker, "utf8").catch(() => undefined),
      "a marker from the window in progress was removed on somebody's judgement",
    ).toBeDefined();
    // And the vault is still held by the dead holder, untouched.
    expect((await holderOf(dir))?.token).toBe(dead.token);
  });
});
