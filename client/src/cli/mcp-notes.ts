import { createHash, randomBytes } from "node:crypto";
import { conflictCopyPath } from "../core/merge.ts";
import { firstFreeName, splitName } from "../core/paths.ts";
import { composite, seam } from "../core/seam.ts";
import { CheckedPathError, PreservationError, type NodeVault } from "./vault.ts";

export const NOTE_BYTES = 1024 * 1024;
export const EDIT_BYTES = 8 * 1024;
export const INPUT_BYTES = 64 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export const midNoteMutation = composite({
  backupVerified: seam("cli/mcp:backupVerified"),
  backupDurable: seam("cli/mcp:backupDurable"),
  published: seam("cli/mcp:published"),
  durable: seam("cli/mcp:durable"),
});

export type NoteMutation =
  | { kind: "edit"; path: string; base: string; edits: readonly { old: string; new: string }[] }
  | { kind: "append"; path: string; base: string; text: string }
  | { kind: "prepend"; path: string; base: string; text: string }
  | { kind: "create"; path: string; content: string };
export type Certainty = boolean | "unknown";
export interface MutationResult {
  applied: Certainty;
  durable?: Certainty;
  path: string;
  base?: string;
  bytesBefore?: number;
  bytesAfter?: number;
  beforeImage?: string;
  preserved: string[];
  noop?: boolean;
  error?: { code: string; message: string };
  sync?: { state: "pending"; reason: string };
}

export class NoteError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function noteDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function noteText(bytes: Uint8Array): string {
  if (bytes.length > NOTE_BYTES)
    throw new NoteError("note_too_large", "notes must be at most 1 MiB");
  try {
    return decoder.decode(bytes);
  } catch {
    throw new NoteError("invalid_utf8", "the note is not valid UTF-8");
  }
}

export function inputText(value: string, cap: number): Uint8Array {
  if (typeof value !== "string" || /\p{Surrogate}/u.test(value)) {
    throw new NoteError(
      "invalid_text",
      "text must contain valid Unicode without unpaired surrogates",
    );
  }
  if (Buffer.byteLength(value) > cap)
    throw new NoteError("input_too_large", "the supplied text exceeds its byte limit");
  return encoder.encode(value);
}

export function backupOf(path: string): string | undefined {
  const match = /^(.*) \(MCP (?:backup|recovery) \d{8}T\d{6}Z [a-f0-9]{8,32}\)(\.[^/]*)?$/isu.exec(
    path,
  );
  return match ? `${match[1]}${match[2] ?? ""}` : undefined;
}

export function noteFormat(path: string, mutable = false): void {
  if (
    typeof path !== "string" ||
    !/\.(md|txt)$/iu.test(path) ||
    (mutable && /\.excalidraw\.md$/iu.test(path))
  ) {
    throw new NoteError(
      "unsupported_format",
      "agent notes must be Markdown or plain text, excluding drawings",
    );
  }
  if (mutable && backupOf(path) !== undefined) {
    throw new NoteError(
      "reserved_backup",
      "MCP recovery copies can be read but cannot be changed by an agent",
    );
  }
}

export function noteFailure(error: unknown): { code: string; message: string } {
  if (error instanceof NoteError || error instanceof CheckedPathError)
    return { code: error.code, message: error.message };
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT")
    return {
      code: "not_found_local",
      message: "the path is not present locally; it may still be catching up",
    };
  if (code === "EACCES" || code === "EPERM")
    return { code: "unreadable", message: "the filesystem refused access to this path" };
  return {
    code: "io_error",
    message:
      "the local operation could not be verified; inspect the reported recovery paths before retrying",
  };
}

function replacement(
  source: string,
  edits: Extract<NoteMutation, { kind: "edit" }>["edits"],
): Uint8Array {
  if (!Array.isArray(edits) || edits.length < 1 || edits.length > 32)
    throw new NoteError("invalid_edits", "supply between 1 and 32 exact edits");
  let input = 0;
  const spans = edits.map((edit) => {
    input += inputText(edit.old, EDIT_BYTES).length + inputText(edit.new, EDIT_BYTES).length;
    if (!edit.old.length) throw new NoteError("invalid_edits", "an old span cannot be empty");
    const start = source.indexOf(edit.old);
    if (start < 0)
      throw new NoteError(
        "no_match",
        "an old span does not occur in the source; read and reconsider",
      );
    if (source.indexOf(edit.old, start + 1) >= 0)
      throw new NoteError(
        "ambiguous_edit",
        "an old span occurs more than once; include unique surrounding text",
      );
    return { start, end: start + edit.old.length, text: edit.new };
  });
  if (input > INPUT_BYTES)
    throw new NoteError("input_too_large", "the combined edit input exceeds 64 KiB");
  spans.sort((a, b) => a.start - b.start);
  for (let i = 1; i < spans.length; i++) {
    if (spans[i]!.start < spans[i - 1]!.end)
      throw new NoteError("overlapping_edits", "the edits overlap in the original source");
  }
  let at = 0;
  const pieces: string[] = [];
  for (const span of spans) {
    pieces.push(source.slice(at, span.start), span.text);
    at = span.end;
  }
  pieces.push(source.slice(at));
  return inputText(pieces.join(""), NOTE_BYTES);
}

function sibling(path: string, kind: "backup" | "recovery"): string {
  const { stem, ext } = splitName(path);
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/gu, "")
    .replace(/\.\d{3}Z$/u, "Z");
  return `${stem} (MCP ${kind} ${stamp} ${randomBytes(8).toString("hex")})${ext}`;
}

/** No client or wire calls belong here. The caller owns the serial write slot. */
export async function mutateNote(
  vault: NodeVault,
  request: NoteMutation,
  changed: (path: string) => void,
): Promise<MutationResult> {
  const result: MutationResult = { applied: false, path: request.path, preserved: [] };
  let proposed: Uint8Array | undefined;
  let publishing = false;
  let raced = false;
  let times = { mtime: Date.now(), ctime: Date.now() };
  const mark = (path: string): void => {
    changed(path);
  };
  const verify = async (path: string, expected: Uint8Array): Promise<void> => {
    const found = await vault.readSnapshot(path, NOTE_BYTES, { flush: true });
    if (
      found.size !== expected.length ||
      found.base !== noteDigest(expected) ||
      !Buffer.from(found.bytes).equals(expected)
    ) {
      throw new NoteError(
        "verification_failed",
        "the written bytes differ from the intended bytes",
      );
    }
  };
  const saveSibling = async (bytes: Uint8Array, kind: "backup" | "recovery"): Promise<string> => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const path = sibling(result.path, kind);
      await vault.checkPath(path, { allowMissing: true });
      // A failed exclusive-open fallback can leave partial bytes. Report its
      // attempted name and never delete it merely because verification failed.
      result.preserved.push(path);
      mark(path);
      if (!(await vault.create(path, bytes, times))) {
        result.preserved.pop();
        continue;
      }
      await verify(path, bytes);
      if (kind === "backup") await midNoteMutation.backupVerified(result.path);
      await vault.flush();
      return path;
    }
    throw new NoteError("backup_collision", "could not claim a free recovery name");
  };
  try {
    noteFormat(request.path, true);
    if (request.kind === "create") {
      proposed = inputText(request.content, NOTE_BYTES);
      const destination = await vault.checkPath(request.path, { allowMissing: true });
      result.path = destination.path;
      if (destination.exists) throw new NoteError("exists", "the destination is already occupied");
      publishing = true;
      result.applied = "unknown";
      mark(result.path);
      if (!(await vault.create(result.path, proposed, times))) {
        publishing = false;
        result.applied = false;
        throw new NoteError("exists", "another writer occupied the destination");
      }
      result.bytesBefore = 0;
    } else {
      if (typeof request.base !== "string" || !/^[a-f0-9]{64}$/u.test(request.base))
        throw new NoteError("invalid_base", "supply the complete SHA-256 base from read_note");
      const before = await vault.readSnapshot(request.path, NOTE_BYTES);
      result.path = before.path;
      noteFormat(result.path, true);
      if (before.base !== request.base)
        throw new NoteError("stale", "the note changed; read it and reconsider the edit");
      const source = noteText(before.bytes);
      if (request.kind === "append" || request.kind === "prepend") {
        const suffix = inputText(request.text, INPUT_BYTES);
        if (suffix.length === 0)
          throw new NoteError("invalid_text", "inserted text cannot be empty");
        if (request.kind === "append") proposed = Buffer.concat([before.bytes, suffix]);
        else {
          const bom = source.startsWith("\ufeff") ? 3 : 0;
          proposed = Buffer.concat([
            before.bytes.subarray(0, bom),
            suffix,
            before.bytes.subarray(bom),
          ]);
        }
      } else proposed = replacement(source, request.edits);
      if (proposed.length > NOTE_BYTES)
        throw new NoteError("note_too_large", "the resulting note exceeds 1 MiB");
      result.bytesBefore = before.size;
      result.bytesAfter = proposed.length;
      if (Buffer.from(before.bytes).equals(proposed)) {
        return { ...result, base: before.base, noop: true };
      }
      times = { mtime: Date.now(), ctime: before.ctime };
      result.durable = false;
      // Rules 3 and 5: a matching base says nothing about unsent prose the
      // requested edit removes. Preserve an independent, verified copy first.
      const backup = await saveSibling(before.bytes, "backup");
      result.beforeImage = backup;
      result.preserved = result.preserved.filter((path) => path !== backup);
      await midNoteMutation.backupDurable(result.path);
      const again = await vault.readSnapshot(result.path, NOTE_BYTES);
      if (again.base !== before.base)
        throw new NoteError(
          "stale",
          "the note changed while its before-image was saved; read and reconsider",
        );
      const keepAt = await firstFreeName(
        conflictCopyPath(result.path, "MCP", new Date()),
        async (path) => (await vault.checkPath(path, { allowMissing: true })).exists,
      );
      await vault.checkPath(result.path);
      publishing = true;
      result.applied = "unknown";
      mark(result.path);
      mark(keepAt);
      const replaced = await vault.replace(
        result.path,
        { contentId: before.base, idOf: async (bytes) => noteDigest(bytes) },
        proposed,
        times,
        keepAt,
      );
      if (replaced.keptAt) {
        result.preserved.push(replaced.keptAt);
        mark(replaced.keptAt);
        await vault.readSnapshot(replaced.keptAt, NOTE_BYTES, { flush: true });
        raced = true;
      }
      if (!replaced.landed) {
        result.applied = false;
        await saveSibling(proposed, "recovery");
        await vault.flush();
        result.durable = true;
        return {
          ...result,
          error: {
            code: "race",
            message: "another writer took the destination; the proposed edit was saved beside it",
          },
        };
      }
    }
    await midNoteMutation.published(result.path);
    await verify(result.path, proposed);
    result.applied = true;
    await vault.flush();
    result.durable = true;
    await midNoteMutation.durable(result.path);
    result.bytesAfter = proposed.length;
    result.base = noteDigest(proposed);
    if (raced)
      return {
        ...result,
        error: {
          code: "race",
          message:
            "the edit landed, but a newer local version was displaced and preserved; inspect both",
        },
      };
    result.sync = { state: "pending", reason: "ordinary sync scheduled" };
    return result;
  } catch (error) {
    if (error instanceof PreservationError) {
      for (const path of error.preserved) {
        if (!result.preserved.includes(path)) result.preserved.push(path);
        mark(path);
      }
    }
    if (publishing && proposed) {
      // Publication can have succeeded even when the adapter threw. Never
      // turn a lost acknowledgement into permission to repeat an append.
      let matches = false;
      try {
        await verify(result.path, proposed);
        matches = true;
        result.applied = true;
      } catch {
        /* The target may belong to a later writer; never roll it back. */
      }
      if (!matches) {
        try {
          await saveSibling(proposed, "recovery");
        } catch {
          /* Its attempted path is retained in preserved. */
        }
      }
      result.durable = false;
    }
    return { ...result, error: noteFailure(error) };
  }
}
