/**
 * What arrives is bounded before it is expanded, parsed or kept (R13).
 *
 * F28 added the counts: how many notifications may queue, how many bodies a
 * fetch may carry. What it did not add is bytes. A count of objects says
 * nothing about the memory they occupy, and each of the three checks ran after
 * the expensive step rather than before it:
 *
 *   - the plaintext ceiling was compared against the finished inflate, so the
 *     allocation it refuses had already happened, and a quarter of a gigabyte
 *     of zeroes is 256 kB on the wire;
 *   - a chunk framed raw skipped that ceiling altogether, so the bound was a
 *     property of how the writer chose to frame its bytes;
 *   - a text frame was parsed and then looked at, and `JSON.parse` on a very
 *     large string is the allocation.
 */

import { deflateSync } from "fflate";
import { describe, expect, it } from "vitest";

import { MAX_CHUNK_PLAINTEXT, openChunk, seal } from "./crypto.ts";
import { testKeys } from "./test-keys.ts";

const CHUNK_RAW = 0;
const CHUNK_DEFLATE = 1;

/** A sealed chunk carrying whatever framing and payload a test wants. */
async function sealedWith(marker: number, payload: Uint8Array): Promise<Uint8Array> {
  const keys = await testKeys();
  const framed = new Uint8Array(1 + payload.length);
  framed[0] = marker;
  framed.set(payload, 1);
  return await seal(keys.content, keys.nonce, framed);
}

describe("a chunk that expands past what a chunk may hold", () => {
  it("is refused, and the expansion is stopped rather than completed", async () => {
    const keys = await testKeys();
    // 256 MiB of one byte, which deflate carries in a few hundred kilobytes.
    // Reaching the old check meant allocating all of it first.
    const bomb = deflateSync(new Uint8Array(256 * 1024 * 1024));
    expect(bomb.length, "the payload is not small enough to make the point").toBeLessThan(
      2 * 1024 * 1024,
    );
    const sealed = await sealedWith(CHUNK_DEFLATE, bomb);

    const started = Date.now();
    await expect(openChunk(keys, sealed)).rejects.toThrow(/over the .* a chunk may hold/);
    // Stopping early is the point, and it is also observable: inflating the
    // whole 256 MiB takes far longer than refusing it partway.
    expect(
      Date.now() - started,
      "the refusal took long enough that it probably inflated the whole thing",
    ).toBeLessThan(5000);
  }, 60_000);

  /** The raw framing gets the same ceiling. It used to get none. */
  it("is refused when it is framed raw as well as when it is deflated", async () => {
    const keys = await testKeys();
    const big = new Uint8Array(MAX_CHUNK_PLAINTEXT + 1);
    const sealed = await sealedWith(CHUNK_RAW, big);
    await expect(openChunk(keys, sealed)).rejects.toThrow(/over the .* a chunk may hold/);
  }, 60_000);

  /** And an ordinary chunk still opens, both ways round. */
  it("still opens a chunk of an ordinary size", async () => {
    const keys = await testKeys();
    const text = new TextEncoder().encode("a note, of the size notes are.\n".repeat(100));
    for (const [marker, payload] of [
      [CHUNK_RAW, text],
      [CHUNK_DEFLATE, deflateSync(text)],
    ] as const) {
      const sealed = await sealedWith(marker, payload);
      expect(await openChunk(keys, sealed)).toEqual(text);
    }
  }, 60_000);
});
