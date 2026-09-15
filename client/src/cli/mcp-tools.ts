import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { LocalMutationError, type Client } from "../core/client.ts";
import { type McpReader } from "./mcp-read.ts";
import {
  INPUT_BYTES,
  EDIT_BYTES,
  NOTE_BYTES,
  NoteError,
  mutateNote,
  noteFailure,
  type NoteMutation,
} from "./mcp-notes.ts";
import { TrackedMcpServer, MCP_REPLY_BYTES } from "./mcp-protocol.ts";
import type { NodeVault } from "./vault.ts";

const text = (bytes: number) =>
  z
    .string()
    .max(bytes)
    .refine(
      (value) => !/\p{Surrogate}/u.test(value) && Buffer.byteLength(value) <= bytes,
      "invalid Unicode or byte limit exceeded",
    );
const path = text(4096).min(1);
const base = z.string().regex(/^[a-f0-9]{64}$/u);
const limit = (max: number) => z.number().int().min(1).max(max);
const readSchema = z
  .object({
    path,
    startLine: limit(Number.MAX_SAFE_INTEGER).optional(),
    maxLines: limit(1000).optional(),
    base: base.optional(),
  })
  .strict();
const listSchema = z
  .object({
    folder: text(4096).optional(),
    nameContains: text(1024).optional(),
    after: text(8192).optional(),
    limit: limit(500).optional(),
    includeBackups: z.boolean().optional(),
  })
  .strict();
const searchSchema = z
  .object({
    query: text(1024).min(1),
    folder: text(4096).optional(),
    caseSensitive: z.boolean().optional(),
    cursor: text(8192).optional(),
    limit: limit(200).optional(),
    contextLines: z.number().int().min(0).max(3).optional(),
    includeBackups: z.boolean().optional(),
  })
  .strict();
const editSchema = z
  .object({
    path,
    base,
    edits: z
      .array(z.object({ old: text(EDIT_BYTES).min(1), new: text(EDIT_BYTES) }).strict())
      .min(1)
      .max(32),
  })
  .strict()
  .refine(
    (value) =>
      value.edits.reduce(
        (n, edit) => n + Buffer.byteLength(edit.old) + Buffer.byteLength(edit.new),
        0,
      ) <= INPUT_BYTES,
    "edits exceed 64 KiB",
  );
const appendSchema = z.object({ path, base, text: text(INPUT_BYTES).min(1) }).strict();
const createSchema = z.object({ path, content: text(NOTE_BYTES) }).strict();

export interface McpSession {
  readonly mode: "read-only" | "writable";
  readonly reader: McpReader;
  readonly writer: NodeVault;
  client(): Client | undefined;
  stopping(): boolean;
  changed(): void;
  summary(): object;
  status(): Promise<object>;
}

export function toolResult(value: object, isError = false): CallToolResult {
  const result: CallToolResult = {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
    ...(isError ? { isError: true } : {}),
  };
  // The JSON-RPC id and SDK metadata also need room in the transport's total budget.
  if (Buffer.byteLength(JSON.stringify(result)) > MCP_REPLY_BYTES - 16384) {
    return toolResult(
      { error: { code: "result_too_large", message: "request a smaller page" } },
      true,
    );
  }
  return result;
}
export function toolFailure(error: unknown): { code: string; message: string } {
  if (error instanceof LocalMutationError) return { code: error.code, message: error.message };
  return noteFailure(error);
}

export function createTools(session: McpSession, version: string) {
  const server = new TrackedMcpServer({ name: "basalt", version });
  const pending = new Set<Promise<CallToolResult>>();
  function call(work: () => Promise<object>): Promise<CallToolResult> {
    const running = (async () => {
      try {
        if (session.stopping()) throw new NoteError("stopping", "the MCP process is stopping");
        const result = await work();
        return toolResult(result, "error" in result);
      } catch (error) {
        return toolResult({ error: toolFailure(error) }, true);
      }
    })();
    pending.add(running);
    void running.finally(() => pending.delete(running));
    return running;
  }
  const readAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
  server.registerTool(
    "list_notes",
    {
      description:
        "List local vault paths. Follow nextAfter for more; backups are hidden unless requested.",
      inputSchema: listSchema,
      annotations: readAnnotations,
    },
    (input, ctx) =>
      call(async () => ({
        ...(await session.reader.list(input, ctx.mcpReq.signal)),
        connection: session.summary(),
      })),
  );
  server.registerTool(
    "read_note",
    {
      description:
        "Read a local note page and its complete SHA-256 base. Pin base when reading later pages.",
      inputSchema: readSchema,
      annotations: readAnnotations,
    },
    (input, ctx) =>
      call(async () => ({
        ...(await session.reader.read(input, ctx.mcpReq.signal)),
        connection: session.summary(),
      })),
  );
  server.registerTool(
    "search_notes",
    {
      description:
        "Search literal text in local notes. Follow nextCursor and check skipped and complete.",
      inputSchema: searchSchema,
      annotations: readAnnotations,
    },
    (input, ctx) =>
      call(async () => ({
        ...(await session.reader.search(input, ctx.mcpReq.signal)),
        connection: session.summary(),
      })),
  );
  server.registerTool(
    "sync_status",
    {
      description:
        "Observe connection, readiness, last sync pass and recoverable versions. This is not an upload receipt.",
      inputSchema: z.object({}).strict(),
      annotations: readAnnotations,
    },
    () => call(() => session.status()),
  );

  async function mutation(request: NoteMutation, signal: AbortSignal): Promise<object> {
    let admitted = false;
    try {
      if (session.mode !== "writable")
        throw new NoteError("read_only", "this process cannot change notes");
      const client = session.client();
      if (!client?.writeReady)
        throw new NoteError(
          "not_ready",
          "wait for a settled live connection before changing notes",
        );
      return await client.mutateLocal(
        async ({ changed }) => {
          if (session.mode !== "writable" || session.stopping())
            throw new NoteError("stopping", "this process cannot admit a mutation");
          admitted = true;
          let invalidated = false;
          const result = await mutateNote(session.writer, request, (path) => {
            if (!invalidated) {
              session.changed();
              invalidated = true;
            }
            changed(path);
          });
          return { ...result, connection: session.summary() };
        },
        { signal },
      );
    } catch (error) {
      return {
        path: request.path,
        applied: admitted ? "unknown" : false,
        ...(admitted ? { durable: "unknown" } : {}),
        preserved: [],
        error: toolFailure(error),
        connection: session.summary(),
      };
    }
  }

  if (session.mode === "writable") {
    const annotations = {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    };
    server.registerTool(
      "edit_note",
      {
        description:
          "Apply 1 to 32 exact, unique old-to-new edits against a required base. Saves a verified before-image first. On stale or unknown outcome, reread and reconsider; never substitute a new base automatically.",
        inputSchema: editSchema,
        annotations,
      },
      (input, ctx) => call(() => mutation({ kind: "edit", ...input }, ctx.mcpReq.signal)),
    );
    server.registerTool(
      "append_note",
      {
        description:
          "Append exact text to an existing note with its required base, preserving a before-image. No separator is added. On uncertain outcome, inspect before retrying.",
        inputSchema: appendSchema,
        annotations,
      },
      (input, ctx) => call(() => mutation({ kind: "append", ...input }, ctx.mcpReq.signal)),
    );
    server.registerTool(
      "create_note",
      {
        description:
          "Create a new Markdown or text note only at an unoccupied path. Never replaces a note.",
        inputSchema: createSchema,
        annotations,
      },
      (input, ctx) => call(() => mutation({ kind: "create", ...input }, ctx.mcpReq.signal)),
    );
  }
  return {
    server,
    async drain() {
      await Promise.all(pending);
    },
  };
}
