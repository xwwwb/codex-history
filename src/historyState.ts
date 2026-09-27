import { reactive } from "vue";
import { scanCodexDirectory } from "./services/codex";
import type { SessionSummary } from "./types";

export const historyState = reactive({
  rootHandle: undefined as FileSystemDirectoryHandle | undefined,
  rootName: "",
  sessions: [] as SessionSummary[],
  scanning: false,
  scanned: false,
  sqliteFile: undefined as string | undefined,
  warnings: [] as string[],
});

export const directoryPickerSupported = "showDirectoryPicker" in window;

export async function scanHistory(handle = historyState.rootHandle) {
  if (!handle) return;
  historyState.scanning = true;
  historyState.scanned = false;
  historyState.warnings = [];
  try {
    const result = await scanCodexDirectory(handle);
    historyState.sessions = result.sessions;
    historyState.sqliteFile = result.sqliteFile;
    historyState.warnings = result.warnings;
    historyState.scanned = true;
    return result;
  } finally {
    historyState.scanning = false;
  }
}

export async function selectHistoryDirectory() {
  if (!directoryPickerSupported) return;
  const handle = await window.showDirectoryPicker({ id: "codex-home", mode: "read" });
  historyState.rootHandle = handle;
  historyState.rootName = handle.name;
  return scanHistory(handle);
}
