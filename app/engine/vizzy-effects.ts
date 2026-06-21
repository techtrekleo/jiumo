// 九墨「Vizzy 視效」— 乾淨的 vizzy 風視覺原型（頻譜條/環形/波形/粒子），全新實作。
// vizzy 閉源、拿不到原始碼，這裡是 vizzy 風格的重寫；沿用 VisualEffect 介面接既有渲染管線。
// 墨系列（墨流/墨滴/墨暈）由 FluidCore 另外處理，不在此檔。

import type { VisualEffect } from "./visual-effects";

/* ───────── 感知頻譜核心 ─────────
   把原始線性 FFT 轉成「感知頻譜」陣列（長度 n，值 0~1）。
   線性頻譜的醜樣＝「左邊一根大、右邊全貼地的下坡」，因為音樂能量幾乎全擠在低頻、
   高頻天生 -4.5dB/oct 滾降。三步驟修正：
   1) 對數頻率分桶 — 每根 bar 涵蓋等比例音程，低頻不再獨佔、能量攤平到整個寬度
   2) 高頻增益補償 — 隨頻率拉高增益，讓右半邊活起來、整條起伏均勻
   3) 鄰桶平滑 — 去鋸齒，線條更柔順                                                */
function spectrum(freq: Uint8Array, n: number): number[] {
  const N = freq.length;
  const minBin = 1, maxBin = Math.min(N - 1, Math.floor(N * 0.8)); // ~16kHz 以下
  const ratio = maxBin / minBin;
  const raw: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const b0 = minBin * Math.pow(ratio, i / n);
    const b1 = minBin * Math.pow(ratio, (i + 1) / n);
    const lo = Math.floor(b0), hi = Math.floor(b1);
    let v: number;
    if (hi <= lo) {
      const f = b0 - lo; // 低頻：桶比 1 bin 還窄 → 線性內插取樣
      v = (freq[lo] * (1 - f) + (freq[lo + 1] ?? freq[lo]) * f) / 255;
    } else {
      let sum = 0, mx = 0; // 高頻：桶涵蓋多 bin → 峰值 0.6 + 平均 0.4（留細節又不過抖）
      for (let b = lo; b <= hi && b < N; b++) { sum += freq[b]; if (freq[b] > mx) mx = freq[b]; }
      v = (mx * 0.6 + (sum / (hi - lo + 1)) * 0.4) / 255;
    }
    const gain = 0.6 + 1.4 * Math.pow(i / n, 0.8); // 高頻增益補償
    raw[i] = Math.min(1, v * gain);
  }
  const out: number[] = new Array(n); // 鄰桶平滑
  for (let i = 0; i < n; i++) {
    const a = raw[Math.max(0, i - 1)], c = raw[Math.min(n - 1, i + 1)];
    out[i] = a * 0.25 + raw[i] * 0.5 + c * 0.25;
  }
  return out;
}
// 對稱排列：把 n 個位置鏡像對應到 half 解析度的感知頻譜 → 左右/上下對稱、看起來「設計過」
function mirrorSpectrum(freq: Uint8Array, n: number): number[] {
  const half = Math.ceil(n / 2);
  const sp = spectrum(freq, half);
  const out: number[] = new Array(n);
  for (let i = 0; i < n; i++) out[i] = sp[i < half ? i : n - 1 - i] ?? 0;
  return out;
}
// 取整段能量（lo~hi 為 0~1 的頻譜比例位置）— 給 bass/treble 脈動用
function band(sp: number[], lo: number, hi: number): number {
  const a = Math.floor(lo * sp.length), b = Math.min(sp.length - 1, Math.floor(hi * sp.length));
  let s = 0; for (let i = a; i <= b; i++) s += sp[i]; return s / Math.max(1, b - a + 1);
}

/* ───────── 繪圖 helpers ───────── */
function applyAlpha(color: string, a: number): string {
  return `${color.substring(0, 7)}${Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, "0")}`;
}
function hexToHue(hex: string): number {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16) / 255, g = parseInt(h.slice(2, 4), 16) / 255, b = parseInt(h.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let hue = 0;
  if (d) { hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4; hue = (hue * 60 + 360) % 360; }
  return hue;
}
function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  r = Math.min(r, w / 2, h / 2); if (r < 0) r = 0;
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function strokeWave(ctx: CanvasRenderingContext2D, pts: { x: number; y: number }[], color: string, lw: number, glow: number) {
  ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length - 1; i++) {
    const xc = (pts[i].x + pts[i + 1].x) / 2, yc = (pts[i].y + pts[i + 1].y) / 2;
    ctx.quadraticCurveTo(pts[i].x, pts[i].y, xc, yc);
  }
  ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.shadowColor = color; ctx.shadowBlur = glow; ctx.stroke();
}

/* ───────── 條狀 ───────── */

const bars: VisualEffect = {
  id: "vz-bars", name: "頻譜條",
  draw(ctx, W, H, freq, { sensitivity, palette, isBeat }) {
    if (!freq) return; ctx.save();
    const n = 64, bw = W / n, baseY = H * 0.88, maxH = H * 0.7;
    const sp = spectrum(freq, n);
    const h0 = hexToHue(palette.secondary), h1 = hexToHue(palette.accent);
    for (let i = 0; i < n; i++) {
      const v = sp[i], bh = Math.pow(v, 1.45) * maxH * sensitivity;
      if (bh < 2) continue;
      const c = `hsl(${h0 + (i / n) * (h1 - h0)}, 85%, ${52 + v * 20}%)`;
      ctx.fillStyle = c; ctx.shadowColor = c; ctx.shadowBlur = isBeat ? 14 : 7;
      roundedRect(ctx, i * bw + bw * 0.15, baseY - bh, bw * 0.7, bh, 2); ctx.fill();
      // 玻璃地板倒影
      ctx.globalAlpha = 0.18;
      roundedRect(ctx, i * bw + bw * 0.15, baseY, bw * 0.7, Math.min(bh, maxH * 0.3), 2); ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  },
};

const mirrorBars: VisualEffect = {
  id: "vz-mirror-bars", name: "鏡像條",
  draw(ctx, W, H, freq, { sensitivity, palette, isBeat }) {
    if (!freq) return; ctx.save();
    const half = 48, bw = W / (half * 2), cx = W / 2, cy = H / 2, maxH = H * 0.42;
    const sp = spectrum(freq, half); // 中央＝低頻、向兩側＝高頻（對稱）
    const h0 = hexToHue(palette.secondary), h1 = hexToHue(palette.accent);
    for (let i = 0; i < half; i++) {
      const v = sp[i], bh = Math.pow(v, 1.5) * maxH * sensitivity;
      if (bh < 2) continue;
      const c = `hsl(${h0 + (i / half) * (h1 - h0)}, 88%, ${54 + v * 18}%)`;
      ctx.fillStyle = c; ctx.shadowColor = c; ctx.shadowBlur = isBeat ? 12 : 6;
      const ebw = bw * 0.62;
      for (const sx of [cx - (i + 1) * bw, cx + i * bw]) {
        roundedRect(ctx, sx + bw * 0.19, cy - bh, ebw, bh, 2); ctx.fill();
        roundedRect(ctx, sx + bw * 0.19, cy, ebw, bh, 2); ctx.fill();
      }
    }
    ctx.restore();
  },
};

const dots: VisualEffect = {
  id: "vz-dots", name: "點狀頻譜",
  draw(ctx, W, H, freq, { sensitivity, palette }) {
    if (!freq) return; ctx.save();
    const n = 96, bw = W / n, cy = H / 2, maxH = H * 0.34;
    const sp = spectrum(freq, n);
    ctx.fillStyle = palette.primary; ctx.shadowColor = palette.primary; ctx.shadowBlur = 10;
    for (let i = 0; i < n; i++) {
      const v = sp[i], x = i * bw + bw / 2;
      if (v < 0.05) { ctx.globalAlpha = 0.5; ctx.beginPath(); ctx.arc(x, cy, 1.6, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1; continue; }
      const h = Math.pow(v, 1.35) * maxH * sensitivity, steps = Math.max(1, Math.floor(h / 6));
      for (let s = 0; s <= steps; s++) {
        const y = (s / steps) * h;
        ctx.beginPath(); ctx.arc(x, cy - y, 2, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(x, cy + y, 2, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.restore();
  },
};

/* ───────── 環形 ───────── */

const radial: VisualEffect = {
  id: "vz-radial", name: "環形頻譜",
  draw(ctx, W, H, freq, { sensitivity, palette, isBeat }) {
    if (!freq) return; ctx.save();
    const cx = W / 2, cy = H / 2, R = Math.min(W, H) * 0.2, n = 120, maxH = Math.min(W, H) * 0.26;
    const sp = mirrorSpectrum(freq, n); // 左右對稱
    ctx.lineWidth = 3; ctx.lineCap = "round";
    const c = isBeat ? palette.accent : palette.primary;
    ctx.strokeStyle = c; ctx.shadowColor = c; ctx.shadowBlur = 8;
    for (let i = 0; i < n; i++) {
      const len = Math.pow(sp[i], 1.4) * maxH * sensitivity;
      if (len < 2) continue;
      const a = (i / n) * Math.PI * 2 - Math.PI / 2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
      ctx.lineTo(cx + Math.cos(a) * (R + len), cy + Math.sin(a) * (R + len));
      ctx.stroke();
    }
    ctx.restore();
  },
};

const ring: VisualEffect = {
  id: "vz-ring", name: "脈動環",
  draw(ctx, W, H, freq, { frame, sensitivity, palette, isBeat }) {
    if (!freq) return; ctx.save();
    const cx = W / 2, cy = H / 2, n = 128;
    const sp = mirrorSpectrum(freq, n); // 對稱輪廓
    const bass = band(sp, 0, 0.12);
    const R = Math.min(W, H) * 0.22 + bass * 60 * sensitivity;
    ctx.strokeStyle = isBeat ? palette.accent : palette.secondary;
    ctx.shadowColor = ctx.strokeStyle; ctx.shadowBlur = 18; ctx.lineWidth = 3 + bass * 4;
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      const r = R + sp[i % n] * 44 * sensitivity + Math.sin(i * 0.5 + frame * 0.04) * 3;
      const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath(); ctx.stroke();
    ctx.restore();
  },
};

const spectrumBlob: VisualEffect = {
  id: "vz-blob", name: "頻譜輪廓",
  draw(ctx, W, H, freq, { sensitivity, palette }) {
    if (!freq) return; ctx.save();
    const cx = W / 2, cy = H / 2, R = Math.min(W, H) * 0.18, n = 96, maxH = Math.min(W, H) * 0.2;
    const sp = mirrorSpectrum(freq, n); // 對稱
    const grad = ctx.createRadialGradient(cx, cy, R * 0.3, cx, cy, R + maxH);
    grad.addColorStop(0, applyAlpha(palette.accent, 0.5)); grad.addColorStop(1, applyAlpha(palette.primary, 0));
    ctx.fillStyle = grad; ctx.strokeStyle = palette.primary; ctx.shadowColor = palette.primary; ctx.shadowBlur = 14; ctx.lineWidth = 2.5;
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const v = sp[i % n], a = (i / n) * Math.PI * 2;
      const r = R + Math.pow(v, 1.35) * maxH * sensitivity;
      const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();
  },
};

/* ───────── 波形 ───────── */

const wave: VisualEffect = {
  id: "vz-wave", name: "波形線",
  draw(ctx, W, H, freq, { frame, sensitivity, palette }) {
    if (!freq) return; ctx.save();
    const cy = H / 2, amp = H * 0.32, n = 200, sp = spectrum(freq, n);
    const pts = sp.map((v, i) => ({ x: (i / n) * W, y: cy - (Math.pow(v, 0.85) - 0.08) * amp * sensitivity - Math.sin(i * 0.1 + frame * 0.03) * 4 }));
    strokeWave(ctx, pts, palette.primary, 2.5, 14);
    ctx.restore();
  },
};

const dualWave: VisualEffect = {
  id: "vz-dual-wave", name: "上下波",
  draw(ctx, W, H, freq, { frame, sensitivity, palette }) {
    if (!freq) return; ctx.save();
    const cy = H / 2, amp = H * 0.28, n = 160, sp = spectrum(freq, n);
    const top = sp.map((v, i) => ({ x: (i / n) * W, y: cy - Math.pow(v, 0.9) * amp * sensitivity - Math.sin(i * 0.12 + frame * 0.03) * 4 }));
    const bot = sp.map((v, i) => ({ x: (i / n) * W, y: cy + Math.pow(v, 0.9) * amp * sensitivity + Math.sin(i * 0.12 + frame * 0.03) * 4 }));
    strokeWave(ctx, top, palette.primary, 2.5, 12);
    strokeWave(ctx, bot, palette.secondary, 2.5, 12);
    ctx.restore();
  },
};

const gradientWave: VisualEffect = {
  id: "vz-gradient-wave", name: "漸層波",
  draw(ctx, W, H, freq, { frame, sensitivity, palette }) {
    if (!freq) return; ctx.save();
    const cy = H / 2, amp = H * 0.32, n = 200, sp = spectrum(freq, n);
    const pts = sp.map((v, i) => ({ x: (i / n) * W, y: cy - Math.pow(v, 0.9) * amp * sensitivity - Math.sin(i * 0.1 + frame * 0.03) * 4 }));
    const g = ctx.createLinearGradient(0, cy - amp, 0, cy + amp * 0.4);
    g.addColorStop(0, applyAlpha(palette.accent, 0.5)); g.addColorStop(1, applyAlpha(palette.primary, 0));
    ctx.beginPath(); ctx.moveTo(0, cy + amp);
    for (const pt of pts) ctx.lineTo(pt.x, pt.y);
    ctx.lineTo(W, cy + amp); ctx.closePath();
    ctx.fillStyle = g; ctx.fill();
    strokeWave(ctx, pts, palette.primary, 2, 10);
    ctx.restore();
  },
};

const pulseLine: VisualEffect = {
  id: "vz-pulse-line", name: "脈衝線",
  draw(ctx, W, H, freq, { sensitivity, palette }) {
    if (!freq) return; ctx.save();
    const baseY = H * 0.6, dot = Math.max(5, Math.floor(W / 240)), n = Math.floor(W / dot), maxS = H * 0.12;
    const sp = spectrum(freq, n);
    ctx.fillStyle = applyAlpha(palette.primary, 0.8);
    for (let i = 0; i < n; i++) { ctx.beginPath(); ctx.arc(i * dot + dot / 2, baseY, 1.6, 0, Math.PI * 2); ctx.fill(); }
    ctx.lineWidth = 2; ctx.lineCap = "round"; ctx.shadowBlur = 12; ctx.shadowColor = palette.secondary; ctx.strokeStyle = applyAlpha(palette.primary, 0.9);
    for (let i = 0; i < n; i++) {
      const v = sp[i], s = Math.pow(Math.max(0, v - 0.03), 1.9) * maxS * sensitivity * 2.4;
      if (s < 2) continue;
      const x = i * dot + dot / 2;
      ctx.beginPath(); ctx.moveTo(x, baseY - s); ctx.lineTo(x, baseY + s * 0.35); ctx.stroke();
    }
    ctx.restore();
  },
};

/* ───────── 粒子 ───────── */

const particles: VisualEffect = {
  id: "vz-particles", name: "粒子場",
  draw(ctx, W, H, freq, { frame, sensitivity, palette, isBeat }) {
    if (!freq) return; ctx.save();
    const cx = W / 2, cy = H / 2, sp = spectrum(freq, 48);
    const bass = band(sp, 0, 0.14), treble = band(sp, 0.6, 1);
    const count = 60 + Math.floor(bass * 120 * sensitivity);
    const cols = [palette.primary, palette.secondary, palette.accent];
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + frame * 0.004;
      const r = 40 + Math.sin(frame * 0.02 + i * 0.3) * 50 + bass * 80 * sensitivity + (i % 5) * 12;
      const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
      const sz = 1.5 + treble * 4 * sensitivity + (isBeat ? 1.5 : 0);
      const c = cols[i % 3];
      ctx.fillStyle = applyAlpha(c, 0.7); ctx.shadowColor = c; ctx.shadowBlur = 8;
      ctx.beginPath(); ctx.arc(x, y, sz, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  },
};

export const VIZZY_EFFECTS: VisualEffect[] = [
  bars, mirrorBars, dots, radial, ring, spectrumBlob, wave, dualWave, gradientWave, pulseLine, particles,
];

export const VIZZY_CATEGORIES: { name: string; ids: string[] }[] = [
  { name: "條狀", ids: ["vz-bars", "vz-mirror-bars", "vz-dots"] },
  { name: "環形", ids: ["vz-radial", "vz-ring", "vz-blob"] },
  { name: "波形", ids: ["vz-wave", "vz-dual-wave", "vz-gradient-wave", "vz-pulse-line"] },
  { name: "粒子", ids: ["vz-particles"] },
];
