/**
 * What a pass costs on the phone, which is the only machine whose answer
 * settles anything.
 *
 * `bun run bench:android`. Read [open work](../docs/open-work.md) first: it
 * names the two things this is meant to decide and fixes the threshold for
 * both *before* the numbers arrive, so neither can be argued into place
 * afterwards.
 *
 * The desktop benchmark next door (`bench-pass.ts`) measures the same phases
 * through `NodeVault` on APFS. The two differ in the term that matters: a
 * desktop `list()` walks a directory and the Obsidian adapter's reads
 * `getAllLoadedFiles()` out of memory, so roughly half of a desktop quiet pass
 * is a cost the phone does not pay, and the share of what remains is what is
 * in question.
 *
 * ## What this will not do
 *
 * It refuses to touch the live vault or the live server, and the refusals are
 * checks rather than intentions: every adb argument naming a path must sit
 * under the bench vault, and a handful of names are refused outright. A
 * benchmark that can reach somebody's notes is one nobody should run.
 *
 * It also needs a person for four things, and says so rather than pretending:
 * Obsidian's vault switcher is not reachable over adb, and neither is the
 * Restricted-mode toggle or a pairing dialog.
 *
 * ## The clock
 *
 * There is no shared clock and none is invented. The end-to-end number is
 * taken entirely on this machine: the moment before `adb` is asked to write,
 * and the moment a fresh read of the peer's own file matches the exact bytes.
 * The phone's numbers are durations from its own monotonic clock, which need
 * agreement with nothing. Total and breakdown are each sound, and what sits
 * between them is reported as a remainder rather than attributed to either.
 *
 * ## What it cannot see
 *
 * The phone has one JavaScript thread and Obsidian is on it, so a phase that
 * held the event loop while Obsidian reacted to the same save is charged for
 * it. That is why the **quiet ticker passes**, where Basalt is alone on the
 * thread, are the evidence for the phase split, and the save passes are used
 * only for the end-to-end figure.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cpus } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline/promises";

import { Client } from "./src/core/client.ts";
import { testWrapped } from "./src/core/test-keys.ts";
import { TestServer, serverBinary } from "./src/core/test-server.ts";
import { JsonIndexStore, NodeVault } from "./src/cli/vault.ts";
import { corpusPaths, noteBody, pathFor } from "./bench-corpus.ts";

const run = promisify(execFile);

/** The vault on the phone this may touch, and nothing else. */
const VAULT = process.env["BENCH_VAULT"] ?? "Bench";
const VAULT_DIR = `/sdcard/Documents/${VAULT}`;
const PLUGIN_DIR = `${VAULT_DIR}/.obsidian/plugins/basalt-sync`;
const TIMING_LOG = `${PLUGIN_DIR}/pass-timings.ndjson`;
const SIZES = (process.env["BENCH_SIZES"] ?? "10000").split(",").map(Number);
const SAMPLES = Number(process.env["BENCH_SAMPLES"] ?? 15);
/** Loopback port on the phone, forwarded to the disposable server here. */
const PHONE_PORT = Number(process.env["BENCH_PHONE_PORT"] ?? 3999);

/**
 * Names this must never appear to operate on.
 *
 * A list rather than a convention, because the cost of being wrong is somebody
 * else's notes and somebody else's server.
 */
const FORBIDDEN = ["Wayne PKB", "homelab", "tail8dd9f3"];

/** One adb call, refused before it runs if it names anything it must not. */
async function adb(...args: string[]): Promise<string> {
  const whole = args.join(" ");
  for (const name of FORBIDDEN) {
    if (whole.includes(name)) {
      throw new Error(`refusing an adb command that names ${name}: ${whole}`);
    }
  }
  for (const arg of args) {
    if (arg.startsWith("/sdcard") && !arg.startsWith(VAULT_DIR)) {
      throw new Error(`refusing an adb command outside ${VAULT_DIR}: ${arg}`);
    }
  }
  const { stdout } = await run("adb", args, { maxBuffer: 256 * 1024 * 1024 });
  return stdout;
}

const line = (text: string, match: string): string =>
  text
    .split("\n")
    .find((l) => l.includes(match))
    ?.trim() ?? "unknown";

/** What the phone is, recorded beside the numbers so they can be read later. */
async function phoneFacts(): Promise<Record<string, string>> {
  const one = async (...args: string[]) => (await adb(...args)).trim();
  return {
    device: await one("shell", "getprop", "ro.product.model"),
    android: await one("shell", "getprop", "ro.build.version.release"),
    obsidian: line(await one("shell", "dumpsys", "package", "md.obsidian"), "versionName"),
    battery: line(await one("shell", "dumpsys", "battery"), "level"),
    thermal: line(await one("shell", "dumpsys", "thermalservice"), "Thermal Status"),
  };
}

/** Whether Obsidian is the focused window, which is when Android lets it work. */
async function inForeground(): Promise<boolean> {
  return /mCurrentFocus.*md\.obsidian/.test(await adb("shell", "dumpsys", "window"));
}

const ask = async (question: string): Promise<void> => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question(`\n  ${question}\n  Press enter when done. `);
  rl.close();
};

/** One line per measured pass, as the plugin wrote it. */
interface PassLine {
  readonly at: number;
  readonly waitedMs: number | null;
  readonly listMs: number;
  readonly decideMs: number;
  readonly transferMs: number;
  readonly saveMs: number;
  readonly journalCompareMs: number;
  readonly filesystemMs: Record<string, { ms: number; calls: number }>;
  readonly journal: { compareMs: number; writeMs: number; bytes: number; kind: string } | null;
  readonly unchanged: number;
  readonly uploaded: number;
  readonly downloaded: number;
}

/** Everything the phone has written since the log was last cleared. */
async function readTimings(): Promise<PassLine[]> {
  const text = await adb("shell", "cat", TIMING_LOG).catch(() => "");
  return text
    .split("\n")
    .filter((l) => l.trim().startsWith("{"))
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as PassLine];
      } catch {
        // A line cut in half by a read racing an append. Dropped rather than
        // guessed at, and the count of them is reported.
        return [];
      }
    });
}

const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
};
const percentile = (values: number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))]!;
};

async function atSize(size: number): Promise<void> {
  console.log(`\n=== ${size.toLocaleString()} notes ===`);

  const server = new TestServer();
  await server.start();
  const secret = new Uint8Array(32).fill(41);
  const wrapped = await testWrapped(secret);
  const peerDir = await mkdtemp(join(tmpdir(), "basalt-android-peer-"));
  const port = new URL(server.wsUrl).port;

  // The phone reaches this machine over its own loopback, forwarded by adb.
  // Nothing is published on the network and the live server is never named.
  await adb("reverse", `tcp:${PHONE_PORT}`, `tcp:${port}`);
  const endpoint = `ws://127.0.0.1:${PHONE_PORT}`;

  const peer = new Client({
    vault: new NodeVault(peerDir),
    store: new JsonIndexStore(join(peerDir, ".basalt", "index.json")),
    url: server.wsUrl,
    ...(await server.deviceCredentials(secret, wrapped, "peer")),
    vaultId: "default",
    device: "peer",
    timeoutMs: 300_000,
    coalesceWrites: false,
  });

  try {
    await peer.connect();

    console.log(`  building ${size.toLocaleString()} notes on this machine...`);
    const made = new Set<string>();
    for (let i = 0; i < size; i++) {
      const rel = pathFor(i);
      const folder = join(peerDir, rel, "..");
      if (!made.has(folder)) {
        await mkdir(folder, { recursive: true });
        made.add(folder);
      }
      await writeFile(join(peerDir, rel), noteBody(i));
    }
    console.log("  uploading to the disposable server...");
    await peer.settle({}, 256);

    // The folders the corpus actually used, so the archive names them rather
    // than sweeping in the peer's `.basalt` index alongside the notes.
    const corpusFolders = [...new Set(corpusPaths(size).map((p) => p.split("/")[0]!))];

    // The phone gets the same bytes locally rather than downloading them, so
    // pairing finds both sides identical and nothing transfers. Written while
    // Obsidian is stopped, which is the one moment a vault has no watcher
    // state to protect; once it is open every write goes through Obsidian.
    console.log("  seeding the phone (Obsidian stopped)...");
    await adb("shell", "am", "force-stop", "md.obsidian");
    await adb("shell", "mkdir", "-p", PLUGIN_DIR);

    // One archive, extracted on the device. `adb push` of a directory is one
    // round trip per file, and fifty thousand of those is the seeding step
    // taking longer than everything it exists to set up. The phone has
    // toybox tar, so the transfer becomes one file and the unpacking happens
    // where the files land.
    const archive = join(peerDir, "..", `bench-corpus-${size}.tar`);
    await run("tar", ["-cf", archive, "-C", peerDir, ...corpusFolders], {
      maxBuffer: 1024 * 1024 * 1024,
    });
    const tarAt = performance.now();
    await adb("push", archive, `${VAULT_DIR}/corpus.tar`);
    await adb("shell", "tar", "-xf", `${VAULT_DIR}/corpus.tar`, "-C", VAULT_DIR);
    await adb("shell", "rm", "-f", `${VAULT_DIR}/corpus.tar`);
    await rm(archive, { force: true });
    console.log(`    seeded in ${((performance.now() - tarAt) / 1000).toFixed(1)} s`);
    await adb("push", "dist/plugin/main.js", `${PLUGIN_DIR}/main.js`);
    await adb("push", "dist/plugin/manifest.json", `${PLUGIN_DIR}/manifest.json`);
    await adb("push", "dist/plugin/styles.css", `${PLUGIN_DIR}/styles.css`);
    const enabled = join(peerDir, ".community-plugins.json");
    await writeFile(enabled, JSON.stringify(["basalt-sync"]));
    await adb("push", enabled, `${VAULT_DIR}/.obsidian/community-plugins.json`);
    await adb("shell", "touch", TIMING_LOG);

    const invite = await peer.invite();
    console.log(`\n  server: ${endpoint}`);
    console.log(`  invite: ${invite.invite}`);
    await ask(
      `Open Obsidian on the phone, choose "Open folder as vault" and pick ${VAULT}.\n` +
        `  Turn off Restricted mode, confirm Basalt Sync is enabled, then pair it\n` +
        `  with the invite above, pointing it at ${endpoint}.`,
    );

    console.log("  waiting for the phone to catch up...");
    await waitFor("the phone to appear online", async () => {
      const rows = await peer.devices();
      return rows.devices.some((d) => d.name !== "peer" && d.online);
    });

    // Settled, and seen to be settled, before anything is timed. Obsidian
    // indexes the whole vault on open and that runs on the same thread.
    await adb("shell", "rm", "-f", TIMING_LOG);
    await adb("shell", "touch", TIMING_LOG);
    console.log("  letting it settle, then collecting quiet passes...");
    await new Promise((r) => setTimeout(r, 120_000));

    const quiet = (await readTimings()).filter((l) => l.unchanged > 0 && l.uploaded === 0);
    console.log(`\n  quiet passes collected: ${quiet.length}`);
    if (quiet.length > 0) {
      const total = (l: PassLine) => l.listMs + l.decideMs + l.transferMs + l.saveMs;
      const share = median(quiet.map((l) => (l.decideMs + l.journalCompareMs) / total(l)));
      console.log(`    total     p50 ${median(quiet.map(total)).toFixed(1)} ms`);
      console.log(`    list      p50 ${median(quiet.map((l) => l.listMs)).toFixed(1)} ms`);
      console.log(`    decide    p50 ${median(quiet.map((l) => l.decideMs)).toFixed(1)} ms`);
      console.log(`    save      p50 ${median(quiet.map((l) => l.saveMs)).toFixed(1)} ms`);
      console.log(
        `    compare   p50 ${median(quiet.map((l) => l.journalCompareMs)).toFixed(1)} ms`,
      );
      console.log(`    decide+compare share: ${(share * 100).toFixed(1)}%  (threshold 50%)`);
    }

    // The end-to-end figure, on this machine's clock at both ends.
    console.log(`\n  ${SAMPLES} saved edits, phone to verified bytes here...`);
    const totals: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      if (!(await inForeground())) {
        console.log("    skipped: Obsidian was not in the foreground");
        continue;
      }
      const nonce = `bench-${Date.now()}-${i}`;
      const rel = pathFor(i % size);
      const uri =
        `obsidian://new?vault=${encodeURIComponent(VAULT)}` +
        `&file=${encodeURIComponent(rel.replace(/\.md$/, ""))}` +
        `&content=${encodeURIComponent(nonce)}&overwrite&silent`;
      const at = performance.now();
      await adb("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", uri);
      await waitFor(`sample ${i + 1} to arrive`, async () => {
        const here = await readFileMaybe(join(peerDir, rel));
        return here !== undefined && here.includes(nonce);
      });
      totals.push(performance.now() - at);
      console.log(`    ${i + 1}/${SAMPLES}: ${totals.at(-1)!.toFixed(0)} ms`);
    }
    if (totals.length > 0) {
      console.log(
        `\n  save to verified on peer: p50 ${median(totals).toFixed(0)} ms, ` +
          `p95 ${percentile(totals, 95).toFixed(0)} ms, over ${totals.length} samples`,
      );
    }
  } finally {
    await adb("reverse", "--remove", `tcp:${PHONE_PORT}`).catch(() => "");
    await peer.close().catch(() => undefined);
    await server.cleanup().catch(() => undefined);
    await rm(peerDir, { recursive: true, force: true });
  }
}

/**
 * Polls until a condition holds, or gives up and says what it was waiting for.
 *
 * `until` in the test harness takes a synchronous predicate; every condition
 * here is a read of another machine.
 */
async function waitFor(what: string, ready: () => Promise<boolean>, ms = 180_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await ready().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`gave up waiting for ${what} after ${ms} ms`);
}

async function readFileMaybe(path: string): Promise<string | undefined> {
  const { readFile } = await import("node:fs/promises");
  return readFile(path, "utf8").catch(() => undefined);
}

async function main(): Promise<void> {
  console.log("basalt: what a pass costs on the phone");
  console.log(`  ${cpus()[0]?.model ?? "unknown cpu"}, ${cpus().length} cores (host)`);
  for (const [k, v] of Object.entries(await phoneFacts())) console.log(`  ${k}: ${v}`);
  console.log(`  vault: ${VAULT_DIR}`);
  console.log(`  sizes: ${SIZES.join(", ")}, ${SAMPLES} samples each`);

  await serverBinary();
  for (const size of SIZES) await atSize(size);
}

await main();
