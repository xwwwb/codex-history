import { join } from "@tauri-apps/api/path";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { open, readDir, readFile, SeekMode, stat } from "@tauri-apps/plugin-fs";

export interface HistoryFile {
  name: string;
  size: number;
  lastModified: number;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
  readTextRange(start: number, end: number): Promise<string>;
}

export interface HistoryFileHandle {
  kind: "file";
  getFile(): Promise<HistoryFile>;
}

export interface HistoryDirectoryHandle {
  kind: "directory";
  name: string;
  entries(): AsyncIterableIterator<[string, HistoryFileHandle | HistoryDirectoryHandle]>;
  getDirectoryHandle(name: string): Promise<HistoryDirectoryHandle>;
  getFileHandle(name: string): Promise<HistoryFileHandle>;
}

function historyFile(path: string, name: string): HistoryFileHandle {
  return {
    kind: "file",
    async getFile() {
      const info = await stat(path);
      if (!info.isFile) throw new Error(`${name} 不是文件`);
      return {
        name,
        size: info.size,
        lastModified: info.mtime?.getTime() ?? 0,
        async text() {
          return new TextDecoder().decode(await readFile(path));
        },
        async arrayBuffer() {
          return (await readFile(path)).buffer;
        },
        async readTextRange(start, end) {
          const file = await open(path, { read: true });
          try {
            await file.seek(start, SeekMode.Start);
            const buffer = new Uint8Array(Math.max(0, end - start));
            let length = 0;
            while (length < buffer.length) {
              const count = await file.read(buffer.subarray(length));
              if (count === null || count === 0) break;
              length += count;
            }
            return new TextDecoder().decode(buffer.subarray(0, length));
          } finally {
            await file.close();
          }
        },
      };
    },
  };
}

function historyDirectory(path: string, name: string): HistoryDirectoryHandle {
  return {
    kind: "directory",
    name,
    async *entries() {
      for (const entry of await readDir(path)) {
        // 符号链接不在所选目录的递归读取范围内。
        if (entry.isSymlink) continue;
        const entryPath = await join(path, entry.name);
        if (entry.isDirectory) yield [entry.name, historyDirectory(entryPath, entry.name)];
        else if (entry.isFile) yield [entry.name, historyFile(entryPath, entry.name)];
      }
    },
    async getDirectoryHandle(childName) {
      const childPath = await join(path, childName);
      if (!(await stat(childPath)).isDirectory) throw new Error(`${childName} 不是文件夹`);
      return historyDirectory(childPath, childName);
    },
    async getFileHandle(childName) {
      const childPath = await join(path, childName);
      if (!(await stat(childPath)).isFile) throw new Error(`${childName} 不是文件`);
      return historyFile(childPath, childName);
    },
  };
}

export async function pickHistoryDirectory(): Promise<HistoryDirectoryHandle | undefined> {
  const path = await openDialog({ directory: true, multiple: false, recursive: true });
  if (!path) return undefined;
  const name = path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
  return historyDirectory(path, name);
}
