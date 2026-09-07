/**
 * One scenario, in a process that is killed inside a seam.
 *
 * Run by `faults.stress.ts`, never by hand. Everything the seams protect is
 * written to be safe across a crash, and none of it had ever been crashed:
 * the seams stop the world and then let it go again, which exercises the
 * ordering but never the case where the second half of an operation simply
 * does not happen. A `finally` that puts a note back is exactly the kind of
 * repair a SIGKILL skips.
 *
 *   bun run src/stress/faults-child.ts <dir> <scenario> <seam> <token>
 *
 * SIGKILL rather than `process.exit`, because `exit` runs handlers and flushes
 * and a crash does not. It also means this process leaves no exit code worth
 * reading: the parent looks at the vault, not at us (rule 4).
 */

import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { seamNamed } from "../core/seam.ts";
import { NodeVault } from "../cli/vault.ts";
// For its seams. The parent enumerates every registered seam and asks for
// each by name, so a module it has loaded and this one has not is a name
// this process cannot find.
import "../cli/lock.ts";
import { SCENARIOS } from "./fault-scenarios.ts";
import type { Ground } from "./faults.ts";

const [dir, wanted, seam, token] = process.argv.slice(2);
if (!dir || !wanted || !seam || !token) {
  console.error("usage: faults-child.ts <dir> <scenario> <seam> <token>");
  process.exit(2);
}

const scenario = SCENARIOS.find((s) => s.name === wanted);
if (scenario === undefined) {
  console.error(`no scenario called ${wanted}`);
  process.exit(2);
}

const save = async (path: string, body: string): Promise<void> => {
  const full = join(dir, path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(`${full}.editor-swap`, body);
  await rename(`${full}.editor-swap`, full);
};

const ground: Ground = {
  dir,
  vault: new NodeVault(dir),
  save,
  saveInPlace: async (path, body) => {
    const full = join(dir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, body);
  },
};

await scenario.setup(ground);

let done = false;
seamNamed(seam).pause = async (): Promise<void> => {
  if (done) return;
  done = true;
  await scenario.interfere(ground, token);
  // Nothing after this line runs. Not a `finally`, not a flush, not the rest
  // of the operation.
  process.kill(process.pid, "SIGKILL");
  // Unreachable, and here so the seam never returns even if the signal is
  // somehow deferred: returning would let the operation finish tidily, which
  // is the thing this file exists not to do.
  await new Promise(() => {});
};

// The scenario may refuse before it ever reaches the seam, which is a fine
// outcome and not this process's business to report.
await scenario.run(ground).catch(() => undefined);
// Reached only when the seam was never hit. The parent tells the difference by
// whether the token is in the vault at all.
process.exit(0);
