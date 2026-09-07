/**
 * The vault's state directory under contention and under failure.
 *
 * C12 and review finding C13. Two processes on one vault each loaded the index,
 * decided from it, and wrote notes, config and index over each other from
 * state the other never saw; and an unlink removed the config before the
 * index, so a failure in between left a vault that read as unpaired while an
 * index from the old pairing waited to be loaded by the next one.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { cleanupBinary, removeTree, serverBinary, TestServer, until } from "../core/test-server.ts";
import { run, type Console } from "./cli.ts";
import { configPath, indexPath, loadConfig, saveConfig } from "./config.ts";
import { STATE_DIR } from "./config.ts";
import { alive, currentHolder, lockPath, lockVault, unlockVault } from "./lock.ts";

/**
 * `saveConfig` and `loadConfig`, failing when a test says so. The CLI imports
 * the same module, so a failure injected here is a failure it meets exactly
 * where it would.
 *
 * The second one is a disk that writes and will not read back, which is a
 * stranger failure than a full disk and the one that decides whether the
 * advice after a half-finished pairing is safe. `breakLoadsAfterSaves` is set
 * to the save count at the start of a test, so reads before the write go
 * through and every read after it fails.
 */
let failSavesAfter = Infinity;
let breakLoadsAfterSaves = Infinity;
let saves = 0;
vi.mock("./config.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config.ts")>();
  return {
    ...actual,
    saveConfig: async (vault: string, config: Parameters<typeof actual.saveConfig>[1]) => {
      saves++;
      if (saves > failSavesAfter) throw new Error("the disk is full, as it were");
      return actual.saveConfig(vault, config);
    },
    loadConfig: async (vault: string) => {
      if (saves > breakLoadsAfterSaves) throw new Error("the disk will not read, as it were");
      return actual.loadConfig(vault);
    },
  };
});

class Run {
  code = -1;
  out: string[] = [];
  err: string[] = [];
  get all(): string {
    return this.out.join("\n") + "\n" + this.err.join("\n");
  }
  json(): Record<string, unknown> {
    return JSON.parse(this.out.join("\n")) as Record<string, unknown>;
  }
}

async function cli(...argv: string[]): Promise<Run> {
  const r = new Run();
  const io: Console = { out: (l) => r.out.push(l), err: (l) => r.err.push(l) };
  r.code = await run(argv, io);
  return r;
}

beforeAll(async () => {
  await serverBinary();
}, 180_000);
afterAll(async () => {
  await cleanupBinary();
});

let server: TestServer | undefined;
const dirs: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  failSavesAfter = Infinity;
  breakLoadsAfterSaves = Infinity;
  saves = 0;
  for (const c of children.splice(0)) {
    // A child killed by a signal has no exit code, only a signal.
    if (c.exitCode === null && c.signalCode === null) {
      const ended = new Promise((r) => c.once("exit", r));
      c.kill("SIGKILL");
      await ended;
    }
  }
  while (dirs.length) await removeTree(dirs.pop()!);
  if (server) await server.cleanup();
  server = undefined;
});

async function vaultDir(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `basalt-state-${name}-`));
  dirs.push(dir);
  return dir;
}

async function paired(name = "a"): Promise<string> {
  return (await pairedWithKey(name)).dir;
}

/**
 * The same, and the recovery key `init` printed.
 *
 * Kept by the caller because nothing reprints it: a paired device holds its
 * own credential and not the vault's root, which is what makes revoking one
 * device mean anything.
 */
async function pairedWithKey(name = "a"): Promise<{ dir: string; recoveryKey: string }> {
  server = new TestServer();
  await server.start();
  const dir = await vaultDir(name);
  const init = await cli("init", server.setup, "--dir", dir, "--device", name, "--json");
  expect(init.code, init.all).toBe(0);
  return { dir, recoveryKey: init.json()["recoveryKey"] as string };
}

/** The CLI as a separate process, which is the only way two of them contend. */
function basalt(...argv: string[]): ChildProcess & { stderrText: () => string } {
  const child = spawn("bun", ["src/cli/bin.ts", ...argv], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  }) as ChildProcess & { stderrText: () => string };
  const err: string[] = [];
  child.stderr!.on("data", (b: Buffer) => err.push(b.toString()));
  child.stdout!.on("data", () => {});
  child.stderrText = () => err.join("");
  children.push(child);
  return child;
}

const exited = (child: ChildProcess) =>
  new Promise<number>((r) => {
    if (child.exitCode !== null) r(child.exitCode);
    else child.once("exit", (code) => r(code ?? -1));
  });

/**
 * F02, the CLI half. The key has to be printed before the step that erases it.
 *
 * `init` writes the root, claims the vault, registers this device, and the
 * registration replaces the root on disk with a device credential. Printing
 * the key after all that meant the window between the replacement and the
 * print held the only copy of it in a local variable, and a kill there left a
 * working device on a vault nobody could ever recover.
 */
/**
 * F26. A rebase reports the same outcome to a person and to a script.
 *
 * The JSON branch returned zero unconditionally while the text branch called
 * `exitCodeFor`, so an incomplete replay was a failure interactively and a
 * success in automation: exactly the difference a cron job cannot see.
 */
/**
 * F27. Cursors matching is not the same as nothing to send.
 *
 * `status` read the persisted index and the server's cursor. With the two
 * equal and the pending set empty it printed "up to date with the server"
 * without looking at the disk at all, so a note edited after a successful
 * sync sat there while the status said everything was current. That is the
 * one thing the status rule in docs/design.md forbids.
 */
describe("what status knows about this device (F27)", () => {
  it("does not claim everything is current with an unsent edit on the disk", async () => {
    const dir = await paired("statusedit");
    await writeFile(join(dir, "note.md"), "first");
    expect((await cli("sync", "--dir", dir)).code).toBe(0);

    // The settled wording, which no longer says "up to date": that would be a
    // claim about content, and the comparison is of sizes and timestamps
    // (R25). This is the string the edit below has to displace.
    const settled = await cli("status", "--dir", dir);
    expect(settled.all).toContain("nothing here looks changed");

    // Typed after the pass, which is the whole of it.
    await writeFile(join(dir, "note.md"), "and a paragraph nobody has sent");
    const after = await cli("status", "--dir", dir);
    expect(after.all, `status called an unsent edit settled:\n${after.all}`).not.toContain(
      "nothing here looks changed",
    );
    expect(after.all).toMatch(/1 not yet sent from here/);

    // And the machine-readable answer carries the same fact.
    const asJson = await cli("status", "--dir", dir, "--json");
    expect(asJson.json()["unsent"]).toBe(1);

    // A new note counts too, and so does one that was removed.
    await writeFile(join(dir, "fresh.md"), "brand new");
    expect((await cli("status", "--dir", dir, "--json")).json()["unsent"]).toBe(2);
    expect((await cli("sync", "--dir", dir)).code).toBe(0);
    expect((await cli("status", "--dir", dir, "--json")).json()["unsent"]).toBe(0);
    await rm(join(dir, "fresh.md"));
    expect((await cli("status", "--dir", dir, "--json")).json()["unsent"]).toBe(1);
  }, 300_000);
});

/**
 * Secrets that never touch the command line (I12).
 *
 * A recovery key typed as an argument is in the shell's history and in
 * `/proc` for every process on the machine while the command runs. Fine for a
 * one-off on a laptop you own, wrong for a script or a shared box. The
 * argument still works, because taking it away would make the common case
 * worse for no gain.
 */
describe("where a secret can come from (I12)", () => {
  it("reads the recovery key from a file, and writes a new one to a file only you can read", async () => {
    server = new TestServer();
    await server.start();
    const dir = await vaultDir("keyfile");
    const out = join(await vaultDir("keyout"), "key.txt");

    // The setup string from a file, and the generated key to one.
    const setupFile = join(dir, "setup.txt");
    await writeFile(setupFile, `${server.setup}\n`);
    const init = await cli("init", "--key-file", setupFile, "--key-out", out, "--dir", dir);
    expect(init.code, init.all).toBe(0);

    const written = (await readFile(out, "utf8")).trim();
    expect(written, "the key file holds no key").toMatch(/^basalt3_/);
    // And it is the key the command printed, not some other one.
    expect(init.all).toContain(written);
    // Readable by nobody else.
    expect((await stat(out)).mode & 0o077, "the key file is readable by others").toBe(0);

    // That key, back in from a file, to rotate with.
    const rotated = await cli("rotate", "--key-file", out, "--dir", dir, "--json");
    expect(rotated.code, rotated.all).toBe(0);
    expect(rotated.json()["recoveryKey"]).not.toBe(written);
  }, 300_000);

  it("refuses an empty key file rather than treating it as no key at all", async () => {
    server = new TestServer();
    await server.start();
    const dir = await vaultDir("emptykey");
    const empty = join(dir, "empty.txt");
    await writeFile(empty, "   \n");
    const r = await cli("init", "--key-file", empty, "--dir", dir);
    expect(r.code).not.toBe(0);
    expect(r.all).toMatch(/is empty/);
  }, 300_000);

  it("will not take the same secret twice, from a file and an argument", async () => {
    server = new TestServer();
    await server.start();
    const dir = await vaultDir("bothkeys");
    const f = join(dir, "setup.txt");
    await writeFile(f, `${server.setup}\n`);
    const r = await cli("init", server.setup, "--key-file", f, "--dir", dir);
    expect(r.code).not.toBe(0);
    expect(r.all).toMatch(/not both/);
  }, 300_000);
});

describe("what a rebase exits with (F26)", () => {
  it("gives JSON and text the same status when a path cannot be replayed", async () => {
    // A server that refuses anything over a few bytes, so the replay after
    // the rebase has a path it cannot finish.
    server = new TestServer();
    server.extraArgs = ["-max-file", "32"];
    await server.start();

    // Two devices of one vault, in the same state, because a rebase changes
    // the state it was asked about: running one and then the other on a
    // single vault compares a replay against a refusal.
    const first = await vaultDir("rebasetext");
    const started = await cli("init", server.setup, "--dir", first, "--device", "a", "--json");
    expect(started.code, started.all).toBe(0);
    const key = started.json()["recoveryKey"] as string;

    const second = await vaultDir("rebasejson");
    expect((await cli("pair", key, "--dir", second, "--device", "b")).code).toBe(0);

    // One note each side knows about, then a backup, then more history. The
    // restore puts the server back before the second note, which is exactly
    // the state `rebase` exists for: the devices hold versions it does not.
    // Without that a rebase refuses before it replays anything, and both
    // formats then exit the same way for the wrong reason.
    await writeFile(join(first, "one.md"), "first");
    expect((await cli("sync", "--dir", first)).code).toBe(0);
    expect((await cli("sync", "--dir", second)).code).toBe(0);
    const backup = await vaultDir("rebasebackup");
    await server.cli("backup", "-to", backup);
    await writeFile(join(first, "two.md"), "second");
    expect((await cli("sync", "--dir", first)).code).toBe(0);
    expect((await cli("sync", "--dir", second)).code).toBe(0);

    const dataDir = server.dataDir;

    // And a note on each device the restored server will refuse, so the
    // replay is incomplete rather than clean.
    await writeFile(join(first, "big.md"), "x".repeat(4096));
    await writeFile(join(second, "big.md"), "x".repeat(4096));

    const restore = async (): Promise<void> => {
      await server!.whileStopped(async () => {
        await rm(dataDir, { recursive: true, force: true });
        await cp(backup, dataDir, { recursive: true });
      });
    };

    await restore();
    const text = await cli("rebase", "--backup-taken", "--dir", first);
    // The first rebase pushes its history back, so the server is no longer
    // behind the second device. Put it back, or the second run measures a
    // refusal rather than a replay.
    await restore();
    const asJson = await cli("rebase", "--backup-taken", "--dir", second, "--json");

    expect(
      asJson.code,
      `text exited ${text.code} and json exited ${asJson.code}:\n${asJson.all}`,
    ).toBe(text.code);
    expect(text.code, `the oversized note was replayed cleanly:\n${text.all}`).toBe(1);
    // And the machine-readable answer says so in its own field too.
    expect(asJson.json()["ok"], `ok disagreed with the exit code:\n${asJson.all}`).toBe(false);
  }, 300_000);
});

describe("what init prints, and when (F02)", () => {
  it("prints the recovery key before it registers the device", async () => {
    server = new TestServer();
    await server.start();
    const dir = await vaultDir("initorder");
    // The order the lines were produced in, which is the whole property: the
    // key has to be out before the config on disk stops holding the root.
    const init = await cli("init", server.setup, "--dir", dir, "--device", "a");
    expect(init.code, init.all).toBe(0);

    const printed = init.out.join("\n");
    const key = printed.match(/basalt3_[A-Za-z0-9_-]+/)?.[0];
    expect(key, `no recovery key was printed at all: ${init.all}`).toBeDefined();
    const keyAt = printed.indexOf(key!);
    const startedAt = printed.indexOf("Started the vault");
    expect(startedAt, "init never reported success").toBeGreaterThan(-1);
    expect(
      keyAt,
      "the key was printed after the registration that had already erased it from disk",
    ).toBeLessThan(startedAt);

    // And the disk is in the state that makes revoking mean something.
    const held = await loadConfig(dir);
    expect(held?.deviceId).toBeDefined();
    expect(held?.secret, "a paired device kept the vault's root").toBeUndefined();
  }, 300_000);
});

/**
 * A version this client could not put back reaches the exit code, not only the
 * text of one command (R46, R50).
 *
 * It was reported by `status` and nothing else, and `wrong` did not include
 * it, so `status --json` answered `ok: true` and exited 0 over a vault holding
 * the only copy of an unsent edit. A green exit is how a cron job never finds
 * out, and this is a fact that does not clear itself: it waits for a person to
 * look at two files and decide.
 *
 * Against a real server, because with an unreachable one every status is
 * already not-ok and the assertion would hold whatever this code did.
 */
describe("a version the client could not put back", () => {
  it("makes an otherwise settled vault report that it is not", async () => {
    const dir = await paired("stranded");
    await writeFile(join(dir, "note.md"), "an ordinary note\n");
    expect((await cli("sync", "--dir", dir)).code).toBe(0);

    // Settled first, so the difference below is the stranded version alone.
    const settled = await cli("status", "--dir", dir, "--json");
    expect(settled.code, settled.all).toBe(0);
    expect(settled.json()["ok"]).toBe(true);

    await mkdir(join(dir, STATE_DIR, "tmp"), { recursive: true });
    await writeFile(
      join(dir, STATE_DIR, "tmp", "preserved.aaaa1111"),
      "the only copy of an edit\n",
    );

    const after = await cli("status", "--dir", dir, "--json");
    expect(
      after.json()["ok"],
      "a vault holding the only copy of an edit reported itself fine",
    ).toBe(false);
    expect(after.code, "and exited 0, which is how a cron job never finds out").toBe(1);
    expect(after.json()["stranded"]).toEqual([join(STATE_DIR, "tmp", "preserved.aaaa1111")]);

    // And the text names the path rather than a directory.
    const text = await cli("status", "--dir", dir);
    expect(text.all).toContain(join(dir, STATE_DIR, "tmp", "preserved.aaaa1111"));
  }, 120_000);
});

describe("the vault lock (C12)", () => {
  it("refuses a second holder and names the first", async () => {
    const dir = await vaultDir("lock");
    const release = await lockVault(dir, "basalt sync");
    await expect(lockVault(dir, "basalt restore")).rejects.toThrow(
      new RegExp(`basalt sync \\(pid ${process.pid} on `),
    );
    await release();
    // Released, so nobody holds it in between and the next holder gets it.
    expect(await currentHolder(dir)).toBeUndefined();
    await (
      await lockVault(dir, "basalt restore")
    )();
  });

  it("refuses a lock whose holder on this host is dead, until unlock clears it", async () => {
    const dir = await vaultDir("stale");
    await mkdir(join(dir, ".basalt"), { recursive: true });
    // A pid nothing is running under. Found by asking, not assumed.
    let dead = 2 ** 22 - 7;
    while (alive(dead)) dead--;
    await writeFile(
      lockPath(dir),
      JSON.stringify({
        pid: dead,
        host: (await import("node:os")).hostname(),
        command: "basalt sync",
        since: 1,
      }),
    );
    // Not taken over. Five attempts at doing that automatically each handed
    // one vault to two writers; the sixth answer is that a person says so.
    await expect(lockVault(dir, "basalt sync")).rejects.toThrow(/basalt unlock/);
    expect(await unlockVault(dir)).toMatchObject({ did: "removed" });
    const release = await lockVault(dir, "basalt sync");
    expect(await currentHolder(dir)).toMatchObject({ pid: process.pid });
    await release();
  });

  it("believes a holder on another host, which it cannot check", async () => {
    const dir = await vaultDir("remote");
    await mkdir(join(dir, ".basalt"), { recursive: true });
    await writeFile(
      lockPath(dir),
      JSON.stringify({
        pid: 1,
        host: "some-other-machine",
        command: "basalt sync --watch",
        since: 1,
      }),
    );
    await expect(lockVault(dir, "basalt sync")).rejects.toThrow(/some-other-machine/);
  });

  it("keeps two real processes from syncing one vault at once", async () => {
    const dir = await paired("two");
    await writeFile(join(dir, "note.md"), "a note\n");

    const watcher = basalt("sync", "--watch", "--dir", dir);
    await until(
      "the watcher to be running",
      () => /Watching for changes/.test(watcher.stderrText()),
      30_000,
    );

    const second = basalt("sync", "--dir", dir);
    expect(await exited(second)).toBe(1);
    expect(second.stderrText()).toMatch(/another basalt is using this vault: basalt sync/);
    expect(second.stderrText()).toMatch(new RegExp(`pid ${watcher.pid} on`));

    // Stopped without cleaning up, as a kill or a crash would leave it.
    const ended = exited(watcher);
    watcher.kill("SIGKILL");
    await ended;
    // The lock is still on the disk, naming the process that died with it.
    // `currentHolder` says who the file names and deliberately not whether
    // they are running: this client no longer has an opinion on that, because
    // forming one and acting on it is what went wrong five times.
    expect(await currentHolder(dir)).toMatchObject({ pid: watcher.pid });

    // The next one refuses, and the refusal is the whole user interface of
    // this decision: it has to say the holder is gone and what to type.
    const third = await cli("sync", "--dir", dir);
    expect(third.code, third.all).toBe(1);
    expect(third.all).toMatch(/not running any more/);
    expect(third.all).toMatch(/basalt unlock/);

    // And that command, typed by a person, is what frees it.
    const cleared = await cli("unlock", "--dir", dir);
    expect(cleared.code, cleared.all).toBe(0);
    expect(cleared.all).toMatch(new RegExp(`pid ${watcher.pid}`));
    expect(await currentHolder(dir)).toBeUndefined();

    const fourth = await cli("sync", "--dir", dir, "--json");
    expect(fourth.code, fourth.all).toBe(0);
    expect(await currentHolder(dir), "the vault is still held afterwards").toBeUndefined();
  }, 120_000);

  it("refuses to unlock a vault whose holder is running", async () => {
    const dir = await paired("held");
    const watcher = basalt("sync", "--watch", "--dir", dir);
    await until(
      "the watcher to be running",
      () => /Watching for changes/.test(watcher.stderrText()),
      30_000,
    );

    const refused = await cli("unlock", "--dir", dir);
    expect(refused.code, refused.all).toBe(1);
    expect(refused.all).toMatch(new RegExp(`pid ${watcher.pid} is still running`));
    // And the watcher still holds it, which is the point of refusing.
    expect(await currentHolder(dir)).toMatchObject({ pid: watcher.pid });

    const ended = exited(watcher);
    watcher.kill("SIGKILL");
    await ended;
  }, 120_000);

  it("lets a reading command through while a watcher holds the vault", async () => {
    const dir = await paired("read");
    const watcher = basalt("sync", "--watch", "--dir", dir);
    await until(
      "the watcher to be running",
      () => /Watching for changes/.test(watcher.stderrText()),
      30_000,
    );
    const status = await cli("status", "--dir", dir, "--json");
    expect(status.code, status.all).toBe(0);
  }, 120_000);
});

describe("unlinking as one transition (C13)", () => {
  it("removes the index before the config, and leaves the vault paired if it cannot", async () => {
    const dir = await paired("unlink");
    await writeFile(join(dir, "note.md"), "a note\n");
    expect((await cli("sync", "--dir", dir)).code).toBe(0);

    // The index cannot be removed: something is in its way.
    await rm(indexPath(dir));
    await mkdir(join(indexPath(dir), "occupied"), { recursive: true });
    const attempt = await cli("unlink", "--dir", dir);
    expect(attempt.code).toBe(1);
    // Still paired, which is the state that refuses to pair again.
    await expect(readFile(configPath(dir), "utf8")).resolves.toMatch(/"deviceSecret"/);
    expect((await cli("init", server!.setup, "--dir", dir)).code).toBe(1);

    await rm(indexPath(dir), { recursive: true });
    const done = await cli("unlink", "--dir", dir, "--json");
    expect(done.code, done.all).toBe(0);
    await expect(stat(configPath(dir))).rejects.toThrow();
    await expect(stat(indexPath(dir))).rejects.toThrow();
  }, 120_000);

  it("refuses to pair over an index left by an unfinished unlink", async () => {
    const { dir, recoveryKey: pairing } = await pairedWithKey("orphan");
    expect((await cli("sync", "--dir", dir)).code).toBe(0);
    // The old order's failure state: config gone, index still there.
    await rm(configPath(dir));

    const init = await cli("init", server!.setup, "--dir", dir);
    expect(init.code).toBe(1);
    expect(init.all).toMatch(/still holds an index/);
    const pair = await cli("pair", pairing, "--dir", dir);
    expect(pair.code).toBe(1);
    expect(pair.all).toMatch(/still holds an index/);

    // Unlink clears it, and then pairing is allowed.
    expect((await cli("unlink", "--dir", dir)).code).toBe(0);
    const again = await cli("pair", pairing, "--dir", dir, "--device", "again", "--json");
    expect(again.code, again.all).toBe(0);
  }, 120_000);

  it("refuses to unlink while another process is syncing the vault", async () => {
    const dir = await paired("busy");
    const watcher = basalt("sync", "--watch", "--dir", dir);
    await until(
      "the watcher to be running",
      () => /Watching for changes/.test(watcher.stderrText()),
      30_000,
    );
    const attempt = await cli("unlink", "--dir", dir);
    expect(attempt.code).toBe(1);
    expect(attempt.all).toMatch(/another basalt is using this vault/);
    await expect(readFile(configPath(dir), "utf8")).resolves.toMatch(/"deviceSecret"/);
  }, 120_000);
});

/**
 * review finding C23, at the CLI. The index on disk is valid JSON and nothing
 * else, and both `sync` and `status` used to read numbers out of it.
 */
describe("an index that is valid JSON and wrong (C23)", () => {
  it("is refused by sync and status alike, with the field named", async () => {
    const dir = await paired("badindex");
    expect((await cli("sync", "--dir", dir)).code).toBe(0);
    const index = JSON.parse(await readFile(indexPath(dir), "utf8")) as Record<string, unknown>;
    await writeFile(indexPath(dir), JSON.stringify({ ...index, pending: "soon" }));

    const sync = await cli("sync", "--dir", dir);
    expect(sync.code).toBe(1);
    expect(sync.all).toMatch(/pending is not a list/);
    expect(sync.all).toMatch(/Remove the index and sync again/);
    const status = await cli("status", "--dir", dir);
    expect(status.code).toBe(1);
    expect(status.all).toMatch(/pending is not a list/);
  }, 120_000);
});

/**
 * review finding C15, at the place protocol 4 leaves it.
 *
 * A vault is claimed by the hello that starts it, and the config holding the
 * root is written and read back before that hello goes out for exactly this
 * reason: the claim commits, its reply is lost, and the only copy of the
 * vault's recovery key is the one on this disk. Nothing resumes from the
 * config, retries the spent token or falls back to the key the root derives,
 * so the answer has to be complete without any of that: every command refuses
 * such a config, prints the
 * recovery key back out of it, and pairing again with that key joins the vault
 * that was claimed, with every note still on it.
 *
 * A vault that could be claimed and then not got back into would be the worst
 * failure this project has, so it is tested end to end rather than by the
 * words of the refusal alone.
 */
describe("a vault that was started and never joined (C15)", () => {
  /**
   * Puts a vault back into the state a lost reply leaves: claimed on the
   * server, and a config on disk that still holds the root and has no device
   * row of its own.
   *
   * Written out rather than kept from before, because `init` gets all the way
   * to a registered device now: this is the state it would have been left in
   * had the registration failed after the claim committed.
   */
  async function startedNotJoined(dir: string, recoveryKey: string): Promise<void> {
    const { parsePairing } = await import("../core/pairing.ts");
    const config = (await loadConfig(dir))!;
    await saveConfig(dir, {
      url: config.url,
      vaultId: config.vaultId,
      device: config.device,
      secret: parsePairing(recoveryKey).secret,
    });
  }

  it("refuses, hands the recovery key back, and pairs again with it", async () => {
    const { dir, recoveryKey } = await pairedWithKey("lost");
    await writeFile(join(dir, "note.md"), "kept\n");
    await cli("sync", "--dir", dir);
    await startedNotJoined(dir, recoveryKey);

    const sync = await cli("sync", "--dir", dir);
    expect(sync.code, sync.all).toBe(1);
    expect(sync.all).toMatch(/never registered itself/);
    // The key itself, not advice to find it somewhere: this config is the only
    // place it exists, and a refusal that does not print it is a lost vault.
    expect(sync.all).toContain(recoveryKey);
    expect(sync.all).toMatch(/unlink this vault and pair again/);
    // And nothing was written on the way past. The root is still there to be
    // read out again by the next command that refuses.
    expect((await loadConfig(dir))!.secret, "the root was dropped by a refusal").toBeDefined();

    // The way back the refusal names, all the way to the notes.
    expect((await cli("unlink", "--dir", dir)).code).toBe(0);
    const again = await cli("pair", recoveryKey, "--dir", dir, "--json");
    expect(again.code, again.all).toBe(0);
    const after = (await loadConfig(dir))!;
    expect(after.secret, "the recovery key was kept after pairing").toBeUndefined();
    expect(after.deviceId).toBeDefined();
    expect((await cli("sync", "--dir", dir)).code).toBe(0);
    expect(await readFile(join(dir, "note.md"), "utf8")).toBe("kept\n");
  }, 180_000);

  /**
   * The other half of the same disk failure, on the pairing path rather than
   * the starting one. A registration commits and its credential does not reach
   * the disk, so the vault has a row nothing holds the key to. That is the
   * orphan the invite path already leaves when a reply is lost, and the
   * refusal has to name it: an unnamed row is one of eight slots nobody can
   * account for later.
   */
  it("names the row it left behind when a pairing could not save its credential", async () => {
    const { dir, recoveryKey } = await pairedWithKey("orphan");
    const second = await vaultDir("second");

    failSavesAfter = saves; // the very next save fails, which is the credential
    const attempt = await cli("pair", recoveryKey, "--dir", second);
    expect(attempt.code, attempt.all).toBe(1);
    expect(attempt.all).toMatch(/nothing can connect as/);
    expect(attempt.all).toMatch(/basalt revoke/);
    // Nothing here claims to be paired, because nothing here can connect.
    failSavesAfter = Infinity;
    expect(await loadConfig(second)).toBeUndefined();

    // And the row the refusal names is really there, and really goes.
    const listed = await cli("devices", "--dir", dir, "--json");
    const rows = listed.json()["devices"] as { id: string; lastSeen: number }[];
    const orphan = rows.find((d) => d.lastSeen === 0);
    expect(orphan, listed.all).toBeDefined();
    expect((await cli("revoke", orphan!.id, "--dir", dir)).code).toBe(0);
  }, 180_000);

  /**
   * The init half of the same failure, and the sentence it was missing.
   *
   * `init` claims the vault, registers this device's row and then saves the
   * credential. When that save fails it printed the recovery key, which is
   * right, and said "unlink here, and pair with that key", which is right and
   * incomplete: the row is already on the server and nothing holds its key, so
   * pairing again registers a *second* row and each retry silently spends one
   * of the vault's eight slots. `pair` said so and `init` did not, which is
   * what one shared counsellor is for; see `adviseAfterRegistering`.
   *
   * Walked to the end rather than asserted as a sentence (rule 11): the row is
   * really there, it has really never connected, and the order the words give
   * really takes it off.
   */
  it("names the row a failed init left, and the way back it names works", async () => {
    server = new TestServer();
    await server.start();
    const dir = await vaultDir("initorphan");
    // The root is saved, the claim and the registration commit, and the save
    // that would record this device's credential fails.
    failSavesAfter = 1;
    const init = await cli("init", server.setup, "--dir", dir, "--device", "first");
    expect(init.code, init.all).toBe(1);
    expect(init.all).toMatch(/Write this recovery key down now/);
    const printed = init.err.join("\n").match(/(basalt3_[A-Za-z0-9_-]+)/)![1]!;
    expect(init.all).toMatch(/device row was registered/);
    expect(init.all).toMatch(/never connected/);
    expect(init.all).toMatch(/basalt revoke/);
    failSavesAfter = Infinity;

    // The row is really there, and has really never connected. Only the
    // recovery key can ask: the vault has no device that can.
    const look = await vaultDir("look");
    const listed = await cli("devices", "--recovery-key", printed, "--dir", look, "--json");
    expect(listed.code, listed.all).toBe(0);
    const stranded = listed.json()["devices"] as { id: string; lastSeen: number }[];
    expect(
      stranded.map((d) => d.lastSeen),
      listed.all,
    ).toEqual([0]);

    // And the way back, in the order the message gives it: pair again, then
    // revoke the row that never connected. That order and not the other one,
    // because the stranded row is this vault's only row and revoking the last
    // one takes --allow-last and the recovery key.
    expect((await cli("unlink", "--dir", dir)).code).toBe(0);
    const again = await cli("pair", printed, "--dir", dir, "--device", "second", "--json");
    expect(again.code, again.all).toBe(0);
    const now = await cli("devices", "--dir", dir, "--json");
    const mine = now.json()["thisDevice"] as string;
    const rows = now.json()["devices"] as { id: string; lastSeen: number }[];
    const orphan = rows.find((d) => d.id !== mine);
    expect(orphan?.lastSeen, now.all).toBe(0);
    expect((await cli("revoke", orphan!.id, "--dir", dir)).code).toBe(0);
    const left = await cli("devices", "--dir", dir, "--json");
    expect((left.json()["devices"] as unknown[]).length, left.all).toBe(1);
    expect((await cli("sync", "--dir", dir)).code).toBe(0);
  }, 180_000);

  /**
   * The mirror image of the orphan above, and the reason the advice is read
   * off the disk in four states rather than two.
   *
   * A disk that writes and will not read back saves the credential, fails the
   * read-back, and then fails the read the catch does as well. Both reads
   * being gone is what makes it dangerous: the row is live and its only key is
   * on this disk, so "that row is one nothing can connect as, revoke it" would
   * destroy a row this device could have used. Rule 2, in the place where
   * absent and unreadable have different consequences.
   */
  it("will not send somebody revoking a row when the disk refuses to say what is here", async () => {
    const { dir, recoveryKey } = await pairedWithKey("writeonly");
    expect(dir).toBeDefined();
    const second = await vaultDir("writeonly-2");

    breakLoadsAfterSaves = saves;
    const attempt = await cli("pair", recoveryKey, "--dir", second, "--device", "two");
    expect(attempt.code, attempt.all).toBe(1);
    expect(attempt.all).toMatch(/could not be read/);
    expect(attempt.all).toMatch(/not known/);
    // The row must not be named for revoking, because it is this device's.
    expect(attempt.all).not.toMatch(/basalt revoke/);
    expect(attempt.all).not.toMatch(/never connected/);

    // And the credential really was written: with the disk reading again this
    // device connects as the row the advice would have told somebody to take
    // away.
    breakLoadsAfterSaves = Infinity;
    expect((await loadConfig(second))!.deviceId).toBeDefined();
    expect((await cli("sync", "--dir", second)).code).toBe(0);
  }, 180_000);

  it("says the same thing to status, without blaming the server", async () => {
    const { dir, recoveryKey } = await pairedWithKey("status");
    await startedNotJoined(dir, recoveryKey);
    const s = await cli("status", "--dir", dir, "--json");
    expect(s.code, s.all).toBe(1);
    const answer = s.json()["server"] as Record<string, unknown>;
    // Rule 7. Nothing was asked of the server, so it is neither reachable nor
    // refused, and calling it refused sends somebody after an outage that is
    // not happening.
    expect(answer["reachable"], s.all).toBe(false);
    expect(answer["refused"], s.all).toBe(false);
    expect(String(answer["error"])).toMatch(/never registered itself/);
  }, 120_000);

  it("fails init honestly when the claim succeeds and the registration is not saved", async () => {
    server = new TestServer();
    await server.start();
    const dir = await vaultDir("init");
    // The root is saved, the claim goes out and commits, and the save that
    // would record this device's credential fails.
    failSavesAfter = 1;
    const init = await cli("init", server.setup, "--dir", dir, "--device", "init");
    expect(init.code).toBe(1);
    expect(init.all).toMatch(/could not register itself/);
    // The recovery key is printed anyway, because at that moment the secret in
    // this config is the only copy of it on this machine.
    expect(init.all).toMatch(/Write this recovery key down now/);
    const printed = init.err.join("\n").match(/(basalt3_[A-Za-z0-9_-]+)/)![1]!;
    expect((await loadConfig(dir))!.secret, "init threw the root away").toBeDefined();

    failSavesAfter = Infinity;
    expect((await cli("unlink", "--dir", dir)).code).toBe(0);
    const again = await cli("pair", printed, "--dir", dir, "--json");
    expect(again.code, again.all).toBe(0);
    expect((await loadConfig(dir))!.secret).toBeUndefined();
    expect((await cli("sync", "--dir", dir)).code).toBe(0);
  }, 180_000);
});
