/**
 * The engine: everything that decides, and nothing that knows where files live.
 *
 * Structure follows Obsidian's: an orchestrator collaborating with a transport
 * that knows no policy, a filter that knows only paths, and a crypto provider
 * with no reference to the app. That
 * shape is why the same engine runs in their plugin and their headless client,
 * and it is why this one can run against a vault held in memory.
 *
 * Two properties this is built around, both from that reading:
 *
 *   - **Single flight.** One sync runs at a time, and requests to sync while one
 *     is running set a flag rather than starting a second. Two passes deciding
 *     about the same file from the same index is how a file gets uploaded twice
 *     or downloaded over itself.
 *   - **Retry and refuse are different.** A file that failed once should be tried
 *     again later; a file that can never work should not be tried forever. One
 *     work queue cannot tell those apart, which is why Obsidian keeps
 *     `fileRetry` and `skippedFiles` as separate tables and so does this.
 *
 * ## What the tests pin down
 *
 * Every one of sixteen deliberate breakages of this file is caught by two
 * engines converging through a real server. Three of them took a specific case
 * to catch, and those cases are worth knowing about because each one is a real
 * way to lose a note:
 *
 *   - Moving the ancestor when the two sides already agree. Nothing transfers,
 *     so it looks like a no-op; skip it and the next pair of edits merges
 *     against a version neither device ever had.
 *   - Recording the ancestor on the download itself. The line above would set it
 *     on the following pass anyway, so the two cover each other. The case that
 *     separates them is a user editing straight after a download, before any
 *     pass in which both sides still agree.
 *   - Uploading the conflict copy rather than waiting for the next scan to find
 *     it as a new file. The scan is a real backstop, and it is no use when the
 *     device that found the conflict syncs once and then stops: the other device
 *     downloads the winning version over its own text, and its own text is gone.
 *
 * None of the three is caught by asserting that two devices agree, which is
 * rule 10 of docs/design.md in its natural habitat.
 */

import { notifyTransfer, type TransferActivity } from "./transfer.ts";
import { looksLikeJson, looksLikeText, chunkBytes, chunkStream, sizesFor } from "./chunk.ts";
import { drawingGate, looksLikeExcalidraw } from "./excalidraw.ts";
import { looksLikeMarkupPath, wellFormedMarkup } from "./markup.ts";
import {
  deriveSchedule,
  entryIsOurs,
  macEntry,
  openChunk,
  openPath,
  parentOf,
  plainDigest,
  sealChunks,
  sealPath,
  type Schedule,
  type SealedChunk,
} from "./crypto.ts";
import { conflictCopyPath, mergeText } from "./merge.ts";
import {
  decide,
  needsRehash,
  newEntry,
  nextUploadTime,
  observe,
  readyToSyncAgain,
  renamed,
  synced,
  type Action,
  type IndexEntry,
  type LocalState,
  type RemoteState,
  reconciled,
} from "./index-state.ts";
import {
  MAX_BATCH_ENTRIES,
  MAX_FETCH_NAMES,
  encodedEntryBytes,
  entryBudget,
  PUTMANY_FRAME_OVERHEAD,
  ProtocolError,
  type BatchEntry,
  type ServerLimits,
  type Transport,
  type WireEntry,
} from "./transport.ts";
import { validateStoredState } from "./stored-state.ts";
import {
  canonicalSpelling,
  firstFreeName,
  foldPath,
  foldsTogether,
  isNeverSynced,
  spellOut,
} from "./paths.ts";
import {
  parents,
  type ExpectedContent,
  type FileStat,
  type IndexStore,
  type Times,
  type Vault,
} from "./vault.ts";

/**
 * An index entry with its derivable fields left out.
 *
 * The entry holds a chunk name list, the same names joined as `hash`, and often
 * the same string again as `synchash`, so a vault's chunk names were written to
 * disk three times over. At two thousand files that is 6.96 MiB of index where
 * 2.33 MiB says the same thing, and the whole of it is stringified and written
 * whenever anything changes.
 *
 * Only the serialised form changes. In memory the entry keeps all three, which
 * is what `decide` compares on a hot path, and neither field is recomputed
 * while the engine is running.
 *
 * Left in place when they differ, because they genuinely can: `hash` is the
 * content as of the last scan and `synchash` as of the last completed sync, and
 * the difference between them is the merge base. Dropping that would not save
 * space, it would lose the ancestor.
 */
function packed(e: IndexEntry): Record<string, unknown> {
  const out: Record<string, unknown> = { ...e };
  if (e.hash === contentId(e.chunks)) delete out["hash"];
  if (e.synchash === e.hash) delete out["synchash"];
  return out;
}

/** The inverse, putting back what `packed` left to be derived. */
function unpacked(path: string, raw: Record<string, unknown>): IndexEntry {
  const e = { ...newEntry(path), ...raw } as IndexEntry;
  if (raw["hash"] === undefined) e.hash = contentId(e.chunks);
  if (raw["synchash"] === undefined) e.synchash = e.hash;
  return e;
}

/**
 * The identity of a file's content, as both sides can compute it.
 *
 * The server holds no plaintext hash, so equality of content is equality of the
 * chunk name sequence. Sealing is deterministic precisely so that works.
 *
 * An empty file gets a marker rather than the empty string, because the index
 * uses `synchash === ""` to mean "never synced". Without this an empty note that
 * had synced perfectly well would read as one that never had, and every pass
 * would treat it as new.
 */
export function contentId(chunkNames: readonly string[]): string {
  return chunkNames.length === 0 ? "-empty-" : chunkNames.join(",");
}

/**
 * Refuses a server that is behind the device talking to it.
 *
 * The docs present the client-ahead case as what catches a server restored from
 * an old backup or pointed at the wrong vault, and the refusal was implemented
 * only in the server, so it was absent exactly when it was needed: against a
 * server that is wrong. `ready.cursor` was parsed, logged, shown in the status
 * line, and never compared. Worse, the status line computed `behind` as
 * `max(0, server - local)`, so a server behind its clients displayed as zero
 * and read as being up to date.
 *
 * Its own function because a real server refuses this case first, so nothing
 * short of a lying transport reaches the check and the comparison is the part
 * worth testing.
 *
 * The message names the way out, because an error string is the only UI a
 * stopped device has. It used to end at "the wrong vault", which is a correct
 * diagnosis and no help at all: the person reading it is looking at a vault
 * that has stopped syncing, and the recovery lived in docs/server.md. Both
 * recoveries are named, and the cost of the blunt one with them, because
 * re-pairing resets the merge base and the next concurrent edit then makes
 * conflict copies instead of merging.
 *
 * A `ProtocolError` with the server's own code for this, rather than a plain
 * Error, for two reasons. `runForever` stops on a fatal `ProtocolError` and
 * otherwise retries: a plain Error here was retried three times and then
 * reported under a message about an entry no device can apply, which is a
 * different fault with a different fix. And a shell that wants to offer the
 * recovery has one thing to recognise however the refusal arrived, from the
 * wire or from here.
 */
export function refuseIfBehind(serverCursor: number, ownCursor: number): void {
  if (serverCursor < ownCursor) {
    throw new ProtocolError(
      "cursor",
      `this server is at version ${serverCursor} and this device has already seen ${ownCursor}: ` +
        `refusing to sync, because a server behind its own clients is a restored backup or the wrong vault. ` +
        `${REJOIN_ADVICE}`,
    );
  }
}

/**
 * The way back from a server that has lost history a device already applied.
 *
 * One string, because the two shells say it in the same breath: the headless
 * client prints it under the refusal and the plugin puts it in the panel beside
 * the button that does it.
 */
export const REJOIN_ADVICE =
  "To rejoin it and keep what only this device holds, back the server up and then run " +
  "basalt rebase --backup-taken here, or press Rejoin this server in the Basalt panel. " +
  "Unlinking and pairing again also works, and it resets the merge base, so the next " +
  "edit made on two devices at once makes conflict copies instead of merging.";

/**
 * What this device accepts whatever the server says it stores.
 *
 * The inbound guards read their bounds from `ready`, which is the party they
 * exist to bound. `numberOf()` maps a missing field to 0 and both guards read
 * `if (max > 0)`, so a server that merely omitted `perFileMax` and `maxChunks`
 * switched them both off, and a corrupt row did the same. Missing has to mean
 * this device's own ceiling, never no ceiling.
 *
 * These are the protocol's own maxima, from the server's store package, so
 * nothing a working server asks for is refused by them.
 */
export const OWN_LIMITS = {
  /** 256 MiB, the largest file any server will store. */
  perFileMax: 1 << 28,
  /** 65536, the most chunks any server records for one entry. */
  maxChunks: 1 << 16,
  /** 16 MiB, the largest batched write any server takes, encoded or as summed budget. */
  maxBatchBytes: 16 << 20,
  /** 64 MiB, the most body bytes any server serves for one fetch. */
  maxFetchBytes: 64 << 20,
  /** 1 MiB, the largest sealed chunk any server stores. */
  chunkMax: 1 << 20,
} as const;

/** The tighter of what the server asks for and what this device allows. */
export function boundedBy(fromServer: number, own: number): number {
  return fromServer > 0 ? Math.min(fromServer, own) : own;
}

/**
 * Refuses a list of entries holding one this vault's key did not sign.
 *
 * The nine fields are exactly what the writer signed, and reading them out of
 * a `WireEntry` is the whole check: a field left out here is a field the
 * server may set freely. A parent of "" is a real value, so a server omitting
 * the field means the same thing. A mac cannot be defaulted that way: an
 * absent one fails, which is the point.
 *
 * Every path that acts on an entry comes through here, and the reason it is
 * one function is that for a while it was two and only one of them existed.
 * The sync path checked every batch entry; recovery did not, so a
 * `history` was shown, a `deleted` list was offered for restore, and the
 * version chosen was fetched and written, all on the server's word. The
 * server holds every sealed path and could name any file; an entry it
 * invented would decrypt, being made of real chunks, and be written into the
 * vault as a restored note.
 *
 * `suffix` is for a caller whose refusal has something more to say, such as
 * recovery adding that the entry is not being shown either.
 */
export async function mustBeOurs(
  keys: Schedule,
  entries: readonly WireEntry[],
  suffix = "",
): Promise<void> {
  const ours = await Promise.all(
    entries.map((e) =>
      entryIsOurs(
        keys,
        {
          path: e.path,
          size: e.size,
          ctime: e.ctime,
          mtime: e.mtime,
          folder: e.folder,
          deleted: e.deleted,
          prev: e.prev,
          chunks: e.chunks,
          parent: e.parent ?? "",
        },
        e.mac,
      ),
    ),
  );
  const forged = ours.indexOf(false);
  if (forged >= 0) {
    throw new Error(
      `version ${entries[forged]!.uid} is not authenticated by this vault's key, ` +
        `so nothing that holds the key wrote it${suffix}`,
    );
  }
}

/**
 * Refuses an entry that contradicts itself, before anything acts on it.
 *
 * Everything here except the sealed path arrives in the clear and unsigned, and
 * the server holds every sealed path in the vault, so it can name any file. The
 * protocol doc states this invariant and assigned it to the server: "a file
 * declaring a size names at least one chunk, since a size with no chunks is
 * byte-identical on the wire to an empty note." It was never mirrored here.
 *
 * Unmirrored, one frame emptied a note. `contentId([])` is `-empty-`,
 * `chunkNamesOf` gives it back as no chunks, nothing is fetched, and the
 * zero-length assembly is written over the file. Through `write` rather than
 * `remove`, so there is no trash copy, and the emptied note then goes to every
 * peer as an ordinary edit.
 *
 * A corrupt row does this as readily as a hostile server, which is the same
 * reason the size and chunk-count limits exist.
 */
export function checkEntryShape(e: WireEntry): void {
  // The same list the server's `store.Entry.Validate` enforces, and
  // `protocol-fixtures.json` is what keeps the two lists the same (I03).
  //
  // This used to check two of the server's rules and the server checked seven.
  // That asymmetry is the wrong way round: a server is not obliged to be
  // honest, so every shape it refuses to *store* is a shape a hostile one can
  // still *send*, and the client is the side that has to refuse it on the way
  // in. Checking less here than the server does meant trusting that nobody
  // would ever write the difference.
  if (e.path === "") {
    throw new Error(`version ${e.uid} has an empty path, and no file is called nothing`);
  }
  if (e.folder && e.deleted) {
    throw new Error(`version ${e.uid} is both a folder and a deletion`);
  }
  if (e.size < 0) {
    throw new Error(`version ${e.uid} declares ${e.size} bytes, and there is no such file`);
  }
  if (!isDigest(e.mac)) {
    throw new Error(
      `version ${e.uid} carries no authenticator of the right shape, so nothing can check it`,
    );
  }
  // `parent` is always sent and an absent one arrives as undefined rather than
  // as the empty string, which is a real value meaning a first version.
  if (e.parent !== undefined && e.parent !== "" && !isDigest(e.parent)) {
    throw new Error(`version ${e.uid} names a parent that is neither empty nor a digest`);
  }
  for (const name of e.chunks) {
    if (!isDigest(name)) {
      throw new Error(`version ${e.uid} names ${JSON.stringify(name)}, which is not a chunk name`);
    }
  }
  if (!e.folder && !e.deleted && e.size > 0 && e.chunks.length === 0) {
    throw new Error(
      `version ${e.uid} declares ${e.size} bytes and names no chunks, which cannot both be true`,
    );
  }
  if (!e.folder && !e.deleted && e.size === 0 && e.chunks.length > 0) {
    throw new Error(`version ${e.uid} is a zero-byte file naming ${e.chunks.length} chunks`);
  }
  if (e.chunks.length > 0 && (e.folder || e.deleted)) {
    const what = e.folder ? "a folder" : "a deletion";
    throw new Error(`version ${e.uid} is ${what} and names ${e.chunks.length} chunks`);
  }
}

/** Lowercase hex SHA-256, which is the shape of a MAC, a parent and a chunk name. */
function isDigest(s: string): boolean {
  return /^[0-9a-f]{64}$/.test(s);
}

/**
 * The chunk names back out of a content id.
 *
 * The id is the names joined, so this is not a lookup, it is punctuation. It
 * matters because a batch already carries the chunk list of every entry in it,
 * so a device that keeps the id keeps the list, and asking the server for it
 * again is a round trip spent learning something already known.
 *
 * A chunk name is hex, so the comma can never appear inside one.
 */
export function chunkNamesOf(id: string): string[] {
  return id === "" || id === "-empty-" ? [] : id.split(",");
}

export interface EngineOptions {
  readonly vault: Vault;
  readonly store: IndexStore;
  /**
   * The vault's data key. Every key this engine uses derives from it.
   *
   * Held directly rather than unwrapped from what `ready` returns, because
   * the key that would unwrap it comes from the root secret and a registered
   * device does not have one. It was handed over once, at registration, by
   * the session that did; see `registerAsDevice` in client.ts.
   *
   * The schedule is still derived in `start` rather than in the constructor,
   * so there is one moment the keys become known and no window in which
   * something could be sealed under a different one.
   */
  readonly dataKey: Uint8Array;
  readonly transport: Transport;
  readonly device: string;
  readonly vaultId: string;
  /** This device's row in the vault's device list. */
  readonly deviceId: string;
  /** This device's own auth key, derived from its own secret. */
  readonly token: string;
  readonly now?: () => number;
  readonly log?: (message: string, ...rest: unknown[]) => void;
  /** Path preparation, and undefined before the pass flushes files and saves its index. */
  readonly onProgress?: (path: string | undefined) => void;
  /** Transfer activity for a sync batch; undefined when the exchange ends, before local saving. */
  readonly onTransfer?: (activity: TransferActivity | undefined) => void;
  /** Whether a path may be three-way merged. Defaults to text extensions. */
  readonly mergeable?: (path: string) => boolean;
  /**
   * Whether to hold back a binary attachment that was written moments ago.
   * Notes and other recognized text formats never wait on this cooldown.
   *
   * On by default, which is right for a client that keeps running. A one-shot
   * sync turns it off: deferring to a next pass that will never happen would
   * mean exiting successfully having skipped the file the user just saved.
   */
  readonly coalesceWrites?: boolean;
  /**
   * Whether two edits to one note may be merged. Default true (I30).
   *
   * False keeps both versions in every case that would have merged, which is
   * what merging already does when it cannot proceed safely.
   */
  readonly merge?: boolean;
  /**
   * Whether this device may send anything to the server. Default false, which
   * is to say it may (I29).
   */
  readonly readOnly?: boolean;
}

/** Overrides for a single pass. */
export interface SyncOptions {
  /**
   * Whether to hold back a file written moments ago, just for this pass.
   *
   * Defaults to whatever the engine was built with. A person choosing "sync
   * now" turns it off: they have said now, and reporting "up to date" while
   * the line they just typed sits unsent is the exact status rule 7 forbids.
   */
  readonly coalesceWrites?: boolean;
  /**
   * Whether two edits to one note may be merged. Default true (I30).
   *
   * False keeps both versions in every case that would have merged, which is
   * what merging already does when it cannot proceed safely.
   */
  readonly merge?: boolean;
  /**
   * Whether this device may send anything to the server. Default false, which
   * is to say it may (I29).
   */
  readonly readOnly?: boolean;
}

/**
 * What a sync did.
 *
 * Counted separately rather than summed, because rule 7 of
 * docs/design.md is that a status which cannot distinguish the cases it
 * collapses is not a status. "12 files synced" hides whether anything conflicted.
 */
/**
 * What one `repair` run did, and what it knows it did not do (I14).
 *
 * The counts are deliberately about this device and nothing else, because that
 * is the whole of what a device can see. A body belonging to a version this
 * device never had is not on this disk and is not in this index: there is
 * nothing here that could notice it is gone, let alone supply it. The
 * authoritative list of what a vault is still missing comes from `basaltd
 * verify` on the server, and both shells say so rather than implying that a
 * clean repair means a whole vault.
 */
export interface RepairReport {
  /** Notes this device holds and examined. */
  scanned: number;
  /** Chunk names offered to the server across all of them. */
  offered: number;
  /** Bodies the server was missing and now has. */
  stored: number;
  /**
   * Chunks of notes this device could not offer, because its copy has moved on
   * from the version the server acknowledged.
   *
   * Those bytes were this device's and are not any more. Counted because it is
   * the one kind of "cannot help" this device can actually see, and because a
   * repair run that examined a note and skipped it should say so.
   */
  couldNotOffer: number;
  /**
   * Bodies the server asked for, was sent, and still does not have.
   *
   * Always zero in a healthy run, and never a normal outcome: the server asked
   * for these, so it wants them, and it refused what arrived. A full disk is
   * the likely reason.
   */
  stillMissing: number;
  /** Paths that could not be read or sent, with why. One does not stop the rest. */
  failed: Array<{ readonly path: string; readonly why: string }>;
}

export interface SyncReport {
  uploaded: number;
  downloaded: number;
  merged: number;
  conflicted: number;
  deletedLocally: number;
  deletedRemotely: number;
  restored: number;
  foldersCreated: number;
  unchanged: number;
  /**
   * Files held back by the write debounce, which will go on the next pass.
   *
   * Its own counter rather than folded into `unchanged`, because rule 7 of
   * docs/design.md is that a status collapsing cases it should distinguish
   * is not a status. "unchanged" for a file the user saved four seconds ago is
   * the exact lie that rule is about.
   */
  waiting: number;
  /** Earliest deferred upload deadline; absent when no timed upload remains. */
  nextUploadAt?: number;
  /** All server entries through this cursor were applied and the local pass saved. */
  appliedCursor?: number;
  /** Files that failed and will be tried again. */
  retrying: number;
  /** Files that can never work and will not be tried again. */
  skipped: number;
  /**
   * Which ones, sorted, and bounded the way `inTheWay` is.
   *
   * The count alone is not an identity, and the plugin's notice fires on a
   * change (N2). One file being fixed in the same pass as another starts
   * failing leaves the count at one, and the new failure was never announced:
   * the glyph said something was wrong and nothing ever said what. Bounded
   * because one bad folder writes off everything under it, and a list the
   * length of a subtree is not a message.
   */
  skippedPaths: string[];
  /**
   * Paths this pass could not finish and will try again, sorted and bounded
   * the way `skippedPaths` is.
   *
   * `retrying` is a count, and a count cannot answer the one question a
   * caller acting on a single path has: did *mine* go? Restoring a version
   * settled the vault, ignored the report, and reported the restored note as
   * sent to the other devices whatever had happened to it (F15). A number is
   * enough for a status line and never enough for a promise about one file.
   */
  retryingPaths: string[];
  /**
   * Paths another device syncs that this one is set to ignore.
   *
   * Its own counter rather than folded into `skipped`, and deliberately not
   * part of the exit code (R2). Refusing them is the configuration doing what
   * it was told, so calling the run a failure meant one `--ignore` made every
   * later sync exit 1 for ever. Counted and printed all the same: a number
   * that quietly disappears is how somebody loses track of a folder they
   * stopped syncing years ago.
   */
  ignored: number;
  /**
   * Local changes this device will never send, because it is read-only (I29).
   *
   * Its own count rather than folded into `ignored`, and out of the exit code
   * for the same reason: it is the configuration doing what it was told. An
   * `--ignore` is a path this device does not sync at all; this is one it
   * syncs in a single direction, and somebody looking at a mirror quietly
   * accumulating local edits should be told which of the two they have.
   */
  heldBack: number;
  /** Which ones, so the line names them rather than counting them. */
  heldBackPaths: string[];
  /**
   * Paths a file is standing in the way of.
   *
   * Its own counter rather than folded into `skipped`, whose label says a file
   * will not be tried again. These are tried every pass and cannot succeed
   * until somebody renames one of the two things that disagree, which is a
   * different thing to tell a person and rule 7 says to tell them apart.
   */
  blocked: number;
  /**
   * Which paths, and what is standing in the way of each.
   *
   * The count on its own is not something anybody can act on, and this is the
   * one refusal that never clears itself: it waits until a person renames one
   * of the two things that disagree, and they cannot do that without being
   * told which two. Bounded, because a folder converted to a file blocks
   * everything under it and a list the length of a subtree is not a message.
   */
  inTheWay: {
    path: string;
    blockedBy: string;
    /**
     * The sentence for this one, where "a file here and a folder elsewhere"
     * is not what happened.
     *
     * Optional, and absent for the clash that named this field, which every
     * caller already spells out. Two names on disk that are one path once
     * normalized need their own sentence: the two look identical printed
     * plainly, so a message that did not spell them out would ask a person to
     * rename one of two strings they cannot tell apart.
     */
    why?: string;
  }[];
  /**
   * The one list a person reads: every path waiting on somebody, and the
   * sentence saying what to do about it.
   *
   * Rule 7 is about a status that cannot tell its cases apart, and the answer
   * to it was four counters. Four is three distinctions to learn before the
   * output can be read, and the distinctions are ours: `blocked`, `skipped`
   * and `refusedInbound` all mean "this path is not syncing and waiting will
   * not fix it", and each one's *reason* is the part that differs and the part
   * that can be acted on. So the reasons are what is printed, in one list, and
   * the categories stay where they belong, in the engine.
   *
   * The four maps are untouched and so are the counters above: each came from
   * its own incident and they carry different exit-code semantics, which
   * merging would throw away to save a noun. This is a projection of them for
   * printing, and both shells render it rather than each inventing its own
   * vocabulary for the same three counters.
   *
   * `ignored` is deliberately not in here (R2). A path another device syncs
   * and this one is set to ignore is the configuration doing what it was
   * asked; nobody needs to attend to it, which is the same reason it is not in
   * the exit code. It keeps its counter and is still printed, because a number
   * that quietly disappears is how somebody loses track of a folder they
   * stopped syncing years ago.
   *
   * Bounded the way `inTheWay` and `skippedPaths` are, and bounded per source
   * rather than over the whole list: one file where a folder belongs blocks a
   * subtree, and a single list capped at the end would let that one cause hide
   * every other. `blocked` is the count of the first kind and `skipped` of the
   * second, so a renderer can always say how many are not shown.
   */
  needsAttention: { path: string; why: string }[];
  /** Chunk bodies actually sent, and their size. The measure that matters. */
  chunksSent: number;
  bytesSent: number;
}

/**
 * How many blocked paths are named before the list stops being a message.
 *
 * One file where a folder belongs blocks every path beneath it, so the count
 * can be a whole subtree while the *cause* is a single name. Naming a few is
 * enough to act on; naming four hundred is a wall.
 */
const IN_THE_WAY_SHOWN = 5;

/** The same bound, and the same reason, for the paths written off. */
const SKIPPED_SHOWN = 5;

/**
 * Counts one path as written off, and records which one.
 *
 * One place, because the count and the names have to move together: a counter
 * bumped without a name is exactly the report the plugin cannot tell apart
 * from the pass before it.
 */
/**
 * What to do about a refusal, in one sentence (I11).
 *
 * A refusal that names only what went wrong leaves somebody with a file that
 * will never sync and no idea which of the two devices to go and look at. The
 * reason and the remedy are different halves and only one of them was ever
 * printed. Kept beside the codes rather than in either shell, because both
 * print the same list and neither should be inventing advice.
 *
 * Nothing for a code with no general answer: a made-up next step is worse
 * than none, because it sends somebody to do something that will not help.
 */
function nextStepFor(code: string | undefined): string {
  switch (code) {
    case "toolarge":
      return "Make it smaller, or raise the server's -max-file and restart it.";
    case "badname":
      return "Rename it to something this server will take, on the device that made it.";
    case "neversync":
      return "Nothing syncs under that name here. Move it, or change what this device ignores.";
    case "badentry":
      return "The device that wrote it sent something malformed; its logs say what.";
    case "nochunk":
      return "The server no longer holds its content. Restore it from a backup, or write it again from a device that still has it.";
    case "cursor":
      return "The server has lost history this device applied. Back the server up, then basalt rebase.";
    default:
      return "";
  }
}

function noteSkipped(report: SyncReport, path: string): void {
  report.skipped++;
  report.skippedPaths.push(path);
}

/** The same pairing for a path that will be tried again. */
function noteRetrying(report: SyncReport, path: string): void {
  report.retrying++;
  report.retryingPaths.push(path);
}

function emptyReport(): SyncReport {
  return {
    uploaded: 0,
    downloaded: 0,
    merged: 0,
    conflicted: 0,
    deletedLocally: 0,
    deletedRemotely: 0,
    restored: 0,
    foldersCreated: 0,
    unchanged: 0,
    waiting: 0,
    retrying: 0,
    skipped: 0,
    skippedPaths: [],
    retryingPaths: [],
    heldBack: 0,
    heldBackPaths: [],
    ignored: 0,
    blocked: 0,
    inTheWay: [],
    needsAttention: [],
    chunksSent: 0,
    bytesSent: 0,
  };
}

interface Retry {
  count: number;
  error: string;
  /** Not before this time. */
  at: number;
}

/**
 * The server's word about a path, plus the spelling the server has for it.
 *
 * `wire` is set only while the two differ, which is only for a vault an older
 * Mac client wrote: it spelled every accented name in NFD, so the server holds
 * `café.md` under a spelling no other device produces. This device files that
 * note under its NFC name, and remembers the other one so the next upload can
 * say which name it used to have. Without that the upload is a second note
 * with a name nobody can tell from the first.
 */
type Remote = RemoteState & { readonly wire?: string };

export class Engine {
  private readonly entries = new Map<string, IndexEntry>();
  /** The server's newest word per plaintext path. */
  private readonly remote = new Map<string, Remote>();
  /** Plaintext paths with inbound work outstanding. */
  private readonly pending = new Set<string>();
  private readonly retries = new Map<string, Retry>();
  /**
   * Paths written off, and what the file looked like when they were. Kept
   * apart from `retries` on purpose, because a file that can never work and a
   * file that failed once want opposite treatment.
   *
   * The fingerprint is the point. "Permanent" describes the file, not the
   * path, and a file can be changed: somebody whose note is refused for being
   * too large shortens it. Without the fingerprint the path stayed written
   * off until the application restarted, and nothing said so.
   */
  private readonly skipped = new Map<string, { why: string; fingerprint: string }>();

  /**
   * Paths from other devices this one will not act on, and why. Counted as
   * skipped in every report, since a person may want to know, and never
   * retried, since nothing about them changes by waiting.
   */
  private readonly refusedInbound = new Map<string, string>();

  /**
   * Paths another device syncs that this device is configured to ignore, and
   * why.
   *
   * Kept apart from `skipped` because this is not a failure (R2). Kept at all
   * for the same reason `skipped` is: without it, every pass would fetch the
   * file again to be told the same thing by the same vault.
   */
  private readonly ignoredPaths = new Map<string, string>();

  /**
   * Paths a file is standing in the way of, as of the last pass.
   *
   * Not written off, only noted: the condition belongs to the vault rather
   * than to the path, and it stops holding by itself when somebody renames
   * the file. Kept only so that the same complaint is not logged every pass.
   */
  private blocked = new Set<string>();
  /** The blocked set being built by the pass in progress. */
  private nowBlocked = new Set<string>();

  /**
   * Set once a vault that advertised streaming failed at it. See `streamScan`:
   * the plugin's streaming is a URL the webview fetches, which is verified on
   * desktop and nowhere else.
   */
  private cannotStream = false;

  /** Writes waiting to go up together. */
  private outbox: Queued[] = [];
  /** And what they cost against the server's two batch caps. */
  private outboxBudget = 0;
  private outboxFrame = 0;

  /** Versions waiting to come down together, and what they will cost to hold. */
  private inbox: Incoming[] = [];
  private inboxBytes = 0;

  /**
   * What the server said it will take, learned at the handshake, and kept so
   * a download can be held to it.
   *
   * The limits arrive at hello and were previously logged and dropped. They
   * bound what this device sends; nothing bounded what it would take. A chunk
   * list is a number the server chooses, and a device that fetches and buffers
   * however many are named runs out of memory on a corrupt row as readily as
   * on a hostile one.
   *
   * Readable because a shell has to be able to say why a file was written
   * off, and "too large" is only meaningful next to the number.
   */
  limits: ServerLimits | undefined;
  /** Sealed path to plaintext, so a path is unsealed once per session. */
  private readonly unsealed = new Map<string, string>();

  /**
   * The vault's keys, known from `ready` onwards and not before.
   *
   * Undefined until the handshake has handed over the wrapped data key. Read
   * through `keys`, which refuses rather than sealing anything under a
   * schedule nobody has agreed on yet.
   */
  private derived: Schedule | undefined;
  /**
   * Settled once `derived` is set, which is after `ready`. The first batch can
   * arrive in the same moment, and a batch opened under the wrong schedule
   * fails its authenticator and ends the session, so `acceptBatch` waits here.
   */
  private readonly keysReady: Promise<void>;
  private settleKeys!: () => void;
  private failKeys!: (err: Error) => void;

  private cursor = 0;
  private syncing = false;
  private again = false;
  private started = false;

  constructor(private readonly opts: EngineOptions) {
    this.keysReady = new Promise<void>((resolve, reject) => {
      this.settleKeys = resolve;
      this.failKeys = reject;
    });
    // Awaited by acceptBatch and by nothing before start; a start that
    // never happens must not surface as an unhandled rejection.
    this.keysReady.catch(() => {});
  }

  /**
   * The vault's keys, or a refusal.
   *
   * Everything that seals, opens or authenticates goes through here. A caller
   * that reaches it before the handshake is a bug, and the message says which
   * bug rather than letting WebCrypto complain about an undefined key.
   */
  private get keys(): Schedule {
    if (this.derived === undefined) {
      throw new Error(
        "this engine has not finished its handshake, so the vault's keys are not known yet",
      );
    }
    return this.derived;
  }

  /** The keys in use, which a shell needs to seal a path for recovery. */
  get vaultKeys(): Schedule {
    return this.keys;
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private log(message: string, ...rest: unknown[]): void {
    this.opts.log?.(message, ...rest);
  }

  private mergeable(path: string): boolean {
    return (this.opts.mergeable ?? looksLikeText)(path);
  }

  /**
   * Chunk sizes for a file, against what this server said it would take.
   *
   * The server's ceiling was never passed. `sizesFor` takes it and defaults
   * to the client's own idea of a maximum, so a server advertising something
   * smaller was ignored and every chunk at the boundary was refused. Nothing
   * noticed because the two numbers happen to be the same, and because the
   * refusal only bites on data that does not compress.
   */
  private sizesFor(size: number, isText: boolean) {
    return sizesFor(size, isText, this.limits?.chunkMax);
  }

  private get coalesce(): boolean {
    return this.opts.coalesceWrites ?? true;
  }

  /**
   * Whether this device may merge two edits into one note (I30).
   *
   * On by default, because it is the thing this client is for. Off is for
   * somebody who would rather look at two files than trust anything to
   * combine them: merging is the only operation here that produces content
   * neither device wrote, and while it refuses everything it cannot do safely,
   * "refuses to guess" and "does not guess" are different promises.
   *
   * Off does not mean anything is lost. It means every case that would have
   * merged keeps both versions instead, which is what merging already falls
   * back to.
   */
  private get merging(): boolean {
    return this.opts.merge ?? true;
  }

  /**
   * Whether this device may send anything to the server (I29).
   *
   * A mirror holds a copy and originates nothing. What this stops is not a
   * mistake in the sync engine: a scan of a mount that came up empty, a path
   * typo, a half-restored disk are all *ordinary local changes*, and ordinary
   * local changes propagate. A device that cannot push cannot delete somebody's
   * notes on every other device by being wrong about what is on its own disk.
   *
   * It does not make the client simpler, and it was proposed on the mistaken
   * belief that it would. Downloads still land through `writePreserving`,
   * because the bytes still arrive on a disk a person may have edited.
   */
  private get sending(): boolean {
    return this.opts.readOnly !== true;
  }

  /**
   * Records a local change this device is not going to send.
   *
   * Counted and named, never silent. A mirror with local edits is a thing
   * somebody should find out about from `status` rather than by noticing years
   * later that a machine has been quietly diverging, which is the reasoning
   * that put `ignored` in the report (R2).
   *
   * Deliberately not a failure. Nothing is wrong and nothing needs fixing: the
   * device was told not to send, and did not.
   */
  private heldBack(path: string, report: SyncReport, why: string): void {
    report.heldBack++;
    if (report.heldBackPaths.length < 20) report.heldBackPaths.push(path);
    this.log("held back", path, why);
  }

  /** What this device knows, for a status line that describes the vault. */
  /**
   * Whether the server is holding exactly what this device holds for one path
   * (R09).
   *
   * An affirmative answer about one file, which is what a caller reporting
   * "sent" actually needs. The alternative was to look for the path in the
   * report's `skippedPaths` and `retryingPaths`, and those are display
   * samples: sorted, de-duplicated and cut to five, because a notice naming
   * four hundred files is not a notice. Absence from a sample is not evidence
   * of anything, and the sixth failure of a pass was reported as a success.
   *
   * `synchash` is written only by `synced`, and `synced` is called only where
   * the server has acknowledged a version. So this is the acknowledgement,
   * asked about one path, and it is true for a file that was already up to
   * date as well as one this pass sent, which is the right answer to "is it
   * on the server" either way.
   */
  serverHasOurs(path: string): boolean {
    const entry = this.entries.get(path);
    if (entry === undefined || entry.folder) return false;
    return entry.syncuid > 0 && entry.synchash !== "" && entry.synchash === entry.hash;
  }

  status(): {
    cursor: number;
    files: number;
    pending: number;
    retrying: number;
    skipped: number;
    /**
     * Paths another device syncs that this one is set to ignore.
     *
     * Reported apart from `skipped` for the same reason the counter is (R2):
     * one is a failure and the other is the configuration doing as it was
     * told, and a caller reading this programmatically could not tell them
     * apart at all.
     */
    ignored: number;
    syncing: boolean;
    /** How many sealed paths are cached, which prune keeps to what is referred to. */
    cachedPaths: number;
  } {
    let files = 0;
    for (const e of this.entries.values()) if (!e.folder) files++;
    return {
      cursor: this.cursor,
      files,
      pending: this.pending.size,
      retrying: this.retries.size,
      skipped: this.skipped.size + this.refusedInbound.size,
      ignored: this.ignoredPaths.size,
      syncing: this.syncing,
      cachedPaths: this.unsealed.size,
    };
  }

  /**
   * Loads the index, opens the session, and drains the backlog.
   *
   * The cursor sent is this device's, from the index. Sending 0 instead would
   * work and would re-download the whole vault, and the server would refuse a
   * cursor it never issued, which is the case that catches a restored backup.
   */
  async start(): Promise<ServerLimits> {
    if (this.started) throw new Error("already started");
    this.started = true;

    // Checked in full before any of it becomes state. See stored-state.ts:
    // a store hands back whatever it parsed, and the casts below used to be
    // the only thing between a corrupt file and a wrong decision.
    const stored = validateStoredState(await this.opts.store.load());
    if (stored) {
      this.cursor = stored.cursor;
      for (const [path, raw] of Object.entries(stored.entries)) {
        this.entries.set(path, unpacked(path, raw as Record<string, unknown>));
      }
      for (const [path, raw] of Object.entries(stored.remote)) {
        this.remote.set(path, raw as Remote);
      }
      for (const path of stored.pending) this.pending.add(path);
      this.log("index loaded", {
        cursor: this.cursor,
        entries: this.entries.size,
        pending: this.pending.size,
      });
    }

    let limits: ServerLimits;
    try {
      limits = await this.opts.transport.hello({
        vault: this.opts.vaultId,
        deviceId: this.opts.deviceId,
        token: this.opts.token,
        device: this.opts.device,
        cursor: this.cursor,
      });
      // The docs present the client-ahead case as what catches a server
      // restored from an old backup or pointed at the wrong vault, and the
      // refusal lived only in the server, so it was missing exactly when it
      // was needed. A server behind this device would answer no batches, and
      // the status line reported `behind` clamped at zero, so it looked like
      // being up to date.
      refuseIfBehind(limits.cursor, this.cursor);
      // The vault's keys, from the data key this device was registered with.
      // This is the only place they are set, and it happens before the first
      // batch is opened: a batch unsealed under any other schedule fails its
      // authenticator.
      this.derived = await deriveSchedule(this.opts.dataKey);
    } catch (err) {
      this.failKeys(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
    this.settleKeys();
    this.limits = limits;
    this.log("connected", limits);
    return limits;
  }

  /**
   * Authenticates one outgoing entry.
   *
   * Everything a receiving device acts on, signed with a key the server does
   * not have, plus the version this was written on top of. The uid is not in
   * it: the server assigns uids and ordering the log is its job, which this
   * does not try to take. What it settles is that the server cannot invent an
   * entry, alter one, or move one file's chunk list onto another file.
   */
  private async authFor(
    entry: PutFacts,
    builtOn: string,
  ): Promise<{ mac: string; parent: string }> {
    const parent = await parentOf(builtOn);
    const mac = await macEntry(this.keys, {
      path: entry.path,
      size: entry.meta.size,
      ctime: entry.meta.ctime,
      mtime: entry.meta.mtime,
      folder: entry.meta.folder ?? false,
      deleted: entry.meta.deleted ?? false,
      prev: entry.meta.prev,
      chunks: entry.names,
      parent,
    });
    return { mac, parent };
  }

  /**
   * Takes a batch from the transport into the remote index.
   *
   * Wired to the transport's `onBatch`. The transport has already checked that
   * the range continues this device's cursor, so what is left here is unsealing
   * the paths and remembering that these paths have work outstanding.
   *
   * A batch with no entries is this device's own write coming back: it carries
   * the cursor advance and nothing to apply.
   */
  async acceptBatch(batch: { from: number; to: number; entries: WireEntry[] }): Promise<void> {
    // Not before the handshake has said which keys this vault uses; see
    // `keysReady`.
    await this.keysReady;
    // Staged, then committed once every entry has unsealed and passed its
    // checks. Applied entry by entry, a batch that failed part way through
    // left the entries before the failure recorded and no way to undo them,
    // and `save()` persists `remote` and `pending`, so they survived the
    // session dying. `deleteLocal` needs no server, so a batch of
    // [forged deletion, entry sealed under another vault's key] applied the
    // deletion on the next pass while the connection died looking like a
    // misconfiguration. "The session ended safely" is not "nothing was
    // applied" unless the state is committed together.
    // Verified and unsealed as two passes over the batch, not one crypto
    // call at a time.
    //
    // Both are WebCrypto, both are per entry, and neither depends on the
    // one before it. Serially a 2000 entry catch-up spent 25.7 ms on the
    // authenticators and 25.0 ms opening paths; together those are 11.5 ms
    // and 8.4 ms. The staging map already commits at the end, so checking
    // the whole batch before touching anything is the same all-or-nothing
    // it already had.
    await mustBeOurs(this.keys, batch.entries);
    for (const e of batch.entries) checkEntryShape(e);

    // The spelling the sender used, and the one this device files it under.
    // They differ only when a peer spells a name in a Unicode normal form
    // that is not NFC, which a Mac running a client older than this rule
    // does for every accented name it uploads.
    const wires = await Promise.all(batch.entries.map((e) => this.plaintextPath(e.path)));
    const paths = wires.map(canonicalSpelling);
    const olds = await Promise.all(
      batch.entries.map((e) => (e.prev ? this.plaintextPath(e.prev) : undefined)),
    );

    const staged = new Map<string, Remote>();
    for (let at = 0; at < batch.entries.length; at++) {
      const e = batch.entries[at]!;
      const path = paths[at]!;
      const wire = wires[at]!;
      // A path this device would never list is refused here, once, as a
      // fact about the path rather than filed for retry: written, it
      // would be invisible to the next scan and reported deleted. A path
      // that is not in canonical form is refused the same way: a
      // filesystem collapses `a//b` onto `a/b`, and the engine keys its
      // whole idea of a file on the string, so two spellings of one file
      // would be two entries here and one file there. Neither ends the
      // session: a peer that is wrong about one path is still the vault.
      const why = refusedInboundPath(path);
      if (why !== undefined) {
        if (!this.refusedInbound.has(path)) {
          this.log("refused a path from another device", path, why);
        }
        this.refusedInbound.set(path, why);
        continue;
      }
      staged.set(path, {
        uid: e.uid,
        folder: e.folder,
        deleted: e.deleted,
        mtime: e.mtime,
        size: e.size,
        hash: contentId(e.chunks),
        // The sender's spelling, kept only while it is not the one this
        // device uses (R10). It is what the next upload of this path names
        // as the path it used to have, so the correction travels as a
        // rename rather than as a second note.
        ...(wire !== path ? { wire } : {}),
      });

      if (e.prev) {
        // A rename travels as one operation, so nothing tells this
        // device the old path is gone except this field. Recorded as a
        // deletion of the old path, which is what it is, and which lets
        // the decision table handle the awkward case for free: if the
        // old path was edited here since the last sync, a deletion loses
        // to an edit and the file is kept and re-uploaded.
        const old = canonicalSpelling(olds[at]!);
        // Unless the two names are one name. A peer correcting the
        // spelling of a path sends exactly that: `café.md` in NFC, moved
        // from `café.md` in NFD. Staged as written, the deletion of the
        // old name lands on the same key as the arrival of the new one
        // and whichever went in last decided whether the note existed
        // (R10). `renamed` refuses a rename to itself for the same
        // reason, one layer up.
        if (old !== path) {
          staged.set(old, {
            uid: e.uid,
            folder: false,
            deleted: true,
            mtime: e.mtime,
            size: 0,
            hash: "",
          });
        }
      }
    }

    for (const [path, state] of staged) {
      this.remote.set(path, state);
      this.pending.add(path);
    }
    this.cursor = batch.to;
  }

  private async plaintextPath(sealed: string): Promise<string> {
    const known = this.unsealed.get(sealed);
    if (known !== undefined) return known;
    const plain = await openPath(this.keys, sealed);
    this.unsealed.set(sealed, plain);
    return plain;
  }

  /**
   * Runs one reconciliation pass, and only one.
   *
   * A request arriving while a pass is running sets a flag and the pass runs
   * again when it finishes, which is Obsidian's `requestSync`. Starting a
   * second pass concurrently would have two of them deciding about the same
   * file from the same index.
   */
  async sync(opts: SyncOptions = {}): Promise<SyncReport> {
    if (this.syncing) {
      this.again = true;
      return emptyReport();
    }
    this.syncing = true;
    try {
      let report = await this.pass(opts);
      while (this.again) {
        this.again = false;
        const next = await this.pass(opts);
        report = combinePasses(report, next);
      }
      return report;
    } finally {
      this.syncing = false;
    }
  }

  private async pass(opts: SyncOptions = {}): Promise<SyncReport> {
    const report = emptyReport();
    const now = this.now();
    const coalesce = opts.coalesceWrites ?? this.coalesce;

    // Both queues empty at the end of every pass that returns. One that
    // threw on its way out leaves them full, and carrying that into the next
    // pass would commit those writes against a report nobody reads, so the
    // pass that did the work would say it did none and `settle` would stop.
    //
    // Dropping them is safe and is the reason this is a discard rather than
    // a flush. Nothing queued was acknowledged, so no entry was marked
    // synced and no file was written; reconciliation sees the same
    // divergence again and queues the same work.
    if (this.outbox.length > 0 || this.inbox.length > 0) {
      this.log("a pass ended early, discarding what it had queued", {
        writes: this.outbox.length,
        reads: this.inbox.length,
      });
      this.outbox = [];
      this.outboxBudget = 0;
      this.outboxFrame = 0;
      this.inbox = [];
      this.inboxBytes = 0;
    }

    // 1. What the filesystem says. The index's cache means an unchanged file
    //    costs one stat, so a full pass over a large vault is affordable and
    //    there is no need to track dirtiness separately.
    const stats = await this.opts.vault.list();
    const onDisk = new Map(stats.map((s) => [s.path, s]));
    for (const stat of stats) {
      const entry = this.entryFor(stat.path);
      observe(entry, stat);
    }

    // Paths that are files, so a path whose parent is one can be spotted
    // before anything tries to create a folder there. A real filesystem
    // answers ENOTDIR, which is not a condition that improves with retrying,
    // and the retry is where this used to spend the rest of the session.
    const filePaths = new Set<string>();
    for (const [path, stat] of onDisk) {
      if (!stat.folder) filePaths.add(path);
    }
    const nowBlocked = new Set<string>();
    this.nowBlocked = nowBlocked;

    // Paths the vault left out of the listing because two names on disk claim
    // them, with the sentence that names both.
    //
    // Read right after the listing and from the same pass, because a path in
    // neither is a path the engine would report deleted: the vault can see
    // both files and omitting them with nothing said would have this device
    // tell the server a note it is looking at is gone, on the strength of a
    // spelling. Nothing syncs under such a path and nothing under it either,
    // since a folder two names claim has no unambiguous path inside it
    // (cli/vault-spelling.test.ts, "blocks the one name two files claim and
    // syncs the rest of the vault").
    const ambiguous = new Map<string, string>();
    for (const clash of this.opts.vault.ambiguous?.() ?? []) {
      ambiguous.set(
        clash.path,
        `${clash.spellings.map((s) => `"${spellOut(s)}"`).join(" and ")} are one name here, ` +
          `and only one of them can sync.`,
      );
    }

    // What the disk will file each local path under, for the collision
    // check in `fill`. Worked out here, once per pass, from the same listing
    // the decisions are made from.
    this.localByIdentity = new Map();
    for (const path of onDisk.keys()) this.localByIdentity.set(this.identity(path), path);
    this.deletingThisPass = new Set();

    // 2. Every path either side knows about, plus the ones the vault could
    //    not name. A clash between two brand new files is in no index and on
    //    neither side, and left out of this set it would be refused in
    //    silence, which is the one thing a refusal that waits on a person
    //    must not be.
    const paths = new Set<string>([
      ...onDisk.keys(),
      ...this.entries.keys(),
      ...this.remote.keys(),
      ...ambiguous.keys(),
    ]);

    const priority = (path: string) =>
      onDisk.get(path)?.folder || this.remote.get(path)?.folder ? 0 : looksLikeText(path) ? 1 : 2;
    const ordered = [...paths]
      .map((path) => ({ path, priority: priority(path) }))
      .sort((a, b) => a.priority - b.priority || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    let notesFlushed = false;
    for (const { path, priority } of ordered) {
      if (priority === 2 && !notesFlushed) {
        // Publish queued notes before an attachment can block reading,
        // chunking, or transfer. All writes retain the same safety checks.
        await this.fill(report);
        await this.flush(report);
        notesFlushed = true;
      }
      if (this.ignoredPaths.has(path)) {
        // Settled, and settled by the person who configured this device. It
        // is counted every pass so it stays visible, and nothing is fetched
        // to find out what is already known.
        //
        // Dropped from the work list, because there is no work: it was left
        // there, so `basalt status` reported an ignored folder as "N files
        // with work outstanding" for the rest of the vault's life. Rule 7,
        // and the counter above is where an ignored path is meant to show.
        this.pending.delete(path);
        report.ignored++;
        continue;
      }
      const skip = this.skipped.get(path);
      if (skip) {
        if (fingerprintOf(this.entries.get(path)) === skip.fingerprint) {
          noteSkipped(report, path);
          continue;
        }
        // Changed since it was written off. Whatever was wrong with it
        // may not be any more, and the only way to find out is to try.
        this.skipped.delete(path);
        this.log("skipped file changed, trying again", path);
      }
      // This path, or a folder above it, is one two names on disk claim.
      // Both are left where they are and nothing moves under the name until
      // a person renames one, which is the only outcome that keeps both
      // notes. Worked out fresh every pass, like the clash below and for the
      // same reason: the moment one of them is renamed there is nothing here
      // to notice, so a remembered refusal would never clear.
      const claimed = ambiguous.has(path)
        ? path
        : parents(path).find((ancestor) => ambiguous.has(ancestor));
      if (claimed !== undefined) {
        const why = ambiguous.get(claimed)!;
        nowBlocked.add(path);
        if (!this.blocked.has(path)) this.log("cannot be both", path, why);
        report.blocked++;
        if (report.inTheWay.length < IN_THE_WAY_SHOWN) {
          report.inTheWay.push({ path, blockedBy: claimed, why });
        }
        continue;
      }

      const blockedBy = parents(path).find((ancestor) => filePaths.has(ancestor));
      if (blockedBy !== undefined && !onDisk.has(path)) {
        // Something upstream is a file where this path needs a folder.
        // Nothing can be written here until somebody renames one of
        // them, and a real filesystem answers ENOTDIR, which does not
        // improve with retrying.
        //
        // Worked out fresh every pass rather than remembered. There is
        // no local file here to notice a change in, so a remembered
        // refusal would have nothing to clear it: the first version of
        // this kept the path written off after the blocker was renamed
        // away, and the note never arrived.
        nowBlocked.add(path);
        if (!this.blocked.has(path)) {
          this.log("cannot be both", path, `${blockedBy} is a file here and a folder elsewhere`);
        }
        report.blocked++;
        if (report.inTheWay.length < IN_THE_WAY_SHOWN) {
          report.inTheWay.push({ path, blockedBy });
        }
        continue;
      }

      const retry = this.retries.get(path);
      if (retry && retry.at > now) {
        noteRetrying(report, path);
        continue;
      }
      try {
        this.opts.onProgress?.(path);
        await this.reconcile(path, onDisk.get(path), report, now, coalesce);
        this.retries.delete(path);
      } catch (err) {
        this.recordFailure(path, err, report);
      }
    }

    // Whatever is still queued moves now. Until these return, no write in
    // this pass has been acknowledged and no queued file is on disk.
    //
    // `wroteThisPass` is not cleared here. `receive` already fills a full
    // inbox part way through the loop, and those writes are the ones
    // `applyDeletes` has to know about: clearing the list before the final
    // fill forgot every file written by an earlier one, so a case-only rename
    // arriving in a pass with more than a batch of downloads deleted the file
    // it had just written. The reset after the deletes is the one that counts.
    await this.fill(report);
    await this.applyDeletes(report);
    this.wroteThisPass = [];
    await this.flush(report);

    this.opts.onProgress?.(undefined);
    for (const path of this.refusedInbound.keys()) noteSkipped(report, path);
    // Sorted and capped once, here, after everything that could add to it.
    // Sorted because the plugin keys its notice on the names and the same set
    // reached in a different order is the same set; capped for the reason
    // above the constant.
    report.skippedPaths = [...new Set(report.skippedPaths)].sort().slice(0, SKIPPED_SHOWN);
    report.retryingPaths = [...new Set(report.retryingPaths)].sort().slice(0, SKIPPED_SHOWN);

    // Replaced rather than added to, so a path stops being blocked the
    // moment the file in its way is gone.
    this.blocked = nowBlocked;

    this.prune(onDisk);
    // Before the index, always. The index names notes, so it must not be
    // durable ahead of them; a vault that defers any part of a write makes it
    // durable here. Rule 3 in another form.
    await this.opts.vault.flush?.();
    await this.save();
    if (
      this.pending.size === 0 &&
      report.waiting === 0 &&
      report.retrying === 0 &&
      report.skipped === 0 &&
      report.blocked === 0 &&
      report.ignored === 0 &&
      report.heldBack === 0 &&
      report.conflicted === 0 &&
      [...this.remote].every(
        ([path, remote]) => (this.entries.get(path)?.syncuid ?? -1) >= remote.uid,
      )
    ) {
      report.appliedCursor = this.cursor;
    }
    report.needsAttention = this.attentionList(report);
    return report;
  }

  /**
   * The four maps, rendered as the one list a person reads.
   *
   * Built here, at the end of a pass, because `inTheWay` is still being added
   * to by `refuseAliases` and `applyDeletes` until then, and a list assembled
   * halfway through would be missing whichever refusal came last.
   *
   * Every entry carries a whole sentence, including what to do, because a
   * reason a person cannot act on is a category with extra words. The two
   * blocked kinds ask for different things and say so: two spellings of one
   * name are both on this device, so the rename is here, while a file here and
   * a folder elsewhere is waiting on whichever device meant the other thing.
   *
   * Deduplicated by path, since a path can be blocked and written off at once,
   * and blocked is the one that clears itself. Bounded per source, for the
   * reason on the field.
   */
  private attentionList(report: SyncReport): { path: string; why: string }[] {
    const out: { path: string; why: string }[] = [];
    const said = new Set<string>();
    const add = (path: string, why: string) => {
      if (said.has(path)) return;
      said.add(path);
      out.push({ path, why });
    };

    for (const blocked of report.inTheWay) {
      add(
        blocked.path,
        blocked.why === undefined
          ? `"${blocked.blockedBy}" is a file here and a folder on another device. ` +
              `Rename one of them, on whichever device meant the other thing.`
          : `${blocked.why} Rename one of them here; nothing syncs under that name until you do.`,
      );
    }
    for (const path of report.skippedPaths) {
      // The reason is in whichever map wrote the path off. `refusedInbound` is
      // counted as skipped in every report and has its own map, so both are
      // asked; a path in neither is one a pass recorded and then cleared, and
      // a bare path with no sentence is worse than no line.
      const why = this.skipped.get(path)?.why ?? this.refusedInbound.get(path);
      if (why !== undefined) add(path, why);
    }
    return out;
  }

  private entryFor(path: string): IndexEntry {
    let entry = this.entries.get(path);
    if (!entry) {
      entry = newEntry(path);
      this.entries.set(path, entry);
    }
    return entry;
  }

  private async reconcile(
    path: string,
    stat: { folder: boolean; mtime: number; ctime: number; size: number } | undefined,
    report: SyncReport,
    now: number,
    coalesce: boolean,
  ): Promise<void> {
    const entry = this.entryFor(path);
    const remote = this.remote.get(path);

    // Checked from the stat, before the file is opened. The server refuses
    // an oversized file at the put, which is correct and far too late: by
    // then the client has read it, chunked it and sealed it, and a file just
    // over the limit costs several times its own size in memory to produce
    // an error that its size alone predicted. On a phone that is not a
    // wasted pass, it is the end of the process.
    const perFileMax = this.limitOn("perFileMax");
    if (stat && !stat.folder && stat.size > perFileMax) {
      this.recordFailure(path, tooLarge(stat.size, perFileMax), report);
      return;
    }

    let local: LocalState | undefined;
    let sealed: Scanned | undefined;
    if (stat) {
      if (!stat.folder && needsRehash(entry, Math.ceil(stat.mtime), stat.size)) {
        // The only place a file is read for its content, and only when
        // the stat says it moved.
        sealed = await this.rehash(entry, path, stat.size);
      }
      local = { folder: stat.folder, mtime: entry.mtime, size: entry.size, hash: entry.hash };
    }

    let action = decide({ local, remote, index: entry, mergeable: this.mergeable(path) });

    // The server still spells this name a way this device does not.
    //
    // Only a vault an older Mac client wrote is in this state: it uploaded
    // `café.md` in NFD, which is the same name as `café.md` and not the same
    // string, and nothing else produces it. This device holds the note under
    // the NFC name, so the correction it owes the server is a rename, and
    // `prev` is how a rename travels: one entry, no bodies, the chunks are
    // already there. Uploading without it is what left two spellings on the
    // server and a vault permanently `blocked` between them, which is the
    // failure the normalisation was added to prevent
    // (cli/normalization.test.ts, "a peer that spells the name NFD").
    //
    // Only with the file actually here, because a rename has to name a file.
    // `prev` is filled only when it is free: a rename this device has not sent
    // yet names the path the server knows, which is the older of the two, and
    // that is the one Obsidian keeps too. The upload is forced whether or not
    // it was free, because it is `remote.wire` going away that says the server
    // has heard, and an attempt that failed owes another one.
    //
    // Files only. A folder carries no content and its entry carries no `prev`,
    // so renaming one would add a second folder to the server and remove
    // nothing. It does not need to: a receiving device folds the old spelling
    // to the same name and makes the same directory.
    const spelled = remote?.wire;
    if (spelled !== undefined && local !== undefined && !local.folder) {
      if (entry.prev === "") entry.prev = spelled;
      if (action.kind === "nothing") {
        action = { kind: "upload", why: "the server spells this name in another normal form" };
      }
    }

    if (
      coalesce &&
      action.kind === "upload" &&
      this.sending &&
      local &&
      !stat?.folder &&
      !looksLikeText(path) &&
      !readyToSyncAgain(entry, now)
    ) {
      // Only repeat binary uploads wait. Notes already have the client's
      // event batching; another per-file delay holds back saved edits.
      // Incoming updates also reach the editor without this cooldown.
      // Give the client a deadline so this cannot wait for the 30 s poll.
      report.waiting++;
      report.nextUploadAt = Math.min(report.nextUploadAt ?? Infinity, nextUploadTime(entry));
      return;
    }

    await this.act(path, action, entry, local, remote, report, sealed);
    this.pending.delete(path);
  }

  /**
   * Chunks and seals a file, filling in the index's content cache.
   *
   * The sealed bodies come back so that an upload deciding to send this file
   * does not read, chunk and seal it all over again. On a first sync that
   * second pass was half of everything the client did: seventeen megabytes
   * took thirty seconds against four seconds of wire, and the four round
   * trips it now costs made the duplication the whole cost.
   *
   * Only for files small enough to hold. Above that the bodies are dropped
   * for the reason `planUpload` explains, and it does its own work.
   */
  private async rehash(entry: IndexEntry, path: string, knownSize?: number): Promise<Scanned> {
    const streamed = await this.streamScan(entry, path, knownSize);
    if (streamed) return streamed;

    const bytes = await this.opts.vault.read(path);
    const isText = this.mergeable(path);
    const pieces = [...chunkBytes(bytes, this.sizesFor(bytes.length, isText), isText)];
    const parts = pieces.map((c) => c.bytes);

    // Small enough to keep: seal it all, and the upload that is about to
    // want the bodies has them.
    if (bytes.length <= KEEP_SEALED_BELOW) {
      const sealed = await sealChunks(this.keys, parts);
      entry.chunks = sealed.map((c) => c.name);
      entry.hash = contentId(entry.chunks);
      entry.size = bytes.length;
      return { bytes, pieces, names: entry.chunks, sealed };
    }

    // Too big to keep the bodies even for a moment, so only the names are
    // taken and the sealed copies are dropped a window at a time.
    // Chunk names without keeping the bodies. See `sealedNames`.
    entry.chunks = await sealedNames(this.keys, parts);
    entry.hash = contentId(entry.chunks);
    entry.size = bytes.length;
    return { bytes, pieces, names: entry.chunks };
  }

  /**
   * Names a large file without ever holding it, when the vault can stream.
   *
   * The buffered path holds the whole file from the moment it is read until
   * the last chunk has gone, because a wanted chunk is sealed again from the
   * bytes in hand. That is the whole of why a 256 MiB attachment costs most of
   * a gigabyte: not the sending, the holding.
   *
   * With blocks and ranges the file is read twice from disk instead: once to
   * cut and name it, keeping one chunk at a time, and again for the chunks the
   * server actually asks for. Two reads of a disk against most of a gigabyte
   * of memory is not a close trade.
   *
   * Returns undefined when the vault cannot do it, or when the file is small
   * enough that holding it is cheaper than reading it twice. A platform whose
   * resource fetch fails, which the plugin has seen on a phone, is the first
   * case after its first failure.
   */
  private async streamScan(
    entry: IndexEntry,
    path: string,
    knownSize: number | undefined,
  ): Promise<Scanned | undefined> {
    const vault = this.opts.vault;
    if (!vault.readBlocks || !vault.readRange || this.cannotStream) return undefined;
    if (knownSize === undefined || knownSize <= KEEP_SEALED_BELOW) return undefined;

    try {
      return await this.streamed(entry, path, knownSize);
    } catch (err) {
      // A vault that offers these methods and cannot deliver. The Obsidian
      // adapter reaches the file through a URL the webview can fetch, and
      // that is verified on desktop and unverified anywhere else, so a
      // failure here is read as "not on this platform" rather than as a
      // failure of the file.
      //
      // Remembered, because otherwise every large file in the vault would
      // discover it again, one at a time.
      this.cannotStream = true;
      this.log("streaming is not available here, reading whole files instead", path, {
        why: (err as Error).message,
      });
      return undefined;
    }
  }

  private async streamed(entry: IndexEntry, path: string, knownSize: number): Promise<Scanned> {
    const vault = this.opts.vault;
    const isText = this.mergeable(path);
    const names: string[] = [];
    const spans: { start: number; end: number }[] = [];
    let size = 0;

    for await (const piece of chunkStream(
      vault.readBlocks!(path),
      this.sizesFor(knownSize, isText),
      isText,
    )) {
      const sealed = await sealChunks(this.keys, [piece.bytes]);
      names.push(sealed[0]!.name);
      spans.push({ start: piece.offset, end: piece.offset + piece.bytes.length });
      size += piece.bytes.length;
    }

    entry.chunks = names;
    entry.hash = contentId(names);
    entry.size = size;
    return { names, spans, path, size };
  }

  private async act(
    path: string,
    action: Action,
    entry: IndexEntry,
    local: LocalState | undefined,
    remote: Remote | undefined,
    report: SyncReport,
    /** What the rehash read and cut, if this file was just scanned. */
    sealed?: Scanned,
  ): Promise<void> {
    switch (action.kind) {
      case "nothing":
        report.unchanged++;
        // Two sides agreeing *is* a sync: the ancestor moves, or the next
        // divergence would merge against a version neither side has.
        if (local && remote && !remote.deleted) {
          if (local.folder && remote.folder) {
            // A folder has no content to compare, and the two sides spell
            // that differently: "" from the scan, "-empty-" from a batch.
            // Left to the hash comparison below, a folder both devices
            // had before they paired never recorded a sync, and
            // `decideFolder` reads no synctime as "never seen here", so
            // removing it later put it straight back.
            synced(entry, "", [], remote.uid, this.now());
          } else if (local.hash === remote.hash) {
            synced(entry, local.hash, entry.chunks, remote.uid, this.now());
          }
        }
        return;

      case "upload":
        await this.upload(path, entry, report, remote?.uid, true, sealed);
        return;

      case "download":
      case "restoreLocal": {
        if (!remote) return;
        await this.receive(path, entry, remote, action.kind, action.why, report, local);
        return;
      }

      case "createLocalFolder":
        await this.opts.vault.mkdir(path);
        entry.folder = true;
        if (remote) synced(entry, "", [], remote.uid, this.now());
        report.foldersCreated++;
        return;

      case "clash":
        // Written off rather than retried. Trying again cannot help
        // while both devices disagree about what this path is, and the
        // alternative was one direction retrying an impossible mkdir
        // for ever while the other silently ignored the file.
        //
        // Neither side is touched. Renaming somebody's file to admit a
        // folder is a larger intervention than telling them the two
        // disagree, and only they know which they meant. The skip
        // clears by itself once the file changes, which renaming it
        // does.
        this.skipped.set(path, {
          why: `${action.why}. Rename one of them, and it will sync.`,
          fingerprint: fingerprintOf(entry),
        });
        noteSkipped(report, path);
        this.log("cannot be both", path, action.why);
        return;

      case "deleteLocal":
        this.deletingThisPass.add(path);
        // Held until the pass has written everything it is going to.
        //
        // Rule 3 argues for this on its own: never delete until a
        // verified copy exists elsewhere. A move makes it concrete. The
        // old path is deleted and the new one downloaded in the same
        // pass, and deleting first threw away the only local copy of
        // bytes the pass was about to write back, so the file came over
        // the wire instead. Deferring costs nothing and means there is
        // never a moment where neither name holds the note.
        this.pendingDeletes.push({ path, why: action.why, based: local });
        if (local !== undefined && !local.folder) {
          const digest = await this.digestOf(path);
          if (digest !== undefined) this.deleteBaseline.set(path, digest);
        }
        return;

      case "deleteRemote": {
        if (!this.sending) {
          // The one this feature exists for. A mirror that decides a note is
          // gone because its disk was not mounted must not be able to say so.
          this.heldBack(path, report, "this device is read-only, so it was not deleted anywhere");
          return;
        }
        // Fixed once, because it is signed and then sent: calling now()
        // twice would sign one timestamp and send another.
        const deletedAt = this.now();
        const facts: PutFacts = {
          // Under the name the server has, where that is not the name this
          // device uses. A note downloaded from a vault an older Mac
          // client wrote is here under its NFC name and there under an NFD
          // one, and until the rename has gone up those are different files
          // to the server: a deletion sent under the NFC name deletes
          // nothing, and the note stays alive on every device that has not
          // folded it (engine.test.ts, "deletes the note the server has").
          path: await this.sealedPath(remote?.wire ?? path),
          meta: { size: 0, ctime: 0, mtime: deletedAt, deleted: true },
          names: [],
        };
        await this.queue(
          {
            path,
            size: 0,
            entry: { ...facts, ...(await this.authFor(facts, entry.synchash)) },
            bodyOf: noBodies,
            basedOn: remote?.uid,
            commit: (uid) => {
              // Recorded before the entry is forgotten. This
              // device's own writes come back with no payload, so
              // nothing else will ever tell it the deletion
              // happened, and a stale entry here reads on the next
              // pass as a file to download back.
              this.remote.set(path, {
                uid,
                folder: false,
                deleted: true,
                mtime: this.now(),
                size: 0,
                hash: "",
              });
              this.entries.delete(path);
              report.deletedRemotely++;
              this.log("deleted on the server", path, action.why);
            },
          },
          report,
        );
        return;
      }

      case "merge":
        await this.merge(path, entry, remote, report);
        return;

      case "conflict":
        await this.conflict(path, entry, remote, report, action.why);
        return;
    }
  }

  /**
   * Queues a file to go up with the next batch.
   *
   * `count` is whether committing it adds to `report.uploaded`. A merge and a
   * conflict copy both upload, and both are already counted as what they are.
   */
  private async upload(
    path: string,
    entry: IndexEntry,
    report: SyncReport,
    /** The server's version this write answers, as the decision saw it. */
    basedOn: number | undefined,
    count = false,
    /**
     * What the pass already read and cut for this exact content. Passed
     * only where the file has not been touched since: a merge rewrites it,
     * so a merge scans again.
     */
    sealed?: Scanned,
  ): Promise<void> {
    // Here rather than at the decision, because this is the choke point (I29).
    //
    // The first version guarded the `upload` action in the switch above and a
    // conflict copy went up anyway: this has four callers, and the other three
    // are a merge result, a conflict copy and the note beside it. Guarding the
    // one place that sends is the difference between a device that mostly does
    // not send and one that cannot.
    if (!this.sending) {
      this.heldBack(path, report, "this device is read-only, so it was not sent");

      // And the ancestor moves here too, for the same reason the guard is here
      // (RR7, RR9).
      //
      // Sending the local version against `basedOn` is what normally records
      // that this remote version has been dealt with. A device that never sends
      // never records it, so the next pass sees both sides moved since the
      // ancestor, decides the same thing again, and does it again: another
      // conflict copy every pass, or the same merge reported every pass. The
      // first fix put this in `conflict` alone and the successful-merge branch
      // kept the defect, which is exactly the mistake the guard above is here
      // to stop being made once per caller.
      //
      // Only `synchash` and `syncuid` move. `hash` and `chunks` describe the
      // bytes on this disk and saying they were the agreed version would be the
      // "a failed push looks like an agreed state" mistake `synced` warns
      // about, reached from the other side. The local edit therefore stays
      // described as it is, the next pass sees an upload, holds it back and
      // says so, which is true and is a fixed point rather than a loop.
      //
      // Nothing is claimed when the answer is not to a version, or when the
      // server has moved on since the decision was taken: a later version has
      // not been dealt with and must not be recorded as though it had.
      const answered = answeredVersion(basedOn, this.remote.get(path));
      if (answered) reconciled(entry, answered.hash, answered.uid, this.now());
      return;
    }
    if (entry.folder) {
      const facts: PutFacts = {
        path: await this.sealedPath(path),
        meta: { size: 0, ctime: 0, mtime: 0, folder: true },
        names: [],
      };
      await this.queue(
        {
          path,
          size: 0,
          // A folder has no content and so no lineage.
          entry: { ...facts, ...(await this.authFor(facts, "")) },
          bodyOf: noBodies,
          basedOn,
          commit: (uid) => {
            synced(entry, "", [], uid, this.now());
            this.remote.set(path, {
              uid,
              folder: true,
              deleted: false,
              mtime: 0,
              size: 0,
              hash: "",
            });
            if (count) report.uploaded++;
          },
        },
        report,
      );
      return;
    }

    const plan = await this.planUpload(entry, path, sealed);
    // Read now, applied later. `entry` is mutable and the commit runs after
    // the flush, so what gets recorded has to be what actually went up.
    const hash = entry.hash;
    const chunks = [...entry.chunks];
    const size = entry.size;
    const mtime = entry.mtime;

    const facts: PutFacts = {
      path: await this.sealedPath(path),
      meta: {
        size,
        ctime: entry.ctime,
        mtime,
        ...(entry.prev ? { prev: await this.sealedPath(entry.prev) } : {}),
      },
      names: plan.names,
    };

    await this.queue(
      {
        path,
        size,
        // Built on whatever this device last had in sync, which is what lets
        // a receiver tell a new version from a replayed old one.
        entry: { ...facts, ...(await this.authFor(facts, entry.synchash)) },
        bodyOf: plan.bodyOf,
        basedOn,
        commit: (uid) => {
          synced(entry, hash, chunks, uid, this.now());
          // Record what the server now holds, so the next pass sees
          // agreement rather than deciding to upload again.
          this.remote.set(path, {
            uid,
            folder: false,
            deleted: false,
            mtime,
            size,
            hash,
          });
          if (count) report.uploaded++;
          this.log("uploaded", path);
        },
      },
      report,
    );
  }

  /**
   * Adds a write to the outbox, flushing when the batch is full.
   *
   * Three bounds, because they guard different things. The count is the
   * server's, and it is what makes a vault of notes one exchange instead of
   * hundreds. The other two are the server's caps on a batched write, one on
   * the summed ciphertext budget of the entries and one on the encoded frame,
   * and between them they bound this device's memory as well: a queued file
   * pins roughly its own size until the batch goes, either as sealed bodies or
   * as the plaintext its offsets point into, so batching two hundred and
   * fifty-six attachments would otherwise hold all of them at once. Notes
   * batch to the count; attachments flush almost every file, which is what
   * this did before.
   */
  private async queue(q: Queued, report: SyncReport): Promise<void> {
    // Two caps from `ready`, both on the whole batch: the summed ciphertext
    // budget of its entries, and the encoded size of the frame. A write that
    // would take either over the cap goes in the next batch, and one whose
    // own budget is over it goes alone, as a `put`, which the server bounds
    // by the file limit instead. Added regardless, one attachment made one
    // batch of everything, the server refused the batch by bytes, and every
    // note in it was written off for the attachment's size.
    const cap = this.batchCap;
    const budget = entryBudget(q.size, q.entry.names.length);
    const encoded = encodedEntryBytes(q.entry);
    if (
      this.outbox.length > 0 &&
      (budget > cap ||
        this.outboxBudget + budget > cap ||
        this.outboxFrame + encoded > cap - PUTMANY_FRAME_OVERHEAD)
    ) {
      await this.flush(report);
    }
    this.outbox.push(q);
    this.outboxBudget += budget;
    this.outboxFrame += encoded;
    if (
      this.outbox.length >= MAX_BATCH_ENTRIES ||
      this.outboxBudget >= cap ||
      this.outboxFrame >= cap - PUTMANY_FRAME_OVERHEAD
    ) {
      await this.flush(report);
    }
  }

  /**
   * One limit, held to the tighter of what the server asked for and what this
   * device allows.
   *
   * The rule lives here rather than at each guard because it was written out
   * by hand at every guard and one of them was written differently: the
   * outbound size pre-check read the server's raw number and gated on `> 0`,
   * so a server advertising `perFileMax: 0` turned it off. Every reader of a
   * limit goes through this, so the next limit added cannot be added with the
   * fallback forgotten.
   */
  private limitOn(which: keyof typeof OWN_LIMITS): number {
    return boundedBy(this.limits?.[which] ?? 0, OWN_LIMITS[which]);
  }

  /** The batched-write cap this device keeps to: the server's, or its own if smaller. */
  private get batchCap(): number {
    return this.limitOn("maxBatchBytes");
  }

  /** The fetch cap this device keeps to, the same way. */
  private get fetchCap(): number {
    return this.limitOn("maxFetchBytes");
  }

  /**
   * Sends the outbox as one exchange and applies what committed.
   *
   * Nothing here is recorded until the server has said so. An entry it refuses
   * goes through the same failure path a single put's refusal did, and the
   * rest of the batch is unaffected.
   */
  private async flush(report: SyncReport): Promise<void> {
    if (this.outbox.length === 0) return;
    const batch = this.outbox;
    this.outbox = [];
    this.outboxBudget = 0;
    this.outboxFrame = 0;

    // One producer per chunk name. Two notes sharing a chunk means the
    // server asks once, and it must not matter which of them is asked.
    const producers = new Map<string, (name: string) => Promise<Uint8Array>>();
    for (const q of batch) {
      for (const name of q.entry.names) {
        if (!producers.has(name)) producers.set(name, q.bodyOf);
      }
    }

    const bodyOf = async (name: string) => {
      const produce = producers.get(name);
      if (!produce) throw new Error(`server asked for ${name}, which no queued file contains`);
      return produce(name);
    };
    let out;
    try {
      out = await this.transferring(
        "upload",
        batch.filter((q) => q.entry.names.length > 0).map((q) => q.path),
        async (onBytes) => {
          const alone = batch.length === 1 ? batch[0]! : undefined;
          if (
            alone !== undefined &&
            entryBudget(alone.size, alone.entry.names.length) > this.batchCap
          ) {
            // One large file is a `put`, not a batch of one. The server caps a
            // batched write by budget and says so in its refusal: split the
            // batch, and send a file over the limit on its own with put. A
            // single put is bounded only by the per-file limit.
            const { entry } = alone;
            const one = await this.opts.transport.put(
              entry.path,
              entry.meta,
              entry.names,
              bodyOf,
              {
                mac: entry.mac,
                parent: entry.parent,
              },
              onBytes,
            );
            return { results: [{ uid: one.uid }], uploaded: one.uploaded, bytes: one.bytes };
          } else {
            return await this.opts.transport.putMany(
              batch.map((q) => q.entry),
              bodyOf,
              onBytes,
            );
          }
        },
      );
    } catch (err) {
      // The exchange itself failed, so nothing in it committed. Every path
      // in the batch is retried, exactly as it would have been alone.
      for (const q of batch) this.recordFailure(q.path, err, report);
      return;
    }

    report.chunksSent += out.uploaded;
    report.bytesSent += out.bytes;
    for (let i = 0; i < batch.length; i++) {
      const q = batch[i]!;
      const result = out.results[i]!;
      if (result.error) {
        this.recordFailure(q.path, result.error, report);
        continue;
      }
      if (this.remote.get(q.path)?.uid !== q.basedOn) {
        // Another device committed a version of this path between the
        // decision and now. Batches arrive on the transport's own chain, so
        // `remote` moves under a running pass, and the server has just
        // taken this write on top of a version it never saw. Recording it
        // as synced would make the index say both sides agree, and the
        // other device would then download this version cleanly over its
        // own edit, with nothing conflicted and nothing merged: a lost
        // update with a clean report.
        //
        // So nothing is recorded. The index still holds the old ancestor
        // and the remote index the version that arrived, which is exactly
        // the divergence the next pass merges or keeps both halves of. It
        // runs straight away, because a client that syncs once and exits
        // must not exit here.
        report.waiting++;
        this.again = true;
        this.log("another device wrote first, reconciling next pass", q.path, {
          decidedAgainst: q.basedOn ?? "nothing",
          now: this.remote.get(q.path)?.uid,
        });
        continue;
      }
      q.commit(result.uid);
    }
  }

  /**
   * Works out what a file's chunks are called, and how to produce one.
   *
   * The names have to be known before the put is sent, because the server
   * answers with the subset it wants, so a file is chunked and sealed in full
   * either way. What changes is whether the sealed bytes are then *kept*.
   *
   * Keeping them all is what this did, and for a 256 MiB attachment, which is
   * the size the server advertises it will take, it meant 512 MiB live at
   * once: the file and a sealed copy of it. Measured rather than guessed, and
   * on a phone that is not a spike but the end of the process.
   *
   * So above a threshold the bodies are dropped and only their offsets kept,
   * and a wanted chunk is sealed again from the file still in hand. Sealing
   * is deterministic, so the second answer is the first one. It costs the
   * sealing twice for the chunks the server actually asks for, and takes the
   * peak from twice the file to the file plus one chunk.
   *
   * Below the threshold nothing is dropped, because almost every file is a
   * note and re-sealing a note to save a few kilobytes is a worse trade.
   */
  /**
   * Sends the server bodies it has lost, without writing a version (I14).
   *
   * A body can go missing while every row stays exactly as it was: a disk rots
   * one and `basaltd verify` quarantines it, or a restore brings back a
   * database and a chunk tree of slightly different ages. Every device that
   * wants that version then downloads for ever, which presents as a sync that
   * never finishes rather than as an error anybody can act on.
   *
   * Ordinary reconciliation cannot fix it, and that is the point of this
   * method. A device whose copy of the note has not changed considers it
   * synced, because it is: the entry is committed, the hashes agree, and there
   * is nothing for a pass to do. It is holding the missing bytes and has no
   * reason to send them. The only way to make it send them used to be to edit
   * the note, which writes a version nobody typed into the history of a vault
   * that is already damaged.
   *
   * So this offers the server the chunk names of everything this device holds,
   * lets the server say which of them it actually lacks, and produces only
   * those, from the files on this disk. Nothing about any entry changes.
   *
   * What this cannot see is said out loud rather than implied away. A body
   * belonging to a version this device never had is not on this disk and is not
   * in this index: nothing here could notice it is gone. `couldNotOffer` is the
   * one kind of "cannot help" a device can see for itself, a note whose local
   * copy has moved on from what the server acknowledged. The authoritative list
   * of what a vault still lacks is `basaltd verify` on the server, and both
   * shells say so, because a clean repair here is not the same claim as a whole
   * vault and reporting it as one would be the comfortable lie.
   */
  async repair(): Promise<RepairReport> {
    const report: RepairReport = {
      scanned: 0,
      offered: 0,
      stored: 0,
      couldNotOffer: 0,
      stillMissing: 0,
      failed: [],
    };

    // One path at a time. The names could be offered all at once, and then a
    // wanted body would have to be traced back to the file that can make it;
    // per path the answer is already in hand, and a file that has changed under
    // us costs one path rather than the run.
    for (const [path, entry] of [...this.entries]) {
      if (entry.folder || entry.chunks.length === 0) continue;
      report.scanned++;

      // Only what this device can prove it holds. `synchash` is the content the
      // server acknowledged; if the local file has moved on, its chunks are not
      // the ones the server is missing, and offering them would be an offer
      // this device cannot keep.
      const names = entry.chunks;
      if (entry.hash !== entry.synchash) {
        report.couldNotOffer += names.length;
        continue;
      }

      try {
        const plan = await this.planUpload(entry, path);
        // The scan has to agree with the index, or the file changed since the
        // last sync and these are not the bodies the server wants.
        if (plan.names.length !== names.length || plan.names.some((n, i) => n !== names[i])) {
          report.couldNotOffer += names.length;
          continue;
        }
        report.offered += names.length;
        const out = await this.opts.transport.resend(names, plan.bodyOf);
        report.stored += out.stored;
        report.stillMissing += out.missing;
      } catch (err) {
        // One path's failure is one path. A repair run is somebody acting on a
        // vault that is already damaged, and stopping at the first file it
        // could not read would leave the rest unrepaired with no list of what
        // was skipped.
        report.failed.push({ path, why: (err as Error).message });
      }
    }
    return report;
  }

  private async planUpload(entry: IndexEntry, path: string, fresh?: Scanned): Promise<UploadPlan> {
    // The scan that decided this file changed already read it, cut it and
    // sealed it. Doing that again was the single largest cost of sending a
    // large attachment: a 64 MiB file was read twice, chunked twice and
    // sealed twice, and the garbage from both passes was live at once.
    // Read and cut here when the caller had no fresh scan to hand over. A
    // merge and a conflict copy both rewrite the file before uploading it, so
    // whatever the pass scanned is stale by the time they are done.
    const scan = fresh ?? (await this.rehash(entry, path));

    if (scan.sealed) {
      const byName = new Map(scan.sealed.map((c) => [c.name, c.bytes]));
      return {
        names: scan.names,
        bodyOf: async (name) => {
          const body = byName.get(name);
          if (!body) throw new Error(`no sealed body for ${name} of ${path}`);
          return body;
        },
      };
    }

    // Offsets only, for a file too large to hold sealed. A wanted chunk is
    // sealed again, which is deterministic and so gives back exactly what
    // was named: either from the bytes still in hand, or by reading the
    // range back off the disk if the file was never held at all.
    const keys = this.keys;
    const vault = this.opts.vault;

    if (scan.spans) {
      const spanOf = new Map(scan.names.map((name, i) => [name, scan.spans[i]!]));
      return {
        names: scan.names,
        bodyOf: async (name) => {
          const span = spanOf.get(name);
          if (!span) throw new Error(`no chunk named ${name} in ${path}`);
          const range = await vault.readRange!(scan.path, span.start, span.end);
          const again = await sealChunks(keys, [range]);
          // Checked against the name it was promised under. The file
          // was read to name it and is being read again to send it,
          // so an edit in between would otherwise put bytes on the
          // wire under a name that is not theirs. The server would
          // catch that and end the session; caught here it is one
          // file to try again next pass.
          if (again[0]!.name !== name) {
            throw new Error(`${path} changed while it was being sent, so it was not sent`);
          }
          return again[0]!.bytes;
        },
      };
    }

    const spanOf = new Map<string, { start: number; end: number }>();
    for (let i = 0; i < scan.names.length; i++) {
      const piece = scan.pieces[i]!;
      spanOf.set(scan.names[i]!, { start: piece.offset, end: piece.offset + piece.bytes.length });
    }
    const bytes = scan.bytes;
    return {
      names: scan.names,
      bodyOf: async (name) => {
        const span = spanOf.get(name);
        if (!span) throw new Error(`no chunk named ${name} in ${path}`);
        const again = await sealChunks(keys, [bytes.subarray(span.start, span.end)]);
        return again[0]!.bytes;
      },
    };
  }

  /**
   * Queues a version to come down with the next fetch.
   *
   * A download was one round trip, which for two hundred notes was two
   * hundred of them, and on a slow link that was most of the sync. The chunk
   * names are already known, because the batch that announced the version
   * carried them, so many files' names can go up in one ask and their bodies
   * come back in one stream.
   */
  private async receive(
    path: string,
    entry: IndexEntry,
    remote: RemoteState,
    kind: "download" | "restoreLocal",
    why: string,
    report: SyncReport,
    based: LocalState | undefined,
  ): Promise<void> {
    const chunks = chunkNamesOf(remote.hash);
    this.checkChunkCount(remote.uid, chunks.length);

    const baseDigest = based === undefined || based.folder ? undefined : await this.digestOf(path);
    this.inbox.push({ path, entry, remote, chunks, kind, why, based, baseDigest });
    this.inboxBytes += remote.size;
    if (this.inbox.length >= MAX_BATCH_ENTRIES || this.inboxBytes >= INBOX_BYTES) {
      await this.fill(report);
    }
  }

  /**
   * Fetches every queued version's chunks in one ask and writes the files.
   *
   * The names are deduplicated across the batch, so two notes that share a
   * chunk cost one body, and a file whose chunks the server cannot serve
   * fails alone rather than taking the batch with it.
   */
  private async fill(report: SyncReport): Promise<void> {
    if (this.inbox.length === 0) return;
    const batch = this.refuseAliases(this.inbox, report);
    this.inbox = [];
    this.inboxBytes = 0;
    if (batch.length === 0) return;

    // Bytes this device already holds are not worth asking for again.
    //
    // A move is the case that matters. Chunk names are hashes of
    // ciphertext, so moving a file costs the sender nothing: the server
    // already has every chunk and only metadata travels. The receiver had
    // no such luck, and downloaded the whole file back over a name it was
    // already storing under. Moving one folder of attachments re-pulled all
    // of it, on every other device.
    const local = new Map<Incoming, string>();
    const byContent = this.heldByContent();
    for (const d of batch) {
      const from = byContent.get(contentId(d.chunks));
      if (from !== undefined && from !== d.path) local.set(d, from);
    }

    const wanted: string[] = [];
    const budgets = new Map<string, number>();
    for (const d of batch) {
      if (local.has(d)) continue;
      const each = perChunkBudget(d.remote.size, d.chunks.length);
      for (const name of d.chunks) {
        const known = budgets.get(name);
        if (known === undefined) wanted.push(name);
        // A chunk two files share is fetched once, and costed at the larger
        // of the two guesses, which is never under what it is.
        if (known === undefined || each > known) budgets.set(name, each);
      }
    }

    const held = new Map<string, Uint8Array>();
    if (wanted.length > 0) {
      try {
        const bodies = await this.fetchAll(
          wanted,
          (name) => budgets.get(name)!,
          batch.filter((d) => !local.has(d)).map((d) => d.path),
        );
        for (let i = 0; i < wanted.length; i++) held.set(wanted[i]!, bodies[i]!);
      } catch (err) {
        // The fetch failed, so no file in it arrived. Each is retried,
        // exactly as it would have been on its own.
        for (const d of batch) this.recordFailure(d.path, err, report);
        return;
      }
    }

    for (const d of batch) {
      try {
        const from = local.get(d);
        const reused = from === undefined ? "ask" : await this.landFromLocal(d, from, report);
        if (reused === "landed") {
          if (d.kind === "download") report.downloaded++;
          else report.restored++;
          this.log(d.kind, d.path, `${d.why}, from ${from} without asking`);
          continue;
        }
        // Written, over somebody's edit, and that edit is beside the note.
        // Counted by `writePreserving` as a conflict and not as a download,
        // and finished: asking the server for bytes already on the disk
        // would only displace them again.
        if (reused === "kept") continue;
        const wrote =
          from !== undefined
            ? // The local copy did not prove out, so ask for it after all.
              // Rare, and it costs one extra round trip rather than a file.
              await this.land(d, await this.fetchFor(d), report)
            : await this.land(d, held, report);
        // Counted only when it happened. A conflict copy is not a download,
        // and reporting one is the kind of true-sounding status rule 7 is
        // about: the incoming version is on this disk either way, but under
        // a different name and with the local file untouched.
        if (!wrote) continue;
        if (d.kind === "download") report.downloaded++;
        else report.restored++;
        this.log(d.kind, d.path, d.why);
      } catch (err) {
        this.recordFailure(d.path, err, report);
      }
    }
  }

  /** Local paths as the disk files them, from this pass's listing. */
  private localByIdentity = new Map<string, string>();
  /** Paths this pass has decided to delete locally, which cannot collide with a write. */
  private deletingThisPass = new Set<string>();

  /** What the disk will file a path under. The vault knows; otherwise the safe guess. */
  private identity(path: string): string {
    return this.opts.vault.canonical ? this.opts.vault.canonical(path) : foldPath(path);
  }

  /**
   * Drops incoming versions that would be filed as one local file.
   *
   * Two distinct paths on the server, `Note.md` and `note.md`, or one name in
   * NFC and NFD, are one file on a disk that folds them. Written in turn, the
   * second replaced the first, both were recorded as synced, and the next scan
   * found the first missing and reported it deleted to every other device.
   * That is not a move, which the case-only rename protection covers; it is
   * two notes, and one of them was lost.
   *
   * Neither is written. Both are named, because only a person can say which
   * spelling they meant, and the refusal clears itself the moment one of them
   * is renamed on the device that has both. A path this pass is deleting is
   * not in the way: that is the rename case, and it goes through as before.
   */
  private refuseAliases(batch: Incoming[], report: SyncReport): Incoming[] {
    const byIdentity = new Map<string, Incoming[]>();
    for (const d of batch) {
      const key = this.identity(d.path);
      const same = byIdentity.get(key) ?? [];
      same.push(d);
      byIdentity.set(key, same);
    }
    const kept: Incoming[] = [];
    for (const [key, group] of byIdentity) {
      const local = this.localByIdentity.get(key);
      const localInTheWay =
        local !== undefined &&
        !this.deletingThisPass.has(local) &&
        group.some((d) => d.path !== local);
      if (!localInTheWay && group.length === 1) {
        kept.push(group[0]!);
        continue;
      }
      for (const d of group) {
        const other = localInTheWay ? local! : group.find((g) => g.path !== d.path)!.path;
        report.blocked++;
        if (report.inTheWay.length < IN_THE_WAY_SHOWN) {
          report.inTheWay.push({ path: d.path, blockedBy: other });
        }
        if (!this.blocked.has(d.path)) {
          this.log("cannot be both", d.path, `${other} is the same file on this disk`);
        }
        this.nowBlocked.add(d.path);
      }
    }
    return kept;
  }

  /**
   * The local deletions this pass decided on, applied once its writes are done.
   *
   * A path is either deleted or written in one pass, never both, because
   * `decide` returns one action for it. That is true of paths and was taken to
   * be true of files, and it is not: rename `Note.md` to `NOTE.md` and the
   * other device is told to write one and delete the other, which on macOS or
   * Windows is one file. It wrote the note and then deleted it, reported the
   * deletion back, and the server agreed the note was gone. Nothing on that
   * device was left to notice.
   *
   * So the writes are remembered, and a deletion naming a file one of them
   * produced is refused. Rule 3 in its smallest form: not "the path is
   * different" but "the file is a different file".
   */
  private pendingDeletes: { path: string; why: string; based: LocalState | undefined }[] = [];
  /**
   * The digest each pending deletion was decided about, taken when it was
   * decided (R01).
   *
   * Kept beside `pendingDeletes` rather than in it so that the read happens
   * once, at the moment the decision is recorded, and not again at the end of
   * the pass when it would describe whatever the editor had done since.
   */
  private deleteBaseline = new Map<string, string>();
  private wroteThisPass: string[] = [];

  /**
   * Whether removing `path` would remove something this pass wrote.
   *
   * The vault answers where it can, because the filesystem is the only thing
   * that actually knows. Where it cannot, two paths equal under case folding
   * are treated as one file, which keeps the note.
   *
   * `sure` is which of the two answered. The fallback keeps the note and does
   * not converge: on a disk that does keep the two spellings apart, the
   * deletion is refused again on every pass, for ever, and the caller reports
   * that rather than returning a clean report over a vault that never settles.
   */
  private async wouldUndoAWrite(
    path: string,
  ): Promise<{ wrote: string; sure: boolean } | undefined> {
    const vault = this.opts.vault;
    for (const wrote of this.wroteThisPass) {
      if (wrote === path) continue;
      if (vault.sameFile) {
        if (await vault.sameFile(wrote, path)) return { wrote, sure: true };
        continue;
      }
      if (foldsTogether(wrote, path)) return { wrote, sure: false };
    }
    return undefined;
  }

  private async applyDeletes(report: SyncReport): Promise<void> {
    const deletes = this.pendingDeletes;
    this.pendingDeletes = [];
    // Drained with them, so a digest never outlives the pass that took it and
    // a later deletion of the same path cannot be checked against a baseline
    // from an earlier one.
    const baselines = this.deleteBaseline;
    this.deleteBaseline = new Map();
    for (const { path, why, based } of deletes) {
      try {
        const same = await this.wouldUndoAWrite(path);
        if (same !== undefined) {
          // Not a failure and not retried: the file is where it should be,
          // under the name the server asked for. Only the deletion of its old
          // name has nowhere to land, because that name was never a second
          // file here.
          this.entries.delete(path);
          if (same.sure) {
            this.log(
              "kept",
              path,
              `deleting it would remove ${same.wrote}, which is the same file`,
            );
            continue;
          }
          // Guessed from the spelling, because this vault cannot say. The
          // note is kept, which is the right side to err on, and it is
          // counted, because on a disk that holds both spellings the
          // deletion comes back every pass and never lands: a report that
          // said nothing happened described a vault that never settles.
          report.blocked++;
          if (report.inTheWay.length < IN_THE_WAY_SHOWN) {
            report.inTheWay.push({ path, blockedBy: same.wrote });
          }
          this.log(
            "kept",
            path,
            `deleting it might remove ${same.wrote}, and this vault cannot say whether they are one file`,
          );
          continue;
        }
        // An incoming deletion removes bytes, so it asks the same question
        // the landing paths do (F01). A file edited since the pass decided
        // to delete it holds work the server has never seen, and the
        // deletion is about the version that is gone, not about this one.
        if (!(await this.unchangedSince(path, based))) {
          report.waiting++;
          this.again = true;
          this.log("kept", path, {
            why: "it changed after the pass decided to delete it",
            deletion: why,
          });
          continue;
        }
        // And the removal preserves too, for the same reason the write does
        // (R01): the check above compares metadata, and an edit that keeps the
        // length is invisible to it. `removeExpecting` says whether what it
        // took away was the version this decided about, and hands it back when
        // it was not.
        const keptAt = await this.removedSomethingElse(path, based, baselines);
        if (keptAt !== undefined) {
          this.log("kept what was about to be deleted", path, {
            why: "it changed after the pass decided to delete it",
            deletion: why,
            keptAt,
          });
          this.landed(keptAt);
          report.conflicted++;
          this.entries.delete(path);
          continue;
        }
        this.entries.delete(path);
        report.deletedLocally++;
        this.log("deleted locally", path, why);
      } catch (err) {
        this.recordFailure(path, err, report);
      }
    }
  }

  /**
   * Records a write this pass made, for the two checks that read it.
   *
   * `wroteThisPass` is for the deletions applied at the end of the pass.
   * `localByIdentity` is for the alias check in every later fill of this
   * pass: it was built from the listing at the start and never updated, so a
   * second spelling of a file the first fill had just landed was not "in the
   * way" of anything and landed over it.
   */
  private landed(path: string): void {
    this.wroteThisPass.push(path);
    this.localByIdentity.set(this.identity(path), path);
  }

  /** Every path this device holds, by the content it holds, newest wins. */
  private heldByContent(): Map<string, string> {
    const by = new Map<string, string>();
    for (const [path, entry] of this.entries) {
      if (entry.folder || entry.hash === "" || entry.hash === "-empty-") continue;
      by.set(entry.hash, path);
    }
    return by;
  }

  /** The chunks for one entry, asked for on their own. */
  private async fetchFor(d: Incoming): Promise<Map<string, Uint8Array>> {
    const each = perChunkBudget(d.remote.size, d.chunks.length);
    const bodies = await this.fetchAll([...d.chunks], () => each, [d.path]);
    const held = new Map<string, Uint8Array>();
    d.chunks.forEach((name, i) => held.set(name, bodies[i]!));
    return held;
  }

  /**
   * Fetches a list of chunks in as many asks as the server's caps require.
   *
   * One `fetch` may carry at most `maxFetchBytes` of summed budget and at
   * most 65536 names, and the server refuses more with `toolarge` and no
   * bodies. This device does not know the stored size of a chunk it has not
   * got, so it costs each at its share of the file's declared size plus the
   * sealing allowance, which is what the server's own budget rule allows and
   * is never under the truth. The bodies come back in the order asked, across
   * every ask.
   */
  private async fetchAll(
    names: readonly string[],
    budgetOf: (name: string) => number,
    paths: readonly string[] = [],
  ): Promise<Uint8Array[]> {
    // History previews call this without paths: they are not a sync pass and
    // must not leave the vault's sync status busy after the preview closes.
    return this.transferring("download", paths, async (onBytes) => {
      const out: Uint8Array[] = [];
      let received = 0;
      for (const ask of planFetches(names, budgetOf, this.fetchCap, MAX_FETCH_NAMES)) {
        const bodies = await this.opts.transport.fetch(
          ask,
          onBytes === undefined ? undefined : (n) => onBytes(received + n),
        );
        for (const b of bodies) {
          out.push(b);
          received += b.length;
        }
      }
      return out;
    });
  }

  private async transferring<T>(
    direction: TransferActivity["direction"],
    paths: readonly string[],
    work: (onBytes: ((bytes: number) => void) | undefined) => Promise<T>,
  ): Promise<T> {
    if (paths.length === 0 || this.opts.onTransfer === undefined) return work(undefined);
    const details = {
      direction,
      files: paths.length,
      ...(paths.length === 1 ? { path: paths[0]! } : {}),
    };
    const progress = (bytes: number) => notifyTransfer(this.opts.onTransfer, { ...details, bytes });
    progress(0);
    try {
      return await work(progress);
    } finally {
      notifyTransfer(this.opts.onTransfer, undefined);
    }
  }

  /**
   * Writes a version from a copy this device already has, or declines to.
   *
   * Declining is the important half. The index says this path holds that
   * content, and the index can be out of date: the file may have been edited
   * between the scan and here. So the bytes are re-chunked and re-sealed and
   * the names compared, which is exact rather than trusting: sealing is
   * deterministic, so identical content gives identical names, and that is
   * the same property deduplication is built on.
   *
   * A false negative costs one round trip, which is what the old code did
   * every time. A false positive would write the wrong bytes into somebody's
   * note, so there is no version of this worth guessing at.
   *
   * Three answers, not two. "ask" is the false negative above, and the caller
   * fetches. "kept" is the write having happened and having displaced
   * somebody's edit, which is finished business: reading it as "ask" sent the
   * pass round again to write the same bytes over the version it had just
   * put there, and made a second conflict copy holding the server's own text.
   */
  private async landFromLocal(
    d: Incoming,
    from: string,
    report: SyncReport,
  ): Promise<"landed" | "kept" | "ask"> {
    let bytes: Uint8Array;
    try {
      bytes = await this.opts.vault.read(from);
    } catch {
      return "ask";
    }
    if (bytes.length !== d.remote.size) return "ask";

    const isText = this.mergeable(from);
    const parts = [...chunkBytes(bytes, this.sizesFor(bytes.length, isText), isText)].map(
      (c) => c.bytes,
    );
    const names = (await sealChunks(this.keys, parts)).map((c) => c.name);
    if (contentId(names) !== contentId(d.chunks)) return "ask";

    // The same check as `land`, for the same reason: this writes over
    // `d.path` too, and finding the bytes on this disk rather than on the
    // wire does not make the destination any less somebody's open note.
    if (!(await this.unchangedSince(d.path, d.based))) return "ask";

    // And the same preserving write (R19). This path used to call
    // `vault.write` straight after the stat, so a version rebuilt from chunks
    // this device already had overwrote an edit that the stat could not see,
    // while the identical download beside it kept one.
    if (
      await this.writePreserving(
        d.path,
        this.expecting(d.baseDigest),
        bytes,
        { mtime: d.remote.mtime, ctime: d.remote.mtime },
        report,
      )
    ) {
      return "kept";
    }
    this.landed(d.path);
    observe(d.entry, {
      folder: false,
      mtime: d.remote.mtime,
      ctime: d.remote.mtime,
      size: bytes.length,
    });
    d.entry.chunks = [...d.chunks];
    d.entry.hash = contentId(d.chunks);
    d.entry.size = bytes.length;
    synced(d.entry, d.entry.hash, d.entry.chunks, d.remote.uid, this.now());
    return "landed";
  }

  /**
   * Whether this path still holds the file the pass decided about (F01).
   *
   * A pass scans, decides, fetches, and only then writes. The fetch is the
   * whole of a slow link and the editor is in use throughout it, so by the
   * time the bytes arrive the note underneath may be somebody's unsaved
   * paragraph. Overwriting it loses work no other device has ever seen,
   * which is rule 1, and a report that says "downloaded 1" while it happens
   * is rule 7 as well.
   *
   * Compared against `LocalState`, whose mtime and size came from the scan
   * that informed the decision, so `Math.ceil` is applied here to match what
   * `observe` stored. Absent means absent on both sides: a note created
   * under the path during the fetch is a change, not an empty slot.
   *
   * **What this does not close.** A write landing between this stat and the
   * write below is still undetected; no adapter here offers a
   * compare-and-swap, and Obsidian's offers no locking at all. The window
   * goes from the length of a fetch to the length of one stat, which is the
   * difference between "happens on a slow link" and "happens if you hit a
   * microsecond". docs/design.md, "What is not claimed", says so.
   */
  /**
   * The plaintext digest of what is at a path now, or undefined if it cannot
   * be read (R01).
   *
   * Streamed where the vault can, so digesting a large attachment costs one
   * pass over it and not a copy of it in memory. A vault that cannot stream
   * reads it whole, which is what the pass was about to do anyway.
   */
  private async digestOf(path: string): Promise<string | undefined> {
    // The vault's own, where it has one (R31).
    //
    // This used to collect every block the vault streamed and then allocate a
    // second buffer of the whole file to join them into, which holds a large
    // attachment twice over and does it on the path that queues a download.
    // The comment called it streaming; it was not. A vault that can hash as it
    // reads keeps nothing, and the headless one can.
    const streamed = this.opts.vault.contentDigest;
    if (streamed !== undefined) return await streamed(path);
    try {
      return await plainDigest(await this.opts.vault.read(path));
    } catch {
      // A file that cannot be read is one this cannot make a promise about.
      // Undefined means "no baseline", and every caller treats that as a
      // reason to keep whatever it finds rather than to overwrite it.
      return undefined;
    }
  }

  /**
   * What the adapter should compare against, or undefined when there is no
   * baseline to compare with.
   */
  private expecting(digest: string | undefined): ExpectedContent | undefined {
    return digest === undefined ? undefined : { contentId: digest, idOf: plainDigest };
  }

  /**
   * Writes over a path, keeping anything it displaces that this pass did not
   * decide about (R01, R18, R19).
   *
   * The one door every destructive landing goes through: an ordinary download,
   * a version rebuilt from chunks this device already had, and a merge. Two of
   * those still called `vault.write` after a stat, which is the check this
   * whole mechanism exists because it is not enough.
   *
   * Returns true when something was preserved or the write did not land. Both
   * mean the incoming version is not simply in place, so the caller must not
   * record it as synced.
   *
   * A vault with no `replace` falls back to the plain write, guarded only by
   * the stat, which is what every vault had before.
   */
  private async writePreserving(
    path: string,
    expect: ExpectedContent | undefined,
    content: Uint8Array,
    times: Times,
    report: SyncReport,
  ): Promise<boolean> {
    const vault = this.opts.vault;
    if (vault.replace === undefined) {
      await vault.write(path, content, times);
      return false;
    }
    // The name a displaced version will take, worked out here because conflict
    // naming is the engine's and a name a person recognises is the point of
    // it. A sibling, so the adapter's move onto it is a rename inside one
    // directory.
    const keepAt = await this.freeConflictPath(path);
    const out = await vault.replace(path, expect, content, times, keepAt);

    if (out.keptAt !== undefined) {
      // On the disk already, under a name of its own. Nothing here has to
      // write it down, which is the difference between this and handing back
      // a buffer: no failure between the adapter and here can lose it (R18).
      this.log("kept what was already there", path, {
        why: "it changed while its next version was being fetched",
        keptAt: out.keptAt,
      });
      this.landed(out.keptAt);
      report.conflicted++;
    }
    if (!out.landed) {
      // Something else took the name in the instant it was free, and it is
      // newer than this decision. The incoming version needs a home of its own
      // rather than being dropped.
      //
      // Through `placeBeside`, like every other copy this puts next to a note.
      // It claims the name with `create` and looks again if that is refused,
      // where this branch used to pick a free name and then `write` it: the
      // same choose-then-truncate the adapters spent two rounds of review
      // having removed, reintroduced one level up in the code that handles
      // their answer.
      const beside = await placeBeside(() => this.freeConflictPath(path), content, times, vault);
      this.landed(beside);
      this.log("kept the incoming version beside", path, { at: beside });
      if (out.keptAt === undefined) report.conflicted++;
    }
    return out.keptAt !== undefined || !out.landed;
  }

  /**
   * Removes a path, and returns what it took away when that was not the
   * version the pass decided to delete (R01).
   *
   * The baseline is read here rather than carried from the scan, because a
   * deletion has no fetch in front of it: the gap this closes is between the
   * scan that listed the file and the removal at the end of the pass, and a
   * digest taken now would be taken after that gap rather than before it. So
   * the digest of record is the one from the listing where there is one, and
   * where there is not, the removal simply reports what it took.
   */
  private async removedSomethingElse(
    path: string,
    based: LocalState | undefined,
    baselines: ReadonlyMap<string, string>,
  ): Promise<string | undefined> {
    const vault = this.opts.vault;
    const digest = based === undefined || based.folder ? undefined : baselines.get(path);
    if (vault.removeExpecting === undefined) {
      await vault.remove(path);
      return undefined;
    }
    // A missing baseline is a reason to look, not a reason to skip looking
    // (R33). It used to send the deletion straight to `remove`, which takes
    // whatever is at the name: the one case R33 names, a baseline that could
    // not be read, was the one case the preserving removal was not used, and
    // the pass reported it as an ordinary deletion rather than as a conflict.
    // A folder has no baseline either and is not a thing an editor rewrites,
    // but the adapter keeps what it finds and that costs nothing.
    const keepAt = await this.freeConflictPath(path);
    const out = await vault.removeExpecting(path, this.expecting(digest), keepAt);
    return out.keptAt;
  }

  private async unchangedSince(path: string, based: LocalState | undefined): Promise<boolean> {
    let now: FileStat | undefined;
    try {
      now = await this.opts.vault.stat(path);
    } catch {
      // A vault that cannot answer is a vault that cannot promise the file is
      // untouched, so this reads as changed and both copies are kept.
      return false;
    }
    if (based === undefined) {
      if (now === undefined) return true;
      // Something is at a path the scan did not list under this name. On a
      // case-folding disk that is routinely this pass's own rename: the scan
      // listed `Note.md`, the server asked for `NOTE.md`, and a stat for the
      // second finds the first because they are one file. Writing over it is
      // the rename, not a stranger's edit, and the old name's deletion at the
      // end of the pass is what completes it.
      //
      // Anything else at an unlisted path is a file that appeared during the
      // fetch, which is the case this guard is for.
      const known = this.localByIdentity.get(this.identity(path));
      return known !== undefined && this.deletingThisPass.has(known);
    }
    if (now === undefined) return false;
    if (now.folder !== based.folder) return false;
    if (now.folder) return true;
    return now.size === based.size && Math.ceil(now.mtime) === based.mtime;
  }

  /**
   * Keeps both when the file changed under a decision already taken (F01).
   *
   * The incoming version goes beside the note rather than over it, which is
   * what `conflict` already does for a divergence the scan saw. This is the
   * same divergence, noticed later.
   */
  private async landedOnAChangedFile(
    d: Incoming,
    content: Uint8Array,
    report: SyncReport,
  ): Promise<void> {
    this.log("kept the local copy", d.path, {
      why: "it changed while its next version was being fetched",
      version: d.remote.uid,
    });
    // The entry is re-read from disk on the next pass, and must not claim the
    // scan's stale shape in the meantime.
    const entry = this.entryFor(d.path);
    await this.conflict(d.path, entry, d.remote, report, "changed during the fetch", content);
  }

  /**
   * Writes one queued version from bodies already in hand.
   *
   * False when it wrote nothing because the file changed under the decision,
   * so the caller counts a conflict rather than a download it did not do.
   */
  private async land(
    d: Incoming,
    held: Map<string, Uint8Array>,
    report: SyncReport,
  ): Promise<boolean> {
    const bodies = d.chunks.map((name) => {
      const body = held.get(name);
      if (!body) throw new Error(`the server did not send ${name}, which ${d.path} is made of`);
      return body;
    });
    const content = await this.assemble(d.remote.uid, bodies);
    // The declared size is the count of the bytes that were chunked, so this
    // is exact rather than approximate, and a mismatch means the chunk list
    // is not the one that file was made of. Checked here as well as on
    // arrival because this is the line that overwrites somebody's note.
    if (content.length !== d.remote.size) {
      throw new Error(
        `version ${d.remote.uid} of ${d.path} assembled to ${content.length} bytes, not the ${d.remote.size} it declares`,
      );
    }

    // The last thing before the bytes go down (F01).
    if (!(await this.unchangedSince(d.path, d.based))) {
      await this.landedOnAChangedFile(d, content, report);
      return false;
    }

    // And then the write itself preserves, because the check above cannot be
    // made exact (R01). A stat compares length and a rounded timestamp, which
    // is what an ordinary correction leaves alone, and there is no
    // compare-and-swap on a file to close the gap between the check and the
    // write. So the adapter moves whatever is there aside before writing over
    // it and hands back anything that was not what this decided about.
    if (
      await this.writePreserving(
        d.path,
        this.expecting(d.baseDigest),
        content,
        { mtime: d.remote.mtime, ctime: d.remote.mtime },
        report,
      )
    ) {
      return false;
    }
    this.landed(d.path);
    observe(d.entry, {
      folder: false,
      mtime: d.remote.mtime,
      ctime: d.remote.mtime,
      size: content.length,
    });
    // The chunk list is the server's, so the cache is filled without
    // re-chunking what was just reassembled, and without asking again.
    d.entry.chunks = [...d.chunks];
    d.entry.hash = contentId(d.chunks);
    d.entry.size = content.length;
    synced(d.entry, d.entry.hash, d.entry.chunks, d.remote.uid, this.now());
    return true;
  }

  /**
   * Downloads and reassembles one version's plaintext.
   *
   * Public because recovery needs it: restoring an old version is fetching
   * its content and writing it back, and there is no reason for a second copy
   * of the reassembly to exist for that.
   */
  async contentOf(uid: number, expected?: string, signedSize?: number): Promise<Uint8Array> {
    const meta = await this.opts.transport.get(uid);
    // `expected` is a content id the caller already holds for this uid, and
    // the one that matters is the merge ancestor's. A three-way merge
    // decides which side's changes are already present, so whoever chooses
    // the base chooses what can be dropped: a base equal to the local file
    // plus some paragraphs makes those paragraphs look deleted by the other
    // side, and mergeText then drops them cleanly, writes the result and
    // uploads it. No conflict copy, one counted merge, and the shortened
    // text becomes canonical everywhere.
    //
    // `entry.synchash` is this device's own record of the ancestor from the
    // last completed sync, so the server cannot move it. That is what makes
    // this check worth anything; comparing an incoming version against the
    // hash the same server announced a moment ago only catches it
    // contradicting itself.
    if (expected !== undefined && contentId(meta.chunks) !== expected) {
      throw new Error(
        `version ${uid} is made of chunks this device did not record for it, ` +
          `so it is not the version it is being offered as`,
      );
    }
    // The size, the same way, which this did not check at all. `land` does
    // (an assembled file must match its declared size) and the restore path
    // is the one that writes into somebody's vault on the worst afternoon.
    //
    // Substituted bodies are not the hole here: `fetch` hashes every body
    // against the name it asked for, so a server cannot answer one name with
    // another chunk's bytes. What this catches is an entry that contradicts
    // itself, from a signing bug or a corrupt row: 500 bytes made of chunks
    // holding five restored as five bytes and said nothing.
    //
    // `signedSize` is the size off an entry whose authenticator this device
    // checked, where the caller has one; `meta.size` is the server's own word
    // for the same number, which it is free to choose. Where both exist they
    // have to agree, and the signed one is what the assembly is held to.
    if (signedSize !== undefined && signedSize !== meta.size) {
      throw new Error(
        `version ${uid} is offered as ${meta.size} bytes and was signed as ${signedSize} bytes`,
      );
    }
    const declared = signedSize ?? meta.size;
    if (meta.chunks.length === 0) {
      if (declared !== 0) {
        throw new Error(
          `version ${uid} declares ${declared} bytes and names no chunks, which cannot both be true`,
        );
      }
      return new Uint8Array(0);
    }
    this.checkChunkCount(uid, meta.chunks.length);
    const each = perChunkBudget(meta.size, meta.chunks.length);
    const content = await this.assemble(uid, await this.fetchAll(meta.chunks, () => each));
    if (content.length !== declared) {
      throw new Error(
        `version ${uid} assembled to ${content.length} bytes, not the ${declared} it declares`,
      );
    }
    return content;
  }

  /**
   * Held to what the server itself advertised. Both of these are the server's
   * own numbers, so refusing past them is not a policy of this client's, it is
   * declining to be told two different things.
   */
  private checkChunkCount(uid: number, count: number): void {
    const maxChunks = this.limitOn("maxChunks");
    if (count > maxChunks) {
      throw new Error(
        `version ${uid} names ${count} chunks, and this server said it stores at most ${maxChunks}`,
      );
    }
  }

  /** Opens sealed bodies in order and joins the plaintext. */
  private async assemble(uid: number, bodies: readonly Uint8Array[]): Promise<Uint8Array> {
    if (bodies.length === 0) return new Uint8Array(0);
    const opened: Uint8Array[] = [];
    let total = 0;
    const perFileMax = this.limitOn("perFileMax");
    // A window at a time, for the reason sealChunks takes one: opening is
    // mostly waiting on WebCrypto, and one at a time leaves it idle. The
    // window is what keeps a large file from holding every opened chunk at
    // once.
    for (let at = 0; at < bodies.length; at += SEAL_WINDOW) {
      const window = await Promise.all(
        bodies.slice(at, at + SEAL_WINDOW).map((b) => openChunk(this.keys, b)),
      );
      for (const part of window) {
        total += part.length;
        if (total > perFileMax) {
          throw new Error(
            `version ${uid} is over ${total} bytes, and this server said it stores at most ${perFileMax}`,
          );
        }
        opened.push(part);
      }
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const b of opened) {
      out.set(b, at);
      at += b.length;
    }
    return out;
  }

  private async merge(
    path: string,
    entry: IndexEntry,
    remote: RemoteState | undefined,
    report: SyncReport,
  ): Promise<void> {
    if (!remote) return;

    // Turned off, so this is a conflict without looking at the bytes (I30).
    //
    // Before the decode and before the ancestor is fetched, because neither is
    // worth doing to reach a decision already made, and because the reason a
    // person reads should be the one they chose rather than whatever the text
    // would have produced.
    if (!this.merging) {
      await this.conflict(path, entry, remote, report, "merging is off on this device");
      return;
    }

    // Refusing to decode is the point. A file is classified as text by its
    // extension, and an extension is a claim rather than a fact: a `.md`
    // holding bytes that are not UTF-8 decodes with replacement characters,
    // merges cleanly, and is written back with those replacements in place
    // of bytes neither side edited. That is a file quietly altered by a sync
    // that reported success.
    //
    // So the merge is attempted only on text that really is text, and
    // anything else takes the conflict path, which keeps both versions
    // byte-for-byte and transforms neither.
    // The ancestor, fetched by the uid the index remembered. This is what
    // `synchash` and `syncuid` are for: one field to identify the common
    // ancestor and one to go and get it, with no version history on the
    // device.
    //
    // Fetched outside the decode's try, and the distinction matters. One
    // catch used to cover the fetches, the local read and the decoding, so a
    // dropped connection, a chunk the server no longer holds and bytes that
    // were never UTF-8 all became a conflict copy labelled "not valid
    // UTF-8". A transport error is not a fact about the file: it propagates,
    // is recorded against the path and is tried again. An ancestor the
    // server has purged is a fact, and it gets said as what it is.
    let baseBytes: Uint8Array;
    try {
      baseBytes = await this.contentOf(entry.syncuid, entry.synchash);
    } catch (err) {
      if (!ancestorIsGone(err)) throw err;
      const why =
        "the version both sides edited from has been purged from the server, so there is nothing to merge against";
      this.log("merge refused", path, why);
      await this.conflict(path, entry, remote, report, why);
      return;
    }
    const mineBytes = await this.opts.vault.read(path);
    // What this file was when its bytes were read, for the check before the
    // merged text is written back (F01). Between here and that write is a
    // fetch for the other side, which is a network round trip, and a merge
    // computed from a version the editor has already replaced would write
    // over the replacement with text nobody has.
    const read = await this.opts.vault.stat(path);
    const mineAt: LocalState | undefined = read && {
      folder: read.folder,
      mtime: Math.ceil(read.mtime),
      size: read.size,
      hash: "",
    };
    const theirsBytes = await this.contentOf(remote.uid, remote.hash, remote.size);

    const dec = new TextDecoder("utf-8", { fatal: true });
    let base: string;
    let mine: string;
    let theirs: string;
    try {
      base = dec.decode(baseBytes);
      mine = dec.decode(mineBytes);
      theirs = dec.decode(theirsBytes);
    } catch {
      const why = "one side is not valid UTF-8, so merging it would rewrite bytes nobody edited";
      this.log("merge refused", path, why);
      await this.conflict(path, entry, remote, report, why);
      return;
    }

    // A canvas that merged cleanly and no longer parses is a canvas
    // Obsidian refuses to open, and the four checks inside mergeText all
    // pass for it: nothing was lost and nothing collided.
    //
    // An Excalidraw drawing is the same failure under a `.md`, so it gets the
    // same treatment through a predicate of its own. Its extension is `md`, so
    // neither `looksLikeJson` nor anything else was ever asked about it, while
    // its body is a JSON scene in a fenced block that a merge concatenates
    // without a comma exactly as it does a canvas: 744 of 4,882 clean merges of
    // an empty drawing two devices both drew on (core/excalidraw.ts, and the
    // corpus in excalidraw.test.ts). The gate is built from all three versions
    // rather than named by extension alone, because it has to abstain on a
    // `.excalidraw.md` whose drawing it cannot read instead of turning every
    // merge of it into a conflict copy; the reasoning is in that module.
    const outcome = mergeText(base, mine, theirs, validityGateFor(path, base, mine, theirs));
    if (outcome.kind === "conflict") {
      this.log("merge refused", path, outcome.why);
      await this.conflict(path, entry, remote, report, outcome.why);
      return;
    }

    const text = outcome.text;
    if (text !== mine) {
      if (!(await this.unchangedSince(path, mineAt))) {
        // The merge is of a version that is no longer here, so writing it
        // would drop whatever replaced it. Both sides are kept instead, which
        // is what a divergence this pass cannot resolve has always meant.
        const why = "it changed while the other side of the merge was being fetched";
        this.log("merge refused", path, why);
        await this.conflict(path, entry, remote, report, why, theirsBytes);
        return;
      }
      // Preserving, like every other landing (R19), and with the one baseline
      // that is exactly right: `mine` is the bytes this merge was computed
      // from, so a digest of them says precisely "is the file still the one I
      // merged". The metadata check above was taken *after* those bytes were
      // read, which let a newer file wear an older baseline's stat.
      if (
        await this.writePreserving(
          path,
          { contentId: await plainDigest(new TextEncoder().encode(mine)), idOf: plainDigest },
          new TextEncoder().encode(text),
          { mtime: this.now(), ctime: entry.ctime },
          report,
        )
      ) {
        // Something else was at the path and has been kept. The merge did not
        // land as itself, so the ancestor must not move.
        return;
      }
    }
    // Uploaded whatever the outcome, because even "take theirs" has to be
    // acknowledged for this path before the ancestor can move.
    observe(entry, { folder: false, mtime: this.now(), ctime: entry.ctime, size: text.length });
    await this.upload(path, entry, report, remote.uid);
    // Counted here, where the merge happened, and not where the put commits.
    // `uploaded` is the other way round, so a flush that fails reports merges
    // whose new version never reached the server. Deliberate: the merge is a
    // fact about this device either way, the text is written and durable, and
    // the pass that failed says so through `retrying`. Moving it into the
    // commit would mean threading a callback per queued file through the
    // flush for a counter.
    report.merged++;
    this.log("merged", path, outcome.kind === "merged" ? "three-way" : outcome.why);
  }

  /**
   * A conflict copy path nothing is using yet.
   *
   * The name carries the device and the time to the minute, so two conflicts
   * on one path from one device inside the same minute produced the same
   * name, and the second write replaced the first. Two passes inside a minute
   * is ordinary: the write debounce is measured in seconds.
   *
   * That lost a note. A conflict copy is the only surviving record of one
   * side of a divergence, and quietly overwriting it is the failure the
   * conflict copy exists to prevent, one level up.
   */
  private freeConflictPath(path: string): Promise<string> {
    return firstFreeName(conflictCopyPath(path, this.opts.device, new Date(this.now())), (p) =>
      this.opts.vault.exists(p),
    );
  }

  /**
   * Keeps both versions.
   *
   * The local file stays where it is and the incoming version takes a new
   * name. Obsidian does the opposite, putting local content in the conflict
   * copy and overwriting the file with the server's, so a sync rewrites the
   * file you have open and your version appears somewhere you were not
   * looking.
   *
   * Both are then uploaded: the copy so other devices get it, and the local
   * file so the server's newest word for that path is what is actually here.
   */
  private async conflict(
    path: string,
    entry: IndexEntry,
    remote: RemoteState | undefined,
    report: SyncReport,
    why: string,
    /**
     * The incoming plaintext, when the caller already holds it.
     *
     * The landing paths do: they have just assembled it, and asking the
     * server for the same version again would be a second round trip for
     * bytes in hand, on the one path where the reason for the conflict is
     * that everything took too long already.
     */
    inHand?: Uint8Array,
  ): Promise<void> {
    if (!remote) return;
    const incoming = inHand ?? (await this.contentOf(remote.uid, remote.hash, remote.size));
    const copyPath = await placeBeside(
      () => this.freeConflictPath(path),
      incoming,
      { mtime: remote.mtime, ctime: remote.mtime },
      this.opts.vault,
    );

    const copyEntry = this.entryFor(copyPath);
    observe(copyEntry, {
      folder: false,
      mtime: remote.mtime,
      ctime: remote.mtime,
      size: incoming.length,
    });
    await this.upload(copyPath, copyEntry, report, this.remote.get(copyPath)?.uid);
    // Which is also what records that this remote version has been dealt with
    // on a device that cannot send it (RR7). That lives in `upload`, at the one
    // place that decides not to send, because it was here first and the
    // successful-merge branch went on repeating itself (RR9).
    await this.upload(path, entry, report, remote.uid);

    // On the queue, not on the commit, for the reason `merged` gives above:
    // both copies are on this disk whatever the flush then does.
    report.conflicted++;
    this.log("kept both", path, { copy: copyPath, why });
  }

  private async sealedPath(path: string): Promise<string> {
    const sealed = await sealPath(this.keys, path);
    this.unsealed.set(sealed, path);
    return sealed;
  }

  /**
   * Records a failure, and decides whether the file is worth trying again.
   *
   * A protocol refusal the session survives and that names the file as the
   * problem will fail identically forever, so retrying it is noise that hides
   * everything else. Anything else gets exponential backoff, in Obsidian's
   * shape: `5 * 2^n` seconds, capped at five minutes.
   */
  private recordFailure(path: string, err: unknown, report: SyncReport): void {
    const message = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: string })?.code;
    // Not a failure at all: this device was told not to sync under that name
    // and did not (R2). Remembered so no later pass fetches it again, counted
    // so it stays visible, and out of the exit code.
    if (code === "ignored") {
      if (!this.ignoredPaths.has(path)) this.log("ignored here", path, message);
      this.ignoredPaths.set(path, message);
      // Owed nothing: it will never be fetched, so leaving it on the inbound
      // work list reported work outstanding for ever when a single pass was
      // all the vault needed (N4). The reconcile loop drops it too, for
      // indexes written before this line existed.
      this.pending.delete(path);
      report.ignored++;
      return;
    }
    // `neversync` is a vault refusing to write under a name its shell never
    // syncs, which no retry changes; the other three are the server's.
    const permanent =
      code !== undefined && ["badentry", "badname", "toolarge", "neversync"].includes(code);

    if (permanent) {
      this.skipped.set(path, {
        why: `${message} ${nextStepFor(code)}`.trim(),
        fingerprint: fingerprintOf(this.entries.get(path)),
      });
      noteSkipped(report, path);
      this.log("skipped for good", path, message);
      return;
    }

    const retry = this.retries.get(path) ?? { count: 0, error: "", at: 0 };
    retry.count++;
    retry.error = message;
    retry.at = this.now() + Math.min(300_000, 5_000 * Math.pow(2, retry.count));
    this.retries.set(path, retry);
    noteRetrying(report, path);
    this.log("will retry", path, { attempt: retry.count, error: message });
  }

  /**
   * Forgets what nothing can act on any more.
   *
   * Two halves, and for a long time there was only the first. `entries` was
   * pruned and `remote` was not, so a vault kept the server's word about every
   * path it had ever deleted, for ever, in a file rewritten on every sync. Six
   * hundred deleted notes cost around 60 KB and six hundred no-op decisions a
   * pass, growing for as long as the vault exists.
   *
   * The second half is not a cap and not a setting. A number would be
   * arbitrary and would evict on the wrong axis, and nobody can reasonably be
   * asked how many tombstones their index should keep. What is dropped here is
   * dropped because it is provably dead: the file is not on disk, the server's
   * newest word is a deletion, no index entry refers to it, and no inbound
   * work is outstanding. A record in that state can only produce a decision to
   * do nothing.
   *
   * Nothing is lost by forgetting it. A batch naming the path again repopulates
   * it, and a file reappearing at that path is a new file, which is what it is.
   * The server keeps the history either way, and `basalt deleted` reads it from
   * there rather than from here.
   */
  private prune(onDisk: Map<string, unknown>): void {
    for (const [path, entry] of this.entries) {
      if (onDisk.has(path)) continue;
      const remote = this.remote.get(path);
      if (remote && !remote.deleted) continue;
      if (entry.synchash === "" && entry.hash === "") this.entries.delete(path);
    }

    // After the loop above, so a path whose entry was just dropped is
    // considered in the same pass rather than the next one.
    //
    // The four clauses are one predicate: the server's last word was a
    // deletion, this device has applied it, and nothing local still refers
    // to it. Four tests fail if the whole predicate goes, and none fails if
    // any single clause does, because in the states actually reachable the
    // clauses overlap. That is a fact about the state space rather than
    // about the clauses, and shaving it down to whatever a current test can
    // tell apart would be optimising the predicate against the tests.
    for (const [path, remote] of this.remote) {
      if (!remote.deleted) continue;
      if (onDisk.has(path)) continue;
      if (this.entries.has(path)) continue;
      if (this.pending.has(path)) continue;
      this.remote.delete(path);
    }

    // The sealed-path cache, kept to what the two indexes still name.
    // It was never pruned, so a device connected through months of renames
    // held every name it had ever been told. Unsealing a path it meets again
    // costs one cipher call, and forgetting one it will not is free.
    if (this.unsealed.size > this.entries.size + this.remote.size + this.pending.size) {
      const keep = new Set<string>([
        ...this.entries.keys(),
        ...this.remote.keys(),
        ...this.pending,
        ...this.refusedInbound.keys(),
      ]);
      for (const [sealed, plain] of this.unsealed) {
        if (!keep.has(plain)) this.unsealed.delete(sealed);
      }
    }
  }

  private async save(): Promise<void> {
    // Null-prototype, because a filename is not a property name (F14).
    //
    // `entries["__proto__"] = ...` on an ordinary object does not add a key.
    // It sets the prototype, or on a frozen prototype does nothing at all, and
    // either way the assignment succeeds silently and the key is not there
    // afterwards. A vault holding a note called `__proto__` therefore
    // downloaded it, advanced the cursor, and saved an index with no record of
    // it: the note was on disk and the index had never heard of it, for ever.
    // `constructor` and `toString` are the same trick with a different name.
    //
    // Objects rather than Maps because this is what goes to JSON, and
    // `JSON.stringify` treats a null-prototype object exactly like any other.
    const entries: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [path, e] of this.entries) entries[path] = packed(e);
    const remote: Record<string, Remote> = Object.create(null) as Record<string, Remote>;
    for (const [path, r] of this.remote) remote[path] = r;
    await this.opts.store.save({
      cursor: this.cursor,
      entries,
      remote,
      pending: [...this.pending],
    });
  }

  /**
   * Records a rename the vault reported, so it travels as one operation.
   *
   * A folder rename is one event in Obsidian, for the folder, and every path
   * beneath it has moved without a word. So everything under `from` moves
   * too: without that, each file inside read as deleted at its old path and
   * new at its new one, and the whole subtree went over the wire again.
   *
   * The local bookkeeping keyed by path moves with it: the retry clock and
   * the write-off, so a file that was stuck does not forget it was stuck by
   * being renamed. What does not move is the server's word (`remote`) or the
   * inbound work list (`pending`), because both describe the server's path,
   * and the server has not heard of the rename yet: the next pass tells it,
   * as an upload of the new name carrying `prev`, and a remote entry moved
   * ahead of that made the new name look already synced and the rename was
   * never sent.
   *
   * A destination that never syncs is refused rather than recorded. An entry
   * under a dot folder is one the listing will never show again, and an
   * entry that is never listed reconciles as a deletion.
   */
  noteRename(from: string, to: string): void {
    if (isNeverSynced(to, new Set())) {
      this.log("rename into a path that never syncs, not recorded", from, to);
      return;
    }
    this.movePath(from, to);
    const under = `${from}/`;
    const known = new Set([...this.entries.keys(), ...this.retries.keys(), ...this.skipped.keys()]);
    for (const path of known) {
      if (path.startsWith(under)) this.movePath(path, to + path.slice(from.length));
    }
  }

  /** Moves the entry and the local bookkeeping from one name to another. */
  private movePath(from: string, to: string): void {
    this.moveEntry(from, to);
    const retry = this.retries.get(from);
    if (retry !== undefined) {
      this.retries.delete(from);
      this.retries.set(to, retry);
    }
    const skip = this.skipped.get(from);
    if (skip !== undefined) {
      this.skipped.delete(from);
      this.skipped.set(to, skip);
    }
  }

  private moveEntry(from: string, to: string): void {
    const entry = this.entries.get(from);
    if (!entry) return;

    // The new path inherits the sync state, so the content is recognised as
    // already on the server and the move costs no chunks, and `prev` tells the
    // server which name this used to be.
    const moved: IndexEntry = { ...entry, chunks: [...entry.chunks] };
    renamed(moved, from, to);
    this.entries.set(to, moved);

    // The old path keeps its entry, and that is the whole correction.
    //
    // It used to be deleted here, which looked right: the file is not there
    // any more. But an index with no entry for a path reads as a path this
    // device has never synced, and the server still holds content at the old
    // name until it is told otherwise, so `decideMissingLocally` saw
    // `synchash === ""` and answered "new on the server". Every move in
    // Obsidian downloaded its own source back, one pass later, and the person
    // was left with the file in both places.
    //
    // Left in place, the next pass sees a path that was synced and is now gone
    // locally, which is `deleteRemote`, which is what a move's old half is.
    // The server suppresses it from the deleted list by matching `prev`.
  }
}

/**
 * Two passes of one sync, as one report.
 *
 * The work counters add, because they count things that happened. The state
 * counters do not: `unchanged`, `waiting`, `retrying`, `skipped`, `ignored`,
 * `blocked` and `inTheWay` describe how the vault looks at the end of a pass,
 * and adding them reported one file held back in two passes as two waiting
 * , and one unchanged file looked at four times as four unchanged. The
 * newest pass has the last word on those.
 *
 * This is also how a settle adds its passes up, which for a while it did
 * through a second copy of this function.
 */
export function combinePasses(a: SyncReport, b: SyncReport): SyncReport {
  return {
    uploaded: a.uploaded + b.uploaded,
    downloaded: a.downloaded + b.downloaded,
    merged: a.merged + b.merged,
    conflicted: a.conflicted + b.conflicted,
    deletedLocally: a.deletedLocally + b.deletedLocally,
    deletedRemotely: a.deletedRemotely + b.deletedRemotely,
    restored: a.restored + b.restored,
    foldersCreated: a.foldersCreated + b.foldersCreated,
    chunksSent: a.chunksSent + b.chunksSent,
    bytesSent: a.bytesSent + b.bytesSent,
    unchanged: b.unchanged,
    waiting: b.waiting,
    ...(b.nextUploadAt !== undefined ? { nextUploadAt: b.nextUploadAt } : {}),
    ...(b.appliedCursor !== undefined ? { appliedCursor: b.appliedCursor } : {}),
    retrying: b.retrying,
    skipped: b.skipped,
    skippedPaths: b.skippedPaths,
    retryingPaths: b.retryingPaths,
    // The newest pass has the last word, like `ignored` and for the same
    // reason this function's own comment gives: these are what the vault
    // looks like at the end of a pass, not things that happened during one.
    // Every pass re-decides the same local changes, so adding them would
    // report one held-back note in two passes as two.
    heldBack: b.heldBack,
    heldBackPaths: b.heldBackPaths,
    ignored: b.ignored,
    blocked: b.blocked,
    inTheWay: b.inTheWay,
    needsAttention: b.needsAttention,
  };
}

/**
 * The predicate that says whether a merged file is still the kind of thing it
 * was, or undefined where there is nothing to ask.
 *
 * Its own function because it is the wiring, and wiring is the part that goes
 * untested: every gate here can exist, read correctly and be asked of nothing.
 * Unwiring this passed the whole suite before it was pulled out where a test
 * could reach it.
 *
 * For prose there is nothing to ask -- any arrangement of lines is a valid
 * note. For a structured file there is, and a line-wise merge does not know
 * it: two edits to different parts of a canvas can each apply cleanly and
 * leave JSON that does not parse, which Obsidian then refuses to open.
 *
 * Three kinds have one. JSON and canvas parse or they do not. An Excalidraw
 * drawing is a JSON scene inside a `.md`, so it is recognised by its content
 * rather than its extension and abstains where it cannot read the drawing
 * (`core/excalidraw.ts`). Markup is the newest: `.svg` was measured not to
 * need a gate, that measurement was taken with the coarse diff, and making the
 * diff exact for ordinary notes took the corpus in `markup.test.ts` from zero
 * malformed merges in 20,923 to one (I28, I31).
 */
/**
 * The server version a held-back write was answering, when it is still that
 * version.
 *
 * Out here and exported because the alternative was a condition inside
 * `upload` that nothing could ask about. It only ever declines on a device
 * that cannot send, which is a device whose `remote` map nothing commits to,
 * so the deciding case is one the read-only tests structurally cannot reach:
 * exactly the guard-that-is-asked-of-nothing this codebase keeps producing.
 *
 * Declining matters anyway. `reconciled` writes a hash and a uid together as
 * the ancestor, and a hash belonging to one version recorded against another
 * uid is a lie about what has been dealt with, which is how a later version
 * gets skipped rather than merged. So: nothing is claimed for a write that
 * answered no version, and nothing is claimed when the version it answered is
 * no longer the one the server has.
 */
export function answeredVersion(
  basedOn: number | undefined,
  remote: { uid: number; hash: string } | undefined,
): { uid: number; hash: string } | undefined {
  if (basedOn === undefined) return undefined;
  if (!remote || remote.uid !== basedOn) return undefined;
  return { uid: basedOn, hash: remote.hash };
}

export function validityGateFor(
  path: string,
  base: string,
  mine: string,
  theirs: string,
): ((text: string) => boolean) | undefined {
  if (looksLikeJson(path)) return parsesAsJson;
  if (looksLikeExcalidraw(path)) return drawingGate(base, mine, theirs);
  if (looksLikeMarkupPath(path)) return wellFormedMarkup;
  return undefined;
}

/**
 * Why a path from another device is one this device will not act on, or
 * undefined for a path it will.
 *
 * Two rules. The dot rule is the shared one from paths.ts: a dot-prefixed
 * segment never syncs in either direction, because Obsidian's index does not
 * list it and a file written and never listed is reported deleted. The
 * canonical rule is that the path is exactly what a filesystem would file it
 * under: no empty segment, no `.` or `..`, nothing leading or trailing.
 */
export function refusedInboundPath(path: string): string | undefined {
  if (path === "") return "an empty path";
  if (isNeverSynced(path, new Set())) return "a path under a dot-prefixed name never syncs";
  if (path.startsWith("/")) return "a path starting with a slash is not canonical";
  if (path.endsWith("/")) return "a path ending with a slash is not canonical";
  for (const part of path.split("/")) {
    if (part === "") return "a path with an empty segment (//) is not canonical";
    if (part === "." || part === "..")
      return `a path with a ${JSON.stringify(part)} segment is not canonical`;
  }
  return undefined;
}

/**
 * Enough of a file to notice it changed.
 *
 * Modification time and size rather than a content hash, because this is read
 * before the pass decides whether to re-read anything, and a hash would mean
 * reading every written-off file on every pass to find out whether it was still
 * written off.
 *
 * Taken off the index entry, which reads as though it were frozen at whatever
 * the last successful sync recorded, and is not: every pass calls `observe`
 * over the whole listing before any of these comparisons, and `observe` stamps
 * the entry with the mtime and size the disk just reported. So this is the
 * on-disk stat, one step removed, and both sides of the comparison come from
 * the same listing. That is what makes a written-off file that somebody has
 * since repaired get tried again, rather than staying written off until the
 * process restarts.
 *
 * A path with nothing on disk is not observed, so its entry keeps whatever it
 * had and a refusal that was never about a local file stays put, which is
 * right: nothing here changed.
 */
function fingerprintOf(entry: IndexEntry | undefined): string {
  return entry ? `${entry.mtime}:${entry.size}` : "gone";
}

/**
 * Below this, a file's sealed chunks are kept rather than made twice.
 *
 * Almost every file is a note, and re-sealing a note to save a few kilobytes is
 * a worse trade than the memory. Above it a file is an attachment, and the
 * memory is the thing that matters.
 */
const KEEP_SEALED_BELOW = 8 * 1024 * 1024;

/** How many chunks are sealed at once when the bodies are not being kept. */
export const SEAL_WINDOW = 16;

/**
 * Chunk names, sealing a bounded window at a time.
 *
 * Sealing is deterministic, so a name can be computed and the body it came from
 * thrown away. Doing them all at once holds a sealed copy of the whole file,
 * plus the compression garbage behind it, live at the same moment.
 *
 * Measured through a whole sync of one 64 MiB attachment, peak resident in a
 * fresh process: 816 MB with everything sealed at once against 522 MB with a
 * window of sixteen. Sealing is mostly waiting on WebCrypto, and sixteen is
 * enough in flight to keep it busy, so the smaller window is not slower.
 *
 * The saving is larger than one sealed copy of the file because a changed file
 * is sealed twice: once by the rehash that decides it changed, and once by the
 * upload that sends it. Both are windowed.
 *
 * This does not contradict `sealChunks`, which measured whole-file sealing as
 * the fast path. That was 1,893 chunks of about a kilobyte, where the
 * per-promise overhead is the cost. These are hundreds of kilobytes each, where
 * the work is.
 *
 * Exported because the property worth testing is that windowing changes nothing
 * but the memory: the names must be exactly what sealing everything at once
 * produces, or a file would be stored under names no other device agrees with.
 */
export async function sealedNames(
  keys: Schedule,
  parts: readonly Uint8Array[],
  window = SEAL_WINDOW,
): Promise<string[]> {
  const names: string[] = [];
  for (let at = 0; at < parts.length; at += window) {
    const sealed = await sealChunks(keys, parts.slice(at, at + window));
    for (const chunk of sealed) names.push(chunk.name);
  }
  return names;
}

/**
 * How many bytes of incoming version this device will queue before fetching.
 * See `receive`: the count bound is the server's and the fetch caps split
 * what goes on the wire; this one is memory, since every queued body is held
 * until its file is written.
 */
const INBOX_BYTES = 8 * 1024 * 1024;

/**
 * What one chunk of a file is costed at when only the file's size is known:
 * its share of the declared size, plus the sealing allowance the server's
 * budget rule grants per chunk. Never under the stored size, because the
 * server's rule is what bounds that.
 */
function perChunkBudget(size: number, chunks: number): number {
  return entryBudget(Math.ceil(size / Math.max(1, chunks)), 1);
}

/**
 * Splits a chunk list into fetches, each within a byte budget and a count.
 *
 * Greedy and in order, so the bodies come back in the order the names were
 * given when the asks are made in sequence. A single name over the byte
 * budget goes on its own: the budget is a guess that is never too small, so
 * a chunk the server holds is one the server will serve alone.
 *
 * Exported because the property worth testing is that nothing in any ask is
 * over either bound and that every name is asked for exactly once.
 */
export function planFetches(
  names: readonly string[],
  budgetOf: (name: string) => number,
  maxBytes: number,
  maxNames: number,
): string[][] {
  const asks: string[][] = [];
  let ask: string[] = [];
  let bytes = 0;
  for (const name of names) {
    const cost = budgetOf(name);
    if (ask.length > 0 && (bytes + cost > maxBytes || ask.length >= maxNames)) {
      asks.push(ask);
      ask = [];
      bytes = 0;
    }
    ask.push(name);
    bytes += cost;
  }
  if (ask.length > 0) asks.push(ask);
  return asks;
}

/**
 * Writes a copy under a free name, without ever replacing what is there.
 *
 * `exists` and then `write` is a gap, and another process, or the editor
 * somebody is typing in, can put a file under that name inside it. A conflict
 * copy or a restore landing there replaced the very file it existed to keep.
 * So where the vault can create exclusively, the name is claimed and written
 * in one step, and a name that turns out taken is passed over for the next.
 *
 * Exported because the engine's conflict copy and the client's restore are
 * the same operation with a different name in hand.
 */
export async function placeBeside(
  freeName: () => Promise<string>,
  bytes: Uint8Array,
  times: Times,
  vault: Pick<Vault, "write" | "create">,
): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const at = await freeName();
    if (!vault.create) {
      await vault.write(at, bytes, times);
      return at;
    }
    if (await vault.create(at, bytes, times)) return at;
    // Taken between choosing it and claiming it. The chooser looks again
    // and finds the next free name, because this one now exists.
  }
  throw new Error("could not find a name beside the note that stayed free long enough to use");
}

/**
 * A refusal carrying the code that makes it permanent.
 *
 * `recordFailure` classifies by code, and `toolarge` is one it writes off rather
 * than retries: a file does not become smaller by being tried again. The write
 * off is undone the moment the file changes, because the skip is keyed on the
 * entry's fingerprint, so somebody who trims an attachment sees it sync.
 */
function tooLarge(size: number, max: number): Error {
  const err = new Error(
    `${size} bytes, and this server said it stores at most ${max}, so it was not read`,
  );
  (err as Error & { code: string }).code = "toolarge";
  return err;
}

/**
 * One read of a file, cut and named, which an upload can use as it stands.
 *
 * `sealed` is present only when the file was small enough to keep the bodies;
 * above that threshold the names were taken a window at a time and the bodies
 * dropped, and a wanted chunk is sealed again from `bytes`.
 */
type Scanned =
  /** The file was read whole, because the vault could only hand it over whole. */
  | {
      readonly bytes: Uint8Array;
      readonly pieces: readonly { offset: number; bytes: Uint8Array }[];
      readonly names: string[];
      readonly sealed?: SealedChunk[];
      readonly spans?: undefined;
    }
  /** The file was streamed, and nothing of it is held but the offsets. */
  | {
      readonly names: string[];
      readonly spans: readonly { start: number; end: number }[];
      readonly path: string;
      readonly size: number;
      readonly bytes?: undefined;
      readonly sealed?: undefined;
    };

/** One version waiting for company in the inbox. */
interface Incoming {
  readonly path: string;
  readonly entry: IndexEntry;
  readonly remote: RemoteState;
  /** The server's own chunk list for this version, from the batch. */
  readonly chunks: readonly string[];
  readonly kind: "download" | "restoreLocal";
  readonly why: string;
  /**
   * What this path held locally when the pass decided to write over it, or
   * undefined when it held nothing.
   *
   * Checked again immediately before the write. Between the decision and the
   * write is a fetch, and the person using the vault is typing through it.
   */
  readonly based: LocalState | undefined;
  /**
   * A digest of the bytes this path held when the pass decided to write over
   * it, or undefined when it held none or could not be read (R01).
   *
   * `based` is metadata and metadata is what an ordinary edit leaves alone: a
   * corrected word is usually the same number of characters, and an editor
   * writing through a temporary file can carry the timestamp over. This is the
   * thing that actually changes, and it is what the adapter compares against
   * whatever it displaces.
   *
   * Read at decision time, which is before the fetch, so it describes the
   * version the decision was actually taken on. That costs one read of a file
   * this pass is about to overwrite anyway.
   */
  readonly baseDigest: string | undefined;
}

/** One write waiting for company in the outbox. */
interface Queued {
  /** The plaintext path, for logging and for recording a failure against. */
  readonly path: string;
  /** Roughly what holding this until the flush costs in memory. */
  readonly size: number;
  readonly entry: BatchEntry;
  readonly bodyOf: (name: string) => Promise<Uint8Array>;
  /**
   * The server's newest version of this path when the write was decided, or
   * undefined when it had none. Compared against the remote index again at
   * commit time; see `flush` for what a difference means.
   */
  readonly basedOn: number | undefined;
  /** Run only once the server has committed it, with the uid it was given. */
  readonly commit: (uid: number) => void;
}

/**
 * Everything about an entry that its MAC covers.
 *
 * Built once and then both sent and authenticated, rather than written out
 * twice: the MAC has to cover exactly what goes on the wire, and two literals
 * kept in step by hand is how that stops being true. Sealing the path is a key
 * derivation and a cipher call, so building it once also halves them.
 */
type PutFacts = Pick<BatchEntry, "path" | "meta" | "names">;

/** What an upload needs: every chunk's name, and a way to get one's bytes. */
interface UploadPlan {
  readonly names: string[];
  readonly bodyOf: (name: string) => Promise<Uint8Array>;
}

/** For a put that carries no bodies at all: a folder, or a deletion. */
async function noBodies(name: string): Promise<Uint8Array> {
  throw new Error(`this put has no bodies, and the server asked for ${name}`);
}

/**
 * Whether a failed fetch means the server no longer has the version at all.
 *
 * `nouid` is an entry purge has removed; `nochunk` is a body it no longer
 * holds, which is what an old version's unshared chunks become. Both are the
 * server telling the truth about its history, as opposed to a connection that
 * went away or a server that answered strangely, which are not facts about
 * the version and are retried.
 */
function ancestorIsGone(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  // `nocontent` is a uid that names a folder or a deletion, which an ancestor
  // never should. If it does, there is equally nothing to merge against.
  return code === "nouid" || code === "nochunk" || code === "nocontent";
}

/** Whether text is still JSON, for the formats where that is what it means to be usable. */
function parsesAsJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
