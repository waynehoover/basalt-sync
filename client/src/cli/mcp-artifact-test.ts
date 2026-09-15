import assert from "node:assert/strict";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { TestServer, removeTree } from "../core/test-server.ts";
import { within } from "../core/test-async.ts";
import { cli, tool } from "./mcp-test.ts";

/** Used by both the fresh production build test and the npm tarball gate. */
export async function smokeMcpArtifact(artifact: string, runtime: string, denyRead?: string) {
  const server = new TestServer();
  const dir = await realpath(await mkdtemp(join(tmpdir(), "basalt-mcp-artifact-vault-")));
  const host = new Client({ name: "artifact-check", version: "1" });
  let command = runtime;
  let args = [artifact, "mcp", "--dir", dir];
  if (denyRead && process.platform === "darwin") {
    const profile = join(dir, "sandbox.sb");
    await writeFile(
      profile,
      `(version 1)\n(allow default)\n(deny file-read* (subpath ${JSON.stringify(denyRead)}))\n`,
    );
    command = "/usr/bin/sandbox-exec";
    args = ["-f", profile, runtime, ...args];
  }
  const transport = new StdioClientTransport({
    command,
    args,
    cwd: dir,
    env: { PATH: process.env.PATH ?? "", NODE_PATH: "" },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  try {
    await server.start();
    const initialized = await cli("init", server.setup, "--dir", dir);
    assert.equal(initialized.code, 0, initialized.err);
    const original = "UNSENT ARTIFACT MARKER\n- [ ] exact task\n";
    await writeFile(join(dir, "note.md"), original);
    const started = performance.now();
    await host.connect(transport);
    const initializationMs = performance.now() - started;
    assert((await host.listTools()).tools.some((tool) => tool.name === "edit_note"));
    await within(
      (async () => {
        for (;;) {
          const status = await tool(host, "sync_status");
          if (status.writeReady) return;
          if (status.connection === "fatal") throw new Error(JSON.stringify(status));
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      })(),
      "production MCP readiness",
      15000,
    );
    const before = await tool(host, "read_note", { path: "note.md" });
    assert.equal(before.content, original);
    const edited = await tool(host, "edit_note", {
      path: "note.md",
      base: before.base,
      edits: [{ old: "- [ ] exact task", new: "- [x] exact task" }],
    });
    assert.equal(edited.applied, true, JSON.stringify(edited));
    assert.equal(edited.durable, true);
    assert.equal(
      (await tool(host, "read_note", { path: "note.md" })).content,
      original.replace("[ ]", "[x]"),
    );
    assert.equal((await tool(host, "read_note", { path: edited.beforeImage })).content, original);
    return { initializationMs: Math.round(initializationMs * 10) / 10 };
  } catch (error) {
    throw new Error(`${String(error)}\n${stderr}`);
  } finally {
    await host.close();
    await transport.close();
    await server.cleanup();
    await removeTree(dir);
  }
}
