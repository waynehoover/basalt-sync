import { expect, it, vi } from "vitest";
import { App, FakeEl, built } from "./stub.ts";
import { ConflictsModal } from "./conflicts.ts";
import { nextTurn } from "../core/test-async.ts";

it("keeps combined text when resolution fails and when the comparison refreshes", async () => {
  built.length = 0;
  const pair = { original: "Note.md", copy: "Note (Conflicted copy phone 202609101200).md" };
  const file = (path: string, text: string) => ({
    path,
    text,
    digest: text,
    stat: { path, mtime: 1, ctime: 1, size: text.length, folder: false },
  });
  const source = {
    pairs: () => [pair],
    open: () => {},
    review: async () => ({
      ...pair,
      current: file(pair.original, "original"),
      preserved: file(pair.copy, "copy"),
    }),
    resolve: vi.fn(async () => {
      throw new Error("One file changed. Refresh the comparison.");
    }),
  };
  const modal = new ConflictsModal(new App() as never, source);
  modal.open();
  await (modal as unknown as { choose(input: typeof pair): Promise<void> }).choose(pair);
  const content = modal.contentEl as unknown as FakeEl;
  const editor = content.querySelector("textarea")!;
  editor.value = "my combined text";
  editor.fire("input");
  const save = built
    .flatMap((row) => row.buttons)
    .find((button) => button.label === "Save combined version")!;
  await save.click();
  await nextTurn();
  expect(source.resolve).toHaveBeenCalledWith(expect.anything(), "edited", "my combined text");
  expect(content.querySelector("textarea")!.value).toBe("my combined text");
  await built
    .flatMap((row) => row.buttons)
    .find((button) => button.label === "Refresh")!
    .click();
  await nextTurn();
  expect(content.querySelector("textarea")!.value).toBe("my combined text");
  modal.close();
});
