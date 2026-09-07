/**
 * Every destructive path, at every seam, with somebody saving into it.
 *
 * These scenarios are ordinary: a note is being replaced by a download, or
 * deleted because another device deleted it, or renamed because this disk
 * spells it in NFD. In each one a person saves the note while it happens.
 *
 * What is not ordinary is that each runs at every seam the client has, so the
 * question is no longer "does the ordering somebody wrote a test for still
 * work" but "is there an ordering that loses the save". See `faults.ts`.
 */

import { afterEach, describe, expect, it } from "vitest";

import { releaseAllSeams, seams } from "../core/seam.ts";
import { crashSweep, losses, sweep } from "./faults.ts";
import { SCENARIOS } from "./fault-scenarios.ts";
// Imported for their seams: a seam is only in the registry once its module
// has been loaded, so the driver's coverage is exactly what is imported here
// and by the scenarios (see `seams`).
import "../cli/vault.ts";
import "../cli/lock.ts";

afterEach(() => releaseAllSeams());

describe("a save landing inside a destructive operation", () => {
  // Not a scenario: a guard. A driver that has loaded no seams reports every
  // permutation as passing, and would go on doing so for ever.
  it("has seams to run against", () => {
    expect(seams().length).toBeGreaterThanOrEqual(9);
  });

  for (const scenario of SCENARIOS) {
    it(`survives it: ${scenario.name}`, async () => {
      const outcomes = await sweep(scenario);
      const reached = outcomes.filter((o) => o.fired);
      expect(reached.length, "no seam was reached, so nothing was tested").toBeGreaterThan(0);
      expect(losses(outcomes)).toEqual([]);
    }, 120_000);
  }
});

describe("a process killed inside a destructive operation", () => {
  // Every seam, not a chosen few: the whole point is that nobody picks.
  for (const scenario of SCENARIOS) {
    it(`leaves both versions findable: ${scenario.name}`, async () => {
      const outcomes = [];
      for (const it of seams()) outcomes.push(await crashSweep(scenario, it.name));
      expect(
        outcomes.filter((o) => o.fired).length,
        "no seam was reached in any child, so nothing was tested",
      ).toBeGreaterThan(0);
      expect(losses(outcomes)).toEqual([]);
    }, 600_000);
  }
});
