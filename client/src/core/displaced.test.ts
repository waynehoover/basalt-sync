/**
 * The record of versions this client could not put back.
 *
 * The bytes always survived. What did not was the knowledge: a scan could see
 * a parked file and had no way to say which note it came off or why, and the
 * plugin could not see it at all because its displaced versions go into a
 * hidden folder Obsidian does not list (R46, PRODUCT_READINESS.md 3).
 *
 * So the properties here are about the record surviving what the note survived:
 * a restart, a torn write, an unreadable log, and a person putting the version
 * back by hand.
 */

import { describe, expect, it } from "vitest";

import { DisplacedLedger, type Displaced, type DisplacedFiles } from "./displaced.ts";

/** A log in memory, with the disk it describes beside it. */
class Files implements DisplacedFiles {
  text: string | undefined;
  readonly onDisk = new Set<string>();
  /** Set to make every read fail, which is not the same as an empty log. */
  unreadable = false;
  rewrites = 0;

  async read(): Promise<string | undefined> {
    if (this.unreadable) throw new Error("the log cannot be read");
    return this.text;
  }
  async append(line: string): Promise<void> {
    this.text = (this.text ?? "") + line;
  }
  async rewrite(text: string): Promise<void> {
    this.rewrites++;
    this.text = text;
  }
  async stillThere(at: string): Promise<boolean> {
    return this.onDisk.has(at);
  }
}

const record = (at: string, from = "note.md"): Displaced => ({
  at,
  from,
  why: "the conflict name was taken",
  when: 1,
});

describe("the displaced-version ledger", () => {
  it("says what is waiting, and what it came off", async () => {
    const files = new Files();
    files.onDisk.add("note.md..keep1");
    const ledger = new DisplacedLedger(files);
    await ledger.record(record("note.md..keep1", "Daily/2026-09-07.md"));

    const waiting = await ledger.waiting();
    expect(waiting).toHaveLength(1);
    // The whole reason this exists rather than a walk: a path is not an
    // explanation, and `note.md..keep1` on its own sends somebody opening
    // files to find out which note it is.
    expect(waiting[0]!.from).toBe("Daily/2026-09-07.md");
    expect(waiting[0]!.why).toContain("conflict name");
  });

  it("survives a restart, because the record is on the disk and not in the object", async () => {
    const files = new Files();
    files.onDisk.add("note.md..keep1");
    await new DisplacedLedger(files).record(record("note.md..keep1"));

    // A different object over the same files, which is what the next `basalt
    // sync` is. Nothing is carried over in memory.
    const afterRestart = await new DisplacedLedger(files).waiting();
    expect(afterRestart.map((d) => d.at)).toEqual(["note.md..keep1"]);
  });

  it("forgets a version once somebody has put it somewhere", async () => {
    const files = new Files();
    files.onDisk.add("note.md..keep1");
    const ledger = new DisplacedLedger(files);
    await ledger.record(record("note.md..keep1"));
    expect(await ledger.waiting()).toHaveLength(1);

    // Renamed, moved back, deleted: whichever it was, the file is not there
    // and there is nothing left to report. This is the only way the list ever
    // gets shorter, because nothing else can say a person has finished.
    files.onDisk.delete("note.md..keep1");
    expect(await ledger.waiting()).toEqual([]);
  });

  it("describes the version that is there now, when one name is displaced twice", async () => {
    const files = new Files();
    files.onDisk.add("note.md..keep1");
    const ledger = new DisplacedLedger(files);
    await ledger.record({ ...record("note.md..keep1"), why: "the first reason", when: 1 });
    await ledger.record({ ...record("note.md..keep1"), why: "the second reason", when: 2 });

    const waiting = await ledger.waiting();
    expect(waiting).toHaveLength(1);
    expect(waiting[0]!.why).toBe("the second reason");
  });

  it("keeps the records before a torn last line", async () => {
    // What a crash mid-append leaves. The records before it name notes and
    // are good; throwing over the broken one would lose all of them, which is
    // the failure this module exists to prevent, arriving through its own log.
    const files = new Files();
    files.onDisk.add("a..keep");
    files.onDisk.add("b..keep");
    files.text =
      `${JSON.stringify(record("a..keep", "a.md"))}\n` +
      `${JSON.stringify(record("b..keep", "b.md"))}\n` +
      `{"at":"c..keep","fro`;

    const waiting = await new DisplacedLedger(files).waiting();
    expect(waiting.map((d) => d.at)).toEqual(["a..keep", "b..keep"]);
  });

  it("says so when the log cannot be read, rather than reporting nothing waiting", async () => {
    // Rule 2. "Nothing is waiting" because the log could not be opened is the
    // exact false clean this is here to prevent, so the empty answer comes
    // with a complaint and the scan's own walk still finds the files.
    const files = new Files();
    files.unreadable = true;
    const said: string[] = [];
    const waiting = await new DisplacedLedger(files, (m) => said.push(m)).waiting();

    expect(waiting).toEqual([]);
    expect(said.join(" ")).toContain("could not read");
  });

  it("does not throw out of the failure path it is called from", async () => {
    // `record` runs after something has already gone wrong with somebody's
    // note. A bookkeeping error replacing that error would hide what actually
    // happened to it.
    const files = new Files();
    files.append = async () => {
      throw new Error("the disk is full");
    };
    const said: string[] = [];
    await expect(
      new DisplacedLedger(files, (m) => said.push(m)).record(record("note.md..keep1")),
    ).resolves.toBeUndefined();
    expect(said.join(" ")).toContain("could not write down");
  });

  it("tidies the log rather than growing it for ever", async () => {
    const files = new Files();
    const ledger = new DisplacedLedger(files);
    // Forty displaced and then resolved, which is a vault somebody has been
    // using for years rather than an unusual one.
    for (let i = 0; i < 40; i++) await ledger.record(record(`gone-${i}..keep`));
    files.onDisk.add("here..keep");
    await ledger.record(record("here..keep"));

    expect(await ledger.waiting()).toHaveLength(1);
    expect(files.rewrites, "the log was never tidied").toBeGreaterThan(0);
    expect(files.text!.trim().split("\n")).toHaveLength(1);
  });
});
