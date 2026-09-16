import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { saveConfig } from "./config.ts";
import { cli } from "./mcp-test.ts";
import { NodeVault } from "./vault.ts";
import { McpReader } from "./mcp-read.ts";
import { createTools, type McpSession } from "./mcp-tools.ts";
import { startHttp } from "./mcp-http.ts";
import { removeTree } from "../core/test-server.ts";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { deferred, within } from "../core/test-async.ts";

export async function httpFixture(
  options: {
    status?: () => Promise<object>;
    now?: () => number;
    allowOrigins?: string[];
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "basalt-http-"));
  await saveConfig(root, {
    url: "ws://127.0.0.1:1",
    vaultId: "private-http-vault",
    device: "test",
    secret: new Uint8Array(32).fill(7),
  });
  await writeFile(join(root, "note.md"), "private note marker 813751\n");
  const issued = await cli("mcp-token", "--dir", root);
  if (issued.code !== 0) throw new Error(issued.err);
  const token = issued.out.trim();
  const writer = new NodeVault(root);
  const reader = new McpReader(new NodeVault(root, { observeOnly: true }));
  const session: McpSession = {
    mode: "read-only",
    reader,
    writer,
    client: () => undefined,
    stopping: () => false,
    changed() {},
    summary: () => ({ connection: "offline" }),
    status: options.status ?? (async () => ({ connection: "offline", readOnly: true })),
  };
  const logs: string[] = [];
  const errors: Error[] = [];
  const server = await startHttp(
    root,
    () => createTools(session, "test"),
    {
      host: "127.0.0.1",
      port: 0,
      allowOrigins: options.allowOrigins ?? [],
      verbose: true,
      log: (line) => logs.push(line),
      ...(options.now ? { now: options.now } : {}),
    },
    (error) => {
      if (error) errors.push(error);
    },
  );
  const url = `http://127.0.0.1:${server.port}/mcp`;
  const clients: Client[] = [];
  return {
    root,
    token,
    url,
    server,
    session,
    logs,
    errors,
    async client(modern = false) {
      const transport = new StreamableHTTPClientTransport(new URL(url), {
        authProvider: { token: async () => token },
      });
      const client = new Client(
        { name: "basalt-http-test", version: "1" },
        {
          versionNegotiation: { mode: modern ? { pin: "2026-07-28" } : "legacy" },
        },
      );
      clients.push(client);
      await client.connect(transport);
      return { client, transport };
    },
    async request(
      body?: object,
      options: {
        method?: string;
        headers?: Record<string, string>;
        path?: string;
        signal?: AbortSignal;
      } = {},
    ) {
      return fetch(options.path ? new URL(options.path, url) : url, {
        method: options.method ?? "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...options.headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    },
    async close() {
      await Promise.all(clients.map((client) => client.close()));
      await server.close();
      await reader.drain();
      await removeTree(root);
    },
  };
}

export const initialize = (id: string | number = 0) => ({
  jsonrpc: "2.0",
  id,
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "raw", version: "1" },
  },
});
export const callStatus = (id: string | number) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name: "sync_status", arguments: {} },
});
export async function legacy(fixture: Awaited<ReturnType<typeof httpFixture>>) {
  const response = await fixture.request(initialize());
  const body = await response.text();
  const id = response.headers.get("mcp-session-id");
  if (response.status !== 200 || !id) throw new Error(`initialize ${response.status}: ${body}`);
  const headers = { "mcp-session-id": id, "mcp-protocol-version": "2025-11-25" };
  const initialized = await fixture.request(
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { headers },
  );
  await initialized.text();
  if (initialized.status !== 202) throw new Error(`initialized: ${initialized.status}`);
  return headers;
}

export async function unusedHttpPort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const address = socket.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return address.port;
}

export async function openHttp(
  bundle: string,
  root: string,
  token: string,
  flags: string[] = [],
  modern = false,
) {
  const port = await unusedHttpPort();
  const child = spawn(
    process.execPath,
    [bundle, "mcp", "--dir", root, "--listen", `127.0.0.1:${port}`, ...flags],
    { stdio: ["pipe", "pipe", "pipe", "ipc"] },
  );
  const closed = once(child, "close");
  const listening = deferred<void>();
  const messages: unknown[] = [];
  const clients: Client[] = [];
  let stdout = "",
    stderr = "";
  child.stdout!.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr!.on("data", (chunk) => {
    stderr += chunk.toString();
    if (stderr.includes("HTTP listening on")) listening.resolve();
  });
  child.on("message", (message) => messages.push(message));
  child.stdin!.end();
  const event = (kind: string, name: string) =>
    within(
      (async () => {
        while (
          !messages.some(
            (value) =>
              value &&
              typeof value === "object" &&
              (value as Record<string, unknown>)[kind] === name,
          )
        )
          await new Promise<void>((resolve) => setImmediate(resolve));
      })(),
      `${kind}: ${name}`,
    );
  const url = `http://127.0.0.1:${port}/mcp`;
  async function connect(modern = false, key = token, at = url) {
    const transport = new StreamableHTTPClientTransport(new URL(at), {
      authProvider: { token: async () => key },
    });
    const client = new Client(
      { name: "basalt-child-http-test", version: "1" },
      {
        versionNegotiation: { mode: modern ? { pin: "2026-07-28" } : "legacy" },
      },
    );
    clients.push(client);
    await client.connect(transport);
    return { client, transport };
  }
  async function close() {
    await Promise.all(clients.map((client) => client.close()));
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    try {
      const [code, signal] = await within(closed, "HTTP child shutdown", 15000);
      return { code, signal, stdout, stderr };
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
    }
  }
  try {
    await within(
      Promise.race([
        listening.promise,
        closed.then(() => {
          throw new Error(`HTTP startup failed: ${stderr}`);
        }),
      ]),
      "HTTP listener startup",
      15000,
    );
    const connected = await connect(modern);
    return {
      ...connected,
      connect,
      child,
      messages,
      url,
      close,
      stdout: () => stdout,
      stderr: () => stderr,
      async hold(name: string) {
        child.send({ hold: name });
        await event("armed", name);
      },
      reached: (name: string) => event("reached", name),
      release: () => {
        if (child.connected) child.send({ release: true });
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
