// 九墨專案存檔（vizzy Projects 模組）— IndexedDB 本地存檔，免帳號、零後端。
// 只存「專案設定」：圖層樹 + 參數 + 歌單 metadata + studio 設定。
// ⚠️ 不存大檔（音檔 File、影片 objectURL）— 載入後由用戶重新加歌/上傳影片，避免爆容量。

import type { Composition } from "./composition";
import type { LyricLine, LyricFontId } from "./lyrics";
import type { Palette, PaperMode } from "./palette";
import type { ParamValues } from "./effects";

export type ProjectData = {
  orientation: "landscape" | "portrait" | "wide" | "square";
  composition: Composition; // 影片層 src 已清空、圖片 dataUrl（logo 等小圖）保留
  tracks: { title: string; lrc: LyricLine[] | null; lrcName: string }[]; // 不含 File
  studio: {
    effectId: string;
    params: ParamValues;
    palette: Palette;
    paperMode: PaperMode;
    fontId: LyricFontId;
    sealOn: boolean;
    title: string;
    visualFxId: string | null;
    gpuFxId?: string | null; // GPU 光效（shader）選中 id；舊存檔沒有 → optional
  };
};

export type SavedProject = { id: string; name: string; savedAt: number; data: ProjectData };
export type SavedProjectMeta = { id: string; name: string; savedAt: number };

const DB_NAME = "jiumo";
const STORE = "projects";
const VERSION = 1;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        t.oncomplete = () => db.close();
      }),
  );
}

export function genProjectId(): string {
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export async function saveProject(p: SavedProject): Promise<void> {
  await tx("readwrite", (s) => s.put(p));
}

export async function loadProject(id: string): Promise<SavedProject | null> {
  return (await tx<SavedProject | undefined>("readonly", (s) => s.get(id))) ?? null;
}

export async function deleteProject(id: string): Promise<void> {
  await tx("readwrite", (s) => s.delete(id));
}

export async function listProjects(): Promise<SavedProjectMeta[]> {
  const all = await tx<SavedProject[]>("readonly", (s) => s.getAll());
  return all
    .map((p) => ({ id: p.id, name: p.name, savedAt: p.savedAt }))
    .sort((a, b) => b.savedAt - a.savedAt);
}
