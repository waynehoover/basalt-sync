import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { App as ObsidianApp, PluginManifest } from "obsidian";
import BasaltPlugin from "./main.ts";
import { App, built, modals, resetStub, type Plugin as StubPlugin } from "./stub.ts";
import { Client, type DeletedList } from "../core/client.ts";
import { TestServer } from "../core/test-server.ts";
import { nextTurn, receiveCommitted, within } from "../core/test-async.ts";

type TestPlugin = BasaltPlugin & StubPlugin;
const plugins: TestPlugin[] = [];
let server: TestServer | undefined;

beforeEach(() => {
  resetStub();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(async () => {
  for (const plugin of plugins.splice(0)) {
    plugin.onunload();
    await plugin.closing;
  }
  await server?.cleanup();
  server = undefined;
  vi.restoreAllMocks();
});

async function load() {
  const app = new App();
  const plugin = new BasaltPlugin(
    app as unknown as ObsidianApp,
    {
      id: "basalt-sync",
      dir: ".obsidian/plugins/basalt-sync",
    } as PluginManifest,
  ) as TestPlugin;
  (plugin as unknown as { confirmSync(): Promise<boolean> }).confirmSync = async () => true;
  plugins.push(plugin);
  await plugin.onload();
  return { app, plugin };
}

async function synced(plugin: TestPlugin) {
  if (plugin.currentState.kind === "synced") return;
  await within(
    new Promise<void>((resolve) => {
      const stop = plugin.watchState((state) => {
        if (state.kind === "synced") {
          stop();
          resolve();
        }
      });
    }),
    "plugin to sync",
    15000,
  );
}

const client = (plugin: TestPlugin) => (plugin as unknown as { client: Client }).client;
const button = (label: string) =>
  built
    .flatMap((row) => row.buttons)
    .reverse()
    .find((b) => b.label === label);

it("restores the selected deletion's content when a peer has since reused its name", async () => {
  server = new TestServer();
  await server.start();
  const a = await load();
  a.app.vault.adapter.seed("Note.md", "the deleted note\n");
  const key = await a.plugin.pairFirst(server.setup, "laptop");
  await synced(a.plugin);
  const b = await load();
  await b.plugin.pair(key, "phone");
  await synced(b.plugin);

  await a.app.vault.adapter.remove("Note.md");
  await a.plugin.syncNow();
  await receiveCommitted(client(b.plugin).transport);
  await b.plugin.syncNow();
  const deletion = (await b.plugin.deletedNotes()).notes.find((note) => note.path === "Note.md")!;
  expect(deletion).toBeDefined();

  a.app.vault.adapter.seed("Note.md", "a different new note\n", Date.now() + 1000);
  await a.plugin.syncNow();
  await receiveCommitted(client(b.plugin).transport);
  await b.plugin.syncNow();
  expect(b.app.vault.adapter.text("Note.md")).toBe("a different new note\n");

  const restored = await b.plugin.recover(deletion);
  expect(restored.path).not.toBe("Note.md");
  expect(b.app.vault.adapter.text("Note.md")).toBe("a different new note\n");
  expect(b.app.vault.adapter.text(restored.path)).toBe("the deleted note\n");
  expect(restored.sent).toBe(true);
  await receiveCommitted(client(a.plugin).transport);
  await a.plugin.syncNow();
  expect(a.app.vault.adapter.text(restored.path)).toBe("the deleted note\n");
});

const deleted = (uid: number, path: string): DeletedList["notes"][number] => ({
  uid,
  path,
  mtime: 1000,
  ctime: 1000,
  size: 0,
  folder: false,
  deleted: true,
  device: "phone",
  chunks: 0,
  contentId: "-empty-",
  restorable: uid - 1,
});

it("keeps a way back to newer deletions after the last note on an older page is restored", async () => {
  const { plugin } = await load();
  let restored = false;
  const newest = deleted(100, "Newer.md");
  const older = deleted(10, "Older.md");
  plugin.deletedNotes = async (_limit, before) =>
    before === undefined
      ? { notes: [newest], more: true, oldest: newest.uid }
      : { notes: restored ? [] : [older], more: false, oldest: older.uid };
  plugin.recover = async () => {
    restored = true;
    return { path: older.path, sent: true };
  };
  plugin.commands.find((command) => command.id === "recover-deleted")!.callback!();
  await nextTurn();
  await button("Show older")!.click();
  const restore = button("Restore")!;
  built.length = 0;
  const modal = modals.at(-1)!;
  await restore.click();
  expect(button("Newest"), "an empty older page must not hide the route back").toBeDefined();
  const newestButton = button("Newest")!;
  built.length = 0;
  await newestButton.click();
  expect(built.map((row) => row.name)).toContain("Newer.md");
  modal.close();
});

it("lets a deleted-note lookup retry after the connection recovers", async () => {
  const { plugin } = await load();
  let calls = 0;
  plugin.deletedNotes = async () => {
    if (++calls === 1) throw new Error("Connection lost");
    return { notes: [deleted(20, "Recovered connection.md")], more: false };
  };
  plugin.commands.find((command) => command.id === "recover-deleted")!.callback!();
  await nextTurn();
  const modal = modals.at(-1)!;
  expect(modal.contentEl.allText()).toContain("Connection lost");
  expect(button("Try again")).toBeDefined();
  const retry = button("Try again")!;
  built.length = 0;
  await retry.click();
  expect(built.map((row) => row.name)).toContain("Recovered connection.md");
  modal.close();
});
