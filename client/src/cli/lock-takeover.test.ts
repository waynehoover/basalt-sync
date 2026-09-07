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

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  // Only `link`, and only so a put-back can be made to fail for a reason of
  // its own rather than because the name was taken.
  return { ...actual, link: vi.fn(actual.link) };
});

import { link, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { hostname } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { STATE_DIR } from "./config.ts";
import { currentHolder, lockPath, lockVault, midEvict, type LockHolder } from "./lock.ts";

const vaults: string[] = [];
afterEach(async () => {
  vi.mocked(link).mockRestore?.();
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

/**
 * A vault whose generation `n` is claimed by a holder that is not running.
 *
 * `vaultWithDeadLock` writes the legacy name, which is generation zero, so
 * every contender aims at generation one and `link` settles them against each
 * other. Reaching the schedule where one caller is aiming *above* another
 * needs the numbering to have started.
 */
async function vaultWithDeadClaim(n: number): Promise<{ dir: string; dead: LockHolder }> {
  const dir = await mkdtemp(join(tmpdir(), "basalt-lock-"));
  vaults.push(dir);
  await mkdir(join(dir, STATE_DIR), { recursive: true });
  const dead: LockHolder = {
    pid: 2 ** 22,
    host: hostname(),
    command: "sync --watch",
    since: Date.now() - 60_000,
    token: "deadtoken00000000000000000000dead",
  };
  await writeFile(
    join(dir, STATE_DIR, `lock.${String(n).padStart(10, "0")}`),
    JSON.stringify(dead),
    { mode: 0o600 },
  );
  return { dir, dead };
}

/** Who holds the vault now, asked of the module rather than of a path. */
const holderOf = currentHolder;

describe("contenders for one dead lock", () => {
  /**
   * The review's exact schedule, driven rather than raced.
   *
   * A is held between reading who holds the vault and claiming the generation
   * after theirs, which is where the two-owner interleaving lived. B runs
   * against that. Whatever order they finish in, exactly one may come away
   * holding the vault.
   */
  it("cannot hand the vault to both while one is deciding", async () => {
    const { dir } = await vaultWithDeadLock();

    let releaseA: (() => void) | undefined;
    const aIsInside = new Promise<void>((ready) => {
      midEvict.pause = async () => {
        // Only the first contender pauses; anybody else must be free to run.
        midEvict.pause = async () => {};
        ready();
        await new Promise<void>((go) => {
          releaseA = go;
        });
      };
    });

    const a = lockVault(dir, "A");
    await aIsInside;
    const b = lockVault(dir, "B");
    // Long enough for B to make several attempts against the paused A.
    await new Promise((r) => setTimeout(r, 40));
    releaseA!();

    const out = await Promise.allSettled([a, b]);
    const won = out.filter((r) => r.status === "fulfilled");
    expect(won.length, `${won.length} of two contenders were handed the same vault`).toBe(1);
    expect(
      await holderOf(dir),
      "somebody was handed the vault and no claim names them",
    ).toBeDefined();
    const loser = out.find((r) => r.status === "rejected");
    if (loser?.status === "rejected") {
      expect((loser.reason as Error).message).toMatch(/another basalt|could not take the lock/);
    }
    for (const r of out) if (r.status === "fulfilled") await r.value();
    expect(await holderOf(dir), "the winner's release left a claim behind").toBeUndefined();
  });

  /**
   * R40, the three-contender schedule, which is the one every previous version
   * of this module failed.
   *
   * A reads a dead holder and pauses. B completes its own takeover and holds
   * the vault. A resumes. Under every earlier design A then moved B's live
   * lock off the authoritative name -- and once it was off, C found nothing
   * there and acquired, so B and C both held and neither was told. Narrowing
   * that window, guarding it with a marker, bucketing the marker by a clock:
   * each made the schedule rarer and none made it impossible, because each
   * still had A remove a name it did not own.
   *
   * Nothing removes anybody's claim now. Superseding one means creating the
   * *next* generation, which `link` gives to exactly one caller, so A's resume
   * finds B's generation already taken and refuses. There is no step at which
   * the vault reads as free while somebody holds it.
   */
  it("refuses both later contenders while the winner still holds it", async () => {
    const { dir } = await vaultWithDeadLock();

    let resumeA: (() => void) | undefined;
    const aIsInside = new Promise<void>((ready) => {
      midEvict.pause = async () => {
        midEvict.pause = async () => {};
        ready();
        await new Promise<void>((go) => {
          resumeA = go;
        });
      };
    });

    const a = lockVault(dir, "A");
    await aIsInside;
    // B takes the vault while A is mid-decision.
    const release = await lockVault(dir, "B");
    expect((await holderOf(dir))?.command, "B did not get the vault").toBe("B");

    resumeA!();
    await expect(a, "A acquired a vault B was holding").rejects.toThrow(
      /another basalt|could not take the lock/,
    );
    // And C, arriving at any point after that, is refused too. Under the old
    // design this is the one that succeeded, because A had just emptied the
    // name B was holding.
    await expect(lockVault(dir, "C"), "C acquired a vault B was holding").rejects.toThrow(
      /another basalt/,
    );

    expect(
      (await holderOf(dir))?.command,
      "the vault changed hands under a holder that was never told",
    ).toBe("B");
    await release();
    expect(await holderOf(dir)).toBeUndefined();
  });

  /**
   * R44. A generation can be reached twice, and a paused contender is aiming
   * at a number rather than at a state.
   *
   * Releasing clears the claims, so the numbering starts again. A caller that
   * read the directory long ago is still holding an arithmetic result from it:
   * generation 1 dead, A reads it meaning to take 2, B takes 2 and finishes
   * and its release empties the directory, C takes 1 and holds, A resumes and
   * links 2 against nothing at all. Both C and A were handed a release, and
   * `currentHolder` named only A, so nothing anywhere said two processes were
   * writing.
   *
   * Winning the name is not owning the vault. Owning it is being the highest
   * claim there is, which is one read and cannot be true of two callers at
   * once.
   */
  it("refuses a contender whose generation came back after a release", async () => {
    // A dead *generational* claim, not the legacy name: the schedule needs A
    // to be aiming one number above what C will end up taking, and that only
    // happens when the numbering has already started.
    const { dir } = await vaultWithDeadClaim(1);

    let resumeA: (() => void) | undefined;
    const aIsInside = new Promise<void>((ready) => {
      midEvict.pause = async () => {
        midEvict.pause = async () => {};
        ready();
        await new Promise<void>((go) => {
          resumeA = go;
        });
      };
    });

    // A has read the dead generation and is about to claim the one after it.
    const a = lockVault(dir, "A");
    await aIsInside;

    // B takes that generation, finishes, and gives it back. Its release is
    // what frees the number A is aiming at.
    await (
      await lockVault(dir, "B")
    )();

    // C then takes the vault from the bottom of the numbering again.
    const release = await lockVault(dir, "C");
    expect((await holderOf(dir))?.command, "C did not get the vault").toBe("C");

    resumeA!();
    await expect(a, "A acquired a vault C was holding").rejects.toThrow(
      /another basalt|could not take the lock/,
    );
    expect(
      (await holderOf(dir))?.command,
      "the vault changed hands under a holder that was never told",
    ).toBe("C");

    await release();
    expect(await holderOf(dir)).toBeUndefined();
  });

  /**
   * The same without the hook: many contenders on one dead lock, all at once.
   *
   * Exactly one may come away with a release function. Twelve was enough to
   * reproduce the earliest version of this bug on the first run.
   */
  it("hands one dead lock to exactly one of twelve contenders", async () => {
    const { dir } = await vaultWithDeadLock();

    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) => lockVault(dir, `c${i}`)),
    );
    const won = results.filter((r) => r.status === "fulfilled");
    expect(won.length, `${won.length} contenders were handed the same vault`).toBe(1);
    expect(
      await holderOf(dir),
      "nobody holds the vault, and one of them thinks it does",
    ).toBeDefined();
    for (const r of results) if (r.status === "fulfilled") await r.value();
    expect(await holderOf(dir), "the winner's release left a claim behind").toBeUndefined();
  });

  /**
   * A lock an older build wrote has no generation, and its holder still counts
   * while it is running. Otherwise an upgrade in the middle of a sync hands
   * the vault to two processes, which is the defect this module is about
   * arriving by way of a version number.
   */
  it("believes a live holder from a build that had no generations", async () => {
    const dir = await mkdtemp(join(tmpdir(), "basalt-lock-"));
    vaults.push(dir);
    await mkdir(join(dir, STATE_DIR), { recursive: true });
    await writeFile(
      lockPath(dir),
      JSON.stringify({
        pid: process.pid,
        host: hostname(),
        command: "an older basalt, still running",
        since: Date.now(),
        token: "oldbuildtoken0000000000000000old",
      }),
      { mode: 0o600 },
    );

    await expect(lockVault(dir, "after the upgrade")).rejects.toThrow(/another basalt/);
  });

  /** And a dead one from that build is superseded and swept. */
  it("supersedes a dead holder from a build that had no generations", async () => {
    const dir = await mkdtemp(join(tmpdir(), "basalt-lock-"));
    vaults.push(dir);
    await mkdir(join(dir, STATE_DIR), { recursive: true });
    await writeFile(
      lockPath(dir),
      JSON.stringify({
        pid: 2 ** 22,
        host: hostname(),
        command: "an older basalt that died",
        since: Date.now() - 60_000,
        token: "oldbuildtoken0000000000000000old",
      }),
      { mode: 0o600 },
    );

    const release = await lockVault(dir, "after the upgrade");
    await release();
    const left = (await readdir(join(dir, STATE_DIR))).filter((n) => n.startsWith("lock"));
    expect(left, `claims were left behind: ${JSON.stringify(left)}`).toEqual([]);
  });

  /** And a completed takeover leaves nothing behind for the next one to trip on. */
  it("clears up after itself", async () => {
    const { dir } = await vaultWithDeadLock();
    const release = await lockVault(dir, "after");
    await release();

    const left = (await readdir(join(dir, STATE_DIR))).filter((n) => n.startsWith("lock"));
    expect(left, `the takeover left debris behind: ${JSON.stringify(left)}`).toEqual([]);
  });
});
