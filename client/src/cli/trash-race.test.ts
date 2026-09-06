/**
 * Moving a note to the trash across a filesystem boundary cannot delete a
 * newer version of it (R08).
 *
 * Where the vault and its `.trash` are on different filesystems a rename will
 * not do it, so the note is copied, the copy is verified, the copy is flushed,
 * and then the original is removed. F13 added the flush, which is what makes
 * the copy survive a power cut. What it did not change is that the removal was
 * unconditional and happened after that flush, which for a folder of
 * attachments is not a short operation: an editor saving into that window had
 * its work deleted on the strength of a comparison made about an older version.
 *
 * Nothing here can close the window entirely; a filesystem offers no
 * compare-and-unlink. What it can do is shrink it to one hash per file and
 * leave anything that does not match alone, so the worst case is a note in two
 * places rather than in none.
 */

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { copyVerifiedThenRemove, midTrash } from "./vault.ts";

const dirs: string[] = [];
afterEach(async () => {
  midTrash.pause = async () => {};
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "basalt-trash-"));
  dirs.push(dir);
  return dir;
}

describe("copying a note away and then removing it", () => {
  it("removes a file whose copy matches", async () => {
    const dir = await scratch();
    const source = join(dir, "note.md");
    const target = join(dir, "trash", "note.md");
    await mkdir(join(dir, "trash"), { recursive: true });
    await writeFile(source, "the only version\n");

    await copyVerifiedThenRemove(source, target);

    expect(await readFile(target, "utf8")).toBe("the only version\n");
    expect((await readdir(dir)).sort()).toEqual(["trash"]);
  });

  it("leaves a file that changed after its copy was verified, and says so", async () => {
    const dir = await scratch();
    const source = join(dir, "note.md");
    const target = join(dir, "trash", "note.md");
    await mkdir(join(dir, "trash"), { recursive: true });
    await writeFile(source, "the version that was copied\n");

    // The editor, in the gap between the copy being made durable and the
    // original being removed.
    midTrash.pause = async (at) => {
      midTrash.pause = async () => {};
      await writeFile(`${at}.editor`, "the unsent edit, written after the copy\n");
      await (await import("node:fs/promises")).rename(`${at}.editor`, at);
    };

    await expect(copyVerifiedThenRemove(source, target)).rejects.toThrow();

    const stillThere = await readFile(source, "utf8").catch(() => "");
    const inTrash = await readFile(target, "utf8").catch(() => "");
    expect(
      `${stillThere}|${inTrash}`,
      "the edit written after the copy was verified is gone",
    ).toContain("the unsent edit, written after the copy\n");
  });

  it("keeps a changed file inside a folder and removes the rest", async () => {
    const dir = await scratch();
    const source = join(dir, "folder");
    const target = join(dir, "trash", "folder");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "quiet.md"), "unchanged\n");
    await writeFile(join(source, "busy.md"), "before the copy\n");
    await mkdir(join(dir, "trash"), { recursive: true });

    midTrash.pause = async () => {
      midTrash.pause = async () => {};
      await writeFile(join(source, "busy.md.editor"), "edited while copying\n");
      await (
        await import("node:fs/promises")
      ).rename(join(source, "busy.md.editor"), join(source, "busy.md"));
    };

    await expect(copyVerifiedThenRemove(source, target)).rejects.toThrow();

    // The edited one is still there, under its own name; the untouched one is
    // gone, because its copy did match.
    expect(await readFile(join(source, "busy.md"), "utf8")).toBe("edited while copying\n");
    expect(await readdir(source)).toEqual(["busy.md"]);
  });
});
