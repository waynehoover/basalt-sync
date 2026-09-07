/**
 * What both adapters write down when a version has nowhere to go, end to end.
 *
 * `core/displaced.test.ts` covers the ledger against a fake. This covers the
 * thing that matters: that the real adapters call it on the paths where a
 * version is actually stranded, and that a new process over the same directory
 * can still say which note is in there and why.
 *
 * The plugin half is here rather than in `plugin/` because the property is
 * that the two clients answer the question the same way, and a property about
 * two things is worth testing in one place.
 */

import { mkdtemp, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { NodeVault } from "./vault.ts";
import { FakeAdapter, FakeVaultIndex, asVault } from "../plugin/fake.ts";
import { ObsidianVault } from "../plugin/vault.ts";
import { DISPLACED_LOG } from "../core/displaced.ts";
import { removeTree } from "../core/test-server.ts";

const enc = new TextEncoder();
const NOW = { mtime: 1_700_000_000_000, ctime: 1_700_000_000_000 };
const MINE = "what this device had\n";

const made: string[] = [];
afterEach(async () => {
  for (const d of made.splice(0)) await removeTree(d);
});

async function vaultDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "basalt-displaced-"));
  made.push(dir);
  return dir;
}

async function idOf(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer);
  return Buffer.from(digest).toString("hex");
}

describe("the headless client, when a displaced version has nowhere to go", () => {
  it("writes down which note it came off, and a new process can still say", async () => {
    const dir = await vaultDir();
    await writeFile(join(dir, "note.md"), MINE);
    // The conflict copy is aimed into a directory this process cannot write,
    // so preservation takes the note off its name and then has nowhere to put
    // it. The bytes survive under a parked name nothing lists.
    await mkdir(join(dir, "shut"));
    await chmod(join(dir, "shut"), 0o500);

    const vault = new NodeVault(dir);
    await expect(
      vault.replace(
        "note.md",
        { contentId: "something else entirely", idOf },
        enc.encode("what the server sent\n"),
        NOW,
        "shut/note (conflict).md",
      ),
    ).rejects.toThrow();

    // A different object over the same directory, which is what the next
    // `basalt sync` is. Nothing carried over in memory.
    const next = new NodeVault(dir);
    await next.list();
    expect(next.stranded, "the parked version was not reported at all").toHaveLength(1);

    const [waiting] = next.displaced;
    expect(waiting, "the scan found the file but nothing said what it was").toBeDefined();
    expect(waiting!.from).toBe("note.md");
    expect(waiting!.why).toContain("could not be placed");
    // And the bytes really are the ones that were on the note.
    expect(await readFile(join(dir, waiting!.at), "utf8")).toBe(MINE);
  });

  it("stops reporting one that has been put back by hand", async () => {
    const dir = await vaultDir();
    await writeFile(join(dir, "note.md"), MINE);
    await mkdir(join(dir, "shut"));
    await chmod(join(dir, "shut"), 0o500);
    const vault = new NodeVault(dir);
    await vault
      .replace(
        "note.md",
        { contentId: "something else", idOf },
        enc.encode("incoming\n"),
        NOW,
        "shut/note (conflict).md",
      )
      .catch(() => undefined);
    await vault.list();
    const [waiting] = vault.displaced;
    expect(waiting).toBeDefined();

    // The person finds it, renames it back, and is not told about it again.
    // Nothing else can say they are finished, so the file being gone is the
    // only signal there is.
    await writeFile(join(dir, "rescued.md"), await readFile(join(dir, waiting!.at)));
    await removeTree(join(dir, waiting!.at));

    const next = new NodeVault(dir);
    await next.list();
    expect(next.stranded).toEqual([]);
    expect(next.displaced).toEqual([]);
  });

  it("reports a parked file nothing wrote a record for", async () => {
    // An older build, or another process. The walk is what finds these, and
    // dropping it in favour of the ledger would have lost them: the two
    // sources answer different halves.
    const dir = await vaultDir();
    await writeFile(join(dir, `orphan.md..basalt-tmp-keepdeadbeef`), MINE);

    const vault = new NodeVault(dir);
    await vault.list();
    expect(vault.stranded).toEqual(["orphan.md..basalt-tmp-keepdeadbeef"]);
    // Reported, with nothing more said about it than that it is there, which
    // is all anybody can know about it.
    expect(vault.displaced).toEqual([]);
  });
});

describe("the plugin, when a displaced version has nowhere to go", () => {
  it("reports it at all, which it never used to", async () => {
    const adapter = new FakeAdapter();
    adapter.seed("note.md", MINE);
    const vault = new ObsidianVault(asVault(new FakeVaultIndex(adapter)), ".obsidian");

    // The path that strands one: the note is moved into a hidden folder to be
    // identified, it turns out not to be the version the pass meant to delete,
    // and it cannot be brought back out under a name a person would find. It
    // stays in the folder, which Obsidian does not list.
    adapter.fault = (op, _path, to) =>
      op === "rename" && to === "kept.md" ? new Error("the conflict name is taken") : undefined;
    const out = await vault.removeExpecting("note.md", { contentId: "whatever", idOf }, "kept.md");
    adapter.fault = undefined;
    expect(out.keptAt, "nothing was stranded, so nothing is under test").toBeDefined();
    expect(out.keptAt).not.toBe("kept.md");

    await vault.list();
    // Obsidian's index does not list a hidden folder, so before the ledger
    // there was nothing here at all: the product reported a clean vault with
    // somebody's note inside a dot-folder.
    expect(vault.stranded).toEqual([out.keptAt]);
    expect(vault.displaced[0]!.from).toBe("note.md");
  });

  it("refuses to hide a note it cannot write down first", async () => {
    // RR2. The record used to be written after the move, and only on the path
    // where something threw. An append that failed therefore left the note in
    // a folder Obsidian does not list with nothing anywhere naming it. Now the
    // record comes first and the note is not moved at all if it cannot be
    // written, which turns a lost note into a deletion that did not happen.
    const adapter = new FakeAdapter();
    adapter.seed("note.md", MINE);
    const vault = new ObsidianVault(asVault(new FakeVaultIndex(adapter)), ".obsidian");

    adapter.fault = (op) => (op === "append" ? new Error("no space left on device") : undefined);
    const out = await vault.removeExpecting("note.md", { contentId: "whatever", idOf }, "kept.md");
    adapter.fault = undefined;

    // Left exactly where it was, and said so.
    expect(out).toEqual({ keptAt: "note.md", landed: true });
    expect(await adapter.read("note.md")).toBe(MINE);

    // And a fresh adapter agrees: nothing is hidden and nothing is waiting.
    const next = new ObsidianVault(asVault(new FakeVaultIndex(adapter)), ".obsidian");
    await next.list();
    expect(next.stranded).toEqual([]);
    expect(next.recovery.complete).toBe(true);
  });

  it("survives a crash between the move aside and everything after it", async () => {
    // RR2. The interrupted case: the note is in the hidden folder and the
    // process is gone before any of the code that used to do the recording
    // ran. The intent written before the move is the only thing left, and it
    // has to be enough.
    const adapter = new FakeAdapter();
    adapter.seed("note.md", MINE);
    const vault = new ObsidianVault(asVault(new FakeVaultIndex(adapter)), ".obsidian");

    // Stop the world immediately after the note has been moved aside, which
    // is where a phone being suspended lands.
    const interrupted = new Error("the process went away");
    adapter.afterRename = () => {
      throw interrupted;
    };
    await vault
      .removeExpecting("note.md", { contentId: "whatever", idOf }, "kept.md")
      .catch(() => undefined);
    adapter.afterRename = undefined;

    const next = new ObsidianVault(asVault(new FakeVaultIndex(adapter)), ".obsidian");
    await next.list();
    expect(next.stranded, "the interrupted move left nothing pointing at the note").toHaveLength(1);
    expect(next.displaced[0]!.from).toBe("note.md");
    // And the bytes really are at the path it names.
    expect(await adapter.read(next.stranded[0]!)).toBe(MINE);
  });

  it("reports an unreadable record as unknown, not as a clean vault", async () => {
    // RR2. Obsidian's index does not list the hidden folder, so this log is
    // the only source there is. A log that cannot be read produces an empty
    // list, and an empty list used to be indistinguishable from a vault with
    // nothing waiting.
    const adapter = new FakeAdapter();
    adapter.seed("note.md", MINE);
    const vault = new ObsidianVault(asVault(new FakeVaultIndex(adapter)), ".obsidian");
    adapter.fault = (op, _path, to) =>
      op === "rename" && to === "kept.md" ? new Error("the conflict name is taken") : undefined;
    await vault.removeExpecting("note.md", { contentId: "whatever", idOf }, "kept.md");
    adapter.fault = undefined;

    const next = new ObsidianVault(asVault(new FakeVaultIndex(adapter)), ".obsidian");
    next.list;
    adapter.fault = (op, path) =>
      op === "read" && path.endsWith(DISPLACED_LOG) ? new Error("permission denied") : undefined;
    await next.list();
    adapter.fault = undefined;

    expect(next.stranded).toEqual([]);
    expect(next.recovery.complete, "an unreadable log was reported as a clean vault").toBe(false);
    expect(next.recovery.why).toContain("could not be read");
  });

  it("keeps the record across a restart", async () => {
    const adapter = new FakeAdapter();
    adapter.seed("note.md", MINE);
    const first = new ObsidianVault(asVault(new FakeVaultIndex(adapter)), ".obsidian");
    adapter.fault = (op, _path, to) =>
      op === "rename" && to === "kept.md" ? new Error("the conflict name is taken") : undefined;
    const out = await first.removeExpecting("note.md", { contentId: "whatever", idOf }, "kept.md");
    adapter.fault = undefined;

    // A new plugin instance over the same vault, which is what reopening
    // Obsidian is.
    const second = new ObsidianVault(asVault(new FakeVaultIndex(adapter)), ".obsidian");
    await second.list();
    expect(second.stranded).toEqual([out.keptAt]);
    expect(second.displaced[0]!.why).toContain("could not be dealt with");
  });
});
