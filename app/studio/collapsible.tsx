"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

/* 可摺疊屬性組（vizzy 右欄 General / Positioning & Size / Basics 那種）。 */

export function Collapsible({ title, defaultOpen = true, children }: { title: string; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="bg-white/[0.03] rounded-xl">
      <button type="button" onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-3 py-2.5 cursor-pointer">
        <span className="text-[11px] text-white/45 tracking-wider">{title}</span>
        <ChevronDown size={14} className={`text-white/35 transition-transform ${open ? "" : "-rotate-90"}`} />
      </button>
      {open && <div className="px-3 pb-3 space-y-2.5">{children}</div>}
    </div>
  );
}
