import { when } from "./history.ts";
import { Modal, Notice, Setting, type App, type DataAdapter } from "obsidian";
import type { Activity, ActivityAction } from "../core/activity.ts";

const LIMIT = 300;
const ACTIONS: Record<ActivityAction, string> = {
  uploaded: "Uploaded to server",
  downloaded: "Downloaded",
  merged: "Merged edits",
  "deleted-local": "Deleted on this device",
  "deleted-server": "Deletion uploaded",
  conflict: "Kept both versions",
  error: "Sync failed",
  resolved: "Conflict resolved",
};

export class ActivityLog {
  events: Activity[] = [];
  problem: string | undefined;
  private dirty = false;
  private writing: Promise<void> = Promise.resolve();
  constructor(
    private readonly adapter: Pick<DataAdapter, "read" | "write" | "exists" | "stat">,
    private readonly path: string,
  ) {}

  async load(): Promise<void> {
    try {
      if (!(await this.adapter.exists(this.path))) return;
      const stat = await this.adapter.stat(this.path);
      if (!stat || stat.size > 3 * 1024 * 1024) throw new Error("Invalid activity log size");
      const data: unknown = JSON.parse(await this.adapter.read(this.path));
      if (!Array.isArray(data) || data.length > LIMIT) throw new Error("Invalid activity log");
      this.events = data.map((event) => {
        if (
          !event ||
          typeof event !== "object" ||
          !Number.isFinite(event.at) ||
          !Object.hasOwn(ACTIONS, event.action) ||
          [event.path, event.copy].some(
            (p) => p !== undefined && (typeof p !== "string" || p.length > 4096),
          )
        )
          throw new Error("Invalid activity entry");
        // Only the allowlisted fields can reach display or export, even from a modified file.
        return {
          at: event.at,
          action: event.action,
          ...(event.path ? { path: event.path } : {}),
          ...(event.copy ? { copy: event.copy } : {}),
        };
      });
    } catch {
      this.problem =
        "The saved activity log could not be read. Sync can continue. Clear the log to start a new one.";
    }
  }

  add(event: Activity): void {
    const last = this.events.at(-1);
    if (
      last &&
      last.action === event.action &&
      last.path === event.path &&
      last.copy === event.copy &&
      event.at - last.at < 1000
    )
      return;
    this.events.push(event);
    this.events = this.events.slice(-LIMIT);
    this.dirty = true;
  }

  flush(): Promise<void> {
    this.writing = this.writing.then(async () => {
      if (!this.dirty || this.problem) return;
      this.dirty = false;
      try {
        await this.adapter.write(this.path, JSON.stringify(this.events));
      } catch {
        this.dirty = true;
        this.problem = "Recent activity could not be saved. Clear the log to retry.";
      }
    });
    return this.writing;
  }

  async clear(): Promise<void> {
    await this.writing;
    this.events = [];
    this.problem = undefined;
    this.dirty = true;
    await this.flush();
  }

  diagnostics(): string {
    // Filenames are deliberately omitted; never export raw errors, URLs or credentials.
    return JSON.stringify(
      this.events.map(({ at, action }) => ({ at, action })),
      null,
      2,
    );
  }
}

export class ActivityModal extends Modal {
  constructor(
    app: App,
    private readonly log: ActivityLog,
    private readonly openPath: (path: string) => void,
  ) {
    super(app);
  }
  override onOpen(): void {
    this.setTitle("Sync activity");
    this.modalEl.addClass("mod-basalt-activity");
    if (this.log.problem) this.contentEl.createEl("p", { text: this.log.problem });
    let query = "";
    let filter = "all";
    const controls = new Setting(this.contentEl).setName("Recent activity");
    controls.settingEl.addClass("basalt-activity-filter");
    controls.addSearch((input) => {
      input.inputEl.setAttribute("aria-label", "Find activity by filename");
      input.setPlaceholder("Find a file…").onChange((value) => {
        query = value.toLocaleLowerCase();
        draw();
      });
    });
    controls.addDropdown((dropdown) => {
      dropdown.selectEl.setAttribute("aria-label", "Activity type");
      dropdown
        .addOptions({ all: "All", error: "Errors", conflict: "Conflicts" })
        .onChange((value) => {
          filter = value;
          draw();
        });
    });
    const list = this.contentEl.createDiv("basalt-activity-list");
    const draw = () => {
      list.empty();
      const events = this.log.events
        .filter(
          (event) =>
            (filter === "all" || event.action === filter) &&
            `${event.path ?? ""} ${event.copy ?? ""}`.toLocaleLowerCase().includes(query),
        )
        .slice()
        .reverse();
      if (!events.length) list.createEl("p", { text: "No matching activity." });
      for (const event of events) {
        const row = new Setting(list)
          .setName(event.path ?? "Sync")
          .setDesc(`${when(event.at)} · ${ACTIONS[event.action]}`);
        if (event.path)
          row.addExtraButton((button) =>
            button
              .setIcon("file-text")
              .setTooltip("Open file")
              .onClick(() => {
                this.close();
                this.openPath(event.path!);
              }),
          );
      }
    };
    draw();
    new Setting(this.contentEl)
      .setName("Troubleshooting")
      .setDesc("The last 300 events stay on this device. Copied diagnostics omit filenames.")
      .addButton((button) =>
        button.setButtonText("Copy diagnostics").onClick(async () => {
          try {
            await navigator.clipboard.writeText(this.log.diagnostics());
            new Notice("Copied diagnostics without filenames.");
          } catch {
            new Notice("The clipboard is unavailable on this device.");
          }
        }),
      )
      .addButton((button) =>
        button.setButtonText("Clear log").onClick(async () => {
          await this.log.clear();
          this.contentEl.empty();
          this.onOpen();
        }),
      );
  }
  override onClose(): void {
    this.contentEl.empty();
  }
}
