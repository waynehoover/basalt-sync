/**
 * Preserved content is on the disk before anyone is told about it, and nothing
 * deletes it afterwards (R18, R21, R22).
 *
 * The first attempt at this handed the caller a buffer and deleted the file it
 * came from in a `finally`. Three things followed. A failure anywhere after
 * the rename-aside took the original with it. The engine had a window in which
 * the only copy of somebody's edit was in memory. And the preserved file lived
 * in the staging directory, which the scan's reaper empties by age, and a
 * rename carries the old timestamp, so it was already older than the cutoff
 * when it arrived.
 *
 * Now the adapter moves the displaced version to a real path in the vault and
 * returns that path. It is a note: on the disk, backed up, discoverable, and
 * not something anybody has to remember to save.
 */

import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { NodeVault, STALE_TEMP_MS, TEMP_MARK } from "./vault.ts";
import { plainDigest } from "../core/crypto.ts";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

async function vault(): Promise<{ dir: string; v: NodeVault }> {
  const dir = await mkdtemp(join(tmpdir(), "basalt-preserve-"));
  dirs.push(dir);
  return { dir, v: new NodeVault(dir) };
}

const enc = new TextEncoder();
const expecting = (id: string) => ({ contentId: id, idOf: plainDigest });

describe("a write that displaces something unexpected", () => {
  it("leaves it at a real path, and says which", async () => {
    const { dir, v } = await vault();
    await writeFile(join(dir, "note.md"), "the unsent edit\n");

    const out = await v.replace(
      "note.md",
      expecting("a digest of something else entirely"),
      enc.encode("the server's version\n"),
      { mtime: 2000, ctime: 1000 },
      "note (kept).md",
    );

    expect(out.keptAt, "nothing was preserved").toBe("note (kept).md");
    expect(out.landed).toBe(true);
    // On the disk, not in a buffer somebody has to write down.
    expect(await readFile(join(dir, "note (kept).md"), "utf8")).toBe("the unsent edit\n");
    expect(await readFile(join(dir, "note.md"), "utf8")).toBe("the server's version\n");
  });

  it("keeps nothing when it wrote over exactly what it expected", async () => {
    const { dir, v } = await vault();
    const was = "the version the pass decided about\n";
    await writeFile(join(dir, "note.md"), was);

    const out = await v.replace(
      "note.md",
      expecting(await plainDigest(enc.encode(was))),
      enc.encode("the server's version\n"),
      { mtime: 2000, ctime: 1000 },
      "note (kept).md",
    );
    expect(out.keptAt, "a file nobody had touched was preserved").toBeUndefined();
    expect(
      (await readdir(dir)).filter((n) => !n.startsWith(".")).sort(),
      "a needless copy was left behind",
    ).toEqual(["note.md"]);
  });

  /**
   * The failure R18 reproduced: an error after the rename-aside used to run a
   * `finally` that deleted the preserved file, so the original was gone and
   * the new content had never landed.
   */
  it("still has the original when the write fails after it was moved aside", async () => {
    const { dir, v } = await vault();
    await writeFile(join(dir, "note.md"), "the only copy\n");
    // A destination whose parent is a file, so linking the staged content in
    // fails after the original has been moved out of the way.
    await writeFile(join(dir, "wall"), "not a directory");

    await v
      .replace(
        "note.md",
        expecting("something else"),
        enc.encode("the server's version\n"),
        { mtime: 2000, ctime: 1000 },
        "note (kept).md",
      )
      .catch(() => undefined);

    // Whatever happened, the bytes nobody has sent anywhere are on this disk.
    const found: string[] = [];
    for (const name of await readdir(dir)) {
      if (name.startsWith(".")) continue;
      found.push(await readFile(join(dir, name), "utf8").catch(() => ""));
    }
    expect(found.join("|"), `the only copy is gone. Found: ${JSON.stringify(found)}`).toContain(
      "the only copy\n",
    );
  });
});

describe("the staging reaper", () => {
  it("deletes only files this code makes", async () => {
    const { dir, v } = await vault();
    const staging = join(dir, ".basalt", "tmp");
    await mkdir(staging, { recursive: true });
    const debris = join(staging, `note.md${TEMP_MARK}zz`);
    const notOurs = join(staging, "somebody-elses-notes.md");
    await writeFile(debris, "half a write");
    await writeFile(notOurs, "a version of a note, preserved from a race");
    // Old enough for the cutoff. A rename carries the timestamp, so anything
    // moved in here looks this old immediately.
    const old = (Date.now() - STALE_TEMP_MS - 60_000) / 1000;
    await utimes(debris, old, old);
    await utimes(notOurs, old, old);

    await v.list();

    expect(await readdir(staging), "the reaper deleted a file it did not create").toEqual([
      "somebody-elses-notes.md",
    ]);
    expect(v.reaped, "it did not reap its own debris").toBe(1);
  });

  it("refuses a staging directory that leaves the vault, and deletes nothing", async () => {
    const base = await mkdtemp(join(tmpdir(), "basalt-preserve-"));
    dirs.push(base);
    const dir = join(base, "vault");
    const elsewhere = join(base, "elsewhere");
    await mkdir(join(dir, ".basalt"), { recursive: true });
    await mkdir(elsewhere, { recursive: true });
    const valuable = join(elsewhere, "valuable.md");
    await writeFile(valuable, "not in the vault at all\n");
    // And one that looks exactly like this code's own debris, which is what
    // isolates the containment check from the name check: by name alone the
    // reaper would take it, and it must not, because it is not in the vault.
    const looksLikeOurs = join(elsewhere, `something.md${TEMP_MARK}zz`);
    await writeFile(looksLikeOurs, "outside the vault, and named like debris\n");
    const old = (Date.now() - STALE_TEMP_MS - 60_000) / 1000;
    await utimes(valuable, old, old);
    await utimes(looksLikeOurs, old, old);
    await (await import("node:fs/promises")).symlink(elsewhere, join(dir, ".basalt", "tmp"));

    await new NodeVault(dir).list().catch(() => undefined);

    expect(
      await readFile(valuable, "utf8"),
      "an ordinary scan deleted a file outside the vault",
    ).toBe("not in the vault at all\n");
    expect(
      await readFile(looksLikeOurs, "utf8"),
      "an ordinary scan reached outside the vault and deleted a file there",
    ).toBe("outside the vault, and named like debris\n");
  });
});
