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

import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";

import { STATE_DIR } from "./config.ts";

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
  await mkdir(dir, { recursive: true });
  const mine: LockHolder = {
    pid: process.pid,
    host: hostname(),
    command,
    since: Date.now(),
    token: randomBytes(16).toString("hex"),
  };

  for (let attempt = 0; attempt < 8; attempt++) {
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
      // between the read and the removal. That is not the theoretical residue
      // this file admits to further down: twelve contenders on one stale lock
      // reproduced it on the first run.
      continue;
    }
    if (at.state === "unreadable") {
      // A file that is there and says nothing. `publish` cannot produce one,
      // so it is debris from something else, and it has to go or nobody can
      // ever take this lock again. Removed only while it is still unreadable:
      // a real lock written in between parses, and is left alone.
      await removeIfStillUnreadable(path);
      continue;
    }
    const holder = at.holder;
    if (holder.host === mine.host && !alive(holder.pid)) {
      // Left behind by a crash or a kill. Removed only while it is still that
      // same dead holder, and the next attempt takes the lock by linking,
      // which is atomic: if another contender for the same stale lock links
      // first, this one loses the link and finds a live holder to refuse for.
      await removeIfStill(path, holder.token);
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
 * Removes the lock only while it still holds the token we decided about.
 *
 * The check and the unlink are two operations and no filesystem here offers
 * them as one, so this narrows the window rather than closing it: a live lock
 * taken between the re-read and the unlink could still be removed. What makes
 * that survivable is that the caller does not then assume it holds anything.
 * It goes back to `publish`, which is atomic, and the process that linked
 * first keeps the lock while the other finds a live holder and refuses.
 *
 * The window is a token comparison wide, and it is only ever entered by a
 * caller that has already read a *dead* holder. Two contenders taking over
 * one abandoned lock is the case that has to be safe, and it is: the loser of
 * the link finds the winner's live holder next time round.
 */
async function removeIfStill(path: string, token: string): Promise<void> {
  const now = await lockState(path);
  if (now.state !== "held" || now.holder.token !== token) return;
  await rm(path, { force: true });
}

/** The same, for a file that is there and cannot be read as a holder. */
async function removeIfStillUnreadable(path: string): Promise<void> {
  const now = await lockState(path);
  if (now.state !== "unreadable") return;
  await rm(path, { force: true });
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
