/**
 * The scenarios, apart from the runner, because a killed process runs them too.
 *
 * `faults.stress.ts` sweeps these in one process; `faults-child.ts` runs one of
 * them in a process that dies inside the seam. Two copies of "a download lands
 * on a note being saved" would drift, and the pair that drifted would be the
 * one nobody was watching.
 */

import { chmod, link, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { expecting, type Scenario } from "./faults.ts";
import { retireName } from "../cli/vault.ts";

const enc = new TextEncoder();
const NOW = { mtime: 1_700_000_000_000, ctime: 1_700_000_000_000 };

/**
 * What this device had, with a mark of its own.
 *
 * Marked because the restart sweep checks for it by name: a version this
 * device is holding and has not sent anywhere is exactly as unrecoverable as
 * the competitor's if a crash loses it, and the two are told apart by these.
 */
export const MINE = "# note\n\nwhat this device had: keepsake-mine.\n";
export const INCOMING = "# note\n\nwhat the server sent.\n";

/** A download landing on a note, with a save arriving during it. */
const overwrite: Scenario = {
  supersedes: true,
  name: "a download lands on a note being saved",
  setup: async (g) => await g.save("note.md", MINE),
  run: async (g) =>
    await g.vault.replace(
      "note.md",
      await expecting(MINE),
      enc.encode(INCOMING),
      NOW,
      "note (conflict).md",
    ),
  interfere: async (g, token) => await g.save("note.md", `# note\n\n${token}\n`),
};

/** A deletion from another device, with a save arriving during it. */
const remove: Scenario = {
  supersedes: true,
  name: "a deletion arrives for a note being saved",
  setup: async (g) => await g.save("note.md", MINE),
  run: async (g) =>
    await g.vault.removeExpecting("note.md", await expecting(MINE), "note (kept).md"),
  interfere: async (g, token) => await g.save("note.md", `# note\n\n${token}\n`),
};

/**
 * Taking away a name whose file has a second one, with a save arriving during
 * it.
 *
 * A read as far as anybody using this client is concerned, which is what made
 * R07 worth the round it took: a read deleted a file.
 *
 * Driven directly rather than through `list`, and with two ordinary names
 * rather than two spellings of one. `retireName` is reachable through a scan
 * only on a filesystem that keeps two Unicode spellings apart and macOS folds
 * them, so a sweep that went through `list` would report every seam as holding
 * on the machine this is usually run on, and a `link` to the other spelling
 * fails EEXIST there because it is the same name. Both of those the driver
 * established rather than assumed, by firing nothing and then by refusing the
 * link. The shape being tested is "this file now has a second name, take the
 * first one away", which is that shape whatever produced it, and it is the
 * shape `cli/respell-race.test.ts` uses for the same reason.
 */
const respell: Scenario = {
  name: "a superseded name is retired while it is saved",
  setup: async (g) => {
    await g.save("old-name.md", MINE);
    await link(join(g.dir, "old-name.md"), join(g.dir, "new-name.md"));
  },
  run: async (g) => {
    const from = join(g.dir, "old-name.md");
    const source = await stat(from);
    await retireName(join(g.dir, ".basalt", "tmp"), from, { dev: source.dev, ino: source.ino });
  },
  interfere: async (g, token) => await g.save("old-name.md", `# note\n\n${token}\n`),
};

/** A note written where a displaced version is about to be parked. */
const collide: Scenario = {
  name: "a note appears where a displaced version is going",
  setup: async (g) => await g.save("note.md", MINE),
  run: async (g) =>
    await g.vault.replace(
      "note.md",
      await expecting("something else entirely"),
      enc.encode(INCOMING),
      NOW,
      "note (conflict).md",
    ),
  interfere: async (g, token) => await g.save("note (conflict).md", `# conflict\n\n${token}\n`),
};

/**
 * A displaced version that cannot be placed anywhere, which must still be
 * findable (R46).
 *
 * The conflict copy is aimed into a directory this process cannot write, so
 * preservation moves the version off the note's name and then has nowhere to
 * put it. The bytes survive under a parked name nothing lists, and the only
 * thing standing between that and a lost note is `stranded` saying where.
 *
 * This scenario exists because the reporting half of the invariant was not
 * being exercised: every other scenario here ends with the version at a name
 * a listing shows, so blanking `stranded` entirely did not fail any of them.
 */
const unplaceable: Scenario = {
  supersedes: true,
  name: "a displaced version has nowhere to go",
  setup: async (g) => {
    await g.save("note.md", MINE);
    await mkdir(join(g.dir, "shut"));
    await chmod(join(g.dir, "shut"), 0o500);
  },
  run: async (g) =>
    await g.vault.replace(
      "note.md",
      await expecting("something else entirely"),
      enc.encode(INCOMING),
      NOW,
      "shut/note (conflict).md",
    ),
  interfere: async (g, token) => await g.save("note.md", `# note\n\n${token}\n`),
};

export const SCENARIOS: readonly Scenario[] = [overwrite, remove, respell, collide, unplaceable];
