import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TestServer, removeTree } from "../core/test-server.ts";
import { deferred, within } from "../core/test-async.ts";
import { buildMcp, cli, openMcp, tool } from "./mcp-test.ts";
import { loadConfig, saveConfig } from "./config.ts";

let buildDir: string, bundle: string;
const roots: string[] = [];
const hosts: Awaited<ReturnType<typeof openMcp>>[] = [];
let server: TestServer | undefined;
beforeAll(async () => {
  buildDir = await mkdtemp(join(tmpdir(), "basalt-mcp-build-"));
  bundle = await buildMcp(buildDir);
}, 30000);
afterAll(async () => {
  await removeTree(buildDir);
});
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  await server?.cleanup();
  server = undefined;
  for (const dir of roots.splice(0)) await removeTree(dir);
});
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), "basalt-mcp-"));
  roots.push(dir);
  return dir;
}
async function paired() {
  server = new TestServer();
  await server.start();
  const dir = await directory();
  const initialized = await cli("init", server.setup, "--dir", dir, "--json");
  expect(initialized.code, initialized.err).toBe(0);
  return { dir, key: JSON.parse(initialized.out).recoveryKey as string };
}
async function host(dir: string, flags: string[] = [], modern = false) {
  const result = await openMcp(bundle, dir, flags, modern);
  hosts.push(result);
  return result;
}
async function ready(client: Awaited<ReturnType<typeof host>>["client"]) {
  await within(
    (async () => {
      for (;;) {
        const status = await tool(client, "sync_status");
        if (status.writeReady) return;
        if (status.connection === "fatal") throw new Error(JSON.stringify(status));
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    })(),
    "MCP initial sync",
    15000,
  );
}

it("edits two daily tasks over stdio while keeping unrelated bytes and the backup on a second device", async () => {
  const { dir, key } = await paired();
  const name = "Daily/2026-09-14.md";
  const original =
    "\ufeff---\r\nprivate: true\r\n---\r\nUnsent marker 982317 with [[a link]].\r\n- [ ] Call Sam\r\n- [ ] Pay bill\r\nKeep every unrelated paragraph.\r\n";
  await mkdir(join(dir, "Daily"));
  await writeFile(join(dir, name), original);
  const { client } = await host(dir, ["--verbose"]);
  await ready(client);
  const listed = await tool(client, "list_notes", { folder: "Daily", nameContains: "2026-09-14" });
  expect(listed.entries.map((entry: { path: string }) => entry.path)).toEqual([name]);
  const read = await tool(client, "read_note", { path: name });
  expect(read.content).toBe(original);
  const edited = await tool(client, "edit_note", {
    path: name,
    base: read.base,
    edits: [
      { old: "- [ ] Call Sam", new: "- [x] Call Sam" },
      { old: "- [ ] Pay bill", new: "- [x] Pay bill" },
    ],
  });
  expect(edited.error).toBeUndefined();
  expect(edited.applied).toBe(true);
  expect(edited.durable).toBe(true);
  const expected = original
    .replace("- [ ] Call Sam", "- [x] Call Sam")
    .replace("- [ ] Pay bill", "- [x] Pay bill");
  expect((await tool(client, "read_note", { path: name })).content).toBe(expected);
  expect((await tool(client, "read_note", { path: edited.beforeImage })).content).toBe(original);
  const refused = await tool(client, "append_note", {
    path: name,
    base: read.base,
    text: "lost-response retry",
  });
  expect(refused.error.code).toBe("stale");
  expect(refused.connection.localGeneration).toBe(edited.connection.localGeneration);
  await within(
    (async () => {
      for (;;) {
        const status = await tool(client, "sync_status");
        if (!status.localWritesSincePass && !status.engine.syncing && status.engine.pending === 0)
          return;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    })(),
    "edited note upload",
    15000,
  );
  const phone = await directory();
  const pair = await cli("pair", key, "--dir", phone, "--device", "phone");
  expect(pair.code, pair.err).toBe(0);
  const synced = await cli("sync", "--dir", phone);
  expect(synced.code, synced.err).toBe(0);
  expect(await readFile(join(phone, name), "utf8")).toBe(expected);
  expect(await readFile(join(phone, edited.beforeImage), "utf8")).toBe(original);
}, 30000);

it("initializes and reads 5000 notes while the sync handshake is stalled, with bounded pages and eight concurrent calls", async () => {
  const { dir } = await paired();
  const accepted = deferred<void>();
  const sockets = new Set<Socket>();
  const blocked = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    accepted.resolve();
  });
  await new Promise<void>((resolve) => blocked.listen(0, "127.0.0.1", resolve));
  const address = blocked.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const config = (await loadConfig(dir))!;
  await saveConfig(dir, { ...config, url: `ws://127.0.0.1:${address.port}` });
  await mkdir(join(dir, "Notes"));
  for (let from = 0; from < 5000; from += 100)
    await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        writeFile(
          join(dir, "Notes", `${String(from + i).padStart(4, "0")}.md`),
          `literal needle ${from + i}\n`,
        ),
      ),
    );
  await writeFile(join(dir, "large.md"), ("a".repeat(1023) + "\n").repeat(1024));
  const started = performance.now();
  try {
    const opened = await host(dir, ["--read-only"], true);
    const { client } = opened;
    await within(accepted.promise, "held sync connection", 5000);
    console.info(
      `MCP initialize while sync stalled: ${(performance.now() - started).toFixed(1)} ms`,
    );
    const tools = await client.listTools();
    expect(tools.tools.some((tool) => tool.name === "edit_note")).toBe(false);
    expect((await tool(client, "sync_status")).writeReady).toBe(false);
    const inventoryStarted = performance.now();
    let after: string | undefined;
    const found: string[] = [];
    do {
      const page = await tool(client, "list_notes", {
        folder: "Notes",
        limit: 500,
        ...(after ? { after } : {}),
      });
      found.push(...page.entries.map((row: { path: string }) => row.path));
      after = page.nextAfter ?? undefined;
    } while (after);
    expect(found).toHaveLength(5000);
    expect(new Set(found).size).toBe(5000);
    console.info(
      `MCP 5000-note inventory, all ten pages: ${(performance.now() - inventoryStarted).toFixed(1)} ms`,
    );
    const page = await tool(client, "read_note", { path: "large.md", maxLines: 1000 });
    expect(page.size).toBe(1024 * 1024);
    expect(Buffer.byteLength(page.content)).toBe(65536);
    expect(page.nextLine).toBe(65);
    let line: number | null = 1;
    let bytes = 0;
    while (line !== null) {
      const part = await tool(client, "read_note", {
        path: "large.md",
        startLine: line,
        base: page.base,
        maxLines: 1000,
      });
      bytes += Buffer.byteLength(part.content);
      line = part.nextLine;
    }
    expect(bytes).toBe(1024 * 1024);
    const requests = Array.from({ length: 8 }, (_, i) =>
      i % 2
        ? { name: "list_notes", args: { folder: "Notes", limit: 5 } }
        : { name: "search_notes", args: { query: "literal needle", folder: "Notes", limit: 5 } },
    );
    const strip = (value: Record<string, unknown>) => {
      const { observedAt: _time, connection: _connection, ...rest } = value;
      return rest;
    };
    const sequential = [];
    for (const request of requests)
      sequential.push(strip(await tool(client, request.name, request.args)));
    expect(
      (await Promise.all(requests.map((request) => tool(client, request.name, request.args)))).map(
        strip,
      ),
    ).toEqual(sequential);
    await opened.close();
    hosts.splice(hosts.indexOf(opened), 1);
    const writable = await host(dir);
    const refused = await tool(writable.client, "create_note", {
      path: "not-admitted.md",
      content: "must not exist",
    });
    expect(refused).toMatchObject({ applied: false, error: { code: "not_ready" } });
    await expect(readFile(join(dir, "not-admitted.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await tool(writable.client, "read_note", { path: "Notes/0000.md" })).content).toBe(
      "literal needle 0\n",
    );
    await writable.close();
    hosts.splice(hosts.indexOf(writable), 1);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => blocked.close(() => resolve()));
  }
}, 60000);

it("omits every mutation in persisted read-only mode and refuses invalid schemas without creating files", async () => {
  const { dir } = await paired();
  const config = (await loadConfig(dir))!;
  await saveConfig(dir, { ...config, readOnly: true });
  const { client } = await host(dir);
  expect((await client.listTools()).tools.map((row) => row.name).sort()).toEqual([
    "list_notes",
    "read_note",
    "search_notes",
    "sync_status",
  ]);
  await expect(
    client.callTool({
      name: "create_note",
      arguments: { path: "unauthorized.md", content: "must not appear" },
    }),
  ).rejects.toThrow();
  await expect(readFile(join(dir, "unauthorized.md"))).rejects.toMatchObject({ code: "ENOENT" });
  for (const args of [
    { path: "x.md", maxLines: 0 },
    { path: "x.md", extra: true },
    { path: "x.md", base: "invalid" },
    { path: "\ud800.md" },
  ]) {
    const result = await client.callTool({ name: "read_note", arguments: args });
    expect(result.isError).toBe(true);
  }
});

it("serves a cancelled search without losing the next request", async () => {
  const { dir } = await paired();
  await writeFile(join(dir, "note.md"), "a local note\n");
  const { client } = await host(dir);
  const cancel = new AbortController();
  const request = client.callTool(
    { name: "search_notes", arguments: { query: "local" } },
    { signal: cancel.signal },
  );
  cancel.abort();
  await expect(request).rejects.toThrow();
  expect((await tool(client, "read_note", { path: "note.md" })).content).toBe("a local note\n");
});
