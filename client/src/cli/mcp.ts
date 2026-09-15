import { runForever, type Client } from "../core/client.ts";
import { outcomeOf } from "../core/outcome.ts";
import type { Args, Console } from "./cli.ts";
import { clientOptions } from "./client-options.ts";
import { loadConfig } from "./config.ts";
import { NodeVault } from "./vault.ts";
import { McpReader } from "./mcp-read.ts";
import { startStdio, type ProtocolHandle } from "./mcp-protocol.ts";
import { createTools, type McpSession } from "./mcp-tools.ts";

function boundedArrays<T extends object>(value: T): { value: T; truncated: boolean } {
  let remaining = 32768;
  let truncated = false;
  const result = Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (!Array.isArray(item)) return [key, item];
      const rows: unknown[] = [];
      for (const row of item) {
        const bytes = Buffer.byteLength(JSON.stringify(row));
        if (rows.length >= 20 || bytes > remaining) {
          truncated = true;
          continue;
        }
        remaining -= bytes;
        rows.push(row);
      }
      return [key, rows];
    }),
  );
  return { value: result as T, truncated };
}

export async function cmdMcp(args: Args, io: Console, version: string): Promise<number> {
  const config = await loadConfig(args.dir);
  if (!config) throw new Error(`${args.dir} is not paired. Run basalt init or basalt pair first.`);
  const opts = await clientOptions(config, { ...args, watch: true }, io);
  const writer = opts.vault as NodeVault;
  const observed = new NodeVault(args.dir, {
    configDir: args.configDir,
    alsoIgnore: args.ignore,
    observeOnly: true,
  });
  await observed.probeCase();
  const reader = new McpReader(observed);
  let current: Client | undefined;
  let stopping = false;
  let state = "connecting";
  let wake: (() => void) | undefined;
  let lastPass: object | null = null;
  let lastFailure: object | null = null;
  let localGeneration = 0;
  let passGeneration = 0;
  let scannedGeneration = 0;
  let protocol: ProtocolHandle | undefined;
  let exitCode = 0;
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  function stop(error?: Error): void {
    if (stopping) return;
    stopping = true;
    state = "stopping";
    if (error) {
      exitCode = 1;
      io.err(`basalt mcp: ${error.message.slice(0, 1024)}`);
    }
    protocol?.stop();
    wake?.();
    // close refuses queued mutations immediately and drains an admitted one.
    void current?.close().catch((error) => {
      exitCode = 1;
      io.err(`basalt mcp: ${String(error).slice(0, 1024)}`);
    });
    finish();
  }
  const summary = () => ({
    connection: state,
    writeReady: !stopping && !!current?.writeReady,
    localGeneration,
    scannedGeneration,
    localWritesSincePass: localGeneration - scannedGeneration,
  });
  const session: McpSession = {
    mode: opts.readOnly ? "read-only" : "writable",
    reader,
    writer,
    client: () => current,
    stopping: () => stopping,
    changed: () => {
      localGeneration++;
    },
    summary,
    async status() {
      return reader.run(async () => {
        let scanFailure: string | undefined;
        try {
          await observed.list({ forceFull: true, checked: true });
        } catch {
          scanFailure = "the recovery inventory could not be completely checked";
        }
        const recovery = observed.recovery;
        const sampled = boundedArrays({ stranded: observed.stranded, displaced: recovery.waiting });
        return {
          ...summary(),
          readOnly: opts.readOnly ?? false,
          mergeEnabled: opts.merge ?? true,
          exclusions: { configDir: args.configDir ?? ".obsidian", ignoredNames: args.ignore },
          engine: current
            ? { ...current.engine.status(), serverCursor: current.serverCursor }
            : null,
          lastPass,
          lastFailure,
          recovery: {
            observedAt: scanFailure ? null : Date.now(),
            complete: !scanFailure && recovery.complete,
            why: scanFailure ?? recovery.why?.slice(0, 1024) ?? null,
            ...sampled.value,
            count: new Set([...observed.stranded, ...recovery.waiting.map((item) => item.at)]).size,
            truncated: sampled.truncated,
          },
          observedAt: Date.now(),
        };
      });
    },
  };
  const registries: ReturnType<typeof createTools>[] = [];
  const onSignal = () => stop();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const loop = runForever(
    {
      ...opts,
      onSyncStart: () => {
        passGeneration = localGeneration;
      },
      onPass: (report) => {
        scannedGeneration = passGeneration;
        const sampled = boundedArrays(report);
        const outcome = boundedArrays(
          outcomeOf(report, undefined, writer.recovery, writer.stranded),
        );
        lastPass = {
          at: Date.now(),
          report: sampled.value,
          outcome: outcome.value,
          truncated: sampled.truncated || outcome.truncated,
        };
      },
      onSyncFailed: (error) => {
        lastFailure = { at: Date.now(), message: error.message.slice(0, 1024), retryInMs: null };
      },
    },
    {
      keepGoing: () => !stopping,
      onWaiting: (value) => {
        wake = value;
      },
      onConnecting: (client) => {
        current = client;
        state = "connecting";
      },
      onClient: (client) => {
        if (client) {
          current = client;
          state = "initial-sync";
        } else {
          current = undefined;
          if (!stopping && state !== "fatal") state = "offline";
        }
      },
      onSynced: () => {
        if (!stopping) state = "ready";
      },
      onFatal: (error) => {
        state = "fatal";
        lastFailure = { at: Date.now(), message: error.message.slice(0, 1024), retryInMs: null };
      },
      onDisconnected: (error, retryInMs) => {
        if (!stopping) state = "offline";
        lastFailure = { at: Date.now(), message: error.message.slice(0, 1024), retryInMs };
      },
      onUnreachable: (error, retryInMs) => {
        if (!stopping) state = "offline";
        lastFailure = { at: Date.now(), message: error.message.slice(0, 1024), retryInMs };
      },
    },
  ).catch(stop);
  try {
    protocol = startStdio(
      () => {
        const registry = createTools(session, version);
        registries.push(registry);
        return registry.server;
      },
      process.stdin,
      process.stdout,
      stop,
    );
    await finished;
  } finally {
    stop();
    await loop;
    await Promise.all(registries.map((registry) => registry.drain()));
    await reader.drain();
    await protocol?.drain();
    await protocol?.close();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
  return exitCode;
}
