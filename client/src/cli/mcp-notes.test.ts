import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

import { NodeVault } from "./vault.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();
const times = { mtime: 1_700_000_000_000, ctime: 1_700_000_000_000 };
const digest = async (bytes: Uint8Array): Promise<string> =>
  createHash("sha256").update(bytes).digest("hex");
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "basalt-mcp-notes-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// The unsafe control for the MCP transaction. The engine calls replace with
// an ancestor it has reconciled; an agent's current digest proves no such
// history exists. A service must preserve the unsent input independently.
it("shows why a current digest cannot replace a before-image", async () => {
  const vault = new NodeVault(root);
  const original = enc.encode(
    "# Daily\n\nUNSENT: call the school about the trip\n\n- [ ] Book tickets\n",
  );
  const proposed = enc.encode("# Daily\n\n- [x] Book tickets\n");
  expect(await vault.create("Daily.md", original, times)).toBe(true);
  await vault.flush();
  const base = await digest(await vault.read("Daily.md"));
  await vault.replace("Daily.md", { contentId: base, idOf: digest }, proposed, times, "kept.md");
  await vault.flush();
  expect(await vault.read("Daily.md")).toEqual(proposed);

  const reader = new NodeVault(root, { observeOnly: true });
  const copies = await Promise.all(
    (await reader.list()).filter((entry) => !entry.folder).map((entry) => reader.read(entry.path)),
  );
  expect(copies.map((bytes) => dec.decode(bytes)).join("\n")).not.toContain(
    "UNSENT: call the school about the trip",
  );
});
