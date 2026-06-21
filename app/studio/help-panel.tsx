"use client";

import { X } from "lucide-react";

// 九墨 Studio 內建使用說明：簡單上手步驟。第一次進來自動跳一次（studio 用 localStorage 控制）。
const STEPS: { n: string; title: string; body: string }[] = [
  { n: "1", title: "加歌", body: "左欄「素材」→「＋加歌」放入 mp3／wav。畫面會跟著音樂呼吸；放多首就照順序連播成一支長影片。" },
  { n: "2", title: "背景", body: "點「背景」層 → 上傳背景圖，或選「背景色」。背景圖可調不透明度、加濾鏡（模糊／色差／VHS 等，每個帶強度）。" },
  { n: "3", title: "音訊圖", body: "點「音訊圖」層 → 右欄選效果（霓虹頻譜／聲紋球／墨流／墨暈…）。下方調墨色，或勾「🎨 自動變色」讓墨色循環跑色。" },
  { n: "4", title: "歌詞", body: "「歌詞」層綁 LRC／SRT，字幕會跟著歌跑（直書卷軸）。也可多加一層綁自己的字幕、自由定位。" },
  { n: "5", title: "片頭・Logo・落款・CTA", body: "左欄「＋新增」可加：影片（片頭＝全螢幕、播完露出主視覺）、圖片（Logo，可上傳）、落款（九墨印章或自訂直書章）、CTA動畫（拇指→訂閱→鈴鐺，游標依序點擊變紅，沒做片頭的直接放這個）。" },
  { n: "6", title: "自動化（進階）", body: "左欄「自動化」：選一層 →「加格」讓參數隨時間動畫（淡入、滑進）；或「跟音樂」讓大小／亮度隨節拍、音量即時脈動。" },
  { n: "7", title: "輸出", body: "「輸出」→「渲染 MP4」：把所有圖層烤成影片檔（QuickTime 直接開）。3 分鐘的歌約兩三分鐘渲染完。" },
];

export function HelpPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={onClose}>
      <div className="bg-[#161310] border border-white/12 rounded-2xl max-w-lg w-full max-h-[85vh] overflow-y-auto shadow-2xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-white/10 sticky top-0 bg-[#161310]">
          <h2 className="text-[15px] text-white/90 tracking-wide">九墨 Studio 怎麼用</h2>
          <button type="button" onClick={onClose} className="text-white/45 hover:text-white"><X size={18} /></button>
        </div>
        <div className="px-5 py-4 space-y-3">
          <p className="text-[12px] text-white/45 leading-relaxed">把一首歌變成一幅會呼吸的水墨影片。照下面幾步就能出片：</p>
          {STEPS.map((s) => (
            <div key={s.n} className="flex gap-3">
              <span className="shrink-0 w-6 h-6 rounded-full bg-red-500/15 text-red-300 text-[12px] flex items-center justify-center mt-0.5">{s.n}</span>
              <div>
                <p className="text-[13px] text-white/85">{s.title}</p>
                <p className="text-[11.5px] text-white/45 leading-relaxed mt-0.5">{s.body}</p>
              </div>
            </div>
          ))}
          <div className="rounded-lg bg-white/[0.04] px-3 py-2.5 mt-1">
            <p className="text-[11px] text-white/50 leading-relaxed">
              <span className="text-white/70">小撇步</span>：用「試滴一墨」可不放歌先看墨色；右上 16:9／9:16 切橫直式；做不出墨點時把「靈敏度／密度」調高，或換成 EDM 那種飽滿的歌。
            </p>
          </div>
        </div>
        <div className="px-5 py-3.5 border-t border-white/10 sticky bottom-0 bg-[#161310]">
          <button type="button" onClick={onClose}
            className="w-full text-[13px] text-white/85 border border-white/20 hover:border-white/45 hover:text-white rounded-lg py-2.5 transition">
            知道了，開始做
          </button>
        </div>
      </div>
    </div>
  );
}
