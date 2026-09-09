/**
 * R1. What a connection has to wait for depends on what the caller is going
 * to do with it.
 *
 * Anything that syncs waits for the backlog, because a pass that runs before
 * catch-up finishes sees a vault the server already has files for and uploads
 * the lot. `basalt status` and the cursor probe in `basalt rebase` do not
 * sync: they read the server's cursor out of the handshake and close. Making
 * them wait meant a device weeks behind unsealed and MAC checked every entry
 * of the backlog before printing one line.
 */

import { describe, expect, it } from "vitest";

import { Client, type ClientOptions } from "./client.ts";
import { FakeSocket, ready, settle } from "./fake-socket.ts";
import { TEST_DATA_KEY } from "./test-keys.ts";
import { MemoryIndexStore, MemoryVault } from "./vault.ts";

/** A client on a socket that will say `ready` and never say `caught-up`. */
function clientOnFakeSocket(extra: Partial<ClientOptions> = {}): {
  socket: FakeSocket;
  client: Client;
} {
  const socket = new FakeSocket();
  const client = new Client({
    vault: new MemoryVault(),
    store: new MemoryIndexStore(),
    dataKey: TEST_DATA_KEY,
    url: "ws://test",
    deviceId: "rig-device",
    token: "t",
    vaultId: "v",
    device: "d",
    timeoutMs: 2000,
    socketFactory: () => socket,
    ...extra,
  });
  return { socket, client };
}

/** Opens the socket and answers the hello, leaving the backlog outstanding. */
async function sayReady(socket: FakeSocket, cursor: number): Promise<void> {
  await settle();
  socket.open();
  for (let i = 0; i < 50 && !socket.sentText.some((m) => m["op"] === "hello"); i++) await settle();
  socket.reply(ready({ cursor }));
  await settle();
}

/** Whether a promise has settled, without waiting on it. */
async function settled(p: Promise<unknown>): Promise<boolean> {
  const pending = Symbol("pending");
  const first = await Promise.race([p.then(() => true), Promise.resolve(pending)]);
  await settle();
  return first !== pending;
}

describe("connecting only as far as the handshake (R1)", () => {
  it("reports authenticated history loading before connect finishes", async () => {
    const progress: { local: number; server: number }[] = [];
    const { socket, client } = clientOnFakeSocket({ onCatchUp: (at) => progress.push(at) });
    const connecting = client.connect();
    connecting.catch(() => undefined);
    try {
      await sayReady(socket, 4);
      // Ready still has to unwrap the vault key; one event-loop tick is not
      // enough to finish WebCrypto when the full suite is competing for CPU.
      await expect.poll(() => client.serverLimits?.cursor).toBe(4);
      expect(progress, "a connected device still looks like a failed connection").toEqual([
        { local: 0, server: 4 },
      ]);
      socket.raw({ op: "batch", from: 1, to: 2, entries: [] });
      await expect.poll(() => client.transport.appliedCursor).toBe(2);
      expect(progress.at(-1)).toEqual({ local: 2, server: 4 });
      expect(await settled(connecting), "progress must not bypass catch-up").toBe(false);
      socket.raw({ op: "batch", from: 3, to: 4, entries: [] });
      socket.raw({ op: "caught-up", cursor: 4 });
      await connecting;
      expect(progress.at(-1)).toEqual({ local: 4, server: 4 });
      const count = progress.length;
      socket.raw({ op: "batch", from: 5, to: 5, entries: [] });
      await expect.poll(() => client.transport.appliedCursor).toBe(5);
      expect(progress.length, "live changes restarted initial-loading feedback").toBe(count);
    } finally {
      await client.close();
      await connecting.catch(() => undefined);
    }
  });

  it("resolves with the server's own cursor without waiting for the backlog", async () => {
    const { socket, client } = clientOnFakeSocket();
    const connecting = client.connect({ waitForBacklog: false });
    await sayReady(socket, 4211);

    // No `caught-up` is ever sent, and the number is the server's own, out of
    // `ready`, which is what status prints.
    const limits = await connecting;
    expect(limits.cursor).toBe(4211);
    expect(client.serverCursor).toBe(4211);
    await client.close();
  });

  it("still waits for the backlog by default, which is what a sync needs", async () => {
    const { socket, client } = clientOnFakeSocket();
    const connecting = client.connect();
    // It fails on its own timeout eventually. What matters here is that it
    // has not finished while the server is still owed a `caught-up`.
    connecting.catch(() => undefined);
    // At zero, because the transport refuses a catch-up ahead of the batches
    // it was given, and this rig sends none.
    await sayReady(socket, 0);

    expect(await settled(connecting), "a sync connected before catch-up").toBe(false);

    socket.raw({ op: "caught-up", cursor: 0 });
    expect((await connecting).cursor).toBe(0);
    await client.close();
  });
});
