// The archive folder, reached through the handle you picked (File System
// Access API). Implements the disk adapter the shared queue core expects
// ({ sizeOf, move, zipEntries }) plus writing downloads. Paths are arrays of
// folder/file names under the archive root.

import { readZipEntries } from '../core/zip.js';

// A reader over a File for the core's zip/STL checks.
export const fileReader = (file) => ({
  size: file.size,
  read: async (position, length) => new Uint8Array(await file.slice(position, position + length).arrayBuffer()),
});

export function folderDisk(root) {
  async function dirOf(parts, create) {
    let dir = root;
    for (const name of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(name, { create });
    return dir;
  }
  async function fileHandle(parts, create = false) {
    try {
      return await (await dirOf(parts, create)).getFileHandle(parts.at(-1), { create });
    } catch (e) {
      if (!create && (e.name === 'NotFoundError' || e.name === 'TypeMismatchError')) return null;
      throw e;
    }
  }
  const disk = {
    root,
    fileHandle,
    dirOf,
    async sizeOf(parts) {
      const h = await fileHandle(parts);
      return h ? (await h.getFile()).size : null;
    },
    async file(parts) {
      const h = await fileHandle(parts);
      return h ? h.getFile() : null;
    },
    async move(from, to) {
      const h = await fileHandle(from);
      if (!h) throw new Error(`Not found: ${from.join('/')}`);
      if (await fileHandle(to)) throw new Error(`Already exists: ${to.join('/')}`);
      await h.move(await dirOf(to, true), to.at(-1));
    },
    async zipEntries(parts) {
      const f = await disk.file(parts);
      return f ? readZipEntries(fileReader(f)) : null;
    },
    // A writable stream for a new file (replaces any existing one).
    async writer(parts) {
      const w = await (await fileHandle(parts, true)).createWritable({ keepExistingData: false });
      return { write: (bytes) => w.write(bytes), close: () => w.close(), abort: () => w.abort() };
    },
    async reader(parts) {
      const f = await disk.file(parts);
      if (!f) throw new Error(`Not found: ${parts.join('/')}`);
      return fileReader(f);
    },
    async remove(parts) {
      const dir = await dirOf(parts, false).catch(() => null);
      if (dir) await dir.removeEntry(parts.at(-1)).catch(() => {});
    },
  };
  return disk;
}

// Is the stored folder usable right now? 'granted' | 'prompt' | 'denied'.
export const folderPermission = (handle) => handle.queryPermission({ mode: 'readwrite' });
