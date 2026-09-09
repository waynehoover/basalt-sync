import { normalizePath, type DataAdapter } from "obsidian";
import { configFolderName, isNeverSynced } from "../core/paths.ts";

export type FirstSync = "download" | "combine";

/** Check the actual files before registering a device or spending its invite. */
export async function checkFirstSync(
  adapter: Pick<DataAdapter, "list">,
  configDir: string,
  choice: FirstSync,
): Promise<void> {
  if (choice === "combine") return;
  if (choice !== "download") throw new Error("Choose how to start the first sync.");
  const excluded = new Set([configFolderName(configDir)]);
  const included = (path: string) => !isNeverSynced(normalizePath(path), excluded);
  const folders = [""];
  while (folders.length > 0) {
    // The loaded-file cache may still be filling when a QR link opens Obsidian.
    // A failed directory read must also refuse pairing, never mean "empty".
    const listed = await adapter.list(folders.pop()!);
    if (listed.files.some(included)) {
      throw new Error(
        "Download server vault needs an empty vault. Create a new Obsidian vault, " +
          "or choose Combine local files to upload the files already on this device. Nothing has been changed.",
      );
    }
    folders.push(...listed.folders.filter(included));
  }
}
