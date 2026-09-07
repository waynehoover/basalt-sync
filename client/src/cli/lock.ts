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
  /**
   * Whether this claim has been given back (R49).
   *
   * A released claim stays on the disk. Removing it freed its number, and a
   * number that comes back is a number a delayed caller can still be aiming
   * at: it publishes against nothing, finds nothing above it, and is admitted
   * beside whoever took the vault in the meantime. The file left behind is
   * the fence that stops the counting going backwards, and it is one small
   * file, because taking the vault sweeps everything under it.
   */
  readonly released?: boolean;
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
    // something short: publishing its own claim, or having just won the
    // generation this one was aiming at. Without this, eight attempts are
    // spent inside a microsecond and a contender gives up on a vault that was
    // about to be free, which is a refusal that reads exactly like a real one.
    if (attempt > 0) await pause(5 * attempt);

    const before = await readClaims(dir);
    const holder = liveOwner(before, mine.host);
    if (holder !== undefined) {
      throw new Error(
        `another basalt is using this vault: ${holder.who.command} (pid ${holder.who.pid} on ` +
          `${holder.who.host}, since ${new Date(holder.who.since).toISOString()}). ` +
          `Wait for it to finish, or stop it.`,
      );
    }

    // The seam sits between reading who holds it and claiming a generation,
    // which is the only interleaving left: a contender that finishes here has
    // taken the vault, and this attempt then finds it and gives its claim up.
    await midEvict.pause();

    const next = highestGeneration(before) + 1;
    const at = claimPath(dir, next);
    if (!(await publish(dir, at, mine))) continue;

    // Won the name. Whether that is the vault is a separate question.
    //
    // A generation is a name, not a rank, and it stays used for ever: a
    // release marks its claim rather than removing it, so the counting never
    // goes backwards and a caller holding an arithmetic result from an older
    // reading finds the number already taken. That is what makes the check
    // below sound, and two attempts at this without it were not.
    //
    // Without the fence: generation 1 dead, A reads it meaning to take 2, B
    // takes 2 and its release empties the directory, C reads the empty
    // directory meaning to take 1. Whichever of A and C publishes second, the
    // first is already holding the vault and the second finds nothing to stop
    // it. Asking who had the highest number admitted A; giving way to the
    // lower generation admitted C. Neither question is "is somebody already
    // in there", which is the only one worth asking, and neither could be
    // answered while the numbers came back.
    //
    // With it, both of them are aiming at a number the tombstone still holds,
    // so `publish` refuses and they look again. What is left here is the gap
    // between this call's own reading and its publish, which is what these
    // two checks cover: nobody else's claim may be live, and this one has to
    // be the newest there is.
    const after = await readClaims(dir);
    const rival = liveOwner(
      after.filter((c) => c.holder?.token !== mine.token),
      mine.host,
    );
    if (rival !== undefined || highestGeneration(after) !== next) {
      await rm(at, { force: true });
      continue;
    }

    return async () => {
      // Marked, not removed. Only this generation's file, by name, and only
      // while it is still ours by token: nothing here can reach another
      // holder's claim, and superseding one has never meant unlinking it.
      const now = await readHolder(at);
      if (now?.token !== mine.token) return;
      await writeFile(at, JSON.stringify({ ...mine, released: true }), { mode: 0o600 });
      // And everything under it goes, which is what keeps the fence to one
      // file. Each was observed dead, released or unreadable before it was
      // superseded, and this is the one moment this process is certainly the
      // only owner.
      await sweepSuperseded(dir, next);
    };
  }
  throw new Error(`could not take the lock at ${path}: something keeps taking it first`);
}

/** One claim on the vault: a generation, and whoever wrote it. */
interface Claim {
  readonly generation: number;
  readonly holder: LockHolder | undefined;
}

/** Whether a claim is somebody's, rather than a fence or debris. */
function isLive(c: Claim, host: string): boolean {
  if (c.holder === undefined || c.holder.released === true) return false;
  return c.holder.host !== host || alive(c.holder.pid);
}

/**
 * Every claim in the directory, the legacy name included as generation zero.
 *
 * A lock file with no generation is one an older build wrote. It counts as a
 * claim for as long as its holder runs, so an upgrade in the middle of a sync
 * cannot hand the vault to two processes.
 */
async function readClaims(dir: string): Promise<Claim[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: Claim[] = [];
  for (const name of names) {
    const n = name === "lock" ? 0 : generationOf(name);
    if (n === undefined) continue;
    const at = await lockState(join(dir, name));
    if (at.state === "absent") continue;
    out.push({ generation: n, holder: at.state === "held" ? at.holder : undefined });
  }
  return out;
}

/**
 * The claim somebody is still running behind, if there is one.
 *
 * A holder on another host cannot be checked, so it is believed: a vault on a
 * shared disk with two machines pointing at it is exactly the case the lock is
 * for. An unreadable claim is nobody's: `publish` cannot produce one, so it is
 * debris from something else, and leaving it would mean nobody could ever take
 * this vault again.
 */
function liveOwner(
  claims: readonly Claim[],
  host: string,
): { generation: number; who: LockHolder } | undefined {
  let found: { generation: number; who: LockHolder } | undefined;
  for (const c of claims) {
    if (!isLive(c, host)) continue;
    // The lowest generation, so two readers of the same directory agree on
    // which claim they are talking about.
    if (found === undefined || c.generation < found.generation) {
      found = { generation: c.generation, who: c.holder! };
    }
  }
  return found;
}

function highestGeneration(claims: readonly Claim[]): number {
  let top = 0;
  for (const c of claims) if (c.generation > top) top = c.generation;
  return top;
}

/**
 * Who holds this vault now, or undefined when nobody does.
 *
 * The ownership rule in one place. It is the owner of the highest generation
 * claimed, which is not something a reader can work out by opening a path, and
 * anything that reimplements it is a second answer to the question this module
 * exists to answer once.
 */
export async function currentHolder(vault: string): Promise<LockHolder | undefined> {
  const dir = join(vault, STATE_DIR);
  return liveOwner(await readClaims(dir), hostname())?.who;
}

/**
 * Where one generation's claim lives.
 *
 * Zero-padded so a listing sorts the way the numbers do, which is only for
 * somebody reading the directory: every comparison here is numeric.
 */
function claimPath(dir: string, generation: number): string {
  return join(dir, `lock.${String(generation).padStart(10, "0")}`);
}

/** The generation a claim file names, or undefined if the name is not one. */
function generationOf(name: string): number | undefined {
  const rest = name.startsWith("lock.") ? name.slice("lock.".length) : undefined;
  if (rest === undefined || rest.length === 0 || !/^[0-9]+$/.test(rest)) return undefined;
  const n = Number(rest);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/**
 * Removes every claim below the one this process holds, and the legacy file.
 *
 * Safe without asking who owns them, which is why it happens here: a lower
 * generation was observed dead or unreadable by whoever superseded it, and no
 * live holder can be below the current generation, because a generation is
 * only created after the one under it was found dead. Removing by exact name
 * cannot reach the current one.
 */
async function sweepSuperseded(dir: string, held: number): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const n = generationOf(name);
    if (n !== undefined && n < held) await rm(join(dir, name), { force: true });
  }
  // The legacy file, and only while nothing is holding it.
  //
  // It is how an older build claims this vault, so removing a live one would
  // let a newer build hold a generation that build cannot see. A dead one is
  // debris and stops anybody from ever using an older binary here again.
  //
  // Read and then unlinked, which is the shape this module spends its length
  // avoiding, and it is the best available across versions: an old build
  // claims that name with `link`, so what is there cannot change while it is
  // there, and the only race is an old build releasing and another claiming
  // inside this pair. Cross-version exclusion is one-directional anyway --
  // nothing an old binary does can see a generation -- so this does not make
  // it worse, and it is written down rather than implied.
  const legacy = join(dir, "lock");
  const at = await lockState(legacy);
  if (at.state === "held" && (at.holder.host !== hostname() || alive(at.holder.pid))) return;
  await rm(legacy, { force: true }).catch(() => undefined);
}

/**
 * Puts a complete claim at `path`, or reports that somebody else got there.
 *
 * The holder is written to a private name first and then `link`ed into place.
 * `link` either creates the name or fails with EEXIST, and the file it creates
 * already holds everything a reader needs, so there is no moment at which a
 * claim exists and says nothing about who owns it. Creating with `wx` and
 * writing afterwards had exactly that moment, and it was long enough for a
 * second process to read an empty file, decide it was corrupt, delete it and
 * take a lock somebody was holding.
 */
async function publish(dir: string, path: string, mine: LockHolder): Promise<boolean> {
  const temp = join(dir, `claiming.${mine.token}`);
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
 * A seam for the one interleaving this module has left: the instant between
 * reading who holds the vault and claiming the generation after theirs.
 *
 * Like `midPublish`, it does nothing in every build.
 */
export const midEvict = { pause: async (): Promise<void> => {} };

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
      released: raw.released === true,
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
