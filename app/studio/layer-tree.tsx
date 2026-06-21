"use client";

import { useState, type ComponentType } from "react";
import {
  GripVertical, Eye, EyeOff, Trash2, Plus, Lock,
  Image as ImageIcon, Type, Video, Waves, Fish, Square, AlignLeft, Stamp, MousePointerClick, Disc3, Zap,
} from "lucide-react";
import {
  type Composition, type Layer, type LayerType,
  LAYER_TYPE_META, LAYER_TYPE_ORDER, displayOrder, canAddLayer,
} from "../engine/composition";

/* 九墨 Phase 2-2 — 左欄圖層樹。
   清單由上到下 = 前景到背景（與陣列 z 序相反）。背景＝底圖，釘在最底、不可拖曳。
   操作全走 ../engine/composition 的純函式，本元件只負責呈現與事件。 */

const TYPE_ICON: Record<LayerType, ComponentType<{ size?: number; className?: string }>> = {
  background: Square,
  effect: Waves,
  body: Fish,
  lyrics: AlignLeft,
  text: Type,
  image: ImageIcon,
  seal: Stamp,
  cta: MousePointerClick,
  player: Disc3,
  alpha: Zap,
  video: Video,
};

type Props = {
  composition: Composition;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAdd: (type: LayerType) => void;
  onRemove: (id: string) => void;
  onToggleVisible: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onReorder: (id: string, toDisplayIndex: number) => void;
};

export function LayerTree({
  composition, selectedId, onSelect, onAdd, onRemove, onToggleVisible, onRename, onReorder,
}: Props) {
  const [addOpen, setAddOpen] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const ordered = displayOrder(composition); // 上＝最前層、下＝底圖
  const addable = LAYER_TYPE_ORDER.filter((t) => canAddLayer(composition, t));
  const indexOfId = (id: string) => ordered.findIndex((l) => l.id === id);

  const handleDrop = (targetId: string) => {
    if (dragId && dragId !== targetId) onReorder(dragId, indexOfId(targetId));
    setDragId(null);
    setOverId(null);
  };

  const renderRow = (layer: Layer, draggable: boolean) => {
    const Icon = TYPE_ICON[layer.type];
    const selected = layer.id === selectedId;
    const over = overId === layer.id && dragId !== null && dragId !== layer.id;
    return (
      <div
        key={layer.id}
        draggable={draggable}
        onDragStart={() => draggable && setDragId(layer.id)}
        onDragEnd={() => { setDragId(null); setOverId(null); }}
        onDragOver={(e) => { if (draggable && dragId) { e.preventDefault(); setOverId(layer.id); } }}
        onDrop={() => { if (draggable) handleDrop(layer.id); }}
        onClick={() => onSelect(layer.id)}
        className={`group flex items-center gap-1.5 rounded-lg border px-2 py-1.5 cursor-pointer transition
          ${selected ? "border-white/40 bg-white/[0.06]" : "border-white/10 hover:border-white/25"}
          ${over ? "border-amber-200/70" : ""}
          ${!layer.visible ? "opacity-45" : ""}`}
      >
        {draggable ? (
          <GripVertical size={13} className="text-white/25 group-hover:text-white/50 shrink-0 cursor-grab" />
        ) : (
          <Lock size={11} className="text-white/25 shrink-0" />
        )}
        <Icon size={13} className="text-white/45 shrink-0" />
        <input
          type="text" value={layer.name}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onRename(layer.id, e.target.value)}
          className="flex-1 min-w-0 bg-transparent text-[12px] text-white/80 outline-none border-b border-transparent focus:border-white/20"
        />
        <button
          type="button" title={layer.visible ? "隱藏" : "顯示"}
          onClick={(e) => { e.stopPropagation(); onToggleVisible(layer.id); }}
          className="text-white/30 hover:text-white shrink-0"
        >
          {layer.visible ? <Eye size={13} /> : <EyeOff size={13} />}
        </button>
        {draggable && (
          <button
            type="button" title="刪除"
            onClick={(e) => { e.stopPropagation(); onRemove(layer.id); }}
            className="text-white/25 hover:text-red-300 shrink-0"
          >
            <Trash2 size={12} />
          </button>
        )}
      </div>
    );
  };

  const draggables = ordered.filter((l) => l.type !== "background");
  const background = ordered.find((l) => l.type === "background");

  return (
    <div className="bg-white/[0.03] rounded-xl p-3 space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-[11px] text-white/40 tracking-wider">圖層（上＝前景／下＝底圖）</p>
        <div className="relative">
          <button
            type="button" onClick={() => setAddOpen((o) => !o)}
            className="flex items-center gap-1 text-[11px] text-white/55 hover:text-white border border-white/15 hover:border-white/40 rounded-full px-2 py-0.5 transition"
          >
            <Plus size={12} /> 新增
          </button>
          {addOpen && (
            <div className="absolute right-0 mt-1 z-10 bg-[#15110f] border border-white/15 rounded-lg p-1 min-w-[120px] shadow-xl">
              {addable.length === 0 ? (
                <p className="text-[11px] text-white/30 px-2 py-1.5">沒有可新增的型別</p>
              ) : (
                addable.map((t) => {
                  const Icon = TYPE_ICON[t];
                  return (
                    <button
                      key={t} type="button"
                      onClick={() => { onAdd(t); setAddOpen(false); }}
                      className="w-full flex items-center gap-2 text-[12px] text-white/70 hover:text-white hover:bg-white/[0.06] rounded px-2 py-1 transition text-left"
                    >
                      <Icon size={13} className="text-white/45" /> {LAYER_TYPE_META[t].label}
                      {!LAYER_TYPE_META[t].multiple && <span className="text-[9px] text-white/25 ml-auto">單例</span>}
                    </button>
                  );
                })
              )}
            </div>
          )}
        </div>
      </div>
      <div className="space-y-1">
        {draggables.map((l) => renderRow(l, true))}
        {background && renderRow(background, false)}
      </div>
    </div>
  );
}
