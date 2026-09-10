import { afterEach, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./cli.ts";
import { TestServer, removeTree } from "../core/test-server.ts";
let server: TestServer | undefined;
let dir: string | undefined;
afterEach(async () => {
  await server?.cleanup();
  if (dir) await removeTree(dir);
});
async function cli(...args: string[]) {
  const output: string[] = [];
  const errors: string[] = [];
  const code = await run(args, { out: (s) => output.push(s), err: (s) => errors.push(s) });
  return { code, output: output.join("\n"), errors: errors.join("\n") };
}
it("history can page to an older version with the existing before argument", async () => {
  server = new TestServer();
  await server.start();
  dir = await mkdtemp(join(tmpdir(), "basalt-review-cli-"));
  const init = await cli(
    "init",
    "--dir",
    dir,
    "--server",
    server.wsUrl,
    "--token",
    server.token,
    "--json",
  );
  expect(init.code).toBe(0);
  for (const text of ["first\n", "second revision\n", "third different revision\n"]) {
    await writeFile(join(dir, "note.md"), text);
    expect((await cli("sync", "--dir", dir)).code).toBe(0);
  }
  const first = await cli("history", "note.md", "--dir", dir, "--json", "--limit", "1");
  expect(first.code, first.output + first.errors).toBe(0);
  const uid = JSON.parse(first.output).versions[0].uid as number;
  const next = await cli(
    "history",
    "note.md",
    "--dir",
    dir,
    "--json",
    "--limit",
    "1",
    "--before",
    String(uid),
  );
  expect(next.code).toBe(0);
  expect(JSON.parse(next.output).versions[0].uid).toBeLessThan(uid);
});
it("invalid command arguments use the documented exit code 2", async () => {
  expect((await cli("sync", "unexpected-vault-argument")).code).toBe(2);
});
it("the documented nested backup is refused and a separate destination works", async () => {
  server = new TestServer();
  await server.start();
  await server.stop();
  await expect(server.cli("backup", "-to", join(server.dataDir, "before-purge"))).rejects.toThrow(
    /contain one another/,
  );
  dir = await mkdtemp(join(tmpdir(), "basalt-review-backup-"));
  await expect(server.cli("backup", "-to", join(dir, "snapshot"))).resolves.toBeTypeOf("string");
});
