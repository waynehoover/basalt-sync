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

import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";

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
      await evicting(dir, path, mine, (now) => now.state === "unreadable");
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
export const midEvict = {
  pause: async (): Promise<void> => {},
  /**
   * The instant after this call has read the lock and before it takes the file.
   *
   * The other window, and the one that decides which branch the eviction takes:
   * a contender completing its own eviction here means the file this is about
   * to take belongs to somebody live, which is the only way to reach the
   * put-back. Without a hook there, a test can only ever drive the ordinary
   * branch and the put-back's failures go unexercised.
   */
  beforeTake: async (): Promise<void> => {},
};

/**
 * Takes a dead holder's lock away, and cannot take a live one (R03, R34).
 *
 * Removing a stale lock is a read and then an unlink, and no filesystem here
 * offers them as one operation. So: A reads a dead holder and is descheduled;
 * B reads the same dead holder, removes it, and links its own live lock; A
 * resumes and unlinks *B's* lock, then links its own. Both have been handed a
 * release function and neither has been told it lost.
 *
 * A marker naming the holder was the first answer, and it moved the problem
 * rather than closing it. A marker whose evictor died had to be recovered by
 * somebody, and recovering it was another read and another unlink; bucketing
 * the marker by a minute of the clock made that part safe and left the gap
 * between the last look at the clock and the unlink, which is where the same
 * two-holder schedule got back in. Guarding a guard is not a plan.
 *
 * The primitive with no gap is `rename`. It is atomic, and unlike `rm` it
 * hands back what it took: exactly one caller can move the lock file to a name
 * of its own, and can then look at what it is holding at leisure, because
 * nothing else can be holding it. If it is the dead holder this decided about,
 * it is dropped and the name is free. If it is anybody else's, it goes
 * straight back under `link`, which refuses an occupied name, so a contender
 * that took the name meanwhile keeps it. Preservation rather than prediction,
 * which is the same answer this project reaches for everywhere else it cannot
 * compare and swap.
 *
 * Two things are left, and both are the floor rather than an oversight. A
 * third contender can link its own lock in the instant between the take and
 * the put-back, which is one syscall wide and needs the taken lock to have
 * been live. And a process that dies between them leaves the lock at
 * `lock.taken.<token>`, so the vault reads as free: the safe direction, and
 * the same debris `publish` already leaves. A hard zero needs `flock`, which
 * Node does not offer portably (docs/compared.md).
 *
 * A third thing is *not* left, and used to be: a put-back that failed for a
 * reason of its own. Every failure read as "somebody took the name", and the
 * cleanup then removed the only copy of a live holder's lock, so the vault
 * went unlocked while that holder was still syncing and the next contender
 * took it. Those two answers are now told apart.
 */
async function evicting(
  dir: string,
  path: string,
  mine: LockHolder,
  remove: (at: LockState) => boolean,
): Promise<void> {
  const taken = join(dir, `lock.taken.${mine.token}`);
  await midEvict.beforeTake();
  try {
    await rename(path, taken);
  } catch {
    // Gone, or another contender took it first. Either way this attempt does
    // nothing and the loop looks again.
    return;
  }
  // The seam sits here, holding a process that has the lock file and has not
  // yet decided about it. That is the whole of the interleaving: whatever a
  // competitor does from here, it is doing it to a vault with no lock at its
  // name, and it can never be doing it to this file.
  await midEvict.pause();

  if (remove(await lockState(taken))) {
    await rm(taken, { force: true });
    return;
  }
  // Somebody live, which means this call's earlier read was stale. It goes
  // back exactly as it was.
  //
  // Every reason the put-back can fail is not the same reason, and reading
  // them as one was a way to hand the vault to two owners. `EEXIST` means a
  // contender has published its own lock at the name, so this copy is a
  // duplicate and goes. Anything else -- a full disk, a quota, a descriptor
  // limit, an I/O error -- means the name is still *free* and this is the only
  // copy of a lock somebody is holding. Dropping it there left the vault
  // unlocked with a live holder still syncing, and the next contender took it.
  for (let attempt = 0; ; attempt++) {
    try {
      await link(taken, path);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") break;
      if (attempt >= 4) {
        // Out of tries, and the file is not this call's to throw away. It
        // stays where it is, under a name that says what it is, and the error
        // names it: a lock nobody can find is a vault nobody can take.
        throw new Error(
          `could not put back the lock at ${path} after reading it (${(err as Error).message}); ` +
            `the holder's lock file is at ${taken} and must be moved back or removed by hand`,
        );
      }
      await pause(5 * (attempt + 1));
    }
  }
  await rm(taken, { force: true });
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
