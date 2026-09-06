/**
 * One process per vault, for anything that changes it.
 *
 * The headless client had no idea whether another of itself was running. Two
 * `sync --watch` instances, a cron `sync` beside a watcher, or an `unlink`
 * racing a pass could each load the index, decide from it, and write notes,
 * the config and the index over each other from state the other never saw.
 * The engine's single-flight rule holds inside one process and nowhere else.
 *
 * So a lock file, taken with `wx` so that creating it is the test for whether
 * it exists. It names its holder, because a refusal that cannot say who holds
 * the vault leaves a person guessing at which terminal to look in, and a
 * holder that has died is recognised by its pid and replaced rather than
 * waited on for ever.
 */

import { link, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";

import { STATE_DIR } from "./config.ts";
import { refuseOutsideVaultAt } from "./vault.ts";

export const lockPath = (vault: string) => join(vault, STATE_DIR, "lock");

/**
 * A seam, and a narrow one: the instant between preparing a lock and putting
 * it at its name.
 *
 * Two processes contending for that instant is the whole of what this module
 * is for, and it is too short to hit by racing. The chunk store keeps a
 * replaceable `sync` for the same reason. It does nothing in every build; a
 * test replaces `pause`.
 */
export const midPublish = { pause: async (): Promise<void> => {} };

const pause = (ms: number): Promise<void> => new Promise((go) => setTimeout(go, ms));

/** What the lock file says about who holds it. */
export interface LockHolder {
  readonly pid: number;
  readonly host: string;
  readonly command: string;
  /** Milliseconds since the epoch. */
  readonly since: number;
  /**
   * Random, and different for every acquisition.
   *
   * A pid is not an identity: the operating system reuses them, and a release
   * that matched on pid and host alone could remove a lock some unrelated
   * process on a recycled pid had taken. This is what "still ours" means.
   */
  readonly token: string;
}

/**
 * Takes the vault's lock, or refuses with the holder's name.
 *
 * Returns the release. A holder on this host whose process is gone is a lock
 * left behind by a crash or a kill, and is taken over. A holder on another
 * host cannot be checked, so it is believed: a vault on a shared disk with two
 * machines pointing at it is exactly the case the lock is for.
 */
export async function lockVault(vault: string, command: string): Promise<() => Promise<void>> {
  const path = lockPath(vault);
  const dir = join(vault, STATE_DIR);
  // The lock lives under `.basalt` like the config and the index, and gets the
  // same question before it is created (R11): a `.basalt` that is a link out
  // of the vault would put the thing that decides who owns this vault
  // somewhere two vaults could share.
  await refuseOutsideVaultAt(vault, path);
  await mkdir(dir, { recursive: true });
  const mine: LockHolder = {
    pid: process.pid,
    host: hostname(),
    command,
    since: Date.now(),
    token: randomBytes(16).toString("hex"),
  };

  for (let attempt = 0; attempt < 8; attempt++) {
    // A short wait between attempts, growing a little.
    //
    // Every reason to go round again is another process part way through
    // something short: publishing a lock, or holding the eviction right for a
    // dead one. Without this, eight attempts are spent inside a microsecond
    // and a contender gives up on a vault that was about to be free, which is
    // a refusal that reads exactly like a real one.
    if (attempt > 0) await pause(5 * attempt);
    const taken = await publish(dir, path, mine);
    if (taken) {
      return async () => {
        // Only if it is still ours, by token. A pid is not an identity: it is
        // reused, and matching on pid and host alone could remove a lock some
        // unrelated process had taken after ours went.
        const now = await readHolder(path);
        if (now?.token === mine.token) await rm(path, { force: true });
      };
    }

    const at = await lockState(path);
    if (at.state === "absent") {
      // Gone between the failed link and this read, so there is nothing to
      // take over and nothing to remove. Straight back to `publish`, which is
      // atomic and will either create the name or find whoever won.
      //
      // Removing here is what handed the lock to two callers. The old code
      // treated "no holder" as debris and unlinked it, and an absent file plus
      // an unconditional unlink is a live lock deleted whenever somebody links
      // between the read and the removal. Twelve contenders on one stale lock
      // reproduced it on the first run.
      continue;
    }
    if (at.state === "unreadable") {
      // A file that is there and says nothing. `publish` cannot produce one,
      // so it is debris from something else, and it has to go or nobody can
      // ever take this lock again. Under the eviction right, and only while it
      // is still unreadable: a real lock written in between parses and is left
      // alone, and nobody else can be removing it at the same time.
      await evicting(dir, path, "unreadable", mine, (now) => now.state === "unreadable");
      continue;
    }
    const holder = at.holder;
    if (holder.host === mine.host && !alive(holder.pid)) {
      // Left behind by a crash or a kill. Taken over under the eviction right
      // for this exact holder, so no other contender can be removing it, and
      // only while it is still that holder. The next attempt takes the lock by
      // linking, which is atomic.
      await evicting(
        dir,
        path,
        holder.token,
        mine,
        (now) => now.state === "held" && now.holder.token === holder.token,
      );
      continue;
    }
    throw new Error(
      `another basalt is using this vault: ${holder.command} (pid ${holder.pid} on ${holder.host}, ` +
        `since ${new Date(holder.since).toISOString()}). Wait for it to finish, or stop it.`,
    );
  }
  throw new Error(`could not take the lock at ${path}: something keeps recreating it`);
}

/**
 * Puts a complete lock file at `path`, or reports that somebody else got there.
 *
 * The holder is written to a private name first and then `link`ed into place.
 * `link` either creates the name or fails with EEXIST, and the file it creates
 * already holds everything a reader needs, so there is no moment at which the
 * lock exists and says nothing about who owns it. Creating with `wx` and
 * writing afterwards had exactly that moment, and it was long enough for a
 * second process to read an empty file, decide it was corrupt, delete it and
 * take a lock somebody was holding.
 */
async function publish(dir: string, path: string, mine: LockHolder): Promise<boolean> {
  const temp = join(dir, `lock.${mine.token}`);
  await writeFile(temp, JSON.stringify(mine), { mode: 0o600 });
  // The moment the old implementation was wrong in. There, the lock file
  // already existed and was empty; here, nothing is at the path yet. A test
  // stops the world here and runs a competitor, which is the only way to
  // observe the difference: an empty lock leaves no trace once it is written.
  await midPublish.pause();
  try {
    await link(temp, path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    return false;
  } finally {
    await rm(temp, { force: true });
  }
}

/**
 * A seam for the one interleaving this module exists to make impossible: the
 * instant between deciding a lock is dead and removing it.
 *
 * Like `midPublish`, it does nothing in every build.
 */
export const midEvict = { pause: async (): Promise<void> => {} };

/**
 * Takes the exclusive right to evict one holder, does the work, and gives it
 * back (R03).
 *
 * This is the whole of the fix, and the reason the obvious version is not
 * enough. Removing a stale lock is a read and then an unlink, and no
 * filesystem here offers them as one operation. So: A reads a dead holder and
 * is descheduled; B reads the same dead holder, removes it, and links its own
 * live lock; A resumes and unlinks *B's* lock, then links its own. Both A and
 * B have been handed a release function and neither has been told it lost.
 * Re-reading the token immediately before the unlink narrows that to a few
 * instructions and does not close it, which the previous comment here admitted
 * to and then reasoned away: it said the loser would find a live holder next
 * time round, and B never looks again, because B had already succeeded.
 *
 * The marker closes it. Its name carries the token being evicted and it is
 * created with `link`, which either makes the name or fails, so exactly one
 * process may be evicting a given holder at a time. Under it, the lock is read
 * again: if it is still that holder, nobody else can have replaced it, because
 * replacing it means evicting it and that right is held here. If it is
 * anything else, somebody got there first and this does nothing at all.
 *
 * A marker outlives its evictor only if the process dies inside these few
 * operations, against a lock that is held for a whole command; when that
 * happens the marker is a lock like any other and is recovered the same way,
 * by its own holder's liveness.
 */
async function evicting(
  dir: string,
  path: string,
  who: string,
  mine: LockHolder,
  remove: (at: LockState) => boolean,
): Promise<void> {
  const marker = `${path}.evicting.${who}.${evictionEpoch()}`;
  if (!(await publish(dir, marker, mine))) {
    // Somebody else is evicting this holder in this window. This attempt does
    // nothing and the loop looks again.
    return;
  }
  try {
    // Read again, under the right, and then act on that read.
    //
    // Acting on an earlier read is the exact shape of the bug this closes, and
    // it is safe here for one reason: nothing can replace this holder while
    // the marker is held, because replacing it means evicting it. The seam
    // sits in the gap on purpose, so a test can hold a process there and prove
    // that a second one cannot get in front of it.
    const still = await lockState(path);
    await midEvict.pause();
    if (remove(still)) await rm(path, { force: true });
  } finally {
    await rm(marker, { force: true });
  }
  // Markers from earlier windows, cleared on the way out. Never the current
  // one, and never anybody's live one: see the note on `evictionEpoch`.
  await sweepOldMarkers(path);
}

/**
 * The window an eviction marker belongs to (R20).
 *
 * The marker gives one process the exclusive right to evict one dead holder,
 * and the first version of it had the same shape as the bug it was closing: a
 * marker left behind by an evictor that died had to be removed by somebody,
 * and removing it was a read followed by an unlink with a gap in between, so
 * two contenders could each end up believing they held the right. Guarding
 * that with a further marker only moves the problem up a level, for ever.
 *
 * So no live marker is ever removed. The name carries a coarse time window,
 * and contenders in the same window contend for the same name, which `link`
 * settles exclusively. A marker from an earlier window is not a name anybody
 * is using now, so deleting it cannot take anybody's exclusion away: it is
 * debris by construction rather than by judgement.
 *
 * Eviction is a handful of filesystem calls and the window is a minute, so
 * losing exclusivity by straddling a boundary needs an eviction to take a
 * minute; the re-read under the marker still stands behind that. This is one
 * machine's clock compared only with itself, and takeover is already
 * host-scoped: a holder on another host is believed and never evicted.
 */
const EVICTION_WINDOW_MS = 60_000;

function evictionEpoch(): number {
  return Math.floor(Date.now() / EVICTION_WINDOW_MS);
}

/**
 * Removes eviction markers from windows that have passed.
 *
 * Safe without asking who holds them, which is the whole point: a marker from
 * an earlier window is not a name any current evictor can be using, so this
 * cannot remove a live exclusion. Anything from the current window or a later
 * one is left alone whatever it says about itself.
 */
async function sweepOldMarkers(path: string): Promise<void> {
  const dir = dirname(path);
  const prefix = `${basename(path)}.evicting.`;
  const now = evictionEpoch();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const epoch = Number(name.slice(name.lastIndexOf(".") + 1));
    if (!Number.isInteger(epoch) || epoch >= now) continue;
    await rm(join(dir, name), { force: true }).catch(() => undefined);
  }
}

/**
 * What is at the lock's path, keeping absent and unreadable apart.
 *
 * They are not the same and treating them as one is what let a live lock be
 * deleted: absent means retry, unreadable means clear the debris. Rule 2, in
 * the small.
 */
type LockState =
  | { readonly state: "absent" }
  | { readonly state: "unreadable" }
  | { readonly state: "held"; readonly holder: LockHolder };

async function lockState(path: string): Promise<LockState> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent" };
    throw err;
  }
  const holder = parseHolder(text);
  return holder === undefined ? { state: "unreadable" } : { state: "held", holder };
}

async function readHolder(path: string): Promise<LockHolder | undefined> {
  const at = await lockState(path);
  return at.state === "held" ? at.holder : undefined;
}

function parseHolder(text: string): LockHolder | undefined {
  try {
    const raw = JSON.parse(text) as Partial<LockHolder>;
    if (typeof raw.pid !== "number" || typeof raw.host !== "string") return undefined;
    return {
      pid: raw.pid,
      host: raw.host,
      command: typeof raw.command === "string" ? raw.command : "unknown command",
      since: typeof raw.since === "number" ? raw.since : 0,
      // A lock written by an older build has none. Reported as the empty
      // string rather than invented, so it never matches a live token and a
      // release of somebody else's lock cannot be mistaken for our own.
      token: typeof raw.token === "string" ? raw.token : "",
    };
  } catch {
    return undefined;
  }
}

/** Whether a process on this host is still running. EPERM means it is, and is not ours. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
