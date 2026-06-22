// 九墨離線渲染管線（WebCodecs）：
// 音訊預分析（離線 FFT 算整條能量曲線）→ 逐幀模擬渲染（虛擬時間、不依賴播放）
// → VideoEncoder H.264 + AudioEncoder AAC → mp4-muxer 串流寫入磁碟
// 比實時快、幀幀精準、可切走分頁（MessageChannel yield 不受背景節流）

import { Muxer as Mp4Muxer, StreamTarget as Mp4StreamTarget } from "mp4-muxer";
import { Muxer as WebMMuxer, StreamTarget as WebMStreamTarget } from "webm-muxer";
import { FluidCore } from "./fluid-core";
import { GpuVisuals, INK_GPU_IDS } from "./gpu-visuals";
import { BgFx } from "./bg-fx";
import { LyricScroller, type LyricLine, type LyricScrollStyle } from "./lyrics";
import type { AudioFrame } from "./audio";
import { EFFECTS, resetInkState, type InkEffect, type ParamValues } from "./effects";
import { PAPER_COLORS, autoPalette, hexToRgb, type Palette, type PaperMode } from "./palette";
import { BodyActor } from "./body-actor";
import { InkKoiActor } from "../inklab/ink-koi-actor";
import { drawMask } from "./overlay";
import {
  drawBackgroundLayer, drawOverlayLayers, drawLyricsLayers, drawPlayerLayer, drawAlphaLayer, getBackgroundImage, bgColorCss, type MediaCache,
} from "./layer-render";
import { isLayerActive, applyAutomations, type Composition, type EffectParams } from "./composition";

const GPU_FREQ_BINS = 2048; // = GpuVisuals 期望的頻譜貼圖寬度（fftSize 4096 的 binCount）

export type OfflineTrack = { buffer: AudioBuffer; lrc: LyricLine[]; title: string };

export type OfflineOptions = {
  tracks: OfflineTrack[];
  width: number;
  height: number;
  fps: number;
  gap: number; // 曲間轉場秒數（洗墨）
  effect: InkEffect;
  params: ParamValues;
  palette: Palette;
  paperMode: PaperMode;
  fonts: readonly string[];
  sealOn: boolean;
  lyricStyle?: LyricScrollStyle; // 直式卷軸歌詞字級/描邊（跟即時預覽對齊，沒給=原樣）
  composition: Composition; //  完整圖層樹：背景圖+濾鏡 / 音訊圖 / 疊加層 / 落款，跟即時預覽對齊
  mediaCache: MediaCache; //    已載入的背景圖 / Logo / 落款圖（dataURL）
  fileHandle: FileSystemFileHandle;
  plan: ExportPlan; // 容器/編碼器組合（pickExportPlan 挑好傳進來）
  body?: {
    source: HTMLCanvasElement;
    x: number; y: number; size: number; amount: number;
    wiggle: number; drift: boolean; pulse: boolean;
    koi?: boolean; // 墨錦鯉走 InkKoiActor（InkCreature 畫法），其餘走 BodyActor
    colors?: string[]; // 錦鯉配色（黑白橘黃紅可混搭）
  };
  onProgress: (done: number, total: number) => void;
  isCancelled: () => boolean;
  trim?: { start: number; end: number }; // 裁切範圍（秒）：只渲染這段；未給=整條時間軸
};

/* ---------- radix-2 FFT（1024 點、就地） ---------- */
function fft(re: Float32Array, im: Float32Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1, cwi = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cwr - im[i + k + len / 2] * cwi;
        const vi = re[i + k + len / 2] * cwi + im[i + k + len / 2] * cwr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const nwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr; cwr = nwr;
      }
    }
  }
}

const FFT_N = 1024;
const HANN = (() => {
  const w = new Float32Array(FFT_N);
  for (let i = 0; i < FFT_N; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FFT_N - 1)));
  return w;
})();

type Seg = { start: number; dur: number; track: OfflineTrack };

// 把 tSec 時刻的音訊視窗載入 re/im 並就地 FFT（能量分析與頻譜貼圖共用）。gap 期間回 null（re 清 0）。
// chan：0=左右混合(預設)、1=左聲道、2=右聲道（對齊即時版 getFreq 的聲道選擇）
function loadWindowFFT(segs: Seg[], tSec: number, re: Float32Array, im: Float32Array, chan = 0): Seg | null {
  const seg = segs.find((s) => tSec >= s.start && tSec < s.start + s.dur) || null;
  im.fill(0);
  if (!seg) { re.fill(0); return null; }
  const buf = seg.track.buffer, sr = buf.sampleRate;
  const ch0 = buf.getChannelData(0);
  const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : ch0;
  const center = Math.floor((tSec - seg.start) * sr);
  const startI = Math.max(0, center - FFT_N / 2);
  for (let i = 0; i < FFT_N; i++) {
    const idx = startI + i;
    const v = idx < buf.length ? (chan === 1 ? ch0[idx] : chan === 2 ? ch1[idx] : (ch0[idx] + ch1[idx]) * 0.5) : 0;
    re[i] = v * HANN[i];
  }
  fft(re, im);
  return seg;
}

// 從 tSec 的 FFT 生 GpuVisuals 要的 0..255 頻譜（2048 bins、跨幀平滑），給音訊圖層用。
// 對應即時版 AnalyserNode（fftSize 4096 → bin j≈頻率 j·sr/4096；本機 FFT 1024 點 → bin b=j/4）。
function fillFreqBytes(
  segs: Seg[], tSec: number, re: Float32Array, im: Float32Array, smooth: Float32Array, out: Uint8Array, k = 0.6, chan = 0,
) {
  const seg = loadWindowFFT(segs, tSec, re, im, chan);
  const kk = Math.max(0, Math.min(0.95, k)); // 平滑係數（0=即時、→1 越平滑）；對齊 AnalyserNode.smoothingTimeConstant
  for (let j = 0; j < GPU_FREQ_BINS; j++) {
    let v = 0;
    if (seg) {
      const b = j >> 2; // 0..511（FFT 正頻段）
      const mag = Math.sqrt(re[b] * re[b] + im[b] * im[b]) / FFT_N;
      const db = 20 * Math.log10(mag + 1e-12);
      v = Math.min(1, Math.max(0, (db + 66) / 46)); // 噪音地板 -66、上限 -20（對齊 studio 預設）
    }
    smooth[j] = smooth[j] * kk + v * (1 - kk);
    out[j] = Math.round(smooth[j] * 255);
  }
}

// 預分析：對整條時間軸（含 gap）每幀產生 AudioFrame，複製即時版 AnalyserNode 行為
function precomputeAudio(segs: Seg[], totalFrames: number, fps: number, density: number, sens: number, startSec: number): AudioFrame[] {
  const frames: AudioFrame[] = new Array(totalFrames);
  const silent: AudioFrame = { bass: 0, mid: 0, treble: 0, beat: false, bassSpike: false, trebleSpike: false };
  let bassEMA = 0, trebleEMA = 0, lastBeat = -1e9, lastBassSpike = -1e9, lastTrebleSpike = -1e9;
  let sBass = 0, sMid = 0, sTreble = 0; // smoothing（模擬 analyser smoothingTimeConstant 0.7）

  const re = new Float32Array(FFT_N);
  const im = new Float32Array(FFT_N);

  for (let f = 0; f < totalFrames; f++) {
    const tSec = startSec + f / fps; // 裁切時偏移到真實時間軸位置
    const nowMs = tSec * 1000;
    const seg = loadWindowFFT(segs, tSec, re, im); // 載入視窗 + FFT（gap 回 null）
    if (!seg) { frames[f] = silent; sBass *= 0.7; sMid *= 0.7; sTreble *= 0.7; continue; }

    // 頻段聚合（同即時版 bin 範圍）+ dB→0..1（AnalyserNode minDb -100 / maxDb -30）
    const binVal = (k: number) => {
      const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]) / FFT_N;
      const db = 20 * Math.log10(mag + 1e-12);
      return Math.min(1, Math.max(0, (db + 100) / 70));
    };
    let bass = 0; for (let k = 1; k <= 7; k++) bass += binVal(k); bass /= 7;
    let mid = 0; for (let k = 8; k <= 64; k++) mid += binVal(k); mid /= 57;
    let treble = 0; for (let k = 65; k <= 200; k++) treble += binVal(k); treble /= 136;
    sBass = sBass * 0.7 + bass * 0.3;
    sMid = sMid * 0.7 + mid * 0.3;
    sTreble = sTreble * 0.7 + treble * 0.3;
    bass = sBass; mid = sMid; treble = sTreble;

    bassEMA += (bass - bassEMA) * 0.05;
    trebleEMA += (treble - trebleEMA) * 0.05;
    let beat = false, bassSpike = false, trebleSpike = false;
    if (bass > Math.max(bassEMA * (1 + 0.8 / sens), 0.5 / sens) && nowMs - lastBassSpike > 900 / density) {
      lastBassSpike = nowMs; lastBeat = nowMs; bassSpike = true;
    } else if (treble > Math.max(trebleEMA * (1 + 0.7 / sens), 0.32 / sens) && nowMs - lastTrebleSpike > 700 / density) {
      lastTrebleSpike = nowMs; trebleSpike = true;
    } else if (bass > bassEMA * (1 + 0.28 / sens) + 0.02 / sens && bass > 0.16 / sens && nowMs - lastBeat > 380 / density) {
      lastBeat = nowMs; beat = true;
    }
    frames[f] = { bass, mid, treble, beat, bassSpike, trebleSpike };
  }
  return frames;
}

// 整條歌單混成單一 48k 立體聲 buffer（含 gap 靜音）
async function mixdown(segs: Seg[], totalDur: number): Promise<AudioBuffer> {
  const sr = 48000;
  const oc = new OfflineAudioContext(2, Math.ceil(totalDur * sr), sr);
  for (const seg of segs) {
    const src = oc.createBufferSource();
    src.buffer = seg.track.buffer;
    src.connect(oc.destination);
    src.start(seg.start);
  }
  return oc.startRendering();
}

// 離線影片：建立元素 + 載入 metadata（給逐幀 seek 用）。瀏覽器解不了/逾時回 null。
function prepOfflineVideo(src: string): Promise<HTMLVideoElement | null> {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.muted = true; v.preload = "auto"; v.playsInline = true;
    let done = false;
    const ok = () => { if (done) return; done = true; resolve(v.duration ? v : null); };
    v.addEventListener("loadeddata", ok, { once: true });
    v.addEventListener("error", () => { if (done) return; done = true; resolve(null); }, { once: true });
    v.src = src;
    setTimeout(() => { if (done) return; done = true; resolve(v.readyState >= 2 && v.duration ? v : null); }, 5000);
  });
}
// 把離線影片 seek 到時間 vt 並等該幀解碼完成（逾時保險、不卡死）。
function seekOfflineVideo(v: HTMLVideoElement, vt: number): Promise<void> {
  return new Promise((resolve) => {
    if (Math.abs(v.currentTime - vt) < 1e-3) { resolve(); return; }
    let done = false;
    const fin = () => { if (done) return; done = true; v.removeEventListener("seeked", fin); resolve(); };
    v.addEventListener("seeked", fin);
    try { v.currentTime = vt; } catch { fin(); return; }
    setTimeout(fin, 300);
  });
}

// MessageChannel yield：不受背景分頁 timer 節流、切走分頁照跑
const mc = typeof MessageChannel !== "undefined" ? new MessageChannel() : null;
function yieldMC(): Promise<void> {
  return new Promise((r) => {
    if (!mc) { setTimeout(r, 0); return; }
    mc.port1.onmessage = () => r();
    mc.port2.postMessage(0);
  });
}
function waitDequeue(enc: VideoEncoder | AudioEncoder): Promise<void> {
  return new Promise((r) => {
    enc.ondequeue = () => { enc.ondequeue = null; r(); };
  });
}

export function supportsOfflineRender(): boolean {
  return typeof VideoEncoder !== "undefined" && typeof AudioEncoder !== "undefined" && "showSaveFilePicker" in window;
}

// 依解析度×fps 選 H.264 level（High Profile）：1080p30 撐 Level 4.0 即可，
// 但 1080p60 會超過 4.0 上限 → 改 4.2，更高再往上。avc1.6400xx 的 xx＝level 十六進位。
function avcCodec(width: number, height: number, fps: number): string {
  const load = width * height * fps;
  let level: number;
  if (load <= 1920 * 1080 * 30) level = 0x28; // 4.0
  else if (load <= 1920 * 1080 * 60) level = 0x2a; // 4.2
  else if (load <= 4096 * 2160 * 30) level = 0x33; // 5.1
  else level = 0x34; // 5.2
  return "avc1.6400" + level.toString(16).padStart(2, "0");
}

// VP9 level 跟著解析度×fps 走（webm 後備用）。vp09.PP.LL.BB：PP=profile0、LL=level×10、BB=8bit。
function vp9Codec(width: number, height: number, fps: number): string {
  const load = width * height * fps;
  let lv: string;
  if (load <= 1280 * 720 * 30) lv = "31"; // 3.1
  else if (load <= 1920 * 1080 * 30) lv = "40"; // 4.0
  else if (load <= 1920 * 1080 * 60) lv = "41"; // 4.1
  else lv = "60"; // 6.0
  return `vp09.00.${lv}.08`;
}

// 匯出格式組合（容器 + 編碼器）。WebCodecs codec 給 encoder，mux* 給 muxer。
export type ExportPlan = {
  container: "mp4" | "webm";
  ext: string; mime: string; label: string;
  videoCodec: string; audioCodec: string; // WebCodecs VideoEncoder/AudioEncoder codec
  muxVideo: string; muxAudio: string; //     muxer track codec id
};

// 挑「這個瀏覽器真的能編」的組合：優先 H.264+AAC(mp4，播放最相容)，缺就退 VP9+Opus(webm)、再退 VP8+Opus。
// 不再寫死綁瀏覽器 → Brave / Linux Chromium 等缺專利編碼器的也能出（webm）。全沒有才回 null（極罕見）。
export async function pickExportPlan(width: number, height: number, fps: number): Promise<ExportPlan | null> {
  const vOk = async (codec: string) => {
    try { return (await VideoEncoder.isConfigSupported({ codec, width, height, bitrate: height >= 1080 ? 10_000_000 : 6_000_000, framerate: fps })).supported === true; } catch { return false; }
  };
  const aOk = async (codec: string) => {
    try { return (await AudioEncoder.isConfigSupported({ codec, numberOfChannels: 2, sampleRate: 48000, bitrate: codec === "opus" ? 160_000 : 192_000 })).supported === true; } catch { return false; }
  };
  const avc = avcCodec(width, height, fps);
  if ((await vOk(avc)) && (await aOk("mp4a.40.2")))
    return { container: "mp4", ext: ".mp4", mime: "video/mp4", label: "MP4", videoCodec: avc, audioCodec: "mp4a.40.2", muxVideo: "avc", muxAudio: "aac" };
  if (await aOk("opus")) {
    const vp9 = vp9Codec(width, height, fps);
    if (await vOk(vp9))
      return { container: "webm", ext: ".webm", mime: "video/webm", label: "WebM", videoCodec: vp9, audioCodec: "opus", muxVideo: "V_VP9", muxAudio: "A_OPUS" };
    if (await vOk("vp8"))
      return { container: "webm", ext: ".webm", mime: "video/webm", label: "WebM", videoCodec: "vp8", audioCodec: "opus", muxVideo: "V_VP8", muxAudio: "A_OPUS" };
  }
  return null;
}

export async function renderOffline(opts: OfflineOptions): Promise<{ chapters: string }> {
  const { tracks, width, height, fps, gap } = opts;

  // 1. 時間軸
  let t = 0;
  const segs: Seg[] = tracks.map((tr) => {
    const s = { start: t, dur: tr.buffer.duration, track: tr };
    t += tr.buffer.duration + gap;
    return s;
  });
  const totalDur = t - gap;
  // 裁切範圍：只渲染 [clipStart, clipEnd]。tSec 用真實時間軸位置(偏移 clipStart)做分析/段落查找；
  // 輸出 timestamp(影片/音訊)則 0-based(從 0 起)才對齊。未給 trim → 整條。
  const clip = opts.trim && opts.trim.end - opts.trim.start > 0.1 ? opts.trim : null;
  const clipStart = clip ? Math.max(0, Math.min(clip.start, totalDur)) : 0;
  const clipEnd = clip ? Math.max(clipStart + 0.1, Math.min(clip.end, totalDur)) : totalDur;
  const renderDur = clipEnd - clipStart;
  const totalFrames = Math.ceil(renderDur * fps);
  const chapters = segs.map((s) => {
    const m = Math.floor(s.start / 60), ss = Math.floor(s.start % 60), h = Math.floor(s.start / 3600);
    const tm = h > 0 ? `${h}:${String(m % 60).padStart(2, "0")}:${String(ss).padStart(2, "0")}` : `${m}:${String(ss).padStart(2, "0")}`;
    return `${tm} ${s.track.title}`;
  }).join("\n");

  // 2. 串流寫檔（容器依 plan：mp4(avc/aac) 或 webm(vp9|vp8/opus)）
  const plan = opts.plan;
  const writable = await opts.fileHandle.createWritable();
  let chain: Promise<unknown> = Promise.resolve();
  const onData = (data: Uint8Array, position: number) => {
    const copy = data.slice();
    chain = chain.then(() => writable.write({ type: "write", position, data: copy }));
  };
  // 兩個 muxer 方法簽名一致 → 用結構型別共用後面所有 addVideoChunk/addAudioChunk/finalize 呼叫
  type AnyMuxer = {
    addVideoChunk: (c: EncodedVideoChunk, m?: EncodedVideoChunkMetadata) => void;
    addAudioChunk: (c: EncodedAudioChunk, m?: EncodedAudioChunkMetadata) => void;
    finalize: () => void;
  };
  const muxer: AnyMuxer = plan.container === "webm"
    ? new WebMMuxer({
        target: new WebMStreamTarget({ onData }),
        video: { codec: plan.muxVideo, width, height, frameRate: fps },
        audio: { codec: plan.muxAudio, numberOfChannels: 2, sampleRate: 48000 },
        firstTimestampBehavior: "offset",
      })
    : new Mp4Muxer({
        target: new Mp4StreamTarget({ onData }),
        video: { codec: "avc", width, height },
        audio: { codec: "aac", numberOfChannels: 2, sampleRate: 48000 },
        // moov 索引寫在檔案開頭（QuickTime 才開得了；fastStart:false 的 moov 在尾端，QuickTime 會說「不相容」）。
        // in-memory 會把整支先暫存在 RAM、finalize 時一次寫出。
        fastStart: "in-memory",
        firstTimestampBehavior: "offset",
      });

  let encErr: Error | null = null;
  const venc = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { encErr = e as Error; },
  });
  venc.configure({
    codec: plan.videoCodec, // H.264 level 或 VP9 level 都已依解析度×fps 算好
    width, height,
    bitrate: height >= 1080 ? 10_000_000 : 6_000_000,
    framerate: fps,
  });
  const aenc = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    error: (e) => { encErr = e as Error; },
  });
  aenc.configure({ codec: plan.audioCodec, numberOfChannels: 2, sampleRate: 48000, bitrate: plan.audioCodec === "opus" ? 160_000 : 192_000 });

  // 3. 音訊：mixdown → AAC/Opus（分批餵、控佇列）
  const full = await mixdown(segs, totalDur);
  const ch0 = full.getChannelData(0);
  const ch1 = full.getChannelData(1);
  const CHUNK = 1024;
  const aStart = Math.floor(clipStart * 48000);                 // 裁切：音訊只取 [clipStart, clipEnd]
  const aEnd = Math.min(full.length, Math.ceil(clipEnd * 48000));
  for (let off = aStart; off < aEnd; off += CHUNK) {
    if (opts.isCancelled()) break;
    const n = Math.min(CHUNK, aEnd - off);
    const data = new Float32Array(n * 2);
    data.set(ch0.subarray(off, off + n), 0);
    data.set(ch1.subarray(off, off + n), n);
    const ad = new AudioData({
      format: "f32-planar", sampleRate: 48000, numberOfFrames: n,
      numberOfChannels: 2, timestamp: Math.round(((off - aStart) / 48000) * 1e6), data, // 0-based 對齊影片
    });
    aenc.encode(ad);
    ad.close();
    if (aenc.encodeQueueSize > 60) await waitDequeue(aenc);
    if (off % (CHUNK * 512) === 0) await yieldMC();
  }

  // 4. 墨韻流體驅動來源 = composition 的「第一個墨韻層（gpuId==null）」，跟即時預覽一致。
  //    （原本誤用 opts.effect/params/palette＝studio 當前選取層 → 同時開墨暈+GPU 層、選到 GPU 層時墨流跑不出來）
  const compEffectLayers = opts.composition.filter((l) => l.type === "effect");
  const a0 = (compEffectLayers[0]?.params as EffectParams | undefined)?.values; // 音訊分析共用第一層的 density/sens
  const inkParams0 = compEffectLayers.find((l) => (l.params as EffectParams).gpuId == null)?.params as EffectParams | undefined;
  const inkEffect: InkEffect = inkParams0 ? (EFFECTS.find((e) => e.id === inkParams0.effectId) || opts.effect) : opts.effect;
  const inkValues: ParamValues = inkParams0?.values ?? opts.params;
  const inkPalette = inkParams0?.palette ?? opts.palette;

  // 5. 音訊預分析
  const density = (a0?.density as number) || (opts.params.density as number) || 1;
  const sens = (a0?.sens as number) || (opts.params.sens as number) || 1;
  const speed = (inkValues.speed as number) || 1;
  const af = precomputeAudio(segs, totalFrames, fps, density, sens, clipStart);

  // 5. 逐幀渲染
  resetInkState(); // 清掉預覽留下的冷卻時間戳（否則墨暈整段噴不出來，因離線 now 從 0 起算）
  const glCanvas = document.createElement("canvas");
  glCanvas.width = width; glCanvas.height = height;
  const core = new FluidCore(glCanvas);
  if (!core.ok) throw new Error("WebGL2 不可用");
  core.paperMode = opts.paperMode;
  const actor = opts.body
    ? (opts.body.koi
        ? new InkKoiActor(opts.body.source, opts.body.x, opts.body.y)
        : new BodyActor(opts.body.source, opts.body.x, opts.body.y))
    : null;
  if (actor) actor.setTint(inkPalette.primary);
  if (actor instanceof InkKoiActor && opts.body?.colors) actor.setColors(opts.body.colors); // 錦鯉配色
  const stage = document.createElement("canvas");
  stage.width = width; stage.height = height;
  const ctx2d = stage.getContext("2d")!;
  const scroller = new LyricScroller();
  const dark = opts.paperMode === "night";
  const dt = (1 / fps) * speed;
  const envK = 60 / fps; // 包絡衰減/上升以 60fps 為基準換算（與即時預覽同一套時間基準 → 任何匯出 fps 都一致）
  let segIdx = -1;

  // 完整圖層樹渲染：背景濾鏡引擎 + 音訊圖引擎（按需建立）+ 頻譜/包絡緩衝
  const comp = opts.composition;
  const cache = opts.mediaCache;
  const effectLayers = comp.filter((l) => l.type === "effect");
  const hasGpuLayers = effectLayers.some((l) => (l.params as EffectParams).gpuId != null);
  const bgHasFilters = comp.some((l) => l.type === "background" && ((l.params.filters as unknown[])?.length ?? 0) > 0);
  const bgCanvas = document.createElement("canvas"); bgCanvas.width = width; bgCanvas.height = height;
  const bgFx = bgHasFilters ? new BgFx(bgCanvas) : null;
  const gpuCanvas = document.createElement("canvas"); gpuCanvas.width = width; gpuCanvas.height = height;
  const gpu = hasGpuLayers ? new GpuVisuals(gpuCanvas) : null;
  const fre = new Float32Array(FFT_N), fim = new Float32Array(FFT_N);
  const freqSmooth = new Float32Array(GPU_FREQ_BINS);
  const freqBytes = new Uint8Array(GPU_FREQ_BINS);
  const freqSmoothR = new Float32Array(GPU_FREQ_BINS); // 右聲道（左右分離用）
  const freqBytesR = new Uint8Array(GPU_FREQ_BINS);
  let beatEnv = 0, bassEnv = 0, trebEnv = 0;
  let lastBeatT = -10; // 上個重音時間(秒)；算 beatPhase（重音漣漪），與即時預覽一致
  const paper = PAPER_COLORS[opts.paperMode];
  const paperCss = `rgb(${Math.round(paper[0] * 255)},${Math.round(paper[1] * 255)},${Math.round(paper[2] * 255)})`;

  // 影片層：建立離線解碼用元素（逐幀 seek 把影片烤進輸出）。預載 metadata；解不了的略過。
  const offlineVideos = new Map<string, HTMLVideoElement>();
  for (const l of comp) {
    if (l.type !== "video" || !l.params.src) continue;
    const v = await prepOfflineVideo(l.params.src);
    if (v) offlineVideos.set(l.id, v);
  }

  for (let i = 0; i < totalFrames; i++) {
    if (opts.isCancelled() || encErr) break;
    const tSec = clipStart + i / fps; // 真實時間軸位置（段落查找/分析/歌詞）；輸出 timestamp 另用 0-based i/fps
    const nowMs = tSec * 1000;
    const si = segs.findIndex((s) => tSec >= s.start && tSec < s.start + s.dur);
    if (si >= 0 && si !== segIdx) {
      segIdx = si;
      scroller.setLines(segs[si].track.lrc);
    }
    const inGap = si < 0;
    const localT = si >= 0 ? tSec - segs[si].start : 0; // 該層 timing 用「曲內秒數」（跟即時版一致）
    const localDur = si >= 0 ? segs[si].dur : 0;
    const lyricChanged = si >= 0 ? scroller.sync(localT, nowMs) : false;

    // 頻段包絡（給音訊圖與「音訊驅動」共用，須在 applyAutomations 前算好）
    const A = af[i];
    const isBeat = A.beat || A.bassSpike || A.trebleSpike;
    beatEnv = Math.max(beatEnv * Math.pow(0.9, envK), isBeat ? 1 : 0);
    if (isBeat) lastBeatT = tSec;
    const beatPhase = Math.min((tSec - lastBeatT) / 0.32, 9); // 0=剛下→1=傳遞完成→淡出（同即時預覽）
    bassEnv = A.bass > bassEnv ? bassEnv + (A.bass - bassEnv) * (1 - Math.pow(0.5, envK)) : bassEnv * Math.pow(0.85, envK);
    trebEnv = A.treble > trebEnv ? trebEnv + (A.treble - trebEnv) * (1 - Math.pow(0.5, envK)) : trebEnv * Math.pow(0.85, envK);
    const audioSample = { bass: bassEnv, mid: A.mid, treble: trebEnv, beat: beatEnv, level: (bassEnv + A.mid + trebEnv) / 3 };

    // 關鍵影格 + 音訊驅動：每幀把 automation/audioBinding 套進 comp（跟即時版一致），下游渲染都吃這份。
    const fcomp = applyAutomations(opts.composition, localT, audioSample);
    const fEffectLayers = fcomp.filter((l) => l.type === "effect");

    // ── 墨韻流體（從解算後 comp 的墨韻層取 effect/參數/墨色 → 與即時預覽一致、支援關鍵影格）
    const fInk = fEffectLayers.find((l) => (l.params as EffectParams).gpuId == null && isLayerActive(l, localT, localDur));
    const inkOn = !!fInk;
    const fInkP = fInk ? (fInk.params as EffectParams) : undefined;
    const curInkEffect = fInkP ? (EFFECTS.find((e) => e.id === fInkP.effectId) || inkEffect) : inkEffect;
    const curInkValues = fInkP?.values ?? inkValues;
    // 自動變色：用 tSec 循環跑色（與即時預覽同秒同色）
    const curInkPalette = fInkP?.autoColor ? autoPalette(tSec) : (fInkP?.palette ?? inkPalette);
    const sp = curInkEffect.update({
      core, audio: af[i], palette: curInkPalette, paperMode: opts.paperMode,
      params: curInkValues, dt, now: nowMs, lyricChanged,
    });
    if (inGap) sp.dyeDissipation = 4.5;
    if (actor && opts.body && inkOn) {
      if (fInkP?.autoColor) actor.setTint(curInkPalette.primary);
      actor.update(dt, af[i], opts.body);
      actor.emitInk(core, curInkPalette, opts.paperMode, opts.body, dt, width, height);
    }
    // 背景參數：自訂色 + 背景圖不透明度；自訂色當墨流紙色（僅無圖時，有圖維持 identity）
    const bgLayer = fcomp.find((l) => l.type === "background");
    const bgP = bgLayer && bgLayer.type === "background" ? bgLayer.params : null;
    const bgFilters = bgP?.filters ?? [];
    const bgImg = bgP?.imageUrl ? getBackgroundImage(fcomp, cache, localT, localDur) : null;
    core.paperColorOverride = bgP?.customColor && !bgImg ? hexToRgb(bgP.customColor) : null;
    core.step(dt, sp);
    core.render();

    // ── 背景：圖+濾鏡走 BgFx；否則直接鋪（背景圖 cover 或背景色）
    let hasBg: boolean;
    if (bgImg && bgFilters.length > 0 && bgFx?.ok && bgP) {
      ctx2d.fillStyle = bgColorCss(bgP); ctx2d.fillRect(0, 0, width, height);
      bgFx.resize(width, height);
      bgFx.setSource(bgImg, width, height);
      bgFx.render(bgFilters.map((f) => ({ fx: f.fx, amount: f.amount, density: f.density, speed: f.speed, angle: f.angle, posX: f.posX, posY: f.posY, scale: f.scale, colorA: f.colorA, colorB: f.colorB })), tSec, audioSample.level, beatEnv);
      ctx2d.save(); ctx2d.globalAlpha = bgP.imageOpacity ?? 1; ctx2d.drawImage(bgCanvas, 0, 0, width, height); ctx2d.restore();
      hasBg = true;
    } else {
      hasBg = drawBackgroundLayer(ctx2d, fcomp, cache, localT, localDur, width, height);
    }

    // ── 合成墨流（有背景時混合模式疊；無 ink 又無背景時鋪背景色給音訊圖墊背）
    if (inkOn) {
      if (hasBg) { ctx2d.save(); ctx2d.globalCompositeOperation = dark ? "lighter" : "multiply"; ctx2d.drawImage(glCanvas, 0, 0, width, height); ctx2d.restore(); }
      else ctx2d.drawImage(glCanvas, 0, 0, width, height);
    } else if (!hasBg) {
      ctx2d.fillStyle = bgP ? bgColorCss(bgP) : paperCss; ctx2d.fillRect(0, 0, width, height);
    }
    if (actor && opts.body && inkOn) actor.draw(ctx2d, width, height, opts.body);

    // ── 依 z 序交錯畫「控制板」與「GPU 音訊圖」：控制板下方特效當背景被模糊/折射、上方特效保持清晰 ──
    const gpuReady = !!(gpu && gpu.ok && hasGpuLayers);
    const specL = fcomp.find((l) => l.type === "effect" && (l.params as EffectParams).gpuId === "gv-spectrum");
    const smoothK = specL ? ((specL.params as EffectParams).values.smoothing as number) ?? 0.6 : 0.6;
    const chanVal = specL ? ((specL.params as EffectParams).values.channel as number) ?? 0 : 0; // 0 混合/1 左/2 右/3 分離
    if (gpuReady) {
      fillFreqBytes(segs, tSec, fre, fim, freqSmooth, freqBytes, smoothK, chanVal === 2 ? 2 : chanVal === 1 || chanVal === 3 ? 1 : 0);
      if (chanVal === 3) fillFreqBytes(segs, tSec, fre, fim, freqSmoothR, freqBytesR, smoothK, 2); // 右聲道
    }
    {
      for (const l of fcomp) {
        if (l.type === "player") { drawPlayerLayer(ctx2d, l, fcomp, cache, localT, localDur, width, height); continue; }
        if (l.type === "alpha") { drawAlphaLayer(ctx2d, l, localT, localDur, beatEnv, tSec, width, height); continue; }
        if (l.type !== "effect" || !gpu || !gpu.ok || !hasGpuLayers) continue;
        const ep = l.params as EffectParams;
        if (ep.gpuId == null || !isLayerActive(l, localT, localDur)) continue;
        const tf = l.transform;
        const lw = (tf?.w ?? 1) * width, lh = (tf?.h ?? 1) * height;
        const lx = (tf?.x ?? 0.5) * width - lw / 2, ly = (tf?.y ?? 0.5) * height - lh / 2;
        gpu.resize(Math.max(2, Math.round(lw)), Math.max(2, Math.round(lh)));
        const isInk = INK_GPU_IDS.has(ep.gpuId);
        const inkPaper = isInk && hasBg && opts.paperMode !== "night";
        gpu.render(ep.gpuId, freqBytes, {
          time: tSec, sens: (ep.values.sens as number) ?? 1, beat: beatEnv, palette: ep.autoColor ? autoPalette(tSec) : ep.palette,
          bass: bassEnv, mid: A.mid, treble: trebEnv,
          bloom: (ep.values.bloom as number) ?? 1.35, gain: (ep.values.gain as number) ?? 1,
          feather: (lw < width * 0.985 || lh < height * 0.985) ? 1 : 0,
          width: (ep.values.width as number) ?? 1, spacing: (ep.values.spacing as number) ?? 1,
          balance: (ep.values.balance as number) ?? 0,
          beatPhase,
          paper: inkPaper,
          shape: (ep.values.shape as number) ?? 1,
          mirrorV: (ep.values.mirrorV as boolean) ?? false,
          mirrorH: (ep.values.mirrorH as boolean) ?? false,
          cap: (ep.values.cap as number) ?? 0.55,
          freqR: chanVal === 3 ? freqBytesR : null, stereo: chanVal === 3,
          radial: (ep.values.radial as boolean) ?? false,
          spin: (ep.values.spin as number) ?? 0,
          reflex: (ep.values.reflex as number) ?? 0,
          outline: (ep.values.outline as boolean) ?? false,
          peakOn: (ep.values.peakOn as boolean) ?? false,
          scale: (ep.values.scale as number) ?? 0,
          weight: (ep.values.weight as number) ?? 0,
          progress: totalFrames > 1 ? i / (totalFrames - 1) : 1, // 白框計時器：輸出 0→1
        });
        const rot = ((tf?.rot ?? 0) * Math.PI) / 180; // 繞框中心旋轉
        const cx = (tf?.x ?? 0.5) * width, cy = (tf?.y ?? 0.5) * height;
        if (isInk && hasBg) {
          ctx2d.save();
          ctx2d.globalCompositeOperation = opts.paperMode === "night" ? "lighter" : "multiply";
          if (rot) { ctx2d.translate(cx, cy); ctx2d.rotate(rot); ctx2d.translate(-cx, -cy); }
          ctx2d.drawImage(gpuCanvas, lx, ly, lw, lh);
          ctx2d.restore();
        } else if (rot) {
          ctx2d.save();
          ctx2d.translate(cx, cy); ctx2d.rotate(rot); ctx2d.translate(-cx, -cy);
          ctx2d.drawImage(gpuCanvas, lx, ly, lw, lh);
          ctx2d.restore();
        } else {
          ctx2d.drawImage(gpuCanvas, lx, ly, lw, lh);
        }
      }
    }

    // ── 右側保護色塊 + 主卷軸歌詞：只有真的有直書歌詞時才畫（沒綁 LRC 就不留空塊）
    const mainLyr = fcomp.find((l) => l.type === "lyrics" && l.params.lines.length === 0);
    if (mainLyr && isLayerActive(mainLyr, localT, localDur) && scroller.lines.length > 0) {
      drawMask(ctx2d, width, height, dark);
      scroller.draw(ctx2d, width, height, nowMs, opts.fonts, !dark, opts.lyricStyle);
    }
    // ── 影片：先逐幀 seek 到對應時間點（async），存進 frameVideos，再交給 drawOverlayLayers 照 z 序內嵌畫。
    //    （修：原本影片被抽出、在所有疊加層之後單獨畫＝永遠蓋最上 → 比影片高 z 的 CTA／落款／文字會被影片蓋掉，
    //      預覽正常但匯出出包。改成把 seek 好的元素傳進 drawOverlayLayers，跟即時預覽走同一套 z 序。）
    const frameVideos = new Map<string, HTMLVideoElement>();
    for (const l of fcomp) {
      if (l.type !== "video" || !l.params.src || !isLayerActive(l, localT, localDur)) continue;
      const v = offlineVideos.get(l.id);
      if (!v || !v.duration || v.videoWidth === 0) continue;
      const startSec = l.timing?.start ?? 0;
      const dur2 = v.duration;
      if (!isFinite(dur2) || dur2 <= 0) continue; // 壞掉/未知長度的影片跳過，避免 NaN
      let vt = localT - startSec;
      if (l.params.loop) vt = ((vt % dur2) + dur2) % dur2;
      if (vt < 0) continue;
      const ended = !l.params.loop && vt > dur2;
      if (ended && l.params.mode === "intro") continue; // 片頭播完 → 露出主視覺
      await seekOfflineVideo(v, Math.max(0, Math.min(dur2 - 0.001, vt)));
      frameVideos.set(l.id, v);
    }

    // ── 多組字幕 → 疊加素材（圖片/影片/文字/落款/CTA）依 z 序畫，跟即時預覽一致
    drawLyricsLayers(ctx2d, fcomp, localT, localDur, width, height);
    drawOverlayLayers(ctx2d, fcomp, cache, localT, localDur, width, height, false, frameVideos);

    const vf = new VideoFrame(stage, {
      timestamp: Math.round((i / fps) * 1e6), // 0-based 輸出時間（裁切時與音訊對齊）
      duration: Math.round(1e6 / fps),
    });
    venc.encode(vf, { keyFrame: i % (fps * 5) === 0 });
    vf.close();
    if (venc.encodeQueueSize > 8) await waitDequeue(venc);
    if (i % 3 === 0) {
      opts.onProgress(i, totalFrames);
      await yieldMC();
    }
  }

  if (!opts.isCancelled() && !encErr) {
    await venc.flush();
    await aenc.flush();
    muxer.finalize();
  }
  venc.close();
  aenc.close();
  bgFx?.destroy();
  gpu?.destroy();
  for (const v of offlineVideos.values()) { v.pause(); v.removeAttribute("src"); v.load(); }
  await chain;
  if (opts.isCancelled() || encErr) {
    await writable.abort?.();
    if (encErr) throw encErr;
    throw new Error("已取消");
  }
  await writable.close();
  opts.onProgress(totalFrames, totalFrames);
  return { chapters };
}
