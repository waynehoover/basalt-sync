/**
 * One process per vault, for anything that changes it.
 *
 * The headless client had no idea whether another of itself was running. Two
 * `sync --watch` instances, a cron `sync` beside a watcher, or an `unlink`
 * racing a pass could each load the index, decide from it, and write notes,
 * the config and the index over each other from state the other never saw.
 * The engine's single-flight rule holds inside one process and nowhere else.
 *
 * So a lock file. It names its holder, because a refusal that cannot say who
 * holds the vault leaves a person guessing at which terminal to look in.
 *
 * ## Why there is no stale-lock takeover
 *
 * There used to be, and it was wrong five times. Each attempt handed one vault
 * to two writers, each fix was reviewed and shipped, and the round after found
 * the next ordering: read-then-unlink (R03), an eviction marker (R34), a
 * clock-bucketed marker (R40), a rename-based take (R44), and generational
 * claims with a fence (R49). The last of those is 416 lines and might be
 * right. Five attempts is enough evidence that nobody here can tell.
 *
 * The problem is not that the rule is subtle. It is that "the holder is dead,
 * so I may have it" is a decision taken from an observation, and between the
 * observation and the act the holder can be alive again -- a recycled pid, a
 * process that had not died yet, a second contender that read the same corpse.
 * POSIX has no compare-and-swap on a file to close that gap. The server does
 * not have this problem because it can call `flock`, which is the kernel doing
 * the whole decision atomically. Node has no binding for `flock`, the packed
 * CLI runs under stock node, and the Obsidian plugin could not load a native
 * addon even if one were acceptable.
 *
 * So this does not decide. Taking the lock is `link`, which is the one atomic
 * thing the filesystem does offer: it either creates the name or it fails, and
 * nothing about a holder's liveness enters into it. A lock left behind by a
 * crash stays there until a person runs `basalt unlock`, which says what it
 * found before it does anything.
 *
 * That is worse to live with and it is the trade this project makes. A crashed
 * sync now wedges a cron job until somebody runs one command, and the error
 * says exactly that. The alternative was a mechanism nobody could demonstrate
 * the correctness of, guarding the rule the whole project exists for.
 */

import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";

import { composite, seam } from "../core/seam.ts";
import { STATE_DIR } from "./config.ts";
import { refuseOutsideVaultAt } from "./vault.ts";

export const lockPath = (vault: string) => join(vault, STATE_DIR, "lock");

/**
 * Where `unlock` records that it is running.
 *
 * One recovery at a time, and this is the whole of what makes manual recovery
 * safe (RR1). Without it: U1 reads a lock whose holder is gone and pauses; U2
 * clears that same lock, so the name is free and a writer takes the vault
 * legitimately; U1 resumes, renames *that* writer's lock aside, and a second
 * writer walks into the name while the first still holds it. Two writers, and
 * the `contested` report at the end of U1 arrives after both are already in.
 *
 * With it, nothing but another `unlock` can make the lock file absent while
 * one is deciding -- an acquirer meets the occupied name and is refused -- so
 * excluding a second `unlock` removes the only way into that schedule.
 */
export const recoveryPath = (vault: string) => join(vault, STATE_DIR, "lock.recovering");

/**
 * A seam, and a narrow one: the instant between preparing a lock and putting
 * it at its name.
 *
 * Two processes contending for that instant is the whole of what this module
 * is for, and it is too short to hit by racing. It does nothing in every
 * build; a test replaces `pause`.
 */
export const midPublish = seam("cli/lock:publish");

/**
 * The two instants inside `unlock`.
 *
 * Breaking a lock is the one destructive act left in this module, and it is
 * the act the five failed takeovers were performing automatically. A person
 * asking for it does not make the window smaller: between reading a dead
 * holder and removing its file, a live one can arrive.
 */
export const midBreak = composite({
  /**
   * After the lock has been read and found abandoned, before it is taken
   * aside.
   *
   * The interleaving that makes the taking-aside necessary at all: what the
   * read saw and what the rename gets need not be the same file.
   */
  beforeTaking: seam("cli/lock:break.beforeTaking"),
  /**
   * After the lock is in this call's hand and before anything is decided.
   *
   * The vault's name is free here, and this call emptied it. A `basalt sync`
   * arriving now takes the vault legitimately, which is fine when the lock
   * really was abandoned and is the thing to be careful about when it was not.
   */
  taken: seam("cli/lock:break.taken"),
});

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
 * Returns the release. Never takes a lock somebody else's file is at, whatever
 * that file says about who wrote it and whether they are still running: see
 * the note at the top of this file.
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

  // Three attempts, and each is a whole acquisition rather than a step towards
  // one. The only reason to go round is a holder that released between our
  // `link` failing and our reading what stopped it, which is a vault that is
  // free and would otherwise be reported as busy.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await publish(dir, path, mine)) {
      return async () => {
        // Ours by token or not at all. A pid and a host are not an identity,
        // and this is the one place that matters: a release that matched on
        // those could remove the lock of whoever holds the vault now.
        //
        // Reading and then unlinking is two steps on one name, which is the
        // shape this project spends its length avoiding. It is sound here
        // because nothing can replace a live holder's lock while it runs:
        // `link` refuses an occupied name, and `unlock` will not break a local
        // process it can see running, `--force` included. Taking the file
        // aside to identify it, as `unlock` does, would be worse rather than
        // better -- it would leave the vault looking free for the instant it
        // took to decide, and a third process could take it while this one
        // still held it.
        const now = await readHolder(path);
        if (now?.token !== mine.token) return;
        await rm(path, { force: true });
      };
    }
    const at = await lockState(path);
    if (at.state === "absent") continue;
    throw new Error(refusal(at, path));
  }
  throw new Error(
    `could not take the lock at ${path}: it keeps being taken and released. ` +
      `Something else is running against this vault in a loop.`,
  );
}

/** What to tell somebody whose command just refused, and what to do about it. */
function refusal(at: Extract<LockState, { state: "held" | "unreadable" }>, path: string): string {
  if (at.state === "unreadable") {
    return (
      `something is at ${path} but it does not name a holder, so this vault cannot be ` +
      `locked and nobody can say who has it. Run basalt unlock to clear it.`
    );
  }
  const who = at.holder;
  const when = new Date(who.since).toISOString();
  const what = `${who.command} (pid ${who.pid} on ${who.host}, since ${when})`;
  // Three different situations, and telling them apart is the difference
  // between a message somebody can act on and one they have to guess at
  // (rule 7). The old lock collapsed the middle case into the first by taking
  // it over, which is what the five attempts were about.
  if (who.host !== hostname()) {
    return (
      `another basalt is using this vault: ${what}. That is a different machine, so ` +
      `this one cannot tell whether it is still running. Wait for it to finish, or if ` +
      `you know it is gone, run basalt unlock --force.`
    );
  }
  if (alive(who.pid)) {
    return `another basalt is using this vault: ${what}. Wait for it to finish, or stop it.`;
  }
  return (
    `this vault is locked by ${what}, which is not running any more. Basalt does not ` +
    `take a lock over by itself. Run basalt unlock to clear it.`
  );
}

/** What `unlock` did, so the caller can say it rather than infer it. */
export type Unlocked =
  | { readonly did: "nothing"; readonly why: string }
  | { readonly did: "removed"; readonly was: LockHolder | undefined; readonly why: string }
  | { readonly did: "refused"; readonly was: LockHolder; readonly why: string }
  /**
   * The residual race, reported rather than hidden.
   *
   * This call took aside a lock it had read as abandoned, found it was not,
   * and could not put it back because somebody else had taken the name in
   * between. Two processes may now believe they hold this vault, and no
   * mechanism available here can undo that: what is left is to say so loudly
   * enough that both get stopped. It needs the lock to change from abandoned
   * to held between two adjacent reads *and* a third process to acquire inside
   * the same instant, and it has never been seen outside its own test.
   */
  | { readonly did: "contested"; readonly was: LockHolder; readonly why: string };

/**
 * Breaks the vault's lock, when the holder is gone.
 *
 * Aside first and identified afterwards, which is the shape everything
 * destructive in this client has: reading a dead holder and then unlinking its
 * file are two steps, and a live holder can arrive between them. `rename` is
 * the atomic way to get exactly the bytes that were at the name; what happens
 * next is decided about the file in hand, and a holder that turns out to be
 * live is put back.
 */
export async function unlockVault(vault: string, force = false): Promise<Unlocked> {
  const path = lockPath(vault);
  await refuseOutsideVaultAt(vault, path);
  const recovery = recoveryPath(vault);
  await refuseOutsideVaultAt(vault, recovery);
  await mkdir(join(vault, STATE_DIR), { recursive: true });

  // One recovery at a time, taken the same way the vault lock is: `link`,
  // which creates the name or fails, and decides nothing about liveness.
  const mine: LockHolder = {
    pid: process.pid,
    host: hostname(),
    command: "unlock",
    since: Date.now(),
    token: randomBytes(16).toString("hex"),
  };
  if (!(await publish(join(vault, STATE_DIR), recovery, mine))) {
    const other = await readHolder(recovery);
    return {
      did: "refused",
      was: other ?? mine,
      why:
        `another basalt unlock is already running against this vault` +
        (other === undefined ? "" : ` (pid ${other.pid} on ${other.host})`) +
        `. Two of them at once can hand this vault to two writers, so this one stopped. ` +
        `If no basalt is running, remove ${recovery} and try again`,
    };
  }
  try {
    return await breakLock(path, force);
  } finally {
    // Ours by token, like every other release here. Not recovery data: a
    // mutex, and one that must not outlive the process holding it.
    const now = await readHolder(recovery);
    if (now?.token === mine.token) await rm(recovery, { force: true }).catch(() => undefined);
  }
}

async function breakLock(path: string, force: boolean): Promise<Unlocked> {
  const before = await lockState(path);
  if (before.state === "absent") {
    return { did: "nothing", why: "nothing is holding this vault" };
  }

  // Refused without touching anything, and this is the whole reason the read
  // happens before the taking-aside rather than after it.
  //
  // Moving a live holder's lock out of the way, even for the instant it takes
  // to decide to put it back, leaves the vault looking free: a `basalt sync`
  // starting in that instant takes it while the holder is still running, which
  // is two writers on one vault caused by the command that exists to prevent
  // them. Every ordinary refusal -- somebody's watcher is running, the lock is
  // on another machine -- now ends here, with no window at all.
  if (before.state === "held" && !mayBreak(before.holder, force)) {
    return { did: "refused", was: before.holder, why: whyKept(before.holder) };
  }
  await midBreak.beforeTaking(path);

  const aside = `${path}.breaking.${randomBytes(8).toString("hex")}`;
  try {
    await rename(path, aside);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { did: "nothing", why: "the lock was released while this was looking at it" };
    }
    throw err;
  }
  await midBreak.taken(aside);

  const at = await lockState(aside);
  if (at.state === "unreadable") {
    // It names nobody, so there is no holder to protect and no way to tell
    // anyone who it was. Removing it is the only thing that lets this vault be
    // used again, and saying so is the rest of it (rule 7).
    await rm(aside, { force: true });
    return {
      did: "removed",
      was: undefined,
      why: "the lock named nobody, so it was debris rather than a holder",
    };
  }

  if (at.state === "absent") {
    // The file this call renamed is not there. Nothing else knows the name, so
    // this is a filesystem that lost it rather than a race, and there is
    // nothing left to put back or remove.
    return { did: "removed", was: undefined, why: "the lock file vanished as it was moved aside" };
  }

  const who = at.holder;
  if (mayBreak(who, force)) {
    await rm(aside, { force: true });
    return { did: "removed", was: who, why: describeGone(who) };
  }

  // Reached only when the lock changed between the read above and the rename:
  // it was abandoned a moment ago and it is held now. Back under its own name,
  // and with `link` rather than `rename`, so a lock somebody legitimately took
  // while this was deciding is not written over. `rename` here would replace
  // the new holder's file with the old holder's, and both would then believe
  // they hold the vault -- which is precisely the defect that took five
  // attempts to stop making.
  let restored = true;
  try {
    await link(aside, path);
  } catch {
    restored = false;
  }
  await rm(aside, { force: true });
  if (restored) return { did: "refused", was: who, why: whyKept(who) };
  return {
    did: "contested",
    was: who,
    why:
      `this vault was locked by ${who.command} (pid ${who.pid} on ${who.host}), which is ` +
      `still running, and another basalt took the lock while that was being established. ` +
      `Two processes may both believe they hold this vault: stop both, then run unlock again`,
  };
}

/**
 * Whether this lock may be cleared.
 *
 * `force` is narrower than "break anything", and deliberately: it covers the
 * one case where this machine *cannot know*, which is a holder on another
 * host. A process running here is checkable, so there is nothing for a person
 * to assert about it and no reason to let them. The first version of this let
 * `--force` break a running local process, which its own documentation did not
 * say and which reopened the release race in `lockVault`.
 */
function mayBreak(who: LockHolder, force: boolean): boolean {
  if (who.host === hostname()) return !alive(who.pid);
  return force;
}

function whyKept(who: LockHolder): string {
  return who.host !== hostname()
    ? `it is held on ${who.host}, and this machine cannot tell whether that process is ` +
        `still running. Use --force if you know it is not.`
    : `pid ${who.pid} is still running, and --force does not break a lock this machine ` +
        `can see is held. Stop it instead.`;
}

function describeGone(who: LockHolder): string {
  const when = new Date(who.since).toISOString();
  return (
    `it was held by ${who.command} (pid ${who.pid} on ${who.host}, since ${when}), ` +
    `which is not running`
  );
}

/**
 * Who holds this vault now, or undefined when nobody does.
 *
 * "Holds" means "there is a lock file naming them", which is exactly what
 * `lockVault` refuses on. It deliberately says nothing about whether they are
 * still running: this client no longer has an opinion about that, and a reader
 * that formed one here would be a second answer to the question this module
 * exists to answer once.
 */
export async function currentHolder(vault: string): Promise<LockHolder | undefined> {
  return await readHolder(lockPath(vault));
}

/**
 * Puts a complete lock at `path`, or reports that somebody else got there.
 *
 * The holder is written to a private name first and then `link`ed into place.
 * `link` either creates the name or fails with EEXIST, and the file it creates
 * already holds everything a reader needs, so there is no moment at which a
 * lock exists and says nothing about who owns it. Creating with `wx` and
 * writing afterwards had exactly that moment, and it was long enough for a
 * second process to read an empty file, decide it was corrupt, delete it and
 * take a lock somebody was holding.
 */
async function publish(dir: string, path: string, mine: LockHolder): Promise<boolean> {
  const temp = join(dir, `claiming.${mine.token}`);
  await writeFile(temp, JSON.stringify(mine), { mode: 0o600 });
  // The moment the first implementation was wrong in. There, the lock file
  // already existed and was empty; here, nothing is at the path yet. A test
  // stops the world here and runs a competitor, which is the only way to
  // observe the difference: an empty lock leaves no trace once it is written.
  await midPublish.pause("");
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
 * What is at the lock's path, keeping absent and unreadable apart.
 *
 * They are not the same and treating them as one is what let a live lock be
 * deleted: absent means the vault is free, unreadable means something is in
 * the way that names nobody. Rule 2, in the small.
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
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { state: "absent" };
    // A directory at the name, a permissions fault, a torn read: something is
    // there and it is not a holder. Reporting it as free would let this
    // process take a lock it cannot write.
    if (code === "EISDIR" || code === "EACCES" || code === "EPERM") {
      return { state: "unreadable" };
    }
    throw err;
  }
  const holder = parseHolder(text);
  return holder === undefined ? { state: "unreadable" } : { state: "held", holder };
}

async function readHolder(path: string): Promise<LockHolder | undefined> {
  const at = await lockState(path).catch(() => ({ state: "unreadable" }) as LockState);
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
