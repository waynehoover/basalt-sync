import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMcp, cli, tool } from "./mcp-test.ts";
import { openHttp } from "./mcp-http-test.ts";
import { TestServer, removeTree } from "../core/test-server.ts";
import { within } from "../core/test-async.ts";
import { spawn } from "node:child_process";
import { once } from "node:events";

let buildDir: string, bundle: string, server: TestServer | undefined;
const roots: string[] = [];
const hosts: Awaited<ReturnType<typeof openHttp>>[] = [];
beforeAll(async () => {
  buildDir = await mkdtemp(join(tmpdir(), "basalt-http-build-"));
  bundle = await buildMcp(buildDir, "./mcp-fault-child.ts");
});
afterAll(async () => removeTree(buildDir));
afterEach(async () => {
  for (const host of hosts.splice(0)) {
    const closed = await host.close();
    expect(closed.code, closed.stderr).toBe(0);
    expect(closed.signal).toBeNull();
    expect(closed.stdout).toBe("");
  }
  await server?.cleanup();
  server = undefined;
  for (const root of roots.splice(0)) await removeTree(root);
});
async function directory() {
  const root = await mkdtemp(join(tmpdir(), "basalt-http-process-"));
  roots.push(root);
  return root;
}
async function paired() {
  server = new TestServer();
  await server.start();
  const dir = await directory();
  const init = await cli("init", server.setup, "--dir", dir, "--json");
  expect(init.code, init.err).toBe(0);
  const credential = await cli("mcp-token", "--dir", dir);
  expect(credential.code).toBe(0);
  return { dir, key: JSON.parse(init.out).recoveryKey as string, token: credential.out.trim() };
}
async function host(dir: string, token: string, flags: string[] = [], modern = false) {
  const result = await openHttp(bundle, dir, token, flags, modern);
  hosts.push(result);
  return result;
}
async function ready(client: Awaited<ReturnType<typeof host>>["client"]) {
  await within(
    (async () => {
      while (!(await tool(client, "sync_status")).writeReady)
        await new Promise<void>((resolve) => setImmediate(resolve));
    })(),
    "HTTP write readiness",
    15000,
  );
}
async function settled(client: Awaited<ReturnType<typeof host>>["client"]) {
  await within(
    (async () => {
      for (;;) {
        const status = await tool(client, "sync_status");
        if (!status.localWritesSincePass && !status.engine.syncing && status.engine.pending === 0)
          return;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    })(),
    "HTTP edit upload",
    15000,
  );
}
async function command(...args: string[]) {
  const child = spawn(process.execPath, [bundle, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  const closed = once(child, "close");
  let out = "",
    err = "";
  child.stdout.on("data", (chunk) => {
    out += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    err += chunk.toString();
  });
  try {
    const [code, signal] = await within(closed, "CLI command exit", 15000);
    return { code, signal, out, err };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  }
}

it.each([false, true])(
  "edits two tasks through a freshly built HTTP child and preserves both versions on another device, modern=%s",
  async (modern) => {
    const { dir, key, token } = await paired();
    const name = "Daily/2026-09-14.md";
    const original =
      "\ufeff---\r\nprivate: true\r\n---\r\nUNSENT PRIVATE MARKER 538127 [[link]]\r\n- [ ] Call Sam\r\n- [ ] Pay bill\r\nKeep every paragraph.\r\n";
    await mkdir(join(dir, "Daily"));
    await writeFile(join(dir, name), original);
    const owner = await host(dir, token, ["--writable", "--verbose"], modern);
    await ready(owner.client);
    const listed = await tool(owner.client, "list_notes", { folder: "Daily" });
    expect(listed.entries.map((entry: { path: string }) => entry.path)).toEqual([name]);
    const read = await tool(owner.client, "read_note", { path: name });
    expect(read.content).toBe(original);
    const edited = await tool(owner.client, "edit_note", {
      path: name,
      base: read.base,
      edits: [
        { old: "- [ ] Call Sam", new: "- [x] Call Sam" },
        { old: "- [ ] Pay bill", new: "- [x] Pay bill" },
      ],
    });
    expect(edited).toMatchObject({ applied: true, durable: true });
    const expected = original
      .replace("- [ ] Call Sam", "- [x] Call Sam")
      .replace("- [ ] Pay bill", "- [x] Pay bill");
    expect((await tool(owner.client, "read_note", { path: name })).content).toBe(expected);
    expect((await tool(owner.client, "read_note", { path: edited.beforeImage })).content).toBe(
      original,
    );
    expect(
      await tool(owner.client, "append_note", {
        path: name,
        base: read.base,
        text: "retry must not appear",
      }),
    ).toMatchObject({ applied: false, error: { code: "stale" } });
    await settled(owner.client);
    const phone = await directory();
    expect((await cli("pair", key, "--dir", phone, "--device", "phone")).code).toBe(0);
    const synced = await cli("sync", "--dir", phone);
    expect(synced.code, synced.err).toBe(0);
    expect(await readFile(join(phone, name), "utf8")).toBe(expected);
    expect(await readFile(join(phone, edited.beforeImage), "utf8")).toBe(original);
    for (const secret of [token, key, "UNSENT PRIVATE MARKER"])
      expect(owner.stderr()).not.toContain(secret);
  },
);

it("defaults HTTP to read-only, keeps stdin EOF harmless, and denies mutation calls", async () => {
  const { dir, token } = await paired();
  await writeFile(join(dir, "note.md"), "original bytes\n");
  const owner = await host(dir, token);
  expect(await tool(owner.client, "sync_status")).toMatchObject({
    readOnly: true,
    writeReady: false,
  });
  expect((await owner.client.listTools()).tools.map((row) => row.name)).not.toContain(
    "append_note",
  );
  const read = await tool(owner.client, "read_note", { path: "note.md" });
  await expect(
    owner.client.callTool({
      name: "append_note",
      arguments: { path: "note.md", base: read.base, text: "unauthorized" },
    }),
  ).rejects.toThrow();
  expect(await readFile(join(dir, "note.md"), "utf8")).toBe("original bytes\n");
  expect(owner.child.exitCode).toBeNull();
});

it("serializes edits from separate HTTP sessions against the same base", async () => {
  const { dir, token } = await paired();
  await writeFile(join(dir, "note.md"), "preserve original unique branch\n");
  const owner = await host(dir, token, ["--writable"]);
  const other = await owner.connect(true);
  await ready(owner.client);
  const read = await tool(owner.client, "read_note", { path: "note.md" });
  const edits = await Promise.all(
    [owner.client, other.client].map((client, i) =>
      tool(client, "append_note", { path: "note.md", base: read.base, text: `accepted ${i}\n` }),
    ),
  );
  expect(edits.filter((edit) => edit.applied === true)).toHaveLength(1);
  const refused = edits.find((edit) => edit.error?.code === "stale")!;
  expect(refused).toBeDefined();
  expect(refused.base).toBeUndefined();
  const winner = edits.findIndex((edit) => edit.applied === true);
  expect(await readFile(join(dir, "note.md"), "utf8")).toBe(read.content + `accepted ${winner}\n`);
  const listing = await tool(owner.client, "list_notes", { includeBackups: true });
  const backups = listing.entries.filter(
    (entry: { backupOf?: string }) => entry.backupOf === "note.md",
  );
  expect(backups).toHaveLength(1);
  expect((await tool(owner.client, "read_note", { path: backups[0].path })).content).toBe(
    read.content,
  );
});

it.each([
  "cli/mcp:backupVerified",
  "cli/mcp:backupDurable",
  "cli/vault:replace.staged",
  "cli/vault:replace.nameFree",
  "cli/mcp:published",
  "cli/mcp:durable",
])(
  "a dropped connection and SIGTERM at %s retain the lock and both versions until the write drains",
  async (seam) => {
    const { dir, token } = await paired();
    const original = "unsent branch before HTTP edit\n";
    await writeFile(join(dir, "note.md"), original);
    const owner = await host(dir, token, ["--writable"]);
    await ready(owner.client);
    const read = await tool(owner.client, "read_note", { path: "note.md" });
    await owner.hold(seam);
    const controller = new AbortController();
    const response = fetch(owner.url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-session-id": owner.transport.sessionId!,
        "mcp-protocol-version": "2025-11-25",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "held-edit",
        method: "tools/call",
        params: {
          name: "append_note",
          arguments: { path: "note.md", base: read.base, text: "admitted append\n" },
        },
      }),
    })
      .then((response) => response.text())
      .catch(() => "disconnected");
    try {
      await owner.reached(seam);
      controller.abort();
      await response;
      owner.child.kill("SIGTERM");
      const denied = await command("sync", "--dir", dir);
      expect(denied.code).not.toBe(0);
      expect(denied.err).toMatch(/lock|held|running|another/i);
      expect(owner.child.exitCode).toBeNull();
    } finally {
      owner.release();
    }
    const closed = await owner.close();
    expect(closed).toMatchObject({ code: 0, signal: null, stdout: "" });
    hosts.splice(hosts.indexOf(owner), 1);
    expect(await readFile(join(dir, "note.md"), "utf8")).toBe(original + "admitted append\n");
    const next = await host(dir, token, ["--writable"]);
    await ready(next.client);
    const listed = await tool(next.client, "list_notes", { includeBackups: true });
    const backups = listed.entries.filter(
      (entry: { backupOf?: string }) => entry.backupOf === "note.md",
    );
    expect(backups).toHaveLength(1);
    expect((await tool(next.client, "read_note", { path: backups[0].path })).content).toBe(
      original,
    );
    expect(
      await tool(next.client, "append_note", {
        path: "note.md",
        base: read.base,
        text: "admitted append\n",
      }),
    ).toMatchObject({ applied: false, error: { code: "stale" } });
  },
);
