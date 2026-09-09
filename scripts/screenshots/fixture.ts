// Desktop-only sample provider for scripts/screenshots.mjs; never shipped.
import { Plugin, PluginSettingTab } from "obsidian";
import { BasaltPanel, BasaltModal, RecoverModal, paintStatus } from "../../client/src/plugin/main";
import { HistoryModal } from "../../client/src/plugin/history";
import { formatInvite } from "../../client/src/core/pairing";

const electron = require("electron");
const fs = require("fs");
const now = new Date();
now.setHours(10, 30, 0, 0);
const at = +now;
const invite = formatInvite({
  url: "wss://sync.example.com",
  vaultId: "default",
  id: new Uint8Array(16).fill(17),
  key: new Uint8Array(32).fill(34),
});
const texts = [
  "# Weekend plans\n\n## Saturday\n- Coffee at the market\n- Walk along the coast\n\n## Sunday\n- Lunch with friends\n- Read a few chapters\n",
  "# Weekend plans\n\n## Saturday\n- Coffee at the market\n- Visit the museum\n\n## Sunday\n- Lunch with friends\n",
  "# Weekend plans\n\n## Saturday\n- Coffee at the market\n\n## Sunday\n- Lunch with friends\n",
];
const versions = texts.map((text, i) => ({
  uid: 30 - i,
  path: "Weekend plans.md",
  size: new TextEncoder().encode(text).length,
  ctime: at - 86400000,
  mtime: at - i * 3600000,
  folder: false,
  deleted: false,
  device: i === 1 ? "Phone" : "MacBook",
  chunks: 1,
  contentId: "sample-" + i,
}));
const settle = () => new Promise((resolve) => setTimeout(resolve, 250));

class PreviewTab extends PluginSettingTab {
  display() {
    this.panel?.teardown();
    this.panel = new BasaltPanel(this.plugin.model, this.containerEl, () => {});
    this.panel.render();
  }
  hide() {
    this.panel?.teardown();
  }
}

export default class Screenshots extends Plugin {
  onload() {
    this.window = this.findWindow(this.app.workspace.containerEl.ownerDocument);
    this.originalBounds = this.window.getBounds();
    this.clipboardBefore = electron.clipboard.readText();
    this.hiddenNotices = new Map();
    this.themes = new Map();
    // A neutral preview backdrop keeps the test vault's sidebar and notes out
    // of the modal's transparent corners. It never covers the plugin itself.
    this.backdrop = this.app.workspace.containerEl.ownerDocument.body.createDiv();
    Object.assign(this.backdrop.style, {
      position: "fixed",
      inset: "0",
      background: "var(--background-primary)",
      zIndex: "49",
      pointerEvents: "none",
    });
    this.status = this.addStatusBarItem();
    this.status.addClass("plugin-basalt-sync");
    this.model = this.makeModel();
    this.tab = new PreviewTab(this.app, this);
    this.addSettingTab(this.tab);
  }

  findWindow(doc) {
    const window = electron.remote.BrowserWindow.getAllWindows().find(
      (w) => w.getTitle() === doc.title,
    );
    if (!window) throw new Error("No window for " + doc.title);
    return window;
  }

  applyTheme(doc, theme) {
    if (!this.themes.has(doc)) this.themes.set(doc, doc.body.classList.contains("theme-dark"));
    // Use Obsidian's native theme classes without saving an appearance setting.
    // Rapid persisted changes can race config-file reloads during a capture run.
    doc.body.classList.toggle("theme-dark", theme === "dark");
    doc.body.classList.toggle("theme-light", theme === "light");
  }

  makeModel(paired = true) {
    const unavailable = () => {
      throw new Error("Screenshot sample only");
    };
    return {
      app: this.app,
      paired,
      deviceName: "MacBook",
      currentState: paired
        ? { kind: "synced", summary: "up to date", at, refused: 0, waiting: 0 }
        : { kind: "unpaired" },
      pendingFirstPairing: () => undefined,
      cursors: () => ({ local: 124, server: 124 }),
      connection: () => ({
        url: "wss://sync.example.com",
        server: { proto: 5, version: __SCREENSHOT_VERSION__ },
      }),
      watchState: (listener) => {
        listener();
        return () => {};
      },
      syncNow: unavailable,
      devices: async () => ({
        devices: [
          { id: "sample-macbook", name: "MacBook", createdAt: at - 86400000, lastSeen: at },
          { id: "sample-phone", name: "Phone", createdAt: at - 7200000, lastSeen: at - 300000 },
        ],
        maxDevices: 0,
        invites: [],
        thisDevice: "sample-macbook",
      }),
      createInvite: async () => ({ invite, expiresAt: at + 600000 }),
      deletedNotes: async () => ({
        notes: [
          {
            ...versions[0],
            uid: 40,
            path: "Packing list.md",
            mtime: at - 1800000,
            deleted: true,
            restorable: 39,
          },
          {
            ...versions[1],
            uid: 38,
            path: "Book ideas.md",
            mtime: at - 3600000,
            deleted: true,
            restorable: 37,
          },
        ],
        more: false,
      }),
      changeServerAddress: unavailable,
      renameDevice: unavailable,
      rotate: unavailable,
      repair: unavailable,
      unlink: unavailable,
      recover: unavailable,
      pair: unavailable,
      pairFirst: unavailable,
    };
  }

  async scene(name, theme) {
    this.modal?.close();
    this.modal = undefined;
    if (name !== "settings" || this.lastScene !== "settings") this.app.setting.close();
    this.lastScene = name;
    await settle();
    this.applyTheme(this.app.workspace.containerEl.ownerDocument, theme);
    this.model = this.makeModel(!["pairing", "join", "setup"].includes(name));
    paintStatus(this.status, this.makeModel().currentState);
    this.backdrop.style.display = name === "status" ? "none" : "";
    this.window.setContentSize(1080, name === "changes" ? 700 : 1100);
    this.window.show();
    this.window.focus();
    if (name === "status") {
      this.target = this.status;
      return;
    }
    if (name === "settings") {
      this.app.setting.open();
      this.app.setting.openTabById(this.manifest.id);
      await settle();
      this.target = this.tab.containerEl;
      return;
    }
    if (name === "changes") {
      this.modal = new HistoryModal(
        this.app,
        {
          history: async () => versions,
          contentAt: async (v) => texts[30 - v.uid],
          currentText: async () => texts[0],
          restoreVersion: async () => {
            throw new Error("Screenshot sample only");
          },
        },
        "Weekend plans.md",
      );
    } else if (name === "deleted" || name === "deleted-empty") {
      if (name === "deleted-empty")
        this.model.deletedNotes = async () => ({ notes: [], more: false });
      this.modal = new RecoverModal(this.model);
    } else this.modal = new BasaltModal(this.model);
    this.modal.open();
    this.target = this.modal.modalEl;
    await settle();
    const content = this.modal.contentEl;
    const press = (label) => {
      const button = [...content.querySelectorAll("button")].find((b) => b.textContent === label);
      if (!button) throw new Error("Missing " + label);
      button.click();
      return button;
    };
    if (name === "join") press("Paste an invite");
    if (name === "setup") press("Use a setup line");
    if (name === "join" || name === "setup") {
      const field = content.querySelector("input");
      field.value = name === "join" ? "Phone" : "MacBook";
      field.dispatchEvent(new field.ownerDocument.defaultView.Event("input", { bubbles: true }));
    }
    if (name === "invite") {
      content.querySelector(".basalt-add-device").open = true;
      press("Create invite");
      await settle();
      this.target = content.querySelector(".basalt-add-device");
      this.target.scrollIntoView({ block: "center" });
    }
    if (name === "server") {
      content.querySelector(".basalt-server").open = true;
      this.target = content.querySelector(".basalt-server");
      this.target.scrollIntoView({ block: "center" });
    }
    if (name === "devices") {
      content.querySelector(".basalt-manage").open = true;
      const button = press("Show devices");
      await settle();
      this.target = button.closest(".setting-item").nextElementSibling;
      this.target.scrollIntoView({ block: "center" });
    }
    if (name === "changes") {
      content.querySelectorAll(".modal-sidebar-list-item")[1].click();
      await settle();
      press("Show changes");
    }
  }

  capture(name, theme, path) {
    this.pending = this.captureScene(name, theme, path);
    return this.pending;
  }

  async captureScene(name, theme, path) {
    try {
      await this.scene(name, theme);
      await settle();
      if (electron.clipboard.readText() === invite)
        electron.clipboard.writeText(this.clipboardBefore);
      const doc = this.target.ownerDocument;
      this.applyTheme(doc, theme);
      await settle();
      if (!doc.body.classList.contains(`theme-${theme}`)) throw new Error("Theme did not change");
      for (const notice of doc.querySelectorAll(".notice-container")) {
        if (!this.hiddenNotices.has(notice))
          this.hiddenNotices.set(notice, notice.style.visibility);
        notice.style.visibility = "hidden";
      }
      const rect = this.target.getBoundingClientRect();
      if (name === "settings") {
        const first = this.target.firstElementChild.getBoundingClientRect();
        const last = this.target.lastElementChild.getBoundingClientRect();
        rect.y = first.y;
        rect.height = last.bottom - first.y;
      }
      if (name === "devices") {
        const heading = this.target.previousElementSibling.getBoundingClientRect();
        rect.height += rect.y - heading.y;
        rect.y = heading.y;
      }
      if (!rect.width || !rect.height) throw new Error("Screenshot target is not visible");
      const window = this.findWindow(doc),
        bounds = window.getContentBounds();
      const padding = name === "status" ? 0 : 16;
      const crop = {
        x: Math.max(0, Math.floor(rect.x - padding)),
        y: Math.max(0, Math.floor(rect.y - padding)),
        width: Math.ceil(rect.width + padding * 2),
        height: Math.ceil(rect.height + padding * 2),
      };
      crop.width = Math.min(crop.width, bounds.width - crop.x);
      crop.height = Math.min(crop.height, bounds.height - crop.y);
      const picture = await window.webContents.capturePage(crop);
      fs.writeFileSync(path, picture.toPNG());
    } catch (err) {
      fs.writeFileSync(path + ".error", String(err.stack ?? err));
    }
  }

  onunload() {
    this.modal?.close();
    this.app.setting.close();
    for (const [doc, dark] of this.themes) {
      doc.body.classList.toggle("theme-dark", dark);
      doc.body.classList.toggle("theme-light", !dark);
    }
    this.app.updateTheme();
    this.window.setBounds(this.originalBounds);
    this.backdrop.remove();
    for (const [el, visibility] of this.hiddenNotices) el.style.visibility = visibility;
    if (electron.clipboard.readText() === invite)
      electron.clipboard.writeText(this.clipboardBefore);
  }
}
