"use client";

import { useCallback, useEffect, useState } from "react";
import { Save, FolderOpen, Trash2 } from "lucide-react";
import { listProjects, deleteProject, type SavedProjectMeta } from "../engine/project-store";

/* 九墨「專案」模組（vizzy Projects）— IndexedDB 本地存檔列表 + 存/載入/刪除。
   只存專案設定（不含音檔/影片大檔），客戶下次打開同瀏覽器還在。 */

const fmt = (t: number) =>
  new Date(t).toLocaleString("zh-TW", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

type Props = {
  onSave: (name: string) => Promise<void>;
  onLoad: (id: string) => void;
};

export function ProjectsPanel({ onSave, onLoad }: Props) {
  const [items, setItems] = useState<SavedProjectMeta[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => { void listProjects().then(setItems).catch(() => {}); }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const save = async () => {
    setBusy(true);
    try {
      await onSave(name.trim() || `專案 ${fmt(Date.now())}`);
      setName("");
      refresh();
    } finally {
      setBusy(false);
    }
  };
  const del = async (id: string) => { await deleteProject(id); refresh(); };

  return (
    <div className="bg-white/[0.03] rounded-xl p-3 space-y-2">
      <p className="text-[11px] text-white/40 tracking-wider">專案（本地存檔）</p>
      <div className="flex gap-1.5">
        <input
          type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="專案名（留空自動命名）"
          className="flex-1 min-w-0 bg-black/40 border border-white/10 rounded-lg px-2 py-1.5 text-[12px] outline-none focus:border-white/30"
        />
        <button type="button" onClick={save} disabled={busy}
          className="flex items-center gap-1 text-[12px] text-amber-100 border border-amber-200/40 rounded-lg px-2.5 hover:border-amber-200/70 transition disabled:opacity-40">
          <Save size={13} /> 存檔
        </button>
      </div>
      <p className="text-[10px] text-white/25 leading-relaxed">只存設定（圖層/參數/歌單名/歌詞）。載入後音檔與影片請重新加歌／上傳。</p>
      <div className="space-y-1 max-h-72 overflow-y-auto pr-0.5">
        {items.length === 0 && <p className="text-[11px] text-white/30 py-2">還沒有存過的專案</p>}
        {items.map((p) => (
          <div key={p.id} className="flex items-center gap-2 rounded-lg border border-white/10 hover:border-white/25 p-2 transition">
            <div className="flex-1 min-w-0">
              <p className="text-[12px] text-white/80 truncate">{p.name}</p>
              <p className="text-[10px] text-white/30">{fmt(p.savedAt)}</p>
            </div>
            <button type="button" onClick={() => onLoad(p.id)} title="載入" className="text-white/45 hover:text-white shrink-0"><FolderOpen size={14} /></button>
            <button type="button" onClick={() => del(p.id)} title="刪除" className="text-white/25 hover:text-red-300 shrink-0"><Trash2 size={13} /></button>
          </div>
        ))}
      </div>
    </div>
  );
}
