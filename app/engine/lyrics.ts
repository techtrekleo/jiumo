// 九墨歌詞系統：LRC/SRT 解析 + 卷軸直書狀態機（方案 B：右起、唱過往左淡去）

export type LyricLine = { t: number; text: string; end?: number };

export function parseLRC(txt: string): LyricLine[] {
  const lines: LyricLine[] = [];
  txt.split(/\r?\n/).forEach((l) => {
    const ms = [...l.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!ms.length) return;
    const text = l.replace(/\[[^\]]*\]/g, "").trim();
    if (!text) return;
    ms.forEach((m) => lines.push({ t: parseInt(m[1]) * 60 + parseFloat(m[2]), text }));
  });
  return lines.sort((a, b) => a.t - b.t);
}

export function parseSRT(txt: string): LyricLine[] {
  const lines: LyricLine[] = [];
  txt.split(/\r?\n\r?\n/).forEach((b) => {
    const m = b.match(/(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/);
    if (!m) return;
    const t = +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
    const end = +m[5] * 3600 + +m[6] * 60 + +m[7] + +m[8] / 1000; // 保留 SRT 結束時間（可在編輯器調整）
    const ls = b.split(/\r?\n/).filter((l) => l.trim() && !/^\d+$/.test(l.trim()) && !l.includes("-->"));
    if (ls.length) lines.push({ t, text: ls.join(" ").trim(), end });
  });
  return lines.sort((a, b) => a.t - b.t);
}

export function parseLyricsFile(name: string, content: string): LyricLine[] {
  return name.toLowerCase().endsWith(".lrc") ? parseLRC(content) : parseSRT(content);
}

// 匯出（#5 歌詞秒數編輯器存檔用）
const pad2 = (n: number) => String(n).padStart(2, "0");
function fmtLrcTime(t: number) {
  const m = Math.floor(t / 60);
  const s = (t % 60).toFixed(2).padStart(5, "0");
  return `[${pad2(m)}:${s}]`;
}
function fmtSrtTime(t: number) {
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
  const ms = Math.round((t - Math.floor(t)) * 1000);
  return `${pad2(h)}:${pad2(m)}:${pad2(s)},${String(ms).padStart(3, "0")}`;
}
export function serializeLRC(lines: LyricLine[]): string {
  return [...lines].sort((a, b) => a.t - b.t).map((l) => `${fmtLrcTime(l.t)}${l.text}`).join("\n");
}
export function serializeSRT(lines: LyricLine[]): string {
  const s = [...lines].sort((a, b) => a.t - b.t);
  return s.map((l, i) => {
    const end = l.end ?? (i + 1 < s.length ? s[i + 1].t : l.t + 3); // 有設定結束時間就用它，否則 fallback 下一句 start
    return `${i + 1}\n${fmtSrtTime(l.t)} --> ${fmtSrtTime(end)}\n${l.text}`;
  }).join("\n\n");
}

// 站上自帶 woff2，全平台一致。歌名/文字/歌詞共用這份清單，皆 SIL OFL（可商用可嵌入、最乾淨）。
// 劍豪體(Aa字庫)聲明禁止嵌入軟體 → 不放進使用者選單，只烤進「九墨」落款圖（見 seal-jiumo.png）。
export const LYRIC_FONTS = [
  { id: "modab", label: "莫大毛筆", fonts: ["Bakudai-Medium", "Bakudai-Light", "Bakudai-Light"] }, // 濃墨毛筆。SIL OFL 1.1（可商用可嵌入）
  { id: "jason", label: "清松手寫", fonts: ["JasonHW", "JasonHW", "JasonHW"] }, //          游清松手寫。SIL OFL（可商用可嵌入）
  { id: "gensen", label: "源泉圓體", fonts: ["GenSenRounded", "GenSenRounded", "GenSenRounded"] }, // 圓潤現代。SIL OFL 1.1（可商用可嵌入）
  { id: "song", label: "思源宋體", fonts: ["NotoSerifTC-Medium", "NotoSerifTC-Medium", "NotoSerifTC-Medium"] }, // 典雅宋。SIL OFL（可商用可嵌入）
  { id: "kai", label: "霞鶩文楷", fonts: ["LXGWWenKaiTC-Medium", "LXGWWenKaiTC-Medium", "LXGWWenKaiTC-Medium"] }, // 端正楷。SIL OFL（可商用可嵌入）
  // 英文厚體（Google Fonts，皆 SIL OFL 可商用可嵌入）。中文字會 fallback 思源宋體。
  { id: "anton", label: "Anton 厚壓縮", fonts: ["Anton", "Anton", "Anton"] }, //          超粗壓縮，標題霸氣
  { id: "archivo", label: "Archivo 黑體", fonts: ["ArchivoBlack", "ArchivoBlack", "ArchivoBlack"] }, // 厚實黑體
  { id: "bebas", label: "Bebas 高瘦", fonts: ["BebasNeue", "BebasNeue", "BebasNeue"] }, //   高瘦大寫，現代
] as const;

export type LyricFontId = (typeof LYRIC_FONTS)[number]["id"];

const ease = (t: number) => 1 - Math.pow(1 - t, 3);

// 卷軸狀態：保留最近三句、換句時做位移/淡入動畫
export class LyricScroller {
  lines: LyricLine[] = [];
  private display: string[] = [];
  private idx = -1;
  private animStart = 0;

  setLines(lines: LyricLine[]) {
    this.lines = lines;
    this.reset();
  }
  reset() {
    this.display = [];
    this.idx = -1;
  }
  // now 由外部傳入（即時 = performance.now()、離線渲染 = 虛擬影格時間）
  push(text: string, now: number) {
    this.display.unshift(text);
    if (this.display.length > 3) this.display.pop();
    this.animStart = now;
  }

  // 回傳 true = 這幀剛換句（外部可滴一滴墨呼應）
  // 依 audioTime 重新定位當前句；支援往回 seek／跳句（不再只往前找下一句、不再殘留舊字幕）
  sync(audioTime: number, now: number): boolean {
    let i = -1;
    for (let k = 0; k < this.lines.length; k++) {
      if (this.lines[k].t <= audioTime) i = k; else break;
    }
    if (i === this.idx) return false; // 沒換句
    if (i < 0) { // seek 到第一句之前 → 清空
      this.display = [];
      this.idx = -1;
      this.animStart = now;
      return true;
    }
    if (i === this.idx + 1) { // 正常往前一句：維持卷軸位移動畫
      this.idx = i;
      this.push(this.lines[i].text, now);
      return true;
    }
    // 往回 seek 或一次跳超過一句 → 用最近三句重建 display（display[0]=最新 i、往後越舊）
    this.idx = i;
    this.display = [];
    for (let s = Math.max(0, i - 2); s <= i; s++) this.display.unshift(this.lines[s].text);
    this.animStart = now;
    return true;
  }

  // 直書卷軸繪製（深字給宣紙、亮字給夜紙）
  draw(ctx: CanvasRenderingContext2D, W: number, H: number, now: number, fonts: readonly string[], dark: boolean) {
    if (!this.display.length) return;
    const isPortrait = H > W;
    const slotX = isPortrait ? [0.8, 0.62, 0.47] : [0.875, 0.79, 0.72];
    const slotSize = isPortrait ? [W * 0.075, W * 0.05, W * 0.042] : [H * 0.052, H * 0.034, H * 0.029];
    const slotAlpha = [0.92, 0.42, 0.18];
    const color = dark ? "#26201b" : "#ece7dc";
    const t = Math.min((now - this.animStart) / 380, 1);
    const k = ease(t);
    for (let s = this.display.length - 1; s >= 0; s--) {
      const text = this.display[s];
      let size = slotSize[s];
      const maxH = H * 0.74;
      if (text.length * size * 1.16 > maxH) size = maxH / (text.length * 1.16);
      let x = slotX[s] * W;
      let alpha = slotAlpha[s];
      if (s === 0) {
        x = (slotX[0] + 0.035 * (1 - k)) * W;
        alpha = slotAlpha[0] * k;
      } else {
        const fx = slotX[s - 1] * W;
        const fa = slotAlpha[s - 1];
        x = fx + (slotX[s] * W - fx) * k;
        alpha = fa + (slotAlpha[s] - fa) * k;
      }
      const yTop = H * 0.5 - (text.length * size * 1.16) / 2;
      ctx.save();
      ctx.font = `${size}px '${fonts[s]}', 'NotoSerifTC-Medium', 'LXGWWenKaiTC-Medium', serif`; // 缺字退思源宋體（近全 CJK）
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillStyle = color;
      ctx.globalAlpha = alpha;
      const step = size * 1.16;
      for (let i = 0; i < text.length; i++) ctx.fillText(text[i], x, yTop + i * step);
      ctx.restore();
    }
  }
}
