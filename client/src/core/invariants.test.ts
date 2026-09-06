/**
 * The six properties everything else is in service of (I19).
 *
 * The suite has plenty of tests that follow a branch. These follow a promise
 * instead, and each one is written so that a change which breaks the promise
 * fails here whatever route it took to break it. Where a property is already
 * pinned in detail somewhere else, this asserts it once more at the boundary
 * and names the file that owns the detail: the point of collecting them is
 * that the list can be read, not that the assertions are new.
 *
 * 1. Every acknowledged version is readable after a restart.
 *    `server/internal/store` TestEntriesAndChunksSurviveAReopen, plus the
 *    restore rehearsal behind the `rehearsal` build tag. Server-side, so it
 *    is named here and asserted there.
 * 2. A newer local edit survives. `landing-races.test.ts` (F01).
 * 3. Only one writer owns a vault. `cli/lock.test.ts` (F07).
 * 4. Recovery material survives an uncertain result. `plugin/main.test.ts`
 *    and `cli/state.test.ts` (F02, F03).
 * 5. Failed input does not advance a cursor. Here, because nothing owned it.
 * 6. A read does not mutate. `landing-races.test.ts` (F08), and here for the
 *    recovery reads, which are the ones a person runs while worried.
 */

import { describe, expect, it } from "vitest";

import { macEntry, sealChunks, sealPath, type Schedule } from "./crypto.ts";
import { FakeSocket, engineOnFakeSocket, settle } from "./fake-socket.ts";
import type { WireEntry } from "./transport.ts";
import { otherVaultKeys } from "./test-keys.ts";

const enc = new TextEncoder();

async function entryFor(
  keys: Schedule,
  uid: number,
  path: string,
  text: string,
  bodies: Map<string, Uint8Array>,
): Promise<WireEntry> {
  const plain = enc.encode(text);
  const [chunk] = await sealChunks(keys, [plain]);
  bodies.set(chunk!.name, chunk!.bytes);
  const facts = {
    path: await sealPath(keys, path),
    size: plain.length,
    ctime: 1000,
    mtime: 1000,
    folder: false,
    deleted: false,
    chunks: [chunk!.name],
    parent: "",
  };
  return { uid, ...facts, device: "other", mac: await macEntry(keys, facts) };
}

function serving(socket: FakeSocket, bodies: Map<string, Uint8Array>): void {
  socket.autoReply = (frame, s) => {
    if (frame["op"] === "fetch") {
      s.bodies(...(frame["chunks"] as string[]).map((n) => bodies.get(n)!));
    } else if (frame["op"] === "ping") s.raw({ res: "pong" });
  };
}

/**
 * Input this device refuses must leave its cursor where it was.
 *
 * The cursor is the whole of what a device remembers about how far it has
 * read, and it is the one number a later pass will not re-examine. Advancing
 * it over a batch that was not applied is a hole nothing asks about again:
 * the versions in it are never fetched, no error is outstanding, and every
 * report says the vault is current. That is the exact shape of the failures
 * this project keeps finding, so it gets a property of its own.
 */
describe("failed input does not advance a cursor", () => {
  it("refuses a batch signed by another vault, and remembers nothing of it", async () => {
    const { engine, socket, vault, t, logs, keys } = await engineOnFakeSocket();
    void keys;
    const bodies = new Map<string, Uint8Array>();
    serving(socket, bodies);

    const before = engine.status().cursor;
    const theirs = await otherVaultKeys(9);
    // A well-formed batch in every respect except the key that signed it.
    const forged = await entryFor(theirs, 1, "theirs.md", "not from this vault", bodies);
    socket.raw({ op: "batch", from: 1, to: 1, entries: [forged] });
    await settle();
    await settle();

    // The batch was delivered and refused, rather than never arriving: without
    // this the assertions below would hold for a test that did nothing.
    expect(
      t.isClosed || logs.some((l) => /forg|not this vault|vault's key/i.test(l)),
      `nothing refused the forged batch, so this proves nothing: ${logs.join(" | ")}`,
    ).toBe(true);
    expect(engine.status().cursor, "the cursor moved over a batch this device refused").toBe(
      before,
    );
    expect(vault.paths(), "a refused batch wrote a note").toEqual([]);
  });

  it("keeps the cursor where the last applied entry left it, not where the batch claimed", async () => {
    const { engine, socket, vault, keys } = await engineOnFakeSocket();
    const bodies = new Map<string, Uint8Array>();
    serving(socket, bodies);

    // One good batch, applied.
    socket.raw({
      op: "batch",
      from: 1,
      to: 1,
      entries: [await entryFor(keys, 1, "good.md", "kept", bodies)],
    });
    for (let i = 0; i < 200 && engine.status().pending < 1; i++) await settle();
    await engine.sync({ coalesceWrites: false });
    const applied = engine.status().cursor;
    expect(applied).toBeGreaterThan(0);
    expect(vault.text("good.md")).toBe("kept");

    // Then one this device cannot accept. The claimed range says 2 to 9,
    // which is what a device that trusted the header would jump to.
    const theirs = await otherVaultKeys(9);
    socket.raw({
      op: "batch",
      from: 2,
      to: 9,
      entries: [await entryFor(theirs, 9, "theirs.md", "not from this vault", bodies)],
    });
    await settle();
    await settle();

    expect(engine.status().cursor, "the cursor jumped to the end of a batch that was refused").toBe(
      applied,
    );
  });
});

/**
 * Reading is not writing.
 *
 * The recovery views are what somebody opens when a note has gone missing,
 * which is the worst possible moment for the act of looking to change
 * anything. `history` and `deleted` ask the server a question; neither is
 * allowed to touch the vault or the index on the way to answering it.
 */
describe("a read does not mutate", () => {
  it("leaves the vault and the cursor alone across a history request", async () => {
    const { engine, socket, vault, t, keys } = await engineOnFakeSocket();
    const bodies = new Map<string, Uint8Array>();
    serving(socket, bodies);

    const entry = await entryFor(keys, 1, "note.md", "the only version", bodies);
    socket.raw({ op: "batch", from: 1, to: 1, entries: [entry] });
    for (let i = 0; i < 200 && engine.status().pending < 1; i++) await settle();
    await engine.sync({ coalesceWrites: false });

    const pathsBefore = vault.paths().slice().sort();
    const textBefore = vault.text("note.md");
    const cursorBefore = engine.status().cursor;

    // A real read, answered. This is the request `basalt history` and the
    // panel's version list both make.
    const asking = t.history(entry.path, { limit: 20 });
    await settle();
    socket.reply({ res: "history", path: entry.path, entries: [entry] });
    expect(await asking).toHaveLength(1);

    expect(vault.paths().slice().sort(), "a read changed what is in the vault").toEqual(
      pathsBefore,
    );
    expect(vault.text("note.md"), "a read rewrote a note").toBe(textBefore);
    expect(engine.status().cursor, "a read moved the cursor").toBe(cursorBefore);
  });
});
