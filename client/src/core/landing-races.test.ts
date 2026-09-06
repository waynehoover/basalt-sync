/**
 * What happens when the vault changes under a decision already taken (F01).
 *
 * A pass decides what to do from a scan, then goes to the network, then
 * writes. The gap between the decision and the write is a fetch, which on a
 * slow link is seconds, and the person using the vault is typing throughout
 * it. Serialising engine passes does not serialise the editor.
 *
 * Every test here edits, replaces or deletes a note inside that gap and
 * asserts the same property: the bytes on this disk that nobody has sent
 * anywhere are still there afterwards. Keeping both copies is the answer the
 * engine already has for a divergence; the bug was that it never asked.
 */

import { describe, expect, it } from "vitest";

import { macEntry, sealChunks, sealPath, type Schedule } from "./crypto.ts";
import { FakeSocket, engineOnFakeSocket, settle } from "./fake-socket.ts";
import type { WireEntry } from "./transport.ts";
import { MemoryVault } from "./vault.ts";

const enc = new TextEncoder();

async function entryFor(
  keys: Schedule,
  uid: number,
  path: string,
  text: string,
  bodies: Map<string, Uint8Array>,
  over: { deleted?: boolean; mtime?: number } = {},
): Promise<WireEntry> {
  const plain = enc.encode(text);
  const [chunk] = await sealChunks(keys, [plain]);
  bodies.set(chunk!.name, chunk!.bytes);
  const facts = {
    path: await sealPath(keys, path),
    size: plain.length,
    ctime: 1000,
    mtime: over.mtime ?? 1000,
    folder: false,
    deleted: over.deleted ?? false,
    chunks: over.deleted ? [] : [chunk!.name],
    parent: "",
  };
  return { uid, ...facts, device: "other", mac: await macEntry(keys, facts) };
}

/**
 * A server that answers fetches, and runs `during` before it sends the bodies.
 *
 * That callback is the editor: it is the only moment the test can write to
 * the vault after the engine has decided what to do with it and before the
 * engine acts on that decision.
 */
function servingWith(
  socket: FakeSocket,
  bodies: Map<string, Uint8Array>,
  during?: () => Promise<void> | void,
): void {
  socket.autoReply = (frame, s) => {
    if (frame["op"] === "fetch") {
      const send = (): void =>
        void s.bodies(...(frame["chunks"] as string[]).map((n) => bodies.get(n)!));
      const ran = during?.();
      if (ran instanceof Promise) void ran.then(send);
      else send();
    } else if (frame["op"] === "ping") s.raw({ res: "pong" });
  };
}

async function accepted(engine: { status(): { pending: number } }, n: number): Promise<void> {
  for (let i = 0; i < 400 && engine.status().pending < n; i++) await settle();
}

/** Whatever the vault holds that is not `path`, which is where a copy lands. */
function beside(vault: MemoryVault, path: string): { path: string; text: string }[] {
  return vault
    .paths()
    .filter((p) => p !== path)
    .map((p) => ({ path: p, text: vault.text(p)! }));
}

describe("a note edited while its next version is in flight (F01)", () => {
  it("keeps the edit, and puts the incoming version beside it", async () => {
    const { engine, socket, vault, keys } = await engineOnFakeSocket();
    const bodies = new Map<string, Uint8Array>();
    servingWith(socket, bodies);

    socket.raw({
      op: "batch",
      from: 1,
      to: 1,
      entries: [await entryFor(keys, 1, "note.md", "one", bodies)],
    });
    await accepted(engine, 1);
    await engine.sync({ coalesceWrites: false });
    expect(vault.text("note.md")).toBe("one");

    // Version two is announced, and the editor saves over the note while its
    // body is on the wire.
    const two = await entryFor(keys, 2, "note.md", "two", bodies, { mtime: 2000 });
    servingWith(socket, bodies, async () => {
      await vault.write("note.md", enc.encode("mine"), { mtime: 5000, ctime: 1000 });
    });
    socket.raw({ op: "batch", from: 2, to: 2, entries: [two] });
    await accepted(engine, 1);

    const report = await engine.sync({ coalesceWrites: false });

    expect(vault.text("note.md"), "the unsent edit was overwritten by the incoming version").toBe(
      "mine",
    );
    const copies = beside(vault, "note.md");
    expect(
      copies.map((c) => c.text),
      `nothing beside the note: ${JSON.stringify(copies)}`,
    ).toContain("two");
    expect(report.conflicted, "keeping both was not reported as a conflict").toBe(1);
  });

  it("keeps a note created under the path while a first version is in flight", async () => {
    const { engine, socket, vault, keys } = await engineOnFakeSocket();
    const bodies = new Map<string, Uint8Array>();

    // Nothing is here when the decision is taken, so the engine plans a plain
    // write. The person creates a note at that path before the body lands.
    const one = await entryFor(keys, 1, "fresh.md", "from the server", bodies);
    servingWith(socket, bodies, async () => {
      await vault.write("fresh.md", enc.encode("typed here first"), { mtime: 5000, ctime: 5000 });
    });
    socket.raw({ op: "batch", from: 1, to: 1, entries: [one] });
    await accepted(engine, 1);

    const report = await engine.sync({ coalesceWrites: false });

    expect(vault.text("fresh.md"), "a note created during the fetch was overwritten").toBe(
      "typed here first",
    );
    expect(beside(vault, "fresh.md").map((c) => c.text)).toContain("from the server");
    expect(report.conflicted).toBe(1);
  });
});

describe("a note edited while an incoming deletion is in flight (F01)", () => {
  it("does not delete bytes the server has never seen", async () => {
    const { engine, socket, vault, keys } = await engineOnFakeSocket();
    const bodies = new Map<string, Uint8Array>();
    servingWith(socket, bodies);

    socket.raw({
      op: "batch",
      from: 1,
      to: 1,
      entries: [await entryFor(keys, 1, "doomed.md", "one", bodies)],
    });
    await accepted(engine, 1);
    await engine.sync({ coalesceWrites: false });
    expect(vault.text("doomed.md")).toBe("one");

    // The deletion carries no body, so there is nothing to hide inside on
    // its own. A real pass has other work: deletions are applied at the end,
    // after every download, so the fetch for an unrelated note is exactly
    // the window in which the editor saves over the doomed one.
    const gone = await entryFor(keys, 2, "doomed.md", "", bodies, { deleted: true, mtime: 2000 });
    const other = await entryFor(keys, 3, "other.md", "unrelated", bodies);
    servingWith(socket, bodies, async () => {
      await vault.write("doomed.md", enc.encode("still writing this"), {
        mtime: 5000,
        ctime: 1000,
      });
    });
    socket.raw({ op: "batch", from: 2, to: 3, entries: [gone, other] });
    await accepted(engine, 1);

    await engine.sync({ coalesceWrites: false });

    expect(
      vault.text("doomed.md"),
      "an incoming deletion removed a local edit the server had never seen",
    ).toBe("still writing this");
  });
});

/**
 * A client that connected to look wrote to the vault anyway (F08).
 *
 * `history`, `deleted`, `devices`, `invite` and `status` do not take the
 * vault's lock, and that is deliberate: looking is not writing, and holding
 * the lock would make `status` refuse exactly while a watcher is running,
 * which is when somebody asks. But the client they built scheduled a sync
 * the moment a batch arrived, so an inspection command that stayed connected
 * long enough downloaded notes and saved an index with no lock held and
 * nobody having asked it to.
 */
describe("a client connected only to look (F08)", () => {
  it("takes a batch and neither downloads it nor saves an index", async () => {
    const { Client } = await import("./client.ts");
    const { MemoryIndexStore } = await import("./vault.ts");
    const { TEST_DATA_KEY, testKeys } = await import("./test-keys.ts");
    const { FakeSocket, ready, RIG_SECRET } = await import("./fake-socket.ts");

    const socket = new FakeSocket();
    const bodies = new Map<string, Uint8Array>();
    const keys = await testKeys(RIG_SECRET);
    const looking = new MemoryVault();
    const store = new MemoryIndexStore();
    const client = new Client({
      vault: looking,
      store,
      dataKey: TEST_DATA_KEY,
      url: "ws://test",
      deviceId: "inspector",
      token: "t",
      vaultId: "v",
      device: "d",
      inspect: true,
      socketFactory: () => socket,
    });

    const connecting = client.connect({ waitForBacklog: false });
    socket.open();
    await settle();
    socket.reply(ready({ cursor: 0 }));
    await connecting;

    // A note arrives while this command is still printing its answer, which
    // is all it takes: catch-up delivers batches to whoever is connected.
    servingWith(socket, bodies);
    socket.raw({
      op: "batch",
      from: 1,
      to: 1,
      entries: [await entryFor(keys, 1, "arrived.md", "not asked for", bodies)],
    });
    // Well past the arrival delay a syncing client would have fired on.
    await new Promise((r) => setTimeout(r, 400));

    expect(looking.paths(), "a command that only looks downloaded a note into the vault").toEqual(
      [],
    );
    expect(await store.load(), "a command that only looks saved an index").toBeUndefined();

    // And asking it to sync is a mistake it names rather than performs.
    await expect(client.sync()).rejects.toThrow(/connected to read, not to sync/);
    await client.close();
  });
});

/**
 * Replay of a signed old version, which the server can do and nothing here
 * detects (F11).
 *
 * The entry authenticator covers the content, the metadata and the version
 * this one was written on top of. It does not cover the uid, because the
 * server assigns uids and ordering the log is its job. So a server can take a
 * version a device really did write, hand it back under a newer uid, and the
 * receiving device applies it: the note reverts to contents it genuinely had
 * once, with a valid signature on the entry that did it.
 *
 * These are pinned rather than fixed. docs/design.md says so under what the
 * server can do, and describes the ancestry check that would close it. If a
 * later change makes one of them fail, that is the fix landing, and the test
 * should become an assertion of the new behaviour rather than be deleted.
 */
describe("a server that replays a signed old version (F11, pinned)", () => {
  it("reverts a note, because nothing binds a version to its place in the log", async () => {
    const { engine, socket, vault, keys } = await engineOnFakeSocket();
    const bodies = new Map<string, Uint8Array>();
    servingWith(socket, bodies);

    const one = await entryFor(keys, 1, "note.md", "the first version", bodies);
    socket.raw({ op: "batch", from: 1, to: 1, entries: [one] });
    await accepted(engine, 1);
    await engine.sync({ coalesceWrites: false });

    const two = await entryFor(keys, 2, "note.md", "the second version", bodies, { mtime: 2000 });
    socket.raw({ op: "batch", from: 2, to: 2, entries: [two] });
    await accepted(engine, 1);
    await engine.sync({ coalesceWrites: false });
    expect(vault.text("note.md")).toBe("the second version");

    // The same entry the device accepted as version one, handed back with a
    // uid that makes it look like the newest thing on the server. Its MAC is
    // the original and verifies, because it is the original.
    socket.raw({ op: "batch", from: 3, to: 3, entries: [{ ...one, uid: 3 }] });
    await accepted(engine, 1);
    await engine.sync({ coalesceWrites: false });

    expect(
      vault.text("note.md"),
      "the replay was detected, which is a fix: update this test to assert it",
    ).toBe("the first version");
  });

  /**
   * The tombstone case, which turns out to be covered already, and by the
   * ordinary divergence rules rather than by anything about replay: the note
   * has been written here since the deletion, so an incoming deletion is not
   * a continuation of what this device holds and the local copy wins. Kept as
   * the boundary of the gap above, so that a change which widens it fails
   * here.
   */
  it("does not delete a note written since, even when the tombstone is replayed", async () => {
    const { engine, socket, vault, keys } = await engineOnFakeSocket();
    const bodies = new Map<string, Uint8Array>();
    servingWith(socket, bodies);

    socket.raw({
      op: "batch",
      from: 1,
      to: 1,
      entries: [await entryFor(keys, 1, "gone.md", "here for now", bodies)],
    });
    await accepted(engine, 1);
    await engine.sync({ coalesceWrites: false });

    const tomb = await entryFor(keys, 2, "gone.md", "", bodies, { deleted: true, mtime: 2000 });
    socket.raw({ op: "batch", from: 2, to: 2, entries: [tomb] });
    await accepted(engine, 1);
    await engine.sync({ coalesceWrites: false });
    expect(vault.text("gone.md")).toBeUndefined();

    // Written again on this device, and then the old tombstone comes back.
    await vault.edit("gone.md", "typed again after the deletion", 6000);
    await engine.sync({ coalesceWrites: false });
    socket.raw({ op: "batch", from: 3, to: 3, entries: [{ ...tomb, uid: 4 }] });
    await accepted(engine, 1);
    await engine.sync({ coalesceWrites: false });

    expect(
      vault.text("gone.md"),
      "a replayed tombstone removed a note this device had written since",
    ).toBe("typed again after the deletion");
  });
});

/**
 * Filenames that are property names on an ordinary object (F14).
 *
 * `entries["__proto__"] = e` does not add a key. It sets the prototype, or on
 * a frozen prototype does nothing at all, and the assignment succeeds either
 * way. So a vault holding a note called `__proto__` downloaded it, advanced
 * the cursor, and saved an index with no record of it: the note was on disk
 * and the index had never heard of it, for ever. `constructor` and `toString`
 * are the same trick under different names, and a delta naming one of them
 * replayed into a state it was missing from.
 *
 * These are legal filenames on every filesystem Basalt runs on.
 */
describe("a note whose name is a property name (F14)", () => {
  const awkward = ["__proto__", "constructor", "toString", "hasOwnProperty"];

  it("survives a download, a save and a restart", async () => {
    const { engine, socket, vault, keys } = await engineOnFakeSocket();
    const bodies = new Map<string, Uint8Array>();
    servingWith(socket, bodies);

    const entries = await Promise.all(
      awkward.map((name, i) => entryFor(keys, i + 1, name, `contents of ${name}`, bodies)),
    );
    socket.raw({ op: "batch", from: 1, to: awkward.length, entries });
    await accepted(engine, 1);
    await engine.sync({ coalesceWrites: false });

    for (const name of awkward) {
      expect(vault.text(name), `${name} was not written to the vault`).toBe(`contents of ${name}`);
    }

    // The index has to name every one of them, or the next pass downloads
    // them all again and the pass after that reports them deleted.
    const state = (await (
      engine as unknown as { opts: { store: { load(): Promise<unknown> } } }
    ).opts.store.load()) as { entries: Record<string, unknown>; remote: Record<string, unknown> };
    for (const name of awkward) {
      expect(
        Object.prototype.hasOwnProperty.call(state.entries, name),
        `the saved index has no entry for ${name}`,
      ).toBe(true);
      expect(
        Object.prototype.hasOwnProperty.call(state.remote, name),
        `the saved index has no server record for ${name}`,
      ).toBe(true);
    }
  });

  it("round-trips through a journal delta and its replay", async () => {
    const { applyDelta, deltaBetween } = await import("./index-journal.ts");
    const empty = { cursor: 0, entries: {}, remote: {}, pending: [] } as unknown as Parameters<
      typeof deltaBetween
    >[0];
    const withThem = {
      cursor: 4,
      entries: Object.fromEntries(awkward.map((n) => [n, { path: n, size: 1 }])),
      remote: Object.fromEntries(awkward.map((n) => [n, { uid: 1 }])),
      pending: awkward,
    } as unknown as Parameters<typeof deltaBetween>[0];

    const delta = deltaBetween(empty, withThem);
    expect(delta, "nothing was recorded as changed").toBeDefined();
    const back = applyDelta(empty, delta!) as unknown as { entries: Record<string, unknown> };
    for (const name of awkward) {
      expect(
        Object.prototype.hasOwnProperty.call(back.entries, name),
        `${name} did not survive the delta`,
      ).toBe(true);
    }

    // And removing them again leaves nothing behind, rather than a key that
    // cannot be deleted because it was never really there.
    const gone = applyDelta(back as never, deltaBetween(withThem, empty)!) as unknown as {
      entries: Record<string, unknown>;
    };
    for (const name of awkward) {
      expect(
        Object.prototype.hasOwnProperty.call(gone.entries, name),
        `${name} could not be removed`,
      ).toBe(false);
    }
  });
});

/**
 * A pass that fails outright, from wherever it was started (F16).
 *
 * `Client.sync` swallows exceptions on purpose: most of its callers are event
 * handlers with nothing useful to do with one, a ticker, an arriving batch, a
 * file the host says was saved. What it did with the exception was log it if
 * a logger happened to be configured, and nothing else. So a device that
 * connected and then failed every pass went on showing the status of the last
 * pass that worked, which is the status rule in docs/design.md read backwards.
 */
describe("a background pass that fails (F16)", () => {
  it("tells the shell, rather than logging it if anybody asked", async () => {
    const { Client } = await import("./client.ts");
    const { MemoryIndexStore } = await import("./vault.ts");
    const { TEST_DATA_KEY } = await import("./test-keys.ts");
    const { FakeSocket, ready } = await import("./fake-socket.ts");

    const socket = new FakeSocket();
    const failures: string[] = [];
    const client = new Client({
      vault: new MemoryVault(),
      store: new MemoryIndexStore(),
      dataKey: TEST_DATA_KEY,
      url: "ws://test",
      deviceId: "d",
      token: "t",
      vaultId: "v",
      device: "d",
      socketFactory: () => socket,
      onSyncFailed: (err) => void failures.push(err.message),
    });
    const connecting = client.connect({ waitForBacklog: false });
    socket.open();
    await settle();
    socket.reply(ready({ cursor: 0 }));
    await connecting;

    // A pass that cannot finish: the engine throws rather than filing one
    // path for retry, which is the whole-pass case `onPass` never sees.
    (client as unknown as { engine: { sync(): Promise<never> } }).engine.sync = async () => {
      throw new Error("the index will not save");
    };

    const report = await client.sync();
    expect(report, "a failed pass reported a result").toBeUndefined();
    expect(failures, "the shell was never told the pass failed").toEqual([
      "the index will not save",
    ]);
    await client.close();
  });
});
