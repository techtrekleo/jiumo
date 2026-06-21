// 九墨「視效家族」— 貓神可視化效果移植（Phase 貓神遷移 M0）。
// 直接畫 2D canvas、吃原始 FFT bins，與墨韻家族（FluidCore 流體）分流。
// 幾何照搬貓神原版（1:1 還原），配色由貓神 hueRange/ColorPaletteType 改對映九墨三槽 Palette。
// 之後每搬一個貓神 drawXXX，就在此檔加一個 VisualEffect、自動進墨效選擇器。

import type { Palette } from "./palette";

export type VisualFrame = {
  frame: number; //       動畫幀計數
  sensitivity: number; // 感應靈敏度（沿用墨效的 sens）
  palette: Palette; //    九墨三槽墨色
  isBeat: boolean; //     當幀是否鼓點/突發（給高亮用）
  image?: CanvasImageSource | null; // 第一個圖片層的圖（給黑膠/控制卡/中心圖類效果）
  title?: string; //                  落款歌名（給展示卡/幾何橫條類效果）
};

export interface VisualEffect {
  id: string;
  name: string;
  draw(ctx: CanvasRenderingContext2D, W: number, H: number, freq: Uint8Array | null, f: VisualFrame): void;
}

/* ───────── 共用輔助（自貓神移植） ───────── */

function roundedRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  if (w < 2 * r) r = w / 2;
  if (h < 2 * r) r = h / 2;
  if (r < 0) r = 0;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function hexToHue(hex: string): number {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16) / 255, g = parseInt(h.slice(2, 4), 16) / 255, b = parseInt(h.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let hue = 0;
  if (d !== 0) {
    if (max === r) hue = ((g - b) / d) % 6;
    else if (max === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }
  return hue;
}

/* ───────── INK→VIS 移植：經典頻譜條 Monstercat（貓神 drawMonstercat 1:1） ───────── */

const monstercat: VisualEffect = {
  id: "vis-monstercat",
  name: "頻譜條",
  draw(ctx, width, height, dataArray, { sensitivity, palette, isBeat }) {
    if (!dataArray) return;
    ctx.save();
    const numBarsOnHalf = 64;
    const totalBars = numBarsOnHalf * 2;
    const barWidth = width / totalBars;
    const centerX = width / 2;
    const centerY = height / 2;
    const maxHeight = height * 0.45;
    const dataSliceEnd = Math.floor(dataArray.length * 0.7);
    const startHue = hexToHue(palette.secondary);
    const endHue = hexToHue(palette.accent);
    const hueRangeSpan = endHue - startHue;

    for (let i = 0; i < numBarsOnHalf; i++) {
      const dataIndex = Math.floor((i / numBarsOnHalf) * dataSliceEnd);
      const amplitude = dataArray[dataIndex] / 255.0;
      const barHeight = Math.pow(amplitude, 2.5) * maxHeight * sensitivity;
      if (barHeight < 2) continue;

      const hue = startHue + (i / numBarsOnHalf) * hueRangeSpan;
      const saturation = isBeat ? 100 : 90;
      const lightness = 60 + amplitude * 10;
      const color = `hsl(${hue}, ${saturation}%, ${lightness}%)`;
      ctx.shadowColor = color;
      ctx.shadowBlur = isBeat ? 10 : 5;
      ctx.fillStyle = color;

      const barGap = 2;
      const effectiveBarWidth = barWidth - barGap;
      const cornerRadius = Math.min(4, effectiveBarWidth / 3);
      const drawBars = (x: number) => {
        roundedRectPath(ctx, x, centerY - barHeight, effectiveBarWidth, barHeight, cornerRadius);
        ctx.fill();
        roundedRectPath(ctx, x, centerY, effectiveBarWidth, barHeight, cornerRadius);
        ctx.fill();
      };
      drawBars(centerX - (i + 1) * barWidth + barGap / 2);
      drawBars(centerX + i * barWidth + barGap / 2);
    }
    ctx.restore();
  },
};

/* ───────── 移植：放射頻譜 Radial Bars（貓神 drawRadialBars 1:1） ───────── */

const radialBars: VisualEffect = {
  id: "vis-radial",
  name: "放射條",
  draw(ctx, width, height, dataArray, { sensitivity, palette, isBeat }) {
    if (!dataArray) return;
    ctx.save();
    const centerX = width / 2, centerY = height / 2;
    const innerRadius = Math.min(width, height) * 0.22;
    const outerRadius = innerRadius + width * 0.015;

    const drawSpikes = (radius: number, spikes: number, maxH: number, dataStart: number, dataEnd: number, direction: number, mainLineWidth: number) => {
      const color = isBeat ? palette.accent : palette.primary;
      for (let i = 0; i < spikes; i++) {
        const dataIndex = Math.floor(dataStart + (i / spikes) * (dataEnd - dataStart));
        const spikeHeight = Math.pow(dataArray[dataIndex] / 255, 2) * maxH * sensitivity;
        if (spikeHeight < 1) continue;
        const angle = (i / spikes) * Math.PI * 2 - Math.PI / 2;
        const x1 = centerX + Math.cos(angle) * radius;
        const y1 = centerY + Math.sin(angle) * radius;
        const x2 = centerX + Math.cos(angle) * (radius + spikeHeight * direction);
        const y2 = centerY + Math.sin(angle) * (radius + spikeHeight * direction);
        ctx.strokeStyle = color;
        ctx.shadowBlur = 10;
        ctx.shadowColor = color;
        ctx.lineWidth = mainLineWidth;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }
    };
    drawSpikes(innerRadius, 128, Math.min(width, height) * 0.08, 0, 64, -1, 2);
    drawSpikes(outerRadius, 128, Math.min(width, height) * 0.28, 100, dataArray.length / 4, 1, 2);
    ctx.restore();
  },
};

function applyAlpha(color: string, alpha: number): string {
  const a = Math.max(0, Math.min(1, alpha));
  const aHex = Math.round(a * 255).toString(16).padStart(2, "0");
  return `${color.substring(0, 7)}${aHex}`;
}

/* ───────── 移植：流光波 Luminous Wave（貓神 drawLuminousWave 1:1） ───────── */

const luminousWave: VisualEffect = {
  id: "vis-luminous",
  name: "流光波",
  draw(ctx, width, height, dataArray, { frame, sensitivity, palette }) {
    if (!dataArray) return;
    ctx.save();
    const centerX = width / 2, centerY = height / 2, maxAmplitude = height * 0.35;
    const beam = ctx.createLinearGradient(0, centerY, width, centerY);
    beam.addColorStop(0, "rgba(0,255,255,0)");
    beam.addColorStop(0.2, applyAlpha(palette.accent, 0x40 / 255));
    beam.addColorStop(0.5, palette.accent);
    beam.addColorStop(0.8, applyAlpha(palette.accent, 0x40 / 255));
    beam.addColorStop(1, "rgba(0,255,255,0)");
    ctx.fillStyle = beam; ctx.shadowBlur = 30; ctx.shadowColor = palette.accent;
    ctx.fillRect(0, centerY - 2, width, 4);
    const waveGradient = ctx.createLinearGradient(centerX, centerY - maxAmplitude, centerX, centerY + maxAmplitude);
    waveGradient.addColorStop(0, applyAlpha(palette.secondary, 0xcc / 255));
    waveGradient.addColorStop(0.4, palette.primary);
    waveGradient.addColorStop(0.5, palette.accent);
    waveGradient.addColorStop(0.6, palette.primary);
    waveGradient.addColorStop(1, applyAlpha(palette.secondary, 0xcc / 255));
    const drawSide = (side: "left" | "right") => {
      const numPointsOnSide = 128, dataSliceLength = dataArray.length * 0.5;
      const topPoints: { x: number; y: number }[] = [], bottomPoints: { x: number; y: number }[] = [];
      for (let i = 0; i <= numPointsOnSide; i++) {
        const progress = i / numPointsOnSide;
        const dataIndex = Math.floor(progress * dataSliceLength);
        const x = side === "left" ? centerX - progress * centerX : centerX + progress * centerX;
        const amplitude = (dataArray[dataIndex] / 255) * maxAmplitude * sensitivity;
        const oscillation = Math.sin(i * 0.1 + frame * 0.05) * 5 * (amplitude / maxAmplitude);
        topPoints.push({ x, y: centerY - (amplitude + oscillation) });
        bottomPoints.push({ x, y: centerY + (amplitude + oscillation) });
      }
      const drawCurve = (pts: { x: number; y: number }[]) => {
        if (pts.length < 2) return;
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length - 1; i++) {
          const xc = (pts[i].x + pts[i + 1].x) / 2, yc = (pts[i].y + pts[i + 1].y) / 2;
          ctx.quadraticCurveTo(pts[i].x, pts[i].y, xc, yc);
        }
        ctx.quadraticCurveTo(pts[pts.length - 1].x, pts[pts.length - 1].y, pts[pts.length - 1].x, pts[pts.length - 1].y);
        ctx.stroke();
      };
      ctx.strokeStyle = waveGradient; ctx.lineWidth = 2.5; ctx.shadowBlur = 15; ctx.shadowColor = palette.primary;
      drawCurve(topPoints); drawCurve(bottomPoints);
    };
    drawSide("left"); drawSide("right");
    ctx.restore();
  },
};

/* ───────── 移植：星雲波 Nebula Wave（貓神 drawNebulaWave 1:1） ───────── */

const nebulaWave: VisualEffect = {
  id: "vis-nebula",
  name: "星雲波",
  draw(ctx, width, height, dataArray, { frame, sensitivity, palette }) {
    if (!dataArray) return;
    ctx.save();
    const centerY = height / 2, centerX = width / 2;
    const numPoints = Math.floor(width / 2);
    const dataSliceLength = dataArray.length * 0.35;
    const base: { x: number; y_amp: number }[] = [];
    for (let i = 0; i <= numPoints / 2; i++) {
      const progress = i / (numPoints / 2);
      const x = centerX - progress * centerX;
      const dataIndex = Math.floor(progress * dataSliceLength);
      const audioAmp = Math.pow(dataArray[dataIndex] / 255, 2) * 150 * sensitivity;
      base.push({ x, y_amp: audioAmp });
    }
    const right = base.slice(1).reverse().map((p) => ({ x: width - p.x, y_amp: p.y_amp }));
    const full = [...base, ...right];
    const solidMul = 0.6, dottedMul = 1.2;
    const strokeWave = (top: boolean) => {
      ctx.beginPath();
      const seq = top ? full : [...full].reverse();
      seq.forEach((p, i) => {
        const yOsc = Math.sin(p.x * 0.05 + frame * 0.02) * 5;
        const y = top ? centerY + p.y_amp * solidMul + yOsc : centerY - p.y_amp * solidMul + yOsc;
        if (i === 0) ctx.moveTo(p.x, y); else ctx.lineTo(p.x, y);
      });
      ctx.strokeStyle = palette.primary; ctx.lineWidth = 2.5; ctx.shadowColor = palette.primary; ctx.shadowBlur = 15;
      ctx.stroke();
    };
    strokeWave(true);
    strokeWave(false);
    ctx.fillStyle = palette.secondary; ctx.shadowColor = palette.secondary; ctx.shadowBlur = 10;
    for (const p of full) {
      const yOsc = Math.sin(p.x * 0.08 + frame * -0.03) * 8;
      ctx.beginPath(); ctx.arc(p.x, centerY + p.y_amp * dottedMul + yOsc, 1.5, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(p.x, centerY - p.y_amp * dottedMul + yOsc, 1.5, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  },
};

/* ───────── 移植：故障波 Glitch Wave（貓神 drawGlitchWave 1:1，掃描線＋節拍滑移） ───────── */

const glitchWave: VisualEffect = {
  id: "vis-glitch-wave",
  name: "故障波",
  draw(ctx, width, height, dataArray, { sensitivity, palette, isBeat }) {
    if (!dataArray) return;
    ctx.save();
    const centerY = height / 2;
    ctx.beginPath();
    const slice = width / (dataArray.length * 0.5);
    let x = 0;
    for (let i = 0; i < dataArray.length * 0.5; i++) {
      const amp = Math.pow(dataArray[i] / 255, 1.5) * height * 0.3 * sensitivity;
      const y = centerY + amp;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      x += slice;
    }
    ctx.strokeStyle = palette.primary; ctx.lineWidth = 2.5; ctx.shadowColor = palette.primary; ctx.shadowBlur = 10;
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.fillStyle = "rgba(0,0,0,0.1)";
    for (let i = 0; i < height; i += 12) ctx.fillRect(0, i, width, 1);
    if (isBeat && Math.random() > 0.6) {
      const n = Math.floor(Math.random() * 3) + 1;
      for (let i = 0; i < n; i++) {
        const sy = Math.random() * height, sh = Math.random() * height / 15 + 3, dx = (Math.random() - 0.5) * 25;
        try { ctx.drawImage(ctx.canvas, 0, sy, width, sh, dx, sy, width, sh); } catch { /* cross-origin */ }
      }
    }
    ctx.restore();
  },
};

/* ───────── 移植：CRT 故障（貓神 drawCrtGlitch，色差＋掃描線＋區塊錯位） ───────── */

const crtGlitch: VisualEffect = {
  id: "vis-crt",
  name: "CRT故障",
  draw(ctx, width, height, dataArray, { sensitivity, palette, isBeat }) {
    if (!dataArray) return;
    ctx.save();
    const centerY = height / 2;
    const drawWave = (color: string, offsetX: number, lw: number) => {
      ctx.strokeStyle = color; ctx.lineWidth = lw;
      ctx.beginPath();
      const slice = width / (dataArray.length * 0.5);
      let x = 0;
      for (let i = 0; i < dataArray.length * 0.5; i++) {
        const amp = Math.pow(dataArray[i] / 255, 1.5) * height * 0.3 * sensitivity;
        const y = centerY + amp;
        if (i === 0) ctx.moveTo(x + offsetX, y); else ctx.lineTo(x + offsetX, y);
        x += slice;
      }
      ctx.stroke();
    };
    if (isBeat && Math.random() > 0.5) {
      ctx.globalCompositeOperation = "lighter";
      const I = 6;
      drawWave("rgba(255,0,100,0.5)", (Math.random() - 0.5) * I, 2);
      drawWave("rgba(0,255,255,0.5)", (Math.random() - 0.5) * I, 2);
      ctx.globalCompositeOperation = "source-over";
    }
    ctx.save(); ctx.shadowBlur = 0; drawWave("rgba(0,0,0,0.7)", 0, 4.5); ctx.restore();
    ctx.shadowColor = palette.primary; ctx.shadowBlur = 10; drawWave(palette.primary, 0, 2.5);
    ctx.shadowBlur = 0;
    ctx.fillStyle = "rgba(0,0,0,0.15)";
    for (let i = 0; i < height; i += 8) ctx.fillRect(0, i, width, 1);
    if (isBeat && Math.random() > 0.7) {
      const n = Math.floor(Math.random() * 2) + 1;
      for (let i = 0; i < n; i++) {
        const sx = Math.random() * width * 0.8, sy = Math.random() * height * 0.8;
        const sw = Math.random() * width * 0.2 + 8, sh = Math.random() * height * 0.08 + 3;
        const dx = sx + (Math.random() - 0.5) * 30, dy = sy + (Math.random() - 0.5) * 15;
        try { ctx.drawImage(ctx.canvas, sx, sy, sw, sh, dx, dy, sw, sh); } catch { /* cross-origin */ }
      }
    }
    ctx.restore();
  },
};

/* ───────── 移植：頻譜條 V2（貓神 drawMonstercatV2，AB|BA 鏡像點基線柱） ───────── */

const monstercatV2: VisualEffect = {
  id: "vis-monstercat-v2",
  name: "頻譜條2",
  draw(ctx, width, height, dataArray, { frame, sensitivity, palette }) {
    if (!dataArray) return;
    ctx.save();
    const centerY = height / 2;
    const maxBarHeight = height * 0.4, barSpacing = 20, barWidth = 8;
    const hasAudio = dataArray.some((v) => v > 0);
    const numBars = Math.floor(width / (barWidth + barSpacing));
    const dataSliceLength = dataArray.length * 0.6;
    const startHue = hexToHue(palette.secondary), endHue = hexToHue(palette.accent);
    const dot = (x: number) => { ctx.fillStyle = "rgba(255,255,255,0.9)"; ctx.beginPath(); ctx.arc(x, centerY, barWidth / 2, 0, Math.PI * 2); ctx.fill(); };
    const bar = (x: number, y: number, h: number, index: number) => {
      if (h < 1) return;
      const hue = startHue + (index / numBars) * (endHue - startHue);
      const sat = 70 + Math.sin(index * 0.2 + frame * 0.01) * 20;
      const light = 50 + Math.sin(index * 0.15 + frame * 0.015) * 15;
      const c = `hsla(${hue}, ${sat}%, ${light}%, 0.9)`;
      ctx.fillStyle = c; ctx.shadowColor = c; ctx.shadowBlur = 8;
      roundedRectPath(ctx, x - barWidth / 2, y, barWidth, h, 2); ctx.fill();
    };
    const numBarsOnHalf = Math.floor(numBars / 2);
    for (let i = 0; i < numBarsOnHalf; i++) {
      const x = i * (barWidth + barSpacing) + barWidth / 2;
      const amp = dataArray[Math.floor((i / numBarsOnHalf) * dataSliceLength)] / 255;
      let h: number;
      if (hasAudio && amp > 0.01) { h = Math.pow(amp, 1.8) * maxBarHeight * sensitivity; if (h < 3) continue; }
      else h = maxBarHeight * 0.03 * (Math.sin(frame * 0.02 + i * 0.15) * 0.03 + 1);
      bar(x, centerY - h, h, i); bar(x, centerY, h, i); dot(x);
      const rx = width - x;
      bar(rx, centerY - h, h, numBars - i - 1); bar(rx, centerY, h, numBars - i - 1); dot(rx);
    }
    ctx.restore();
  },
};

/* ───────── 移植：歌詞脈衝線（貓神 drawLyricPulseLine，點狀基線＋衰減尖峰） ───────── */

let pulseBuffer: number[] = [];
let pulseLastTime = 0;
const PULSE_DECAY = 0.18;

const lyricPulseLine: VisualEffect = {
  id: "vis-pulse-line",
  name: "脈衝線",
  draw(ctx, width, height, dataArray, { sensitivity, palette }) {
    if (!dataArray) return;
    ctx.save();
    const baseLineY = height * 0.62;
    const dotRadius = 1.6, dotSpacing = Math.max(5, Math.floor(width / 240));
    const numDots = Math.floor(width / dotSpacing);
    if (pulseBuffer.length !== numDots) { pulseBuffer = new Array(numDots).fill(0); pulseLastTime = performance.now() / 1000; }
    const now = performance.now() / 1000, dt = Math.max(0, now - pulseLastTime);
    pulseLastTime = now;
    const decay = Math.exp(-dt / PULSE_DECAY);
    const lineColor = palette.primary, glowColor = palette.secondary;
    const dataStart = Math.floor(dataArray.length * 0.05), dataEnd = Math.floor(dataArray.length * 0.45);
    const dataSpan = Math.max(1, dataEnd - dataStart);
    const maxSpike = height * 0.1, minSpike = 2;
    ctx.globalAlpha = 0.85; ctx.fillStyle = applyAlpha(lineColor, 0.85);
    for (let i = 0; i < numDots; i++) { ctx.beginPath(); ctx.arc(i * dotSpacing + dotSpacing * 0.5, baseLineY, dotRadius, 0, Math.PI * 2); ctx.fill(); }
    ctx.globalAlpha = 1; ctx.lineWidth = 2; ctx.lineCap = "round"; ctx.shadowBlur = 14; ctx.shadowColor = glowColor; ctx.strokeStyle = applyAlpha(lineColor, 0.9);
    for (let i = 0; i < numDots; i++) {
      const progress = i / Math.max(1, numDots - 1);
      const idx = dataStart + Math.floor(progress * dataSpan);
      const v = dataArray[Math.min(dataArray.length - 1, idx)] / 255;
      const target = Math.min(maxSpike, Math.pow(Math.max(0, v - 0.03), 2.2) * maxSpike * sensitivity * 2.2);
      pulseBuffer[i] = target > pulseBuffer[i] ? target : pulseBuffer[i] * decay;
      const spike = pulseBuffer[i];
      if (spike < minSpike) continue;
      const x = i * dotSpacing + dotSpacing * 0.5;
      ctx.beginPath(); ctx.moveTo(x, baseLineY - spike); ctx.lineTo(x, baseLineY + spike * 0.35); ctx.stroke();
    }
    ctx.restore();
  },
};

/* ───────── 移植：量子脈衝 Tech Wave（貓神 drawTechWave，節點/核心/波函數/頻譜/粒子） ───────── */

const techWave: VisualEffect = {
  id: "vis-tech",
  name: "量子脈衝",
  draw(ctx, width, height, dataArray, { frame, sensitivity, palette, isBeat }) {
    if (!dataArray) return;
    ctx.save();
    const cx = width / 2, cy = height / 2;
    const bass = dataArray.slice(0, 32).reduce((a, b) => a + b, 0) / 32 / 255;
    const mid = dataArray.slice(32, 96).reduce((a, b) => a + b, 0) / 64 / 255;
    const treble = dataArray.slice(96, 128).reduce((a, b) => a + b, 0) / 32 / 255;
    const fieldRadius = Math.min(width, height) * 0.5;
    const fg = ctx.createRadialGradient(cx, cy, 0, cx, cy, fieldRadius);
    fg.addColorStop(0, applyAlpha(palette.primary, 0.08)); fg.addColorStop(1, "transparent");
    ctx.fillStyle = fg; ctx.fillRect(0, 0, width, height);
    const nodeCount = 8;
    for (let i = 0; i < nodeCount; i++) {
      const a = (i / nodeCount) * Math.PI * 2 + frame * 0.015, nr = fieldRadius * 0.6;
      const nx = cx + Math.cos(a) * nr, ny = cy + Math.sin(a) * nr;
      const ns = 6 + bass * 4 * sensitivity;
      const nc = i % 3 === 0 ? palette.primary : i % 3 === 1 ? palette.secondary : palette.accent;
      ctx.fillStyle = nc; ctx.shadowColor = nc; ctx.shadowBlur = 12;
      ctx.beginPath(); ctx.arc(nx, ny, ns, 0, Math.PI * 2); ctx.fill();
      if (i % 2 === 0) { ctx.strokeStyle = applyAlpha(nc, 0.3); ctx.lineWidth = 1.5; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.arc(nx, ny, ns + 8 + mid * 8 * sensitivity, 0, Math.PI * 2); ctx.stroke(); }
      ctx.setLineDash([]);
      const ni = (i + 1) % nodeCount, na = (ni / nodeCount) * Math.PI * 2 + frame * 0.015;
      ctx.strokeStyle = applyAlpha(palette.accent, 0.2 + treble * 0.3); ctx.lineWidth = 1; ctx.setLineDash([2, 2]);
      ctx.beginPath(); ctx.moveTo(nx, ny); ctx.lineTo(cx + Math.cos(na) * nr, cy + Math.sin(na) * nr); ctx.stroke();
    }
    ctx.setLineDash([]);
    const coreRadius = 20 + bass * 30 * sensitivity;
    for (let i = 0; i < 2; i++) {
      const lr = coreRadius + i * 10, lc = i % 2 === 0 ? palette.primary : palette.secondary;
      const lg = ctx.createRadialGradient(cx, cy, 0, cx, cy, lr);
      lg.addColorStop(0, applyAlpha(lc, 0.6 - i * 0.3)); lg.addColorStop(1, "transparent");
      ctx.fillStyle = lg; ctx.shadowColor = lc; ctx.shadowBlur = 15;
      ctx.beginPath(); ctx.arc(cx, cy, lr, 0, Math.PI * 2); ctx.fill();
    }
    for (let i = 0; i < 4; i++) {
      const wa = (i / 4) * Math.PI * 2 + frame * 0.008, amp = 40 + mid * 60 * sensitivity, fr = 2 + treble * 3;
      ctx.strokeStyle = applyAlpha(palette.accent, 0.5); ctx.lineWidth = 1.5; ctx.shadowColor = palette.accent; ctx.shadowBlur = 8;
      ctx.beginPath();
      for (let x = 0; x < width; x += 6) {
        const wh = Math.sin((x / width) * fr * Math.PI + frame * 0.015) * amp;
        const rx = cx + (x - cx) * Math.cos(wa) - wh * Math.sin(wa), ry = cy + (x - cx) * Math.sin(wa) + wh * Math.cos(wa);
        if (x === 0) ctx.moveTo(rx, ry); else ctx.lineTo(rx, ry);
      }
      ctx.stroke();
    }
    const spectrumBars = 32, bw = width / spectrumBars;
    for (let i = 0; i < spectrumBars; i++) {
      const amp = dataArray[Math.floor((i / spectrumBars) * dataArray.length)] / 255;
      const bh = Math.pow(amp, 1.3) * height * 0.25 * sensitivity;
      if (bh < 3) continue;
      const dx = isBeat && Math.random() > 0.9 ? (Math.random() - 0.5) * 4 : 0;
      const dh = isBeat && Math.random() > 0.95 ? Math.random() * 8 : 0;
      ctx.fillStyle = i < spectrumBars * 0.33 ? applyAlpha(palette.primary, 0.7 + amp * 0.2) : i < spectrumBars * 0.66 ? applyAlpha(palette.secondary, 0.7 + amp * 0.2) : applyAlpha(palette.accent, 0.7 + amp * 0.2);
      ctx.fillRect(i * bw + dx, height - bh, bw - 1, bh + dh);
    }
    const particleCount = 40 + bass * 60 * sensitivity;
    for (let i = 0; i < particleCount; i++) {
      const a = (i / particleCount) * Math.PI * 2 + frame * 0.003, r = 30 + Math.sin(frame * 0.02 + i * 0.05) * 40;
      ctx.fillStyle = applyAlpha(palette.accent, 0.6 + treble * 0.2); ctx.shadowColor = palette.accent; ctx.shadowBlur = 8;
      ctx.beginPath(); ctx.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 1.5 + mid * 2 * sensitivity, 0, Math.PI * 2); ctx.fill();
    }
    for (let i = 0; i < 6; i++) {
      const la = (i / 6) * Math.PI * 2 + frame * 0.01, ll = fieldRadius * 0.3 + bass * 40 * sensitivity;
      ctx.strokeStyle = applyAlpha(palette.primary, 0.3); ctx.lineWidth = 1.5; ctx.setLineDash([8, 8]);
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(la) * ll, cy + Math.sin(la) * ll); ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.restore();
  },
};

/* ───────── 移植：水波漣漪 Water Ripple（貓神 drawWaterRipple） ───────── */

const waterRipple: VisualEffect = {
  id: "vis-water",
  name: "水波漣漪",
  draw(ctx, width, height, dataArray, { frame, sensitivity, palette, isBeat }) {
    if (!dataArray) return;
    ctx.save();
    const cx = width / 2, cy = height / 2;
    const bass = dataArray.slice(0, 32).reduce((a, b) => a + b, 0) / 32 / 255;
    const mid = dataArray.slice(32, 128).reduce((a, b) => a + b, 0) / 96 / 255;
    const treble = dataArray.slice(128, 256).reduce((a, b) => a + b, 0) / 128 / 255;
    const maxR = Math.min(width, height) * 0.45;
    for (let layer = 0; layer < 5; layer++) {
      const age = (frame + layer * 15) % 100;
      const r = (age / 100) * maxR, op = Math.max(0, 1 - age / 100) * 0.7;
      if (op <= 0.05) continue;
      const intensity = (bass * 0.5 + mid * 0.3 + treble * 0.2) * sensitivity;
      const rc = isBeat ? palette.accent : palette.primary;
      ctx.strokeStyle = applyAlpha(rc, op * intensity); ctx.lineWidth = Math.max(1, 4 - layer * 0.6); ctx.shadowBlur = 20; ctx.shadowColor = rc;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
      if (layer === 0 && isBeat) {
        for (let w = 0; w < 12; w++) {
          const wa = (w / 12) * Math.PI * 2, wr = r + Math.sin(frame * 0.15 + w) * 8;
          ctx.beginPath(); ctx.arc(cx + Math.cos(wa) * wr, cy + Math.sin(wa) * wr, 3, 0, Math.PI * 2);
          ctx.fillStyle = applyAlpha(rc, op * 0.9); ctx.fill();
        }
      }
    }
    const centerR = Math.min(width, height) * 0.08 + bass * 40;
    const cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, centerR);
    cg.addColorStop(0, palette.accent); cg.addColorStop(0.4, palette.primary); cg.addColorStop(1, "rgba(0,150,200,0)");
    ctx.shadowBlur = 50; ctx.shadowColor = palette.primary; ctx.fillStyle = cg;
    ctx.beginPath(); ctx.arc(cx, cy, centerR, 0, Math.PI * 2); ctx.fill();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + frame * 0.02, nr = Math.min(width, height) * 0.25;
      const ni = dataArray[Math.floor((i / 8) * dataArray.length)] / 255;
      if (ni <= 0.1) continue;
      ctx.fillStyle = applyAlpha(palette.secondary, ni * 0.8); ctx.shadowBlur = 15; ctx.shadowColor = palette.secondary;
      ctx.beginPath(); ctx.arc(cx + Math.cos(a) * nr, cy + Math.sin(a) * nr, ni * 20 * sensitivity, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  },
};

/* ───────── 移植：星核 Stellar Core（貓神 drawStellarCore，漣漪＋音符＋觸鬚＋核心） ───────── */

const stellarCore: VisualEffect = {
  id: "vis-stellar",
  name: "星核",
  draw(ctx, width, height, dataArray, { frame, sensitivity, palette, isBeat }) {
    if (!dataArray) return;
    ctx.save();
    const cx = width / 2, cy = height / 2;
    const bass = dataArray.slice(0, 32).reduce((a, b) => a + b, 0) / 32 / 255;
    const mid = dataArray.slice(32, 128).reduce((a, b) => a + b, 0) / 96 / 255;
    const treble = dataArray.slice(128, 256).reduce((a, b) => a + b, 0) / 128 / 255;
    const maxR = Math.min(width, height) * 0.5;
    for (let layer = 0; layer < 4; layer++) {
      const age = (frame + layer * 20) % 100, r = (age / 100) * maxR, op = Math.max(0, 1 - age / 100) * 0.8;
      if (op <= 0.05) continue;
      const intensity = (bass * 0.5 + mid * 0.3 + treble * 0.2) * sensitivity;
      const rc = isBeat ? palette.accent : palette.primary;
      ctx.strokeStyle = applyAlpha(rc, op * intensity); ctx.lineWidth = Math.max(2, 6 - layer); ctx.shadowBlur = 15; ctx.shadowColor = rc;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
      if (layer % 3 === 0) { ctx.strokeStyle = applyAlpha(palette.secondary, op * intensity * 0.5); ctx.lineWidth = Math.max(1, 3 - layer * 0.5); ctx.shadowBlur = 8; ctx.shadowColor = palette.secondary; ctx.beginPath(); ctx.arc(cx, cy, r + 3, 0, Math.PI * 2); ctx.stroke(); }
    }
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + frame * 0.02, nr = Math.min(width, height) * 0.25;
      const nx = cx + Math.cos(a) * nr, ny = cy + Math.sin(a) * nr;
      const ni = dataArray[Math.floor((i / 8) * dataArray.length)] / 255;
      if (ni <= 0.12) continue;
      const ns = ni * 25 * sensitivity;
      ctx.fillStyle = applyAlpha(palette.secondary, ni); ctx.shadowBlur = 15; ctx.shadowColor = palette.secondary;
      ctx.beginPath(); ctx.arc(nx, ny, ns, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 20; ctx.fillStyle = applyAlpha(palette.secondary, ni * 0.2);
      ctx.beginPath(); ctx.arc(nx, ny, ns * 1.3, 0, Math.PI * 2); ctx.fill();
    }
    const spikes = 90, sbr = Math.min(width, height) * 0.12;
    for (let i = 0; i < spikes; i++) {
      const sh = Math.pow(dataArray[Math.floor((i / spikes) * dataArray.length * 0.5)] / 255, 1.5) * 120 * sensitivity;
      if (sh < 2) continue;
      const a = (i / spikes) * Math.PI * 2;
      const x1 = cx + Math.cos(a) * sbr, y1 = cy + Math.sin(a) * sbr;
      const x2 = cx + Math.cos(a) * (sbr + sh), y2 = cy + Math.sin(a) * (sbr + sh);
      const cpr = sbr + sh / 2, swirl = sh / 15 + Math.sin(frame * 0.03 + i * 0.05) * 8;
      const ctrlX = cx + Math.cos(a) * cpr, ctrlY = cy + Math.sin(a) * cpr + Math.sin(frame * 0.03 + i * 0.05) * swirl;
      ctx.strokeStyle = palette.primary; ctx.shadowColor = palette.primary; ctx.shadowBlur = 6; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.quadraticCurveTo(ctrlX, ctrlY, x2, y2); ctx.stroke();
    }
    const coreR = Math.min(width, height) * 0.05 + bass * 40;
    const cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
    cg.addColorStop(0, palette.accent); cg.addColorStop(0.4, palette.primary); cg.addColorStop(1, "rgba(0,150,200,0)");
    ctx.shadowBlur = 30; ctx.shadowColor = palette.primary; ctx.fillStyle = cg;
    ctx.beginPath(); ctx.arc(cx, cy, coreR, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  },
};

/* ───────── 移植：完整星系 Particle Galaxy（貓神 drawParticleGalaxy，螺旋臂/小行星帶/行星/太陽） ───────── */

const particleGalaxy: VisualEffect = {
  id: "vis-galaxy",
  name: "完整星系",
  draw(ctx, width, height, dataArray, { frame, sensitivity, palette }) {
    if (!dataArray) return;
    ctx.save();
    const cx = width / 2, cy = height / 2;
    const bass = dataArray.slice(0, 32).reduce((a, b) => a + b, 0) / 32 / 255;
    const mid = dataArray.slice(32, 96).reduce((a, b) => a + b, 0) / 64 / 255;
    const treble = dataArray.slice(96, 128).reduce((a, b) => a + b, 0) / 32 / 255;
    const nebulaRadius = Math.min(width, height) * 0.6;
    const armLength = nebulaRadius * 0.5;
    for (let arm = 0; arm < 2; arm++) {
      const armAngle = (arm / 2) * Math.PI * 2 + frame * 0.003, armColor = arm % 2 === 0 ? palette.primary : palette.secondary;
      for (let i = 0; i < 25; i++) {
        const t = i / 25, radius = t * armLength, sa = armAngle + t * 1.5 * Math.PI + Math.sin(t * Math.PI * 3) * 0.2;
        const x = cx + radius * Math.cos(sa), y = cy + radius * Math.sin(sa);
        const ss = (1 - t) * 2.5 + bass * 1.5 * sensitivity;
        if (ss <= 0.5) continue;
        ctx.fillStyle = applyAlpha(armColor, (1 - t) * 0.7 + mid * 0.2); ctx.shadowColor = armColor; ctx.shadowBlur = ss * 1.5;
        ctx.beginPath(); ctx.arc(x, y, ss, 0, Math.PI * 2); ctx.fill();
      }
    }
    const beltRadius = nebulaRadius * 0.35, asteroidCount = 40 + treble * 20 * sensitivity;
    ctx.shadowBlur = 0;
    for (let i = 0; i < asteroidCount; i++) {
      const a = (i / asteroidCount) * Math.PI * 2 + frame * 0.001, r = beltRadius + (Math.random() - 0.5) * 15;
      ctx.fillStyle = applyAlpha(palette.accent, 0.5 + mid * 0.3);
      ctx.beginPath(); ctx.arc(cx + r * Math.cos(a), cy + r * Math.sin(a), 0.8 + Math.random() * 1.5, 0, Math.PI * 2); ctx.fill();
    }
    for (let i = 0; i < 2; i++) {
      const pa = (i / 2) * Math.PI * 2 + frame * 0.008, pr = 60 + i * 50;
      const px = cx + Math.cos(pa) * pr, py = cy + Math.sin(pa) * pr;
      const ps = 12 + i * 3 + bass * 8 * sensitivity, pc = i === 0 ? palette.primary : palette.secondary;
      const pg = ctx.createRadialGradient(px, py, 0, px, py, ps);
      pg.addColorStop(0, applyAlpha(pc, 0.9)); pg.addColorStop(0.6, applyAlpha(pc, 0.7)); pg.addColorStop(1, applyAlpha(pc, 0.4));
      ctx.fillStyle = pg; ctx.shadowColor = pc; ctx.shadowBlur = 15;
      ctx.beginPath(); ctx.arc(px, py, ps, 0, Math.PI * 2); ctx.fill();
      if (i === 1) { ctx.strokeStyle = applyAlpha(pc, 0.5); ctx.lineWidth = 1.5; ctx.setLineDash([8, 8]); ctx.beginPath(); ctx.arc(px, py, ps * 1.8, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]); }
      const moons = i === 0 ? 1 : 2;
      for (let j = 0; j < moons; j++) {
        const ma = (j / moons) * Math.PI * 2 + frame * 0.015, mr = ps * 2.2;
        ctx.fillStyle = applyAlpha(palette.accent, 0.7);
        ctx.beginPath(); ctx.arc(px + Math.cos(ma) * mr, py + Math.sin(ma) * mr, 2.5 + mid * 1.5 * sensitivity, 0, Math.PI * 2); ctx.fill();
      }
    }
    const sunR = 25 + bass * 20 * sensitivity;
    const sgg = ctx.createRadialGradient(cx, cy, 0, cx, cy, sunR * 2);
    sgg.addColorStop(0, applyAlpha("#FFFF00", 0.3)); sgg.addColorStop(0.5, applyAlpha("#FF8800", 0.2)); sgg.addColorStop(1, "transparent");
    ctx.fillStyle = sgg; ctx.beginPath(); ctx.arc(cx, cy, sunR * 2, 0, Math.PI * 2); ctx.fill();
    const sg = ctx.createRadialGradient(cx, cy, 0, cx, cy, sunR);
    sg.addColorStop(0, "#FFFFFF"); sg.addColorStop(0.3, "#FFFF00"); sg.addColorStop(0.7, "#FF8800"); sg.addColorStop(1, "#FF4400");
    ctx.fillStyle = sg; ctx.shadowColor = "#FFFF00"; ctx.shadowBlur = 30;
    ctx.beginPath(); ctx.arc(cx, cy, sunR, 0, Math.PI * 2); ctx.fill();
    for (let i = 0; i < 3; i++) {
      ctx.strokeStyle = applyAlpha("#FFFF00", 0.25 - i * 0.08); ctx.lineWidth = 1.5; ctx.setLineDash([8, 8]);
      ctx.beginPath(); ctx.arc(cx, cy, sunR * 1.5 + i * 12 + bass * 15 * sensitivity, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.setLineDash([]);
    const dustCount = 80 + mid * 40 * sensitivity;
    for (let i = 0; i < dustCount; i++) {
      ctx.fillStyle = applyAlpha(palette.accent, 0.25 + Math.random() * 0.3);
      ctx.beginPath(); ctx.arc((i * 47) % width, (i * 79) % height, 0.4 + Math.random() * 0.8, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  },
};

/* ───────── 移植：金屬花朵 Liquid Metal（貓神 drawLiquidMetal，貝茲花瓣＋花蕊＋能量環） ───────── */

const liquidMetal: VisualEffect = {
  id: "vis-liquid-metal",
  name: "金屬花",
  draw(ctx, width, height, dataArray, { frame, sensitivity, palette, isBeat }) {
    if (!dataArray) return;
    ctx.save();
    const cx = width / 2, cy = height / 2;
    const bass = dataArray.slice(0, 16).reduce((a, b) => a + b, 0) / 16 / 255;
    const mid = dataArray.slice(16, 64).reduce((a, b) => a + b, 0) / 48 / 255;
    const treble = dataArray.slice(64, 128).reduce((a, b) => a + b, 0) / 64 / 255;
    const numPetals = 6 + Math.floor(mid * 2 * sensitivity);
    const petalLength = Math.min(width, height) * 0.15 + bass * 80 * sensitivity;
    for (let i = 0; i < numPetals; i++) {
      const pa = (i / numPetals) * Math.PI * 2 + frame * 0.008, pc = i % 2 === 0 ? palette.primary : palette.secondary;
      const sx = cx + Math.cos(pa) * 15, sy = cy + Math.sin(pa) * 15;
      const ex = cx + Math.cos(pa) * petalLength, ey = cy + Math.sin(pa) * petalLength;
      const c1x = sx + Math.cos(pa + 0.2) * petalLength * 0.4, c1y = sy + Math.sin(pa + 0.2) * petalLength * 0.4;
      const c2x = sx + Math.cos(pa - 0.2) * petalLength * 0.4, c2y = sy + Math.sin(pa - 0.2) * petalLength * 0.4;
      const pg = ctx.createLinearGradient(sx, sy, ex, ey);
      pg.addColorStop(0, applyAlpha(pc, 0.8)); pg.addColorStop(0.5, applyAlpha(pc, 0.6)); pg.addColorStop(1, applyAlpha(pc, 0.3));
      ctx.strokeStyle = pg; ctx.lineWidth = 4 + mid * 6 * sensitivity; ctx.lineCap = "round"; ctx.shadowColor = pc; ctx.shadowBlur = 8 + bass * 8 * sensitivity;
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.bezierCurveTo(c1x, c1y, c2x, c2y, ex, ey); ctx.stroke();
    }
    const coreR = 20 + bass * 40 * sensitivity;
    const cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
    cg.addColorStop(0, palette.accent); cg.addColorStop(0.6, palette.primary); cg.addColorStop(1, "transparent");
    ctx.fillStyle = cg; ctx.shadowColor = palette.accent; ctx.shadowBlur = 15 + bass * 10 * sensitivity;
    ctx.beginPath(); ctx.arc(cx, cy, coreR, 0, Math.PI * 2); ctx.fill();
    const numRings = 2 + Math.floor(mid * sensitivity);
    for (let i = 0; i < numRings; i++) {
      const rr = coreR + 20 + i * 15 + bass * 20 * sensitivity, rot = frame * (0.015 + i * 0.008);
      ctx.strokeStyle = applyAlpha(palette.accent, 0.5 - i * 0.2 + treble * 0.1); ctx.lineWidth = 2 + mid * sensitivity; ctx.setLineDash([10, 10]);
      const segs = 4 + Math.floor(mid * 2 * sensitivity);
      for (let j = 0; j < segs; j++) { ctx.beginPath(); ctx.arc(cx, cy, rr, (j / segs) * Math.PI * 2 + rot, ((j + 1) / segs) * Math.PI * 2 + rot); ctx.stroke(); }
    }
    ctx.setLineDash([]);
    const particleCount = 8 + treble * 20 * sensitivity;
    for (let i = 0; i < particleCount; i++) {
      const a = (i / particleCount) * Math.PI * 2 + frame * 0.003, r = 60 + Math.sin(frame * 0.02 + i * 0.1) * 30 + bass * 20 * sensitivity;
      const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r, psz = 2 + mid * 4 * sensitivity;
      const ppg = ctx.createRadialGradient(x, y, 0, x, y, psz);
      ppg.addColorStop(0, palette.accent); ppg.addColorStop(1, "transparent");
      ctx.fillStyle = ppg; ctx.shadowColor = palette.accent; ctx.shadowBlur = 8 + mid * 5 * sensitivity;
      ctx.beginPath(); ctx.arc(x, y, psz, 0, Math.PI * 2); ctx.fill();
    }
    if (isBeat && Math.random() > 0.6) { ctx.fillStyle = applyAlpha(palette.primary, 0.2); ctx.beginPath(); ctx.arc(cx, cy, coreR * 1.5, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
  },
};

/* ───────── 移植：數位熔接 Data Mosh（貓神 drawDataMosh，ghost frame＋頻譜＋核心） ───────── */

const dataMoshState: { imageData: ImageData | null; framesLeft: number } = { imageData: null, framesLeft: 0 };

const dataMosh: VisualEffect = {
  id: "vis-datamosh",
  name: "數位熔接",
  draw(ctx, width, height, dataArray, { frame, sensitivity, palette, isBeat }) {
    if (!dataArray) return;
    ctx.save();
    const cx = width / 2, cy = height / 2;
    const bass = dataArray.slice(0, 32).reduce((a, b) => a + b, 0) / 32 / 255;
    const mid = dataArray.slice(32, 96).reduce((a, b) => a + b, 0) / 64 / 255;
    const treble = dataArray.slice(96, 128).reduce((a, b) => a + b, 0) / 32 / 255;
    if (dataMoshState.framesLeft > 0 && dataMoshState.imageData && frame % 3 === 0) {
      ctx.globalAlpha = 0.2; ctx.putImageData(dataMoshState.imageData, 0, 0); dataMoshState.framesLeft--; ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = palette.primary; ctx.lineWidth = 2; ctx.shadowColor = palette.primary; ctx.shadowBlur = 8;
    ctx.beginPath();
    for (let x = 0; x < width; x += 4) { const y = cy + Math.sin((x / width) * 2 * Math.PI + frame * 0.01) * height * 0.12 * sensitivity * bass; if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
    ctx.stroke();
    const numBars = 64, bw = width / numBars;
    for (let i = 0; i < numBars; i++) {
      const amp = dataArray[Math.floor((i / numBars) * dataArray.length)] / 255;
      const bh = Math.pow(amp, 1.5) * height * 0.3 * sensitivity;
      if (bh < 4) continue;
      const dx = isBeat && Math.random() > 0.85 ? (Math.random() - 0.5) * 8 : 0;
      const dy = isBeat && Math.random() > 0.9 ? (Math.random() - 0.5) * 10 : 0;
      const hueShift = (i / numBars) * 60 - 30;
      ctx.fillStyle = `hsla(${200 + hueShift + (frame * 0.5) % 360}, ${80 + amp * 20}%, ${50 + amp * 30}%, ${0.8 + amp * 0.2})`;
      ctx.shadowBlur = 3;
      roundedRectPath(ctx, i * bw + dx, height - bh + dy, bw, bh, Math.min(bw * 0.3, bh * 0.2)); ctx.fill();
      ctx.shadowBlur = 0;
      if (isBeat && Math.random() > 0.92) { ctx.fillStyle = "#FF00FF"; ctx.fillRect(i * bw + dx, height - bh + dy + Math.random() * bh, bw, 1); }
    }
    const coreR = 30 + bass * 50 * sensitivity;
    ctx.fillStyle = palette.primary; ctx.shadowColor = palette.accent; ctx.shadowBlur = 20;
    ctx.beginPath(); ctx.arc(cx, cy, coreR, 0, Math.PI * 2); ctx.fill();
    for (let i = 0; i < 2; i++) {
      const rr = coreR + 20 + i * 15, rot = frame * (0.02 + i * 0.01);
      ctx.strokeStyle = applyAlpha(palette.accent, 0.4 - i * 0.2); ctx.lineWidth = 2;
      for (let j = 0; j < 8; j++) { ctx.beginPath(); ctx.arc(cx, cy, rr, (j / 8) * Math.PI * 2 + rot, ((j + 1) / 8) * Math.PI * 2 + rot); ctx.stroke(); }
    }
    const particleCount = 20 + bass * 40 * sensitivity;
    for (let i = 0; i < particleCount; i++) {
      const a = (i / particleCount) * Math.PI * 2 + frame * 0.005, r = 50 + Math.sin(frame * 0.01 + i * 0.1) * 20;
      ctx.fillStyle = applyAlpha(palette.accent, 0.5 + treble * 0.3);
      ctx.beginPath(); ctx.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 1.5 + mid * 3 * sensitivity, 0, Math.PI * 2); ctx.fill();
    }
    if (frame % 2 === 0) { ctx.strokeStyle = applyAlpha(palette.primary, 0.08); ctx.lineWidth = 1; for (let y = 0; y < height; y += 8) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke(); } }
    if (isBeat && Math.random() > 0.85) { try { dataMoshState.imageData = ctx.getImageData(0, 0, width, height); dataMoshState.framesLeft = 3 + Math.floor(Math.random() * 5); } catch { /* cross-origin */ } }
    ctx.restore();
  },
};

/* ───────── 移植：訊號干擾 Signal Scramble（貓神 drawSignalScramble，色差＋雪花＋撕裂） ───────── */

const signalScramble: VisualEffect = {
  id: "vis-signal",
  name: "訊號干擾",
  draw(ctx, width, height, dataArray, { sensitivity, palette, isBeat }) {
    if (!dataArray) return;
    ctx.save();
    const cy = height / 2;
    ctx.globalCompositeOperation = "lighter";
    const intensity = isBeat ? 15 : 5;
    const subWave = (color: string, offset: number) => {
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath();
      const slice = width / (dataArray.length * 0.5); let x = 0;
      for (let i = 0; i < dataArray.length * 0.5; i++) { const amp = Math.pow(dataArray[i] / 255, 1.5) * height * 0.3 * sensitivity; ctx.lineTo(x, cy + amp + (Math.random() - 0.5) * offset); x += slice; }
      ctx.stroke();
    };
    subWave("rgba(255,0,100,0.6)", intensity);
    subWave("rgba(0,255,255,0.6)", intensity);
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = palette.primary; ctx.lineWidth = 2.5; ctx.shadowColor = palette.primary; ctx.shadowBlur = 10;
    ctx.beginPath();
    const slice = width / (dataArray.length * 0.5); let x = 0;
    for (let i = 0; i < dataArray.length * 0.5; i++) { const amp = Math.pow(dataArray[i] / 255, 1.5) * height * 0.3 * sensitivity; ctx.lineTo(x, cy + amp); x += slice; }
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.fillStyle = "rgba(255,255,255,0.08)";
    for (let i = 0; i < 200; i++) ctx.fillRect(Math.random() * width, Math.random() * height, Math.random() * 2, Math.random() * 2);
    ctx.strokeStyle = "rgba(255,255,255,0.05)"; ctx.lineWidth = 1;
    for (let i = 0; i < 3; i++) { const y = height * Math.random(); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke(); }
    if (isBeat && Math.random() > 0.5) {
      const ty = Math.random() * height, th = Math.random() * 50 + 20, ts = (Math.random() - 0.5) * 80;
      try { ctx.drawImage(ctx.canvas, 0, ty, width, th, ts, ty, width, th); } catch { /* cross-origin */ }
    }
    ctx.restore();
  },
};

/* ───────── 移植：故障頻譜條 Monstercat Glitch（貓神 drawMonstercatGlitch，頻譜條＋節拍故障塊） ───────── */

const monstercatGlitch: VisualEffect = {
  id: "vis-monstercat-glitch",
  name: "故障頻譜",
  draw(ctx, width, height, dataArray, f) {
    if (!dataArray) return;
    monstercat.draw(ctx, width, height, dataArray, f);
    if (!f.isBeat) return;
    ctx.save();
    if (Math.random() > 0.7) ctx.filter = `hue-rotate(${(Math.random() - 0.5) * 30}deg) saturate(${1.2 + Math.random() * 0.3})`;
    const n = Math.floor(Math.random() * 3) + 1;
    for (let i = 0; i < n; i++) {
      const sx = Math.random() * width * 0.8, sy = Math.random() * height * 0.8;
      const sw = Math.random() * width * 0.15 + 8, sh = Math.random() * height * 0.08 + 4;
      try { ctx.drawImage(ctx.canvas, sx, sy, sw, sh, sx + (Math.random() - 0.5) * 20, sy, sw, sh); } catch { /* cross-origin */ }
    }
    ctx.restore();
  },
};

/* ───────── 移植：數位風暴 Pixel Sort（貓神 drawPixelSort，雲＋閃電＋數位雨＋柱＋核心） ───────── */

const pixelSort: VisualEffect = {
  id: "vis-pixel-sort",
  name: "數位風暴",
  draw(ctx, width, height, dataArray, { frame, sensitivity, palette, isBeat }) {
    if (!dataArray) return;
    ctx.save();
    const cx = width / 2, cy = height / 2;
    const bass = dataArray.slice(0, 16).reduce((a, b) => a + b, 0) / 16 / 255;
    const mid = dataArray.slice(16, 64).reduce((a, b) => a + b, 0) / 48 / 255;
    const treble = dataArray.slice(64, 128).reduce((a, b) => a + b, 0) / 64 / 255;
    const storm = (bass + mid + treble) / 3;
    for (let i = 0; i < 8; i++) {
      const clx = (i / 8) * width + Math.sin(frame * 0.02 + i) * 50, cly = height * 0.2 + Math.sin(frame * 0.01 + i * 0.5) * 30;
      ctx.fillStyle = applyAlpha(palette.primary, 0.1 + storm * 0.2);
      ctx.beginPath(); ctx.arc(clx, cly, 80 + bass * 100 * sensitivity, 0, Math.PI * 2); ctx.fill();
    }
    if (isBeat && Math.random() > 0.6) {
      const n = Math.floor(Math.random() * 3) + 1;
      for (let i = 0; i < n; i++) {
        const sx = Math.random() * width, ex = sx + (Math.random() - 0.5) * 200;
        ctx.strokeStyle = "#FFFFFF"; ctx.lineWidth = 3; ctx.shadowColor = "#00FFFF"; ctx.shadowBlur = 20;
        ctx.beginPath(); ctx.moveTo(sx, 0);
        for (let j = 1; j <= 8; j++) { const p = j / 8; ctx.lineTo(sx + (ex - sx) * p + (Math.random() - 0.5) * 40, height * p); }
        ctx.stroke();
      }
    }
    ctx.shadowBlur = 0;
    for (let i = 0; i < 200; i++) {
      const x = (i * 37) % width, y = (frame * 2 + i * 2) % (height + 100);
      ctx.strokeStyle = applyAlpha(palette.accent, 0.3 + treble * 0.4); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + 10 + treble * 20 * sensitivity); ctx.stroke();
    }
    const numBars = 64, bw = width / numBars;
    for (let i = 0; i < numBars; i++) {
      const amp = dataArray[Math.floor((i / numBars) * dataArray.length)] / 255;
      const bh = Math.pow(amp, 1.5) * height * 0.6 * sensitivity;
      if (bh < 2) continue;
      const gx = isBeat && Math.random() > 0.8 ? (Math.random() - 0.5) * 10 : 0;
      const hueShift = (i / numBars) * 80 - 40;
      ctx.fillStyle = `hsla(${200 + hueShift + (frame * 0.3) % 360}, ${85 + amp * 15}%, ${55 + amp * 25}%, ${0.9 + amp * 0.1})`;
      ctx.shadowBlur = 4;
      roundedRectPath(ctx, i * bw + gx, height - bh, bw - 1, bh, Math.min(bw * 0.25, bh * 0.15)); ctx.fill();
      ctx.shadowBlur = 0;
    }
    const coreR = 30 + bass * 60 * sensitivity;
    const cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
    cg.addColorStop(0, "#FFFFFF"); cg.addColorStop(0.3, palette.accent); cg.addColorStop(0.7, palette.primary); cg.addColorStop(1, "transparent");
    ctx.fillStyle = cg; ctx.shadowColor = palette.accent; ctx.shadowBlur = 30;
    ctx.beginPath(); ctx.arc(cx, cy, coreR, 0, Math.PI * 2); ctx.fill();
    for (let i = 0; i < 3; i++) {
      const rr = coreR + 20 + i * 15, rot = frame * (0.02 + i * 0.01);
      ctx.strokeStyle = applyAlpha(palette.accent, 0.4 - i * 0.1); ctx.lineWidth = 2; ctx.setLineDash([10, 10]);
      for (let j = 0; j < 8; j++) { ctx.beginPath(); ctx.arc(cx, cy, rr, (j / 8) * Math.PI * 2 + rot, ((j + 1) / 8) * Math.PI * 2 + rot); ctx.stroke(); }
    }
    ctx.setLineDash([]);
    ctx.restore();
  },
};

/* ───────── 移植：排斥力場 Repulsor Field（貓神 drawRepulsorField，邊界環＋能量線＋粒子＋核心） ───────── */

const repulsorParticles: { x: number; y: number; vx: number; vy: number; r: number; op: number; color: string }[] = [];

const repulsorField: VisualEffect = {
  id: "vis-repulsor",
  name: "排斥力場",
  draw(ctx, width, height, dataArray, { frame, sensitivity, palette, isBeat }) {
    if (!dataArray) return;
    ctx.save();
    const cx = width / 2, cy = height / 2;
    const fieldRadius = Math.min(width, height) * 0.35;
    const bass = dataArray.slice(0, 32).reduce((a, b) => a + b, 0) / 32 / 255;
    const pulseRadius = fieldRadius + bass * 20 * sensitivity;
    for (let i = 0; i < 3; i++) {
      ctx.strokeStyle = applyAlpha(palette.accent, 0.4 - i * 0.1); ctx.lineWidth = 3 - i * 0.5; ctx.setLineDash([8, 8]);
      ctx.beginPath(); ctx.arc(cx, cy, pulseRadius - i * 8, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.setLineDash([]);
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 + frame * 0.01, ll = fieldRadius * 0.3 + bass * 50 * sensitivity;
      ctx.strokeStyle = applyAlpha(palette.primary, 0.3); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * ll, cy + Math.sin(a) * ll); ctx.stroke();
    }
    if (repulsorParticles.length === 0) {
      const cols = [palette.primary, palette.secondary, palette.accent];
      for (let i = 0; i < 60; i++) {
        const a = Math.random() * Math.PI * 2, d = Math.random() * fieldRadius;
        repulsorParticles.push({ x: cx + Math.cos(a) * d, y: cy + Math.sin(a) * d, vx: (Math.random() - 0.5) * 2, vy: (Math.random() - 0.5) * 2, r: 1.5 + Math.random() * 2.5, op: 0.5 + Math.random() * 0.4, color: cols[i % 3] });
      }
    }
    const speed = 1 + bass * 3 * sensitivity;
    for (const p of repulsorParticles) {
      p.x += p.vx * speed; p.y += p.vy * speed;
      const a = Math.atan2(p.y - cy, p.x - cx), dist = Math.hypot(p.x - cx, p.y - cy);
      if (dist > fieldRadius) {
        p.x = cx + Math.cos(a) * fieldRadius; p.y = cy + Math.sin(a) * fieldRadius;
        const nx = Math.cos(a), ny = Math.sin(a), dot = p.vx * nx + p.vy * ny;
        p.vx = (p.vx - 2 * dot * nx) * 0.8; p.vy = (p.vy - 2 * dot * ny) * 0.8;
      }
      ctx.shadowColor = p.color; ctx.shadowBlur = 15;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fillStyle = applyAlpha(p.color, p.op * 0.9); ctx.fill();
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r * 1.5, 0, Math.PI * 2); ctx.fillStyle = applyAlpha(p.color, p.op * 0.3); ctx.fill();
    }
    const coreR = width * 0.02 + bass * 50 * sensitivity;
    const icg = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
    icg.addColorStop(0, "#FFFFFF"); icg.addColorStop(0.3, applyAlpha(palette.accent, 0.9)); icg.addColorStop(0.7, applyAlpha(palette.primary, 0.7)); icg.addColorStop(1, "transparent");
    ctx.fillStyle = icg; ctx.shadowColor = palette.primary; ctx.shadowBlur = isBeat ? 50 : 25;
    ctx.beginPath(); ctx.arc(cx, cy, coreR * 1.2, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = applyAlpha(palette.accent, 0.6); ctx.lineWidth = 4; ctx.shadowBlur = 20;
    ctx.beginPath(); ctx.arc(cx, cy, coreR * 2 + bass * 30 * sensitivity, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  },
};

/* ───────── 移植：音訊地貌 Audio Landscape（貓神 drawAudioLandscape，3D 網格地形） ───────── */

const audioLandscape: VisualEffect = {
  id: "vis-landscape",
  name: "音訊地貌",
  draw(ctx, width, height, dataArray, { frame, sensitivity, palette }) {
    if (!dataArray) return;
    ctx.save();
    const cx = width / 2, cy = height * 0.6, fov = width * 0.8;
    const gridSizeX = 40, gridSizeZ = 30, spacing = (width / gridSizeX) * 1.2, maxTerrain = height * 0.2;
    const angle = frame * 0.002;
    const startHue = hexToHue(palette.secondary), endHue = hexToHue(palette.accent);
    const project = (x3d: number, y3d: number, z3d: number) => {
      const rotX = x3d * Math.cos(angle) - z3d * Math.sin(angle), rotZ = x3d * Math.sin(angle) + z3d * Math.cos(angle);
      const scale = fov / (fov + rotZ);
      return { x: rotX * scale + cx, y: y3d * scale + cy, scale };
    };
    ctx.lineWidth = 1.5;
    for (let z = 0; z < gridSizeZ; z++) {
      ctx.beginPath();
      let first = false;
      for (let x = 0; x < gridSizeX; x++) {
        const th = Math.pow(dataArray[Math.floor((x / gridSizeX) * dataArray.length * 0.6)] / 255, 2) * maxTerrain * sensitivity;
        const p = project((x - gridSizeX / 2) * spacing, -th, (z - gridSizeZ / 2) * spacing);
        if (p.scale <= 0) continue;
        if (!first) { ctx.moveTo(p.x, p.y); first = true; } else ctx.lineTo(p.x, p.y);
      }
      if (first) {
        const zp = z / gridSizeZ, hue = startHue + zp * (endHue - startHue);
        const col = `hsla(${hue}, 90%, ${40 + zp * 30}%, ${1 - zp * 0.7})`;
        ctx.strokeStyle = col; ctx.shadowColor = col; ctx.shadowBlur = 5; ctx.stroke();
      }
    }
    ctx.restore();
  },
};

/* ───────── 移植：融合 Fusion（貓神 drawFusion，底部點柱＋鏡像波） ───────── */

const fusion: VisualEffect = {
  id: "vis-fusion",
  name: "融合",
  draw(ctx, width, height, dataArray, { frame, sensitivity, palette }) {
    if (!dataArray) return;
    ctx.save();
    const cy = height / 2, cx = width / 2;
    const startHue = hexToHue(palette.secondary), endHue = hexToHue(palette.accent), span = endHue - startHue;
    const numColumns = 128, csx = width / numColumns;
    for (let i = 0; i < numColumns; i++) {
      const di = Math.floor(i * (dataArray.length * 0.7 / numColumns));
      const ch = Math.pow(dataArray[di] / 255, 2) * height * 0.8 * sensitivity;
      if (ch < 1) continue;
      const color = `hsl(${startHue + (i / numColumns) * span}, 80%, 60%)`;
      ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 5;
      const x = i * csx + csx / 2, dsy = 8, numDots = Math.floor(ch / dsy);
      for (let j = 0; j < numDots; j++) {
        ctx.globalAlpha = 1 - Math.pow(j / numDots, 2);
        ctx.beginPath(); ctx.arc(x, height - j * dsy - dsy / 2, 1 + (dataArray[di] / 255) * 1.5, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.globalAlpha = 1; ctx.shadowBlur = 0;
    const numPoints = Math.floor(width / 2), dsl = dataArray.length * 0.35;
    const base: { x: number; y: number }[] = [];
    for (let i = 0; i <= numPoints / 2; i++) {
      const progress = i / (numPoints / 2);
      base.push({ x: cx - progress * cx, y: Math.pow(dataArray[Math.floor(progress * dsl)] / 255, 2) * 150 * sensitivity });
    }
    const right = base.slice(1).reverse().map((p) => ({ x: width - p.x, y: p.y }));
    const full = [...base, ...right];
    const solidMul = 0.6, dottedMul = 1.2;
    for (const top of [true, false]) {
      ctx.beginPath();
      const seq = top ? full : [...full].reverse();
      seq.forEach((p, i) => { const yOsc = Math.sin(p.x * 0.05 + frame * 0.02) * 5; const y = top ? cy + p.y * solidMul + yOsc : cy - p.y * solidMul + yOsc; if (i === 0) ctx.moveTo(p.x, y); else ctx.lineTo(p.x, y); });
      ctx.strokeStyle = palette.primary; ctx.lineWidth = 2.5; ctx.shadowColor = palette.primary; ctx.shadowBlur = 15; ctx.stroke();
    }
    ctx.fillStyle = palette.secondary; ctx.shadowColor = palette.secondary; ctx.shadowBlur = 10;
    for (const p of full) {
      const yOsc = Math.sin(p.x * 0.08 + frame * -0.03) * 8;
      ctx.beginPath(); ctx.arc(p.x, cy + p.y * dottedMul + yOsc, 1.5, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(p.x, cy - p.y * dottedMul + yOsc, 1.5, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  },
};

/* ───────── 移植：色差故障 Chromatic Aberration（貓神 drawChromaticAberration，RGB 分離位移；頻譜條當底） ───────── */

let chromaCanvas: HTMLCanvasElement | null = null;

const chromaticAberration: VisualEffect = {
  id: "vis-chromatic",
  name: "色差故障",
  draw(ctx, width, height, dataArray, f) {
    if (!dataArray) return;
    monstercat.draw(ctx, width, height, dataArray, f);
    const bassLen = Math.floor(dataArray.length * 0.1);
    let bass = 0; for (let i = 0; i < bassLen; i++) bass += dataArray[i]; bass = bass / bassLen / 255;
    const shift = (4 + Math.pow(bass, 1.5) * 60 * f.sensitivity) * (f.isBeat ? 1.8 : 1);
    if (!chromaCanvas || chromaCanvas.width !== width || chromaCanvas.height !== height) { chromaCanvas = document.createElement("canvas"); chromaCanvas.width = width; chromaCanvas.height = height; }
    const off = chromaCanvas.getContext("2d")!;
    off.clearRect(0, 0, width, height); off.drawImage(ctx.canvas, 0, 0);
    ctx.save();
    ctx.globalCompositeOperation = "screen"; ctx.globalAlpha = 0.45;
    ctx.drawImage(chromaCanvas, -shift, 0);
    ctx.drawImage(chromaCanvas, shift, 0);
    ctx.restore();
  },
};

/* ───────── 移植：點陣頻譜 Dot Bar Spectrum（貓神 drawDotBarSpectrum，鏡像點陣＋柱） ───────── */

const dotBarSpectrum: VisualEffect = {
  id: "vis-dotbar",
  name: "點陣頻譜",
  draw(ctx, width, height, dataArray, { sensitivity, palette }) {
    if (!dataArray) return;
    ctx.save();
    const cy = height / 2, numBars = 96, bw = width / numBars, maxH = height * 0.32;
    for (let i = 0; i < numBars; i++) {
      const amp = dataArray[Math.floor((i / numBars) * dataArray.length * 0.7)] / 255;
      const x = i * bw + bw / 2;
      if (amp < 0.04) { ctx.fillStyle = applyAlpha(palette.primary, 0.5); ctx.beginPath(); ctx.arc(x, cy, 1.6, 0, Math.PI * 2); ctx.fill(); continue; }
      const h = Math.pow(amp, 1.6) * maxH * sensitivity;
      ctx.fillStyle = palette.primary; ctx.shadowColor = palette.primary; ctx.shadowBlur = 10;
      ctx.fillRect(x - bw * 0.3, cy - h, bw * 0.6, h);
      ctx.fillRect(x - bw * 0.3, cy, bw * 0.6, h);
    }
    ctx.restore();
  },
};

/* ───────── 移植：鋼琴演奏家 Piano Virtuoso（貓神 drawPianoVirtuoso，琴鍵被音訊按下） ───────── */

const pianoVirtuoso: VisualEffect = {
  id: "vis-piano",
  name: "鋼琴",
  draw(ctx, width, height, dataArray, { sensitivity, palette }) {
    if (!dataArray) return;
    ctx.save();
    const kh = height * 0.25, numWhite = 28, wkw = width / numWhite, bkw = wkw * 0.6, bkh = kh * 0.6;
    for (let i = 0; i < numWhite; i++) {
      const x = i * wkw, pts = Math.floor(dataArray.length * 0.7 / numWhite);
      let press = 0; for (let j = i * pts; j < i * pts + pts; j++) press += dataArray[j] || 0; press /= pts * 255;
      const pressed = Math.pow(press, 2) * sensitivity > 0.1;
      ctx.fillStyle = pressed ? palette.accent : "#f8f9fa"; ctx.strokeStyle = "#dee2e6"; ctx.lineWidth = 1;
      ctx.fillRect(x, height - kh, wkw - 1, kh); ctx.strokeRect(x, height - kh, wkw - 1, kh);
      ctx.fillStyle = pressed ? "#ffffff" : "#6c757d"; ctx.font = "12px Arial"; ctx.textAlign = "center";
      ctx.fillText(String.fromCharCode(65 + (i % 7)), x + wkw / 2, height - 10);
    }
    const pattern = [1, 1, 0, 1, 1, 1, 0];
    for (let i = 0; i < numWhite - 1; i++) {
      if (pattern[i % 7] !== 1) continue;
      const x = (i + 1) * wkw - bkw / 2;
      const press = ((dataArray[Math.floor(i * dataArray.length * 0.7 / numWhite)] || 0) + (dataArray[Math.floor((i + 1) * dataArray.length * 0.7 / numWhite)] || 0)) / 2 / 255;
      const pressed = Math.pow(press, 2) * sensitivity > 0.15;
      ctx.fillStyle = pressed ? palette.secondary : "#343a40"; ctx.fillRect(x, height - kh, bkw, bkh);
      ctx.fillStyle = "rgba(255,255,255,0.2)"; ctx.fillRect(x, height - kh, bkw, 5);
    }
    ctx.restore();
  },
};

/* ───────── 移植：歐皇訂製版 Basic Wave（貓神 drawBasicWave，純白平滑波＋0.1s 衰減＋倒影） ───────── */

let basicWaveBuffer: number[] = [];
let basicWaveLastTime = 0;
const BASIC_DECAY = 0.1;

const basicWave: VisualEffect = {
  id: "vis-basic-wave",
  name: "歐皇版",
  draw(ctx, width, height, dataArray, { frame, sensitivity }) {
    if (!dataArray) return;
    ctx.save();
    const cx = width / 2, cy = height / 2, maxAmplitude = height * 0.15;
    const total = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
    const rhythm = Math.min(total / 120, 1);
    const numPoints = 400, waveWidth = width * 0.8, startX = cx - waveWidth / 2;
    if (basicWaveBuffer.length !== numPoints + 1) basicWaveBuffer = new Array(numPoints + 1).fill(0);
    const now = performance.now() / 1000, dt = now - basicWaveLastTime; basicWaveLastTime = now;
    const decay = Math.exp(-dt / BASIC_DECAY);
    const sr = 12;
    const pts: { x: number; y: number }[] = [], refl: { x: number; y: number }[] = [];
    for (let i = 0; i <= numPoints; i++) {
      const progress = i / numPoints, x = startX + progress * waveWidth, di = Math.floor(progress * dataArray.length);
      let sm = 0, n = 0;
      for (let j = -sr; j <= sr; j++) { sm += dataArray[Math.max(0, Math.min(dataArray.length - 1, di + j))]; n++; }
      const cur = Math.pow(sm / n / 255, 0.5) * maxAmplitude * sensitivity * rhythm * 3;
      basicWaveBuffer[i] = cur > basicWaveBuffer[i] ? cur : basicWaveBuffer[i] * decay;
      const amp = basicWaveBuffer[i], base = Math.sin(progress * Math.PI * 2 + frame * 0.01) * 2;
      pts.push({ x, y: cy - amp - base });
      refl.push({ x, y: cy + amp * 0.3 + base });
    }
    const stroke = (p: { x: number; y: number }[], alpha: number) => {
      ctx.beginPath(); ctx.moveTo(p[0].x, p[0].y);
      for (let i = 1; i < p.length - 1; i++) { const xc = (p[i].x + p[i + 1].x) / 2, yc = (p[i].y + p[i + 1].y) / 2; ctx.quadraticCurveTo(p[i].x, p[i].y, xc, yc); }
      ctx.strokeStyle = `rgba(255,255,255,${alpha})`; ctx.lineWidth = 2.5; ctx.shadowColor = "rgba(255,255,255,0.5)"; ctx.shadowBlur = 8; ctx.stroke();
    };
    stroke(pts, 0.95); stroke(refl, 0.25);
    ctx.restore();
  },
};

/* ───────── 移植：圓形波形 Circular Wave（貓神 drawCircularWave，中心圓圖＋四組 1/4 圓放射線） ───────── */

const circularWave: VisualEffect = {
  id: "vis-circular",
  name: "圓形波形",
  draw(ctx, width, height, dataArray, { sensitivity, palette, image }) {
    if (!dataArray) return;
    ctx.save();
    const cx = width / 2, cy = height / 2, R = Math.min(width, height) * 0.25;
    if (image) {
      try {
        const iw = (image as HTMLImageElement).naturalWidth || (image as HTMLVideoElement).videoWidth || 1;
        const ih = (image as HTMLImageElement).naturalHeight || (image as HTMLVideoElement).videoHeight || 1;
        ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip();
        const aspect = iw / ih, ds = R * 2;
        const dw = aspect >= 1 ? ds * aspect : ds, dh = aspect < 1 ? ds / aspect : ds;
        ctx.drawImage(image, cx - dw / 2, cy - dh / 2, dw, dh); ctx.restore();
      } catch { /* image not ready */ }
    }
    ctx.strokeStyle = palette.primary; ctx.lineWidth = 5; ctx.shadowColor = palette.accent; ctx.shadowBlur = 8;
    const rot = -30 * Math.PI / 180, numLines = 15, maxLen = R * 3, minLen = R * 0.02;
    const sample = (t: number) => { const s = Math.floor(0.05 * dataArray.length), e = Math.floor(0.35 * dataArray.length); return dataArray[s + Math.floor(t * (e - s - 1))] / 255; };
    const q1: number[] = [];
    for (let i = 0; i < numLines; i++) q1.push(Math.pow(Math.max(0, sample(i / (numLines - 1)) - 0.2), 1.2) * maxLen * sensitivity * 1.5);
    const quads: [number, number, number[]][] = [[-Math.PI / 2, 0, q1], [-Math.PI, -Math.PI / 2, q1], [Math.PI / 2, Math.PI, [...q1].reverse()], [0, Math.PI / 2, [...q1].reverse()]];
    for (const [sa, ea, lens] of quads) {
      for (let i = 0; i < numLines; i++) {
        const a = sa + (i / (numLines - 1)) * (ea - sa) + rot, ll = lens[i];
        const x1 = cx + Math.cos(a) * R, y1 = cy + Math.sin(a) * R;
        if (ll < minLen) { ctx.fillStyle = palette.primary; ctx.beginPath(); ctx.arc(x1, y1, 1.5, 0, Math.PI * 2); ctx.fill(); }
        else { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(cx + Math.cos(a) * (R + ll), cy + Math.sin(a) * (R + ll)); ctx.stroke(); }
      }
    }
    ctx.restore();
  },
};

/* ───────── 圖卡/文字型效果（貓神 batch E）：核心移植，用 VisualFrame.image + title。
   多圖/控制卡細節（第二張圖、控制卡樣式）依賴 M3/M4 圖文參數，標註待對原版校 1:1。 ───────── */

function drawTitle(ctx: CanvasRenderingContext2D, title: string | undefined, x: number, y: number, px: number, color: string) {
  if (!title) return;
  ctx.save(); ctx.font = `${px}px 'Bakudai-Medium'`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillStyle = color; ctx.shadowColor = "rgba(0,0,0,0.5)"; ctx.shadowBlur = px * 0.2; ctx.fillText(title, x, y); ctx.restore();
}

// 幾何橫條 / Z 總訂製款（drawGeometricBars）：中央方框（圖）＋震動邊框＋旋轉半圓＋橫條＋歌名
const geometricBars: VisualEffect = {
  id: "vis-geometric",
  name: "幾何橫條",
  draw(ctx, width, height, dataArray, { frame, sensitivity, palette, image, title }) {
    if (!dataArray) return;
    ctx.save();
    const cx = width / 2, cy = height * 0.4;
    const frameSize = Math.min(width * 0.4, height * 0.5), fx = cx - frameSize / 2, fy = cy - frameSize / 2;
    const bassV = (dataArray[0] / 255) * 8, midV = (dataArray[Math.floor(dataArray.length * 0.3)] / 255) * 8 * 0.7, highV = (dataArray[Math.floor(dataArray.length * 0.7)] / 255) * 8 * 0.5;
    if (image) { try { ctx.drawImage(image, fx, fy, frameSize, frameSize); } catch { /* not ready */ } }
    else { ctx.fillStyle = "rgba(0,0,0,0.3)"; ctx.fillRect(fx, fy, frameSize, frameSize); }
    ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 2; ctx.strokeRect(fx + highV, fy + highV, frameSize, frameSize);
    const scx = fx + frameSize, scR = frameSize / 2;
    ctx.save(); ctx.beginPath(); ctx.arc(scx, cy, scR, -Math.PI / 2, Math.PI / 2); ctx.clip();
    ctx.translate(scx, cy); ctx.rotate((frame * 0.01) % (Math.PI * 2));
    if (image) { try { ctx.drawImage(image, -scR, -scR, scR * 2, scR * 2); } catch { /* not ready */ } } else { ctx.fillStyle = "rgba(0,0,0,0.3)"; ctx.beginPath(); ctx.arc(0, 0, scR, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
    const numBars = 48, bw = width / numBars;
    ctx.fillStyle = palette.primary; ctx.shadowColor = palette.primary; ctx.shadowBlur = 6;
    for (let i = 0; i < numBars; i++) { const amp = dataArray[Math.floor((i / numBars) * dataArray.length)] / 255; const bh = Math.pow(amp, 1.5) * height * 0.18 * sensitivity; ctx.fillRect(i * bw, height * 0.82 - bh, bw - 2, bh); }
    drawTitle(ctx, title, cx, height * 0.9, Math.min(width, height) * 0.05, "#ffffff");
    void bassV; void midV;
    ctx.restore();
  },
};

// 唱片加控制卡（drawVinylRecord）：旋轉黑膠＋中心圖標籤＋橫條
const vinylRecord: VisualEffect = {
  id: "vis-vinyl",
  name: "黑膠唱片",
  draw(ctx, width, height, dataArray, { frame, sensitivity, palette, image, title }) {
    if (!dataArray) return;
    ctx.save();
    const cx = width * 0.32, cy = height / 2, R = Math.min(width, height) * 0.32;
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(frame * 0.02);
    ctx.fillStyle = "#0c0c0c"; ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.06)"; ctx.lineWidth = 1;
    for (let r = R * 0.4; r < R; r += 6) { ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke(); }
    const labelR = R * 0.36;
    ctx.save(); ctx.beginPath(); ctx.arc(0, 0, labelR, 0, Math.PI * 2); ctx.clip();
    if (image) { try { ctx.drawImage(image, -labelR, -labelR, labelR * 2, labelR * 2); } catch { /* not ready */ } } else { ctx.fillStyle = palette.secondary; ctx.beginPath(); ctx.arc(0, 0, labelR, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
    ctx.fillStyle = "#000"; ctx.beginPath(); ctx.arc(0, 0, 5, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    const numBars = 40, area = width * 0.5, bw = area / numBars, x0 = width * 0.46;
    ctx.fillStyle = palette.primary; ctx.shadowColor = palette.primary; ctx.shadowBlur = 8;
    for (let i = 0; i < numBars; i++) { const amp = dataArray[Math.floor((i / numBars) * dataArray.length * 0.7)] / 255; const bh = Math.pow(amp, 1.5) * height * 0.3 * sensitivity; ctx.fillRect(x0 + i * bw, cy - bh / 2, bw - 2, bh); }
    drawTitle(ctx, title, width * 0.7, height * 0.85, Math.min(width, height) * 0.05, palette.primary);
    ctx.restore();
  },
};

// 相片晃動（drawPhotoShake）：圖片沿不規則軌跡晃動＋橫條
const photoShake: VisualEffect = {
  id: "vis-photo-shake",
  name: "相片晃動",
  draw(ctx, width, height, dataArray, { frame, sensitivity, palette, image, isBeat }) {
    if (!dataArray) return;
    ctx.save();
    const bass = dataArray[0] / 255;
    const sx = Math.sin(frame * 0.4) * 12 * bass + (isBeat ? (Math.random() - 0.5) * 16 : 0);
    const sy = Math.cos(frame * 0.33) * 12 * bass;
    const iw = Math.min(width, height) * 0.5;
    if (image) { try { const ih = iw * ((image as HTMLImageElement).naturalHeight || 1) / ((image as HTMLImageElement).naturalWidth || 1); ctx.drawImage(image, width / 2 - iw / 2 + sx, height / 2 - ih / 2 + sy, iw, ih); } catch { /* not ready */ } }
    else { ctx.fillStyle = applyAlpha(palette.secondary, 0.5); ctx.fillRect(width / 2 - iw / 2 + sx, height / 2 - iw / 2 + sy, iw, iw); }
    const numBars = 64, bw = width / numBars;
    ctx.fillStyle = palette.accent;
    for (let i = 0; i < numBars; i++) { const amp = dataArray[Math.floor((i / numBars) * dataArray.length)] / 255; const bh = Math.pow(amp, 1.5) * height * 0.15 * sensitivity; ctx.fillRect(i * bw, height - bh, bw - 1, bh); }
    ctx.restore();
  },
};

// 方框像素化（drawFramePixelation）：像素化＋震動＋橫條
const framePixelation: VisualEffect = {
  id: "vis-frame-pixel",
  name: "方框像素化",
  draw(ctx, width, height, dataArray, { sensitivity, palette, isBeat }) {
    if (!dataArray) return;
    ctx.save();
    const total = dataArray.reduce((a, b) => a + b, 0) / dataArray.length / 255;
    const px = Math.max(6, Math.floor(8 + total * 24));
    const cols = Math.ceil(width / px), rows = Math.ceil(height / px);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const di = Math.floor(((r * cols + c) % dataArray.length));
        const v = dataArray[di] / 255;
        if (v < 0.12) continue;
        const sh = (isBeat ? (Math.random() - 0.5) * 4 : 0);
        ctx.fillStyle = applyAlpha(c % 3 === 0 ? palette.primary : c % 3 === 1 ? palette.secondary : palette.accent, 0.3 + v * 0.6 * sensitivity);
        ctx.fillRect(c * px + sh, r * px, px - 1, px - 1);
      }
    }
    ctx.restore();
  },
};

// 魚眼扭曲（drawFisheyeDistortion，原 WebGL）：頻譜條當底 + 桶型徑向縮放近似（2D）
const fisheyeDistortion: VisualEffect = {
  id: "vis-fisheye",
  name: "魚眼扭曲",
  draw(ctx, width, height, dataArray, f) {
    if (!dataArray) return;
    monstercat.draw(ctx, width, height, dataArray, f);
    const bassLen = Math.floor(dataArray.length * 0.1);
    let bass = 0; for (let i = 0; i < bassLen; i++) bass += dataArray[i]; bass = bass / bassLen / 255;
    const zoom = 1 + (0.04 + bass * 0.12) * (f.isBeat ? 1.5 : 1);
    try {
      const snap = ctx.getImageData(0, 0, width, height);
      const tmp = document.createElement("canvas"); tmp.width = width; tmp.height = height; tmp.getContext("2d")!.putImageData(snap, 0, 0);
      ctx.save(); ctx.globalAlpha = 0.6; ctx.translate(width / 2, height / 2); ctx.scale(zoom, zoom); ctx.translate(-width / 2, -height / 2);
      ctx.drawImage(tmp, 0, 0); ctx.restore();
    } catch { /* cross-origin */ }
  },
};

// 動態控制卡（drawDynamicControlCard）：模糊圖底＋控制卡＋橫條
const dynamicControlCard: VisualEffect = {
  id: "vis-dyn-card",
  name: "重低音卡",
  draw(ctx, width, height, dataArray, { sensitivity, palette, image, title }) {
    if (!dataArray) return;
    ctx.save();
    if (image) { try { ctx.save(); ctx.filter = "blur(24px)"; ctx.globalAlpha = 0.5; ctx.drawImage(image, 0, 0, width, height); ctx.restore(); } catch { /* not ready */ } }
    const cw = width * 0.6, ch = height * 0.28, cardX = (width - cw) / 2, cardY = height * 0.58;
    ctx.fillStyle = "rgba(20,16,15,0.7)"; roundedRectPath(ctx, cardX, cardY, cw, ch, 16); ctx.fill();
    const numBars = 48, bw = cw / numBars;
    ctx.fillStyle = palette.primary;
    for (let i = 0; i < numBars; i++) { const amp = dataArray[Math.floor((i / numBars) * dataArray.length)] / 255; const bh = Math.pow(amp, 1.6) * ch * 0.7 * sensitivity; ctx.fillRect(cardX + i * bw, cardY + ch - bh, bw - 2, bh); }
    drawTitle(ctx, title, width / 2, cardY + ch * 0.3, Math.min(width, height) * 0.045, "#fff");
    ctx.restore();
  },
};

// 可夜訂製版二號（drawKeYeCustomV2）：白色圓角框＋文字＋柱狀
const keYeCustomV2: VisualEffect = {
  id: "vis-keye-v2",
  name: "可夜卡二號",
  draw(ctx, width, height, dataArray, { sensitivity, palette, title }) {
    if (!dataArray) return;
    ctx.save();
    const cw = width * 0.7, ch = height * 0.4, cardX = (width - cw) / 2, cardY = (height - ch) / 2;
    ctx.fillStyle = "rgba(255,255,255,0.92)"; roundedRectPath(ctx, cardX, cardY, cw, ch, 24); ctx.fill();
    const numBars = 56, bw = cw / numBars, baseY = cardY + ch * 0.7;
    ctx.fillStyle = palette.secondary;
    for (let i = 0; i < numBars; i++) { const amp = dataArray[Math.floor((i / numBars) * dataArray.length)] / 255; const bh = Math.pow(amp, 1.5) * ch * 0.4 * sensitivity; ctx.fillRect(cardX + 20 + i * (bw - 0.4), baseY - bh, bw * 0.6, bh); }
    drawTitle(ctx, title, width / 2, cardY + ch * 0.25, Math.min(width, height) * 0.05, "#1a1a1a");
    ctx.restore();
  },
};

// 邊緣虛化（drawBlurredEdge）：金屬條分隔文字與音訊光柱
const blurredEdge: VisualEffect = {
  id: "vis-blurred-edge",
  name: "邊緣虛化",
  draw(ctx, width, height, dataArray, { sensitivity, palette, title }) {
    if (!dataArray) return;
    ctx.save();
    const barY = height * 0.5;
    const mg = ctx.createLinearGradient(0, barY - 4, 0, barY + 4);
    mg.addColorStop(0, "#888"); mg.addColorStop(0.5, "#fff"); mg.addColorStop(1, "#666");
    ctx.fillStyle = mg; ctx.fillRect(0, barY - 3, width, 6);
    const numBars = 80, bw = width / numBars;
    ctx.shadowColor = palette.accent; ctx.shadowBlur = 16;
    for (let i = 0; i < numBars; i++) {
      const amp = dataArray[Math.floor((i / numBars) * dataArray.length)] / 255;
      const bh = Math.pow(amp, 1.5) * height * 0.3 * sensitivity;
      const g = ctx.createLinearGradient(0, barY - bh, 0, barY); g.addColorStop(0, applyAlpha(palette.primary, 0)); g.addColorStop(1, palette.primary);
      ctx.fillStyle = g; ctx.fillRect(i * bw, barY - bh, bw - 1, bh);
    }
    ctx.shadowBlur = 0;
    drawTitle(ctx, title, width / 2, height * 0.78, Math.min(width, height) * 0.06, "#fff");
    ctx.restore();
  },
};

// 動態音樂展示卡（drawMusicShowcaseCard）：背景圖＋滑入卡＋專輯封面＋歌名＋橫條
const musicShowcaseCard: VisualEffect = {
  id: "vis-showcase",
  name: "音樂展示卡",
  draw(ctx, width, height, dataArray, { frame, sensitivity, palette, image, title }) {
    if (!dataArray) return;
    ctx.save();
    if (image) { try { ctx.globalAlpha = 0.35; ctx.drawImage(image, 0, 0, width, height); ctx.globalAlpha = 1; } catch { /* not ready */ } }
    const slide = Math.min(1, frame / 60);
    const cw = width * 0.66, ch = height * 0.3, cardX = (width - cw) / 2, cardY = height * 0.6 - (1 - slide) * 40;
    ctx.fillStyle = "rgba(15,12,11,0.82)"; roundedRectPath(ctx, cardX, cardY, cw, ch, 18); ctx.fill();
    const coverS = ch * 0.7, coverX = cardX + ch * 0.15, coverY = cardY + ch * 0.15;
    if (image) { try { ctx.drawImage(image, coverX, coverY, coverS, coverS); } catch { /* not ready */ } } else { ctx.fillStyle = palette.secondary; ctx.fillRect(coverX, coverY, coverS, coverS); }
    const numBars = 40, area = cw - coverS - ch * 0.4, bw = area / numBars, x0 = coverX + coverS + ch * 0.15;
    ctx.fillStyle = palette.primary;
    for (let i = 0; i < numBars; i++) { const amp = dataArray[Math.floor((i / numBars) * dataArray.length)] / 255; const bh = Math.pow(amp, 1.5) * ch * 0.45 * sensitivity; ctx.fillRect(x0 + i * bw, cardY + ch * 0.7 - bh, bw - 1, bh); }
    if (title) drawTitle(ctx, title, x0 + area / 2, cardY + ch * 0.3, ch * 0.16, "#fff");
    ctx.restore();
  },
};

export const VISUAL_EFFECTS: VisualEffect[] = [
  monstercat, monstercatV2, monstercatGlitch, radialBars, luminousWave, nebulaWave, basicWave, lyricPulseLine, dotBarSpectrum,
  techWave, waterRipple, stellarCore, particleGalaxy, liquidMetal, repulsorField, audioLandscape, fusion, pianoVirtuoso, circularWave,
  dataMosh, signalScramble, pixelSort, chromaticAberration, glitchWave, crtGlitch, fisheyeDistortion, framePixelation,
  geometricBars, vinylRecord, photoShake, dynamicControlCard, keYeCustomV2, blurredEdge, musicShowcaseCard,
];

// 效果分類（右欄縮圖牆分組用，沿用貓神原本的款別）
export const VISUAL_CATEGORIES: { name: string; ids: string[] }[] = [
  { name: "基礎", ids: ["vis-monstercat", "vis-monstercat-v2", "vis-nebula", "vis-luminous", "vis-radial", "vis-basic-wave", "vis-pulse-line", "vis-circular", "vis-water", "vis-dotbar"] },
  { name: "進階", ids: ["vis-monstercat-glitch", "vis-tech", "vis-stellar", "vis-repulsor", "vis-chromatic", "vis-fisheye"] },
  { name: "實驗", ids: ["vis-datamosh", "vis-vinyl", "vis-pixel-sort", "vis-signal", "vis-landscape", "vis-geometric"] },
  { name: "特殊", ids: ["vis-galaxy", "vis-liquid-metal", "vis-crt", "vis-glitch-wave", "vis-fusion", "vis-piano"] },
  { name: "控制卡", ids: ["vis-dyn-card", "vis-frame-pixel", "vis-photo-shake", "vis-blurred-edge", "vis-keye-v2", "vis-showcase"] },
];
