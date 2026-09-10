import { afterEach, expect, it } from "vitest";
import { Client } from "./client.ts";
import { MemoryIndexStore, MemoryVault } from "./vault.ts";
import { TestServer } from "./test-server.ts";
import { testWrapped } from "./test-keys.ts";
import { receiveCommitted } from "./test-async.ts";

let server: TestServer;
let client: Client;
afterEach(async () => {
  await client?.close();
  await server?.cleanup();
});
it("returns to an edited open note before preparing the remaining attachments", async () => {
  server = new TestServer();
  await server.start();
  const vault = new MemoryVault(),
    order: string[] = [];
  const secret = new Uint8Array(32).fill(55);
  client = new Client({
    vault,
    store: new MemoryIndexStore(),
    url: server.wsUrl,
    ...(await server.deviceCredentials(secret, await testWrapped(secret))),
    vaultId: "default",
    device: "phone",
    inspect: true,
    activePath: () => "note.md",
    onActivity: (event) => {
      if (event.action === "uploaded") order.push(event.path!);
    },
  });
  await client.connect();
  await vault.edit("note.md", "before");
  await client.engine.sync({ coalesceWrites: false });
  order.length = 0;
  await vault.edit("a.bin", "attachment-a");
  await vault.edit("z.bin", "attachment-z");
  const read = vault.read.bind(vault);
  let changed = false;
  vault.read = async (path) => {
    if (path === "a.bin" && !changed) {
      changed = true;
      await vault.edit("note.md", "edited while transferring");
      client.noteChanged("note.md");
    }
    return read(path);
  };
  await client.engine.sync({ coalesceWrites: false });
  expect(order.indexOf("note.md")).toBeGreaterThanOrEqual(0);
  expect(order.indexOf("note.md")).toBeLessThan(order.indexOf("z.bin"));
  expect(vault.text("note.md")).toBe("edited while transferring");
});

it.each(["oversized", "unreadable"] as const)(
  "syncs background notes when the active note is %s and has pending remote work",
  async (failure) => {
    server = new TestServer();
    server.extraArgs = ["-max-file", "64"];
    await server.start();
    const secret = new Uint8Array(32).fill(56),
      wrapped = await testWrapped(secret);
    const source = new MemoryVault();
    const writer = new Client({
      vault: source,
      store: new MemoryIndexStore(),
      url: server.wsUrl,
      ...(await server.deviceCredentials(secret, wrapped, "writer")),
      vaultId: "default",
      device: "writer",
      coalesceWrites: false,
    });
    try {
      await writer.connect();
      await source.edit("active.md", "remote edit");
      await source.edit("background.md", "another device's note");
      await writer.settle();
      const vault = new MemoryVault();
      const local = failure === "oversized" ? "local draft ".repeat(10) : "local draft";
      await vault.edit("active.md", local);
      if (failure === "unreadable") {
        const read = vault.read.bind(vault);
        vault.read = (path) => {
          if (path === "active.md") throw new Error("temporarily unreadable");
          return read(path);
        };
      }
      client = new Client({
        vault,
        store: new MemoryIndexStore(),
        url: server.wsUrl,
        ...(await server.deviceCredentials(secret, wrapped, "reader")),
        vaultId: "default",
        device: "reader",
        inspect: true,
        activePath: () => "active.md",
      });
      await client.connect();
      for (let round = 0; round < 2; round++) {
        const report = await client.engine.sync({ coalesceWrites: false });
        expect(vault.text("background.md")).toBe("another device's note");
        expect(vault.text("active.md")).toBe(local);
        if (failure === "oversized") expect(report.nextUploadAt).toBeUndefined();
        else expect(report.nextUploadAt).toBeGreaterThan(Date.now());
        expect(report.appliedCursor).toBeUndefined();
        expect(failure === "oversized" ? report.skipped : report.retrying).toBe(1);
      }
      expect(await writer.history("active.md")).toHaveLength(1);
    } finally {
      await writer.close();
    }
  },
);

it("prioritizes a remote edit arriving while the active note is being read", async () => {
  server = new TestServer();
  await server.start();
  const secret = new Uint8Array(32).fill(57),
    wrapped = await testWrapped(secret);
  const source = new MemoryVault();
  const writer = new Client({
    vault: source,
    store: new MemoryIndexStore(),
    url: server.wsUrl,
    ...(await server.deviceCredentials(secret, wrapped, "writer")),
    vaultId: "default",
    device: "writer",
    coalesceWrites: false,
  });
  try {
    await writer.connect();
    await source.edit("active.md", "before");
    await writer.settle();
    const vault = new MemoryVault();
    client = new Client({
      vault,
      store: new MemoryIndexStore(),
      url: server.wsUrl,
      ...(await server.deviceCredentials(secret, wrapped, "reader")),
      vaultId: "default",
      device: "reader",
      inspect: true,
      activePath: () => "active.md",
    });
    await client.connect();
    await client.engine.sync({ coalesceWrites: false });
    expect(vault.text("active.md")).toBe("before");
    await vault.edit("background.bin", "attachment");
    const read = vault.read.bind(vault);
    let arrived = false;
    let readAttachment = false;
    vault.read = async (path) => {
      if (path === "active.md" && !arrived) {
        arrived = true;
        await source.edit("active.md", "incoming edit");
        await writer.settle();
        await receiveCommitted(client.transport);
      }
      if (path === "background.bin") {
        readAttachment = true;
        expect(vault.text("active.md")).toBe("incoming edit");
      }
      return read(path);
    };
    client.noteChanged("active.md");
    const report = await client.engine.sync({ coalesceWrites: false });
    expect(arrived && readAttachment).toBe(true);
    expect(vault.text("active.md")).toBe("incoming edit");
    expect(report.retrying).toBe(0);
    expect(report.nextUploadAt).toBeUndefined();
  } finally {
    await writer.close();
  }
});
