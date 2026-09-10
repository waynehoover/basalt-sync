import { Modal, Setting, type App } from "obsidian";
import { previewCounts, type SyncPreview, type PreviewAction } from "../core/preview.ts";
const LABELS: Record<PreviewAction, string> = {
  upload: "Upload",
  download: "Download",
  merge: "Merge, or keep both if edits overlap",
  copy: "Keep both versions",
  "delete-local": "Delete on this device",
  "delete-server": "Upload deletion",
  unchanged: "Already matches",
  blocked: "Needs attention",
  "held-back": "Local change kept on this device",
};
export class SyncPreviewModal extends Modal {
  private answer: ((proceed: boolean) => void) | undefined;
  constructor(
    app: App,
    private readonly preview: SyncPreview,
    private readonly heading = "Preview sync",
  ) {
    super(app);
  }
  confirm(): Promise<boolean> {
    return new Promise((resolve) => {
      this.answer = resolve;
      this.open();
    });
  }
  override onOpen(): void {
    this.setTitle(this.heading);
    this.modalEl.addClass("mod-basalt-preview");
    const counts = previewCounts(this.preview);
    this.contentEl.createEl("p", {
      text: "Based on the files here and the server history just read. Changes made while this is open will be checked again during sync.",
    });
    for (const [key, count] of Object.entries(counts)) {
      if (count)
        new Setting(this.contentEl)
          .setName(LABELS[key as PreviewAction])
          .setDesc(`${count.toLocaleString()} ${count === 1 ? "file" : "files"}`);
    }
    const details = this.contentEl.createEl("details");
    details.createEl("summary", { text: "File details" });
    const changes = this.preview.files.filter((file) => file.action !== "unchanged");
    const list = details.createDiv("basalt-activity-list");
    for (const file of changes.slice(0, 200))
      new Setting(list).setName(file.path).setDesc(LABELS[file.action]);
    if (changes.length > 200)
      list.createEl("p", { text: `Showing 200 of ${changes.length.toLocaleString()} changes.` });
    if (this.answer)
      new Setting(this.contentEl)
        .addButton((button) => button.setButtonText("Pause sync").onClick(() => this.close()))
        .addButton((button) =>
          button
            .setButtonText("Continue sync")
            .setCta()
            .onClick(() => {
              this.answer?.(true);
              this.answer = undefined;
              this.close();
            }),
        );
  }
  override onClose(): void {
    this.answer?.(false);
    this.answer = undefined;
    this.contentEl.empty();
  }
}
