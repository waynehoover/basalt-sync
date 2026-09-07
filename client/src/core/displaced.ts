/**
 * A record of every version this client took off a name and could not put back.
 *
 * Preservation moves the bytes aside before it writes, and sometimes there is
 * nowhere to put them: the conflict name is taken, the directory is not
 * writable, the disk filled up. The bytes survive, under a name nothing lists.
 * That is safe and it is useless on its own, because a note nobody can find is
 * not much better than a deleted one (R46).
 *
 * The headless client used to answer this by walking the vault and recognising
 * parked names. That works and it is not enough:
 *
 *   - It can say a file is there and not what it is. Somebody looking at
 *     `note.md..basalt-tmp-keep3f9c` has to guess which note it came off and
 *     why it is not at its name.
 *   - The plugin cannot do it at all in the place it matters. Its displaced
 *     versions go into a hidden folder, and it never implemented the walk, so
 *     the Obsidian client -- which is the product -- reported nothing.
 *   - It is rediscovery rather than a record. The bytes survive a restart; the
 *     knowledge of what happened to them did not.
 *
 * So the fact is written down when it happens, and the scan reconciles against
 * it rather than replacing it. Both shells write the same records and both
 * read them, so "what is waiting" has one answer (PRODUCT_READINESS.md 3).
 *
 * The shape is `JournalFiles`: a small interface the shell implements and
 * everything hard above it. Append-only lines, because that is the only shape
 * that is one implementation on both a Node filesystem and Obsidian's adapter,
 * and because a record of a note that could not be saved is a poor thing to
 * lose to a partial write.
 */

/** One version that is somewhere nothing lists. */
export interface Displaced {
  /** Where the bytes are now, as a vault-relative path. */
  readonly at: string;
  /** The note they came off, as a vault-relative path. */
  readonly from: string;
  /** Why they are not at that name, in a sentence a person can read. */
  readonly why: string;
  /** Milliseconds since the epoch. */
  readonly when: number;
}

/**
 * What a shell must provide. Deliberately small: everything hard is above it.
 *
 * `append` must place bytes at the end and nowhere else. `stillThere` answers
 * about the disk rather than about the log, because the log is a record of
 * what happened and the disk is the question being asked (rule 4).
 */
export interface DisplacedFiles {
  read(): Promise<string | undefined>;
  append(line: string): Promise<void>;
  /** Replaces the whole log, durably as far as the platform allows. */
  rewrite(text: string): Promise<void>;
  /** Whether something is still at this vault-relative path. */
  stillThere(at: string): Promise<boolean>;
}

/**
 * When the log has enough dead records to be worth rewriting.
 *
 * A vault that strands one version a year would otherwise carry every resolved
 * record for ever. Rewriting is a whole-file write and the log is tiny, so the
 * only reason not to do it on every read is that a read happens on every scan.
 */
const COMPACT_AT = 32;

export class DisplacedLedger {
  private readonly files: DisplacedFiles;
  private readonly say: (message: string) => void;

  constructor(files: DisplacedFiles, log: (message: string) => void = () => undefined) {
    this.files = files;
    this.say = log;
  }

  /**
   * Writes down that a version is somewhere nothing lists.
   *
   * Never throws. This is called from the failure path of an operation that
   * has already gone wrong, and a bookkeeping error that replaced the real one
   * would hide what actually happened to somebody's note. What it costs when
   * it fails is the reason rather than the bytes: the scan still finds a
   * parked file and still reports it, with less to say about it.
   */
  async record(d: Displaced): Promise<void> {
    try {
      await this.files.append(`${JSON.stringify(d)}\n`);
    } catch (err) {
      this.say(`could not write down that ${d.at} is waiting: ${(err as Error).message}`);
    }
  }

  /**
   * What is really waiting, reconciled against the disk.
   *
   * A record whose file is gone is dropped: somebody moved it back, or renamed
   * it, or decided they did not want it, and none of those need reporting for
   * ever. Dropping it is the only way this list ever gets shorter, because
   * there is no moment at which anything else can say a person is finished
   * with a preserved note.
   *
   * Order is oldest first, and duplicates by path are collapsed to the newest
   * record: the same name can be displaced twice, and the second time is the
   * one that describes the bytes now there.
   *
   * `tidy` is false for a caller that is only asking. `status` takes no lock
   * and may run beside a watcher, so its scan reaps nothing and re-spells
   * nothing (R12); rewriting this log would have been the one write it still
   * made, and a question is not a reason to change anything. The answer is the
   * same either way: what is dropped from the answer is dropped whether or not
   * the file is rewritten.
   */
  async waiting(tidy = true): Promise<Displaced[]> {
    const all = await this.parse();
    const newest = new Map<string, Displaced>();
    for (const d of all) newest.set(d.at, d);

    const live: Displaced[] = [];
    let dead = 0;
    for (const d of newest.values()) {
      if (await this.files.stillThere(d.at).catch(() => true)) live.push(d);
      else dead++;
    }
    // Counted against the whole log rather than against the live records: a
    // log of a thousand resolved entries and one live one is what this is for.
    if (tidy && (all.length - live.length >= COMPACT_AT || (dead > 0 && live.length === 0))) {
      await this.compact(live);
    }
    live.sort((a, b) => a.when - b.when);
    return live;
  }

  private async compact(live: readonly Displaced[]): Promise<void> {
    try {
      await this.files.rewrite(live.map((d) => `${JSON.stringify(d)}\n`).join(""));
    } catch (err) {
      // The log keeps its dead records, which costs a longer file and nothing
      // else: `waiting` filters them every time.
      this.say(`could not tidy the displaced-version log: ${(err as Error).message}`);
    }
  }

  private async parse(): Promise<Displaced[]> {
    let text: string | undefined;
    try {
      text = await this.files.read();
    } catch (err) {
      // Rule 2: unreadable is not empty. Reporting nothing waiting because the
      // log could not be read is the exact failure this module exists to stop,
      // so it says so and the scan's own walk still finds the files.
      this.say(`could not read the displaced-version log: ${(err as Error).message}`);
      return [];
    }
    if (text === undefined || text.length === 0) return [];
    const out: Displaced[] = [];
    for (const line of text.split("\n")) {
      if (line.trim().length === 0) continue;
      const d = parseLine(line);
      // A torn last line is what a crash mid-append leaves. Skipped rather
      // than thrown on: the records before it are good, and they are the ones
      // naming notes.
      if (d !== undefined) out.push(d);
    }
    return out;
  }
}

function parseLine(line: string): Displaced | undefined {
  try {
    const raw = JSON.parse(line) as Partial<Displaced>;
    if (typeof raw.at !== "string" || raw.at.length === 0) return undefined;
    return {
      at: raw.at,
      from: typeof raw.from === "string" ? raw.from : "an unknown note",
      why: typeof raw.why === "string" ? raw.why : "it could not be placed",
      when: typeof raw.when === "number" ? raw.when : 0,
    };
  } catch {
    return undefined;
  }
}

/**
 * The name both shells give this log.
 *
 * One name rather than two, because somebody looking for it after a crash
 * should not have to know which client wrote it, and because a support answer
 * that says "look in `.basalt`" is worth more than one that says "it depends".
 */
export const DISPLACED_LOG = "displaced.log";
