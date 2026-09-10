import { afterEach, expect, it } from "vitest";
import { Client } from "./client.ts";
import { MemoryIndexStore, MemoryVault } from "./vault.ts";
import { TestServer } from "./test-server.ts";
import { testWrapped } from "./test-keys.ts";

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
