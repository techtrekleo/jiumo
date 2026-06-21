"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { FluidCore } from "../engine/fluid-core";
import { AudioEngine, computePeaks } from "../engine/audio";
import { LyricScroller, parseLyricsFile, LYRIC_FONTS, type LyricFontId, type LyricLine } from "../engine/lyrics";
import { EFFECTS, defaultsOf, testDrop, type InkEffect, type ParamValues } from "../engine/effects";
import { PRESET_PALETTES, PAPER_COLORS, autoPalette, hexToRgb, type Palette, type PaperMode } from "../engine/palette";
import { VIZZY_EFFECTS } from "../engine/vizzy-effects";
import { GpuVisuals, INK_GPU_IDS } from "../engine/gpu-visuals";
import { BgFx } from "../engine/bg-fx";
import { drawMask } from "../engine/overlay";
import { renderOffline, supportsOfflineRender, pickExportPlan, type OfflineTrack } from "../engine/offline";
import { BODY_PRESETS, makeBodyCanvas } from "../engine/bodies";
import { BodyActor } from "../engine/body-actor";
import { InkKoiActor } from "../inklab/ink-koi-actor";
import { KOI_COLOR_LIST } from "../inklab/ink-creature";
import { LayerTree } from "./layer-tree";
import { LayerInspector } from "./layer-inspector";
import { AutomationsPanel } from "./automations-panel";
import { HelpPanel } from "./help-panel";
import { Timeline } from "./timeline";
import { LyricEditor } from "./lyric-editor";
import { EffectPicker } from "./effect-picker";
import { Collapsible } from "./collapsible";
import { ProjectsPanel } from "./projects-panel";
import { ExportPanel } from "./export-panel";
import { saveProject, loadProject, genProjectId, type ProjectData } from "../engine/project-store";
import { listPresets, addPreset, deletePreset as deletePresetStore, genPresetId, type EffectPreset } from "../engine/preset-store";
import { Layers, Image as ImageIcon, Type as TypeIcon, FolderOpen, Sparkles, Activity, BarChart3, Maximize, Film, HelpCircle, Frame } from "lucide-react";
import { CoverEditor } from "./cover-editor";

// 左側 7 模組 icon rail（vizzy 風）
const LEFT_MODULES = [
  { id: "composition", label: "組成", icon: Layers },
  { id: "media", label: "素材", icon: ImageIcon },
  { id: "lyrics", label: "歌詞", icon: TypeIcon },
  { id: "projects", label: "專案", icon: FolderOpen },
  { id: "effects", label: "特效", icon: Sparkles },
  { id: "automations", label: "自動化", icon: Activity },
  { id: "analyzers", label: "分析", icon: BarChart3 },
] as const;
type LeftModuleId = (typeof LEFT_MODULES)[number]["id"];
import {
  defaultComposition, createLayer, insertLayer, removeLayer, moveLayerInDisplay,
  toggleLayerVisible, updateLayer, setLayerTransform, setLayerTiming, isLayerActive, applyAutomations, migrateComposition,
  type Composition, type Layer, type LayerType, type EffectParams,
} from "../engine/composition";
import { drawBackgroundLayer, drawOverlayLayers, drawLyricsLayers, drawPlayerLayer, drawAlphaLayer, getBackgroundImage, bgColorCss, pruneMediaCache, type MediaCache } from "../engine/layer-render";

/* 九墨 Studio：
   P1 — 合成 canvas + schema 屬性面板 + 墨流/墨滴 + 自訂墨色 + 錄製
   P2a — 歌單佇列（多首歌連播 = 長影片）+ 洗墨轉場 + 自動章節時間戳 */

const FONT_FACE_CSS = `
@font-face { font-family: 'Bakudai-Medium'; src: url('/fonts/Bakudai-Medium.woff2') format('woff2'); font-display: swap; }
@font-face { font-family: 'Bakudai-Light'; src: url('/fonts/Bakudai-Light.woff2') format('woff2'); font-display: swap; }
@font-face { font-family: 'NotoSerifTC-Medium'; src: url('/fonts/NotoSerifTC-Medium.woff2') format('woff2'); font-display: swap; }
@font-face { font-family: 'LXGWWenKaiTC-Medium'; src: url('/fonts/LXGWWenKaiTC-Medium.woff2') format('woff2'); font-display: swap; }
@font-face { font-family: 'GenSenRounded'; src: url('/fonts/GenSenRounded2.woff2?v=2') format('woff2'); font-display: swap; }
@font-face { font-family: 'JasonHW'; src: url('/fonts/JasonHW1.woff2') format('woff2'); font-display: swap; }
@font-face { font-family: 'Anton'; src: url('/fonts/Anton.woff2') format('woff2'); font-display: swap; }
@font-face { font-family: 'ArchivoBlack'; src: url('/fonts/ArchivoBlack.woff2') format('woff2'); font-display: swap; }
@font-face { font-family: 'BebasNeue'; src: url('/fonts/BebasNeue.woff2') format('woff2'); font-display: swap; }
`;

const BTN =
  "px-3 py-1.5 rounded-full text-[12px] tracking-wider border border-white/15 bg-black/40 text-white/75 hover:text-white hover:border-white/40 transition select-none cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed";

type Track = { id: string; file: File | null; title: string; lrc: LyricLine[] | null; lrcName: string };

// 墨體：剪影持續印進墨場（核心清晰、邊緣被流場拖成飄逸的觸手/尾/雲）
type InkBody = { name: string; x: number; y: number; size: number; amount: number; wiggle: number; drift: boolean; pulse: boolean; colors?: string[] };

type Mutable = {
  effect: InkEffect;
  params: ParamValues;
  palette: Palette;
  paperMode: PaperMode;
  fonts: readonly string[];
  sealOn: boolean;
  title: string;
};

const fmtTime = (t: number) => {
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
};

// 四個條狀頻譜 → 預設套「底部 1/5 條狀框」（畫面下方、不被遮）；放射/球體等 → 全螢幕框。
const SPECTRUM_GPU_IDS = new Set(["gv-spectrum"]);
const SPECTRUM_FRAME = { x: 0.5, y: 0.88, scale: 1, w: 1, h: 0.2 }; // 高度 1/5、置底（留 2% 底邊不被切）
const FULL_FRAME = { x: 0.5, y: 0.5, scale: 1, w: 1, h: 1 };

export default function StudioClient() {
  const stageRef = useRef<HTMLCanvasElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const audioFileRef = useRef<HTMLInputElement>(null);
  const lrcFileRef = useRef<HTMLInputElement>(null);

  const coreRef = useRef<FluidCore | null>(null);
  const audioRef = useRef<AudioEngine | null>(null);
  const scrollerRef = useRef(new LyricScroller());
  const mutRef = useRef<Mutable>({
    effect: EFFECTS[0],
    params: defaultsOf(EFFECTS[0]),
    palette: PRESET_PALETTES[0],
    paperMode: "xuan",
    fonts: ["Bakudai-Medium", "Bakudai-Light", "Bakudai-Light"],
    sealOn: true,
    title: "",
  });
  const recRef = useRef<{ rec: MediaRecorder | null; chunks: Blob[] }>({ rec: null, chunks: [] });
  const tracksRef = useRef<Track[]>([]);
  const currentIdxRef = useRef(0);
  const washUntilRef = useRef(0);
  const chaptersRef = useRef<{ t: number; title: string }[]>([]);
  const recStartRef = useRef(0);
  const pendingLrcRef = useRef<string | null>(null);
  const offlineActiveRef = useRef(false);
  const cancelRenderRef = useRef(false);
  const bodyFileRef = useRef<HTMLInputElement>(null);
  const stampCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const bodyRef = useRef<InkBody | null>(null);
  const actorRef = useRef<BodyActor | InkKoiActor | null>(null);

  const [effectId, setEffectId] = useState(EFFECTS[0].id);
  const [params, setParams] = useState<ParamValues>(defaultsOf(EFFECTS[0]));
  const [palette, setPalette] = useState<Palette>(PRESET_PALETTES[0]);
  const [autoColor, setAutoColor] = useState(false); // 自動變色：墨色循環跑過所有預設配色
  const [showHelp, setShowHelp] = useState(false); // 使用說明面板
  useEffect(() => { if (!localStorage.getItem("jiumo-help-seen")) setShowHelp(true); }, []); // 第一次進來自動跳一次
  const [paperMode, setPaperMode] = useState<PaperMode>("xuan");
  const [orientation, setOrientation] = useState<"landscape" | "portrait" | "wide" | "square">("landscape");
  const [resolution, setResolution] = useState<"720" | "1080">("1080"); // 預覽/錄製短邊
  const [exportFps, setExportFps] = useState<30 | 60>(30);
  const [exportOpen, setExportOpen] = useState(false);
  const [coverOpen, setCoverOpen] = useState(false); // 封面製作 overlay
  const [fontId, setFontId] = useState<LyricFontId>("modab");
  const [sealOn, setSealOn] = useState(true);
  const [title, setTitle] = useState("");
  const [tracks, setTracks] = useState<Track[]>([]);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [recording, setRecording] = useState(false);
  const [downloadUrl, setDownloadUrl] = useState("");
  const [chaptersText, setChaptersText] = useState("");
  const [renderPct, setRenderPct] = useState(-1);
  const [body, setBody] = useState<InkBody | null>(null);
  const [status, setStatus] = useState("加歌進歌單、九墨會跟著它呼吸。放多首就是一支長影片");
  const [unsupported, setUnsupported] = useState(false);

  // Phase 2-2/2-3 圖層系統
  const [composition, setComposition] = useState<Composition>(() => defaultComposition());
  const [selectedLayerId, setSelectedLayerId] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [lyricEditorOpen, setLyricEditorOpen] = useState(false);
  const [leftModule, setLeftModule] = useState<LeftModuleId>("composition");
  const [presets, setPresets] = useState<EffectPreset[]>([]);
  useEffect(() => { setPresets(listPresets()); }, []); // localStorage 只在 client 讀
  const [peaks, setPeaks] = useState<number[] | null>(null);
  const [volume, setVolume] = useState(1);
  const [noiseFloor, setNoiseFloor] = useState(-66); // 偵測門檻（dB）：高=只偵測大聲、低=連微弱也偵測
  const [loop, setLoop] = useState<{ start: number; end: number } | null>(null);
  const loopRef = useRef<{ start: number; end: number } | null>(null);
  useEffect(() => { loopRef.current = loop; }, [loop]);
  // 裁切範圍（影片裁切器）：在播放條拖選一段 → 只輸出這段、預覽也在這段循環
  const [clip, setClip] = useState<{ start: number; end: number } | null>(null);
  const clipRef = useRef<{ start: number; end: number } | null>(null);
  useEffect(() => { clipRef.current = clip; }, [clip]);
  const barElRef = useRef<HTMLDivElement>(null);
  const trimDragRef = useRef<{ mode: "new" | "start" | "end"; anchor: number; moved: boolean } | null>(null);
  useEffect(() => { audioRef.current?.setVolume(volume); }, [volume]);
  useEffect(() => { audioRef.current?.setNoiseFloor(noiseFloor); }, [noiseFloor]);
  const compRef = useRef<Composition>(composition);
  const mediaCacheRef = useRef<MediaCache>(new Map());
  const prevFxOnRef = useRef(true);
  const [visualFxId, setVisualFxId] = useState<string | null>(null); // 載入舊專案的 2D 視效（2D 已退役）
  const [gpuFxId, setGpuFxId] = useState<string | null>(null); // 編輯 UI 鏡像「選中效果層」的 GPU 光效 id
  const gpuFxRef = useRef<string | null>(null);
  const gpuEngineRef = useRef<GpuVisuals | null>(null);
  const bgFxRef = useRef<BgFx | null>(null); // 背景濾鏡引擎（WebGL2 後製鏈）
  useEffect(() => { gpuFxRef.current = gpuFxId; }, [gpuFxId]);
  // 選 GPU 光效 → 退出墨韻/2D（2D 已退役，但載入的舊專案仍可能帶 2D，保留 setVisualFxId(null) 清掉）
  const selectGpu = (id: string) => {
    setGpuFxId(id); setVisualFxId(null);
    // 頻譜 ↔ 其他 GPU 效果切換時，自動把框換成各自的預設（頻譜=底部 1/5 條狀、其他=全螢幕）。
    // 只在框「還是預設值」時才換，使用者自己拉過的位置/大小不會被蓋掉。
    setComposition((c) => {
      const l = c.find((x) => x.id === selectedLayerId);
      if (!l || l.type !== "effect") return c;
      const tf = l.transform;
      const wantStrip = SPECTRUM_GPU_IDS.has(id);
      const isFull = !tf || ((tf.w ?? 1) >= 0.99 && (tf.h ?? 1) >= 0.99);
      const isStrip = !!tf && Math.abs((tf.h ?? 1) - SPECTRUM_FRAME.h) < 0.02 && (tf.w ?? 1) >= 0.99;
      if (wantStrip && isFull) return setLayerTransform(c, l.id, SPECTRUM_FRAME);
      if (!wantStrip && isStrip) return setLayerTransform(c, l.id, FULL_FRAME);
      return c;
    });
  };
  useEffect(() => { compRef.current = composition; pruneMediaCache(mediaCacheRef.current, composition); }, [composition]);
  // 時間軸要知道歌曲總長：低頻輪詢即可（duration 很少變、不需每幀）
  useEffect(() => {
    const id = setInterval(() => {
      const d = audioRef.current?.duration || 0;
      setDuration((prev) => (Math.abs(prev - d) > 0.05 ? d : prev));
    }, 500);
    return () => clearInterval(id);
  }, []);

  const addLayer = (type: LayerType) => {
    // updater 外建層：id 穩定，不被 strict-mode 雙呼叫複製。
    // 新增的「音訊圖」預設給 GPU 光效（可獨立顯示）；預設那層才是墨韻流體。
    const layer = type === "effect"
      ? createLayer("effect", { params: { gpuId: "gv-spectrum" }, transform: { y: SPECTRUM_FRAME.y, w: SPECTRUM_FRAME.w, h: SPECTRUM_FRAME.h } }) // 預設統一頻譜 → 底部 1/5 條狀框
      : createLayer(type);
    setComposition((c) => insertLayer(c, layer));
    setSelectedLayerId(layer.id);
  };
  const reorderLayer = (id: string, toDisplayIndex: number) => setComposition((c) => moveLayerInDisplay(c, id, toDisplayIndex));
  const deleteLayer = (id: string) => {
    setComposition((c) => removeLayer(c, id));
    setSelectedLayerId((cur) => (cur === id ? null : cur));
  };
  const patchParams = (id: string, params: Record<string, unknown>) => setComposition((c) => updateLayer(c, id, { params }));
  const patchTransform = (id: string, t: { x?: number; y?: number; scale?: number; w?: number; h?: number; rot?: number }) => setComposition((c) => setLayerTransform(c, id, t));
  const patchTiming = (id: string, t: { start?: number; end?: number }) => setComposition((c) => setLayerTiming(c, id, t));
  const patchAutomations = (id: string, automations: import("../engine/composition").Automation[]) => setComposition((c) => updateLayer(c, id, { automations }));
  const patchBindings = (id: string, audioBindings: import("../engine/composition").AudioBinding[]) => setComposition((c) => updateLayer(c, id, { audioBindings }));
  // 上傳：圖片/Logo/背景圖讀成 dataURL（可存檔）；影片用 objectURL（檔案大、不入存檔）
  const uploadToLayer = (id: string, file: File, target: "image" | "video" | "bg" | "lrc") => {
    if (target === "video") {
      const url = URL.createObjectURL(file);
      patchParams(id, { src: url, fileName: file.name });
      // 探測能否解碼：HEVC/H.265、部分 .mov 瀏覽器播不了會靜默不顯示 → 給明確提示
      const probe = document.createElement("video");
      probe.muted = true; probe.preload = "auto"; probe.src = url;
      probe.onloadeddata = () => setStatus(`影片就緒：${file.name}`);
      probe.onerror = () => setStatus("這支影片瀏覽器無法播放（多半是 HEVC/H.265 或 .mov）。請轉成 mp4（H.264）再上傳。");
      return;
    }
    if (target === "lrc") {
      const r = new FileReader();
      r.onload = (e) => { patchParams(id, { lines: parseLyricsFile(file.name, String(e.target?.result || "")) }); };
      r.readAsText(file);
      return;
    }
    const r = new FileReader();
    r.onload = (e) => {
      const url = String(e.target?.result || "");
      if (target === "bg") patchParams(id, { imageUrl: url, fileName: file.name });
      else patchParams(id, { dataUrl: url, fileName: file.name });
    };
    r.readAsDataURL(file);
  };
  const selectedLayer: Layer | null = composition.find((l) => l.id === selectedLayerId) || null;

  // 多效果層：每層的效果設定存在自己的 EffectParams。選層 → 載入該層設定到編輯 UI；編輯 → 寫回該層。
  // 防迴圈靠「值參考相等」：載入時設成同一個 values/palette 參考，只有真的編輯才產生新參考。
  useEffect(() => {
    const l = composition.find((x) => x.id === selectedLayerId);
    if (l?.type !== "effect") return;
    const ep = l.params;
    setEffectId(ep.effectId); setGpuFxId(ep.gpuId); setVisualFxId(null);
    setParams(ep.values); setPalette(ep.palette); setAutoColor(ep.autoColor ?? false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLayerId]);
  useEffect(() => {
    const l = compRef.current.find((x) => x.id === selectedLayerId);
    if (l?.type !== "effect") return;
    const ep = l.params as EffectParams;
    if (ep.effectId === effectId && ep.gpuId === gpuFxId && ep.values === params && ep.palette === palette && (ep.autoColor ?? false) === autoColor) return; // 載入造成的，不回寫
    setComposition((c) => updateLayer(c, l.id, { params: { effectId, gpuId: gpuFxId, values: params, palette, autoColor } }));
  }, [effectId, gpuFxId, params, palette, autoColor, selectedLayerId]);

  // 專案存檔（只存設定；影片 src 清空、音檔 File 不存）
  const saveCurrentProject = async (name: string) => {
    const compClean = composition.map((l) => (l.type === "video" ? { ...l, params: { ...l.params, src: "" } } : l)) as Composition;
    const data: ProjectData = {
      orientation,
      composition: compClean,
      tracks: tracks.map((t) => ({ title: t.title, lrc: t.lrc, lrcName: t.lrcName })),
      studio: { effectId, params, palette, paperMode, fontId, sealOn, title, visualFxId, gpuFxId },
    };
    await saveProject({ id: genProjectId(), name, savedAt: Date.now(), data });
    setStatus(`已存檔：${name}`);
  };
  const loadProjectById = async (id: string) => {
    const p = await loadProject(id);
    if (!p) { setStatus("找不到該專案"); return; }
    const d = p.data;
    setOrientation(d.orientation);
    const comp = migrateComposition(d.composition); // 舊頻譜 id → gv-spectrum
    setComposition(comp);
    compRef.current = comp;
    setSelectedLayerId(null);
    setEffectId(d.studio.effectId);
    setParams(d.studio.params);
    setPalette(d.studio.palette);
    setPaperMode(d.studio.paperMode);
    setFontId(d.studio.fontId);
    setSealOn(d.studio.sealOn);
    setTitle(d.studio.title);
    setVisualFxId(d.studio.visualFxId);
    setGpuFxId(d.studio.gpuFxId ?? null);
    const restored: Track[] = d.tracks.map((t) => ({ id: Math.random().toString(36).slice(2, 9), file: null, title: t.title, lrc: t.lrc, lrcName: t.lrcName }));
    setTracks(restored);
    tracksRef.current = restored;
    scrollerRef.current.setLines(restored[0]?.lrc || []);
    setStatus(`已載入「${p.name}」。歌曲音檔請重新加歌（設定都還在）`);
  };

  // 自訂 preset：把目前效果＋參數＋墨色＋紙色存成一格
  const saveCurrentPreset = () => {
    const kind: "ink" | "visual" = visualFxId ? "visual" : "ink";
    const eid = visualFxId || effectId;
    const baseName = visualFxId
      ? VIZZY_EFFECTS.find((v) => v.id === visualFxId)?.name || "視效"
      : EFFECTS.find((e) => e.id === effectId)?.name || "墨韻";
    const preset: EffectPreset = { id: genPresetId(), name: `${baseName} ${presets.length + 1}`, kind, effectId: eid, params, palette, paperMode };
    setPresets(addPreset(preset));
    setStatus(`已存 preset：${preset.name}`);
  };
  const applyPreset = (p: EffectPreset) => {
    setPaperMode(p.paperMode);
    setPalette(p.palette);
    setParams(p.params);
    if (p.kind === "visual") setVisualFxId(p.effectId);
    else { setEffectId(p.effectId); setVisualFxId(null); }
  };
  const removePreset = (id: string) => setPresets(deletePresetStore(id));
  const toggleFullscreen = () => {
    const el = stageRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.();
  };

  useEffect(() => { mutRef.current.effect = EFFECTS.find((e) => e.id === effectId) || EFFECTS[0]; }, [effectId]);
  useEffect(() => { mutRef.current.params = params; }, [params]);
  useEffect(() => { mutRef.current.palette = palette; }, [palette]);
  useEffect(() => {
    mutRef.current.paperMode = paperMode;
    if (coreRef.current) coreRef.current.paperMode = paperMode;
  }, [paperMode]);
  // 紙色＝全域＋同步背景層（夜紙＝暗背景才真的變暗；背景層有自訂色 customColor 時不動它）
  const applyPaper = (mode: PaperMode) => {
    setPaperMode(mode);
    setComposition((c) => c.map((l) => l.type === "background" && !(l.params as { customColor?: string }).customColor
      ? { ...l, params: { ...l.params, paperMode: mode } } : l));
  };
  useEffect(() => {
    const f = LYRIC_FONTS.find((x) => x.id === fontId) || LYRIC_FONTS[0];
    mutRef.current.fonts = f.fonts;
  }, [fontId]);
  useEffect(() => { mutRef.current.sealOn = sealOn; }, [sealOn]);
  useEffect(() => { mutRef.current.title = title; }, [title]);
  useEffect(() => { tracksRef.current = tracks; }, [tracks]);
  useEffect(() => { bodyRef.current = body; }, [body]);
  useEffect(() => { actorRef.current?.setTint(palette.primary); }, [palette]);
  useEffect(() => { const a = actorRef.current; if (a instanceof InkKoiActor) a.setColors(body?.colors ?? null); }, [body?.colors]);

  const loadTrack = (i: number) => {
    const t = tracksRef.current[i];
    if (!t) return;
    if (t.file) { audioRef.current?.load(t.file); computePeaks(t.file).then(setPeaks).catch(() => setPeaks(null)); }
    else setPeaks(null);
    scrollerRef.current.setLines(t.lrc || []);
    setTitle(t.title);
    mutRef.current.title = t.title;
    currentIdxRef.current = i;
    setCurrentIdx(i);
  };

  const loadBody = async (f: File) => {
    const bmp = await createImageBitmap(f);
    const S = 512;
    const c = document.createElement("canvas");
    c.width = S; c.height = S;
    const cx = c.getContext("2d")!;
    const k = Math.min(S / bmp.width, S / bmp.height);
    cx.drawImage(bmp, (S - bmp.width * k) / 2, (S - bmp.height * k) / 2, bmp.width * k, bmp.height * k);
    bmp.close();
    stampCanvasRef.current = c;
    const actor = new BodyActor(c, 0.3, 0.55);
    actor.setTint(mutRef.current.palette.primary);
    actorRef.current = actor;
    setBody({ name: f.name.replace(/\.[^.]+$/, ""), x: 0.3, y: 0.55, size: 0.42, amount: 1, wiggle: 0.5, drift: true, pulse: true });
    setStatus("墨體放進去了、牠游動時會拖出墨線。月亮類就把漂移關掉");
  };
  const loadPreset = (id: string) => {
    const preset = BODY_PRESETS.find((b) => b.id === id);
    if (!preset) return;
    const c = makeBodyCanvas(preset);
    stampCanvasRef.current = c;
    const actor = id === "koi" ? new InkKoiActor(c, 0.3, 0.55) : new BodyActor(c, 0.3, 0.55);
    actor.setTint(mutRef.current.palette.primary);
    const koiColors = id === "koi" ? ["ink"] : undefined; // 預設＝墨色（純色，可在面板改墨/白/金/銀）
    if (id === "koi" && actor instanceof InkKoiActor) actor.setColors(koiColors!);
    actorRef.current = actor;
    setBody({ name: preset.name, x: 0.3, y: 0.55, ...preset.defaults, colors: koiColors });
    setStatus(`${preset.name}放進去了、牠游動時會拖出墨線`);
  };
  const removeBody = () => {
    setBody(null);
    stampCanvasRef.current = null;
    actorRef.current = null;
  };

  /* 主迴圈 */
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    stage.width = 1920;
    stage.height = 1080;
    const ctx2d = stage.getContext("2d")!;
    const glCanvas = document.createElement("canvas");
    glCanvas.width = stage.width;
    glCanvas.height = stage.height;
    const core = new FluidCore(glCanvas);
    if (!core.ok) { setUnsupported(true); return; }
    coreRef.current = core;
    // GPU 光效引擎（獨立 WebGL2 canvas，跟墨流一樣 drawImage 合成進舞台）
    const gpuCanvas = document.createElement("canvas");
    gpuCanvas.width = stage.width;
    gpuCanvas.height = stage.height;
    const gpu = new GpuVisuals(gpuCanvas);
    gpuEngineRef.current = gpu;
    // 背景濾鏡引擎（獨立 WebGL2 canvas，把背景圖套後製鏈後 drawImage 鋪底）
    const bgFxCanvas = document.createElement("canvas");
    bgFxCanvas.width = stage.width;
    bgFxCanvas.height = stage.height;
    const bgFx = new BgFx(bgFxCanvas);
    bgFxRef.current = bgFx;
    let beatEnv = 0; // 節拍包絡：打點瞬間拉 1、之後衰減 → glow 不閃爍
    let lastBeatT = -10; // 上個重音的時間(秒)；算 beatPhase（重音漣漪用）
    let bassEnv = 0, trebEnv = 0; // 頻段包絡（attack 快、release 慢）→ vizzy 那種絲滑縮放
    const audio = new AudioEngine();
    audioRef.current = audio;

    // 連播：一首結束 → 洗墨轉場 → 下一首；錄製中順便記章節
    audio.onEnded = () => {
      const next = currentIdxRef.current + 1;
      const isRec = recRef.current.rec?.state === "recording";
      if (next < tracksRef.current.length) {
        washUntilRef.current = performance.now() + 1300;
        setTimeout(() => {
          loadTrack(next);
          void audioRef.current?.play(true);
          if (isRec) {
            chaptersRef.current.push({
              t: (performance.now() - recStartRef.current) / 1000,
              title: tracksRef.current[next]?.title || `第 ${next + 1} 首`,
            });
          }
        }, 1500);
      } else {
        setPlaying(false);
        if (recRef.current.rec && recRef.current.rec.state !== "inactive") recRef.current.rec.stop();
      }
    };

    void document.fonts.load("32px 'Bakudai-Medium'");
    void document.fonts.load("32px 'Bakudai-Light'");
    // 預載所有字體選項（canvas 要字體 ready 才畫得出來，否則退回系統字）
    for (const f of ["GenSenRounded", "JasonHW", "NotoSerifTC-Medium", "LXGWWenKaiTC-Medium", "Anton", "ArchivoBlack", "BebasNeue"]) void document.fonts.load(`32px '${f}'`);

    let raf = 0;
    let last = performance.now();
    let destroyed = false;

    const frame = (time: number) => {
      if (destroyed) return;
      raf = requestAnimationFrame(frame);
      if (offlineActiveRef.current) { last = time; return; }
      const m = mutRef.current;
      const realDt = Math.min((time - last) / 1000, 0.1); // 真實經過時間（封頂 0.1s 防掉幀/切分頁後爆衝）
      last = time;
      if (realDt <= 0) return;
      const cache = mediaCacheRef.current;
      const ct = audio.currentTime, dur = audio.duration || 0;
      const lp = loopRef.current;
      if (lp && audio.playing && ct >= lp.end) audio.seek(lp.start); // loop 區段
      const cl = clipRef.current; // 裁切段：預覽時在範圍內循環，方便確認要輸出的段落
      if (cl && audio.playing && (ct >= cl.end || ct < cl.start - 0.25)) audio.seek(cl.start);

      // 音訊分析：density/sens 取 base 第一個效果層（自動化/音訊綁定不改分析本身）
      const baseFx0 = (compRef.current.find((l) => l.type === "effect")?.params as EffectParams | undefined)?.values;
      const af = audio.analyse(time, (baseFx0?.density as number) || 1, (baseFx0?.sens as number) || 1);
      // 頻段包絡（上升快、下降慢）→ 音訊圖與「音訊驅動」共用，必須在 applyAutomations 前算好。
      // 衰減/上升係數換算成「以 60fps 為基準的真實時間」(envK=realDt*60) → 發光衰減不隨 rAF 幀率漂移（錄製=預覽）。
      const envK = realDt * 60;
      const isBeat = af.beat || af.bassSpike || af.trebleSpike;
      beatEnv = Math.max(beatEnv * Math.pow(0.9, envK), isBeat ? 1 : 0);
      if (isBeat) lastBeatT = time / 1000;
      const beatPhase = Math.min((time / 1000 - lastBeatT) / 0.32, 9); // 0=剛下重音→1=傳遞完成(0.32s)→淡出
      bassEnv = af.bass > bassEnv ? bassEnv + (af.bass - bassEnv) * (1 - Math.pow(0.5, envK)) : bassEnv * Math.pow(0.85, envK);
      trebEnv = af.treble > trebEnv ? trebEnv + (af.treble - trebEnv) * (1 - Math.pow(0.5, envK)) : trebEnv * Math.pow(0.85, envK);
      const audioSample = { bass: bassEnv, mid: af.mid, treble: trebEnv, beat: beatEnv, level: (bassEnv + af.mid + trebEnv) / 3 };
      // 關鍵影格 + 音訊驅動：每幀把 automation/audioBinding 套進 comp（base 留在 compRef，渲染吃解算後的）
      const comp = applyAutomations(compRef.current, ct, audioSample);

      // 效果層：墨韻流體（單例＝第一個 ink 效果層）＋ 多個 GPU 音訊圖層（各自渲染）
      const effectLayers = comp.filter((l) => l.type === "effect");
      // 永遠 sync 定位（暫停往回拖時間軸也要即時更新直式歌詞、不殘留）；但 lyricChanged 只在播放時為 true，避免暫停誤觸滴墨
      const scrollerChanged = scrollerRef.current.sync(audio.currentTime, time);
      const lyricChanged = audio.playing ? scrollerChanged : false;
      // 墨韻流體：第一個 gpuId==null 且可見的效果層才驅動 FluidCore（流體單例）
      const inkLayer = effectLayers.find((l) => (l.params as EffectParams).gpuId == null && isLayerActive(l, ct, dur));
      const inkOn = !!inkLayer;
      if (!inkOn && prevFxOnRef.current) core.rebuild(); // 墨韻關閉那幀清流場
      prevFxOnRef.current = inkOn;
      const inkP = inkLayer ? (inkLayer.params as EffectParams) : undefined;
      const inkEffect = inkP ? (EFFECTS.find((e) => e.id === inkP.effectId) || EFFECTS[0]) : m.effect;
      const inkValues = inkP?.values ?? m.params;
      // 自動變色：用音檔時間 ct 循環跑色（預覽=匯出同秒同色）；否則用固定 palette
      const inkPalette = inkP?.autoColor ? autoPalette(ct) : (inkP?.palette ?? m.palette);
      const speed = (inkValues.speed as number) || 1;
      const b = bodyRef.current;
      const actor = actorRef.current;
      const W0 = stage.width, H0 = stage.height;
      if (b && actor && inkOn && inkP?.autoColor) actor.setTint(inkPalette.primary); // 自動變色時墨體剪影也跟著換色
      // 背景參數：自訂色 + 背景圖不透明度（流體步進前要先設好 paperColorOverride）
      const bgLayer = comp.find((l) => l.type === "background");
      const bgP = bgLayer && bgLayer.type === "background" ? bgLayer.params : null;
      const bgHasImg = !!bgP?.imageUrl && !!getBackgroundImage(comp, cache, ct, dur);
      // 自訂背景色：無圖時讓墨流坐在自訂色上（有圖時維持紙色 identity、圖才不被染色）
      core.paperColorOverride = bgP?.customColor && !bgHasImg ? hexToRgb(bgP.customColor) : null;
      // ── 固定步長模擬：墨流/滴墨/墨體用「真實經過時間」切成 ≤1/60 的步推進，
      //    與 rAF fps 脫鉤 → 錄製（編碼拖慢 fps）= 順順預覽 = 離線匯出，墨滴密度/流速一致。
      const wash = performance.now() < washUntilRef.current;
      const SIM_STEP = 1 / 60; // 流體單步上限（沿用原本穩定性）
      let remain = realDt; // 本幀要消化的真實時間（已封頂 0.1s）
      let firstSub = true;
      do {
        const cdt = Math.min(remain, SIM_STEP); // 真實時間切塊
        const sdt = cdt * speed; // 模擬 dt（流速縮放，沿用原本 dt=baseDt*speed 慣例）
        const stepParams = inkOn
          ? inkEffect.update({ core, audio: af, palette: inkPalette, paperMode: m.paperMode, params: inkValues, dt: sdt, now: time, lyricChanged: firstSub && lyricChanged })
          : { curl: 0, velDissipation: 0.85, dyeDissipation: 0.6, diffusion: 0.03 };
        if (wash) stepParams.dyeDissipation = 4.5;
        if (b && actor && inkOn) { actor.update(cdt, af, b); actor.emitInk(core, inkPalette, m.paperMode, b, cdt, W0, H0); }
        core.step(sdt, stepParams);
        remain -= cdt;
        firstSub = false;
      } while (remain > 1e-4);
      core.render();
      const W = stage.width, H = stage.height;
      // 背景圖鋪底 → 有圖時墨用混合模式疊上（讓底圖透出），無圖維持原本不透明紙。
      // 背景層帶濾鏡 + 圖已載入 + 引擎可用 → 走 BgFx 後製鏈；否則直接 drawImage（載入中也走這條）。
      let hasBg: boolean;
      const bgFilters = bgP?.filters ?? [];
      const bgImg = bgFilters.length > 0 ? getBackgroundImage(comp, cache, ct, dur) : null;
      if (bgImg && bgFx.ok && bgP) {
        ctx2d.fillStyle = bgColorCss(bgP); ctx2d.fillRect(0, 0, W, H); // 底色（圖半透明時露出）
        bgFx.resize(W, H);
        bgFx.setSource(bgImg, W, H);
        bgFx.render(bgFilters.map((f) => ({ fx: f.fx, amount: f.amount, density: f.density, speed: f.speed, angle: f.angle, posX: f.posX, posY: f.posY, scale: f.scale, colorA: f.colorA, colorB: f.colorB })), time / 1000, audioSample.level, beatEnv);
        ctx2d.save(); ctx2d.globalAlpha = bgP.imageOpacity ?? 1; ctx2d.drawImage(bgFxCanvas, 0, 0, W, H); ctx2d.restore();
        hasBg = true;
      } else {
        hasBg = drawBackgroundLayer(ctx2d, comp, cache, ct, dur, W, H);
      }
      // 合成墨韻流體（有 ink 層才畫）；沒 ink 又沒背景圖時鋪背景色給 GPU 層墊背
      if (inkOn) {
        if (hasBg) { ctx2d.save(); ctx2d.globalCompositeOperation = m.paperMode === "night" ? "lighter" : "multiply"; ctx2d.drawImage(glCanvas, 0, 0, W, H); ctx2d.restore(); }
        else ctx2d.drawImage(glCanvas, 0, 0, W, H);
      } else if (!hasBg) {
        ctx2d.fillStyle = bgP ? bgColorCss(bgP) : `rgb(${Math.round(PAPER_COLORS[m.paperMode][0] * 255)},${Math.round(PAPER_COLORS[m.paperMode][1] * 255)},${Math.round(PAPER_COLORS[m.paperMode][2] * 255)})`;
        ctx2d.fillRect(0, 0, W, H);
      }
      if (b && actor && inkOn) actor.draw(ctx2d, W, H, b); // 墨體剪影疊在流體上
      // 依陣列序 z-order 交錯畫「GPU 音訊圖」與「控制板」：控制板下方的特效先畫(被它模糊/折射當背景)、
      // 上方的特效在它之後畫(保持清晰)。控制板從 overlay pass 移到這 → 圖層樹上下關係真的生效。
      for (const l of comp) {
        if (l.type === "player") { drawPlayerLayer(ctx2d, l, comp, cache, ct, dur, W, H); continue; }
        if (l.type === "alpha") { drawAlphaLayer(ctx2d, l, ct, dur, beatEnv, time / 1000, W, H); continue; }
        if (l.type !== "effect") continue;
        const ep = l.params as EffectParams;
        if (ep.gpuId == null || !isLayerActive(l, ct, dur) || !gpu.ok) continue;
        const tf = l.transform;
        const lw = (tf?.w ?? 1) * W, lh = (tf?.h ?? 1) * H;
        const lx = (tf?.x ?? 0.5) * W - lw / 2, ly = (tf?.y ?? 0.5) * H - lh / 2;
        gpu.resize(Math.max(2, Math.round(lw)), Math.max(2, Math.round(lh)));
        // 墨象·東方：有背景可壓墨時走「墨上紙」（宣紙=深墨 multiply / 夜紙=亮墨 lighter）
        const isInk = INK_GPU_IDS.has(ep.gpuId);
        const inkPaper = isInk && hasBg && m.paperMode !== "night";
        if (ep.gpuId === "gv-spectrum") audio.setSmoothing((ep.values.smoothing as number) ?? 0.6); // 頻譜平滑開關
        const ch = ep.gpuId === "gv-spectrum" ? ((ep.values.channel as number) ?? 0) : 0; // 0 混合 / 1 左 / 2 右 / 3 左右分離
        const mainFreq = ch === 1 ? audio.getFreq("left") : ch === 2 ? audio.getFreq("right") : ch === 3 ? audio.getFreq("left") : audio.getFreq();
        const freqR = ch === 3 ? audio.getFreq("right") : null;
        gpu.render(ep.gpuId, mainFreq, {
          time: time / 1000, sens: (ep.values.sens as number) ?? 1, beat: beatEnv, palette: ep.autoColor ? autoPalette(ct) : ep.palette,
          bass: bassEnv, mid: af.mid, treble: trebEnv,
          bloom: (ep.values.bloom as number) ?? 1.35, gain: (ep.values.gain as number) ?? 1,
          feather: (lw < W * 0.985 || lh < H * 0.985) ? 1 : 0,
          width: (ep.values.width as number) ?? 1, spacing: (ep.values.spacing as number) ?? 1,
          balance: (ep.values.balance as number) ?? 0,
          beatPhase,
          paper: inkPaper,
          shape: (ep.values.shape as number) ?? 1,
          mirrorV: (ep.values.mirrorV as boolean) ?? false,
          mirrorH: (ep.values.mirrorH as boolean) ?? false,
          cap: (ep.values.cap as number) ?? 0.55,
          freqR, stereo: ch === 3,
          radial: (ep.values.radial as boolean) ?? false,
          spin: (ep.values.spin as number) ?? 0,
          reflex: (ep.values.reflex as number) ?? 0,
          outline: (ep.values.outline as boolean) ?? false,
          peakOn: (ep.values.peakOn as boolean) ?? false,
          scale: (ep.values.scale as number) ?? 0,
          weight: (ep.values.weight as number) ?? 0,
          progress: audio.duration ? audio.currentTime / audio.duration : 0, // 白框計時器：播放進度
        });
        const rot = ((tf?.rot ?? 0) * Math.PI) / 180; // 繞框中心旋轉
        const cx = (tf?.x ?? 0.5) * W, cy = (tf?.y ?? 0.5) * H;
        if (isInk && hasBg) {
          ctx2d.save();
          ctx2d.globalCompositeOperation = m.paperMode === "night" ? "lighter" : "multiply";
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
      const dark = m.paperMode === "night";
      // 主卷軸歌詞：第一個「沒自帶 lines」的歌詞層（綁歌單那首歌）→ 用既有 LyricScroller 卷軸畫。
      // 右側保護色塊（drawMask）只有「真的有直書歌詞要顯示」時才畫 → 沒綁 LRC 就不留空塊。
      const mainLyr = comp.find((l) => l.type === "lyrics" && l.params.lines.length === 0);
      const showScroller = !!mainLyr && isLayerActive(mainLyr, ct, dur) && scrollerRef.current.lines.length > 0;
      if (showScroller) { drawMask(ctx2d, W, H, dark); scrollerRef.current.draw(ctx2d, W, H, time, m.fonts, !dark); }
      // 落款印章已改成「落款」圖層（drawOverlayLayers 畫），程序化 drawSeal 退役
      // 多組 LRC：有自帶 lines 的歌詞層各自畫當前句（自訂位置/字型/特效）
      drawLyricsLayers(ctx2d, comp, ct, dur, W, H);
      // 疊加上傳素材層（圖片 Logo / 影片 / 文字）依 z 序與時間軸畫最上
      drawOverlayLayers(ctx2d, comp, cache, ct, dur, W, H, audio.playing);
      if (audio.loaded && progressRef.current && timeRef.current) {
        const pct = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
        progressRef.current.style.width = `${pct}%`;
        timeRef.current.textContent = `${fmtTime(audio.currentTime)} / ${fmtTime(audio.duration || 0)}`;
      }
    };
    raf = requestAnimationFrame(frame);

    return () => {
      destroyed = true;
      cancelAnimationFrame(raf);
      audio.destroy();
      gpu.destroy();
      bgFx.destroy();
      gpuEngineRef.current = null;
      bgFxRef.current = null;
      coreRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 方向 + 解析度切換（短邊 720/1080，長邊 16:9） */
  useEffect(() => {
    const stage = stageRef.current;
    const core = coreRef.current;
    if (!stage || !core) return;
    const shortSide = resolution === "720" ? 720 : 1080;
    if (orientation === "square") {           // 1:1 方形
      stage.width = shortSide;
      stage.height = shortSide;
    } else if (orientation === "wide") {      // 2:1 寬幅（短邊＝高）
      stage.width = shortSide * 2;
      stage.height = shortSide;
    } else {                                  // 16:9 橫 / 9:16 直
      const longSide = Math.round(shortSide * 16 / 9);
      stage.width = orientation === "landscape" ? longSide : shortSide;
      stage.height = orientation === "landscape" ? shortSide : longSide;
    }
    core.canvas.width = stage.width;
    core.canvas.height = stage.height;
    core.rebuild();
  }, [orientation, resolution]);

  /* 歌單操作 */
  const addAudioFiles = (files: FileList | File[]) => {
    const items: Track[] = [...files].map((f) => ({
      id: Math.random().toString(36).slice(2, 9),
      file: f,
      title: f.name.replace(/\.[^.]+$/, ""),
      lrc: null,
      lrcName: "",
    }));
    setTracks((prev) => {
      const next = [...prev, ...items];
      tracksRef.current = next;
      if (prev.length === 0 && next.length > 0) setTimeout(() => loadTrack(0), 0);
      return next;
    });
    setStatus(items.length > 1 ? `加了 ${items.length} 首、會照順序連播成一支長影片` : "音檔就緒。幫它綁 .lrc 歌詞、或直接預覽");
  };
  const bindLrc = (trackId: string, f: File) => {
    const r = new FileReader();
    r.onload = (e) => {
      const lines = parseLyricsFile(f.name, String(e.target?.result || ""));
      setTracks((prev) => {
        const next = prev.map((t) => (t.id === trackId ? { ...t, lrc: lines, lrcName: `${f.name}（${lines.length} 句）` } : t));
        tracksRef.current = next;
        return next;
      });
      const idx = tracksRef.current.findIndex((t) => t.id === trackId);
      if (idx === currentIdxRef.current) scrollerRef.current.setLines(lines);
      setStatus(`歌詞綁好了、共 ${lines.length} 句`);
    };
    r.readAsText(f);
  };
  const removeTrack = (trackId: string) => {
    setTracks((prev) => {
      const next = prev.filter((t) => t.id !== trackId);
      tracksRef.current = next;
      return next;
    });
  };

  const togglePlay = async () => {
    const a = audioRef.current;
    if (!tracksRef.current.length) { setStatus("先加歌"); return; }
    if (!a?.loaded) loadTrack(currentIdxRef.current);
    if (a?.playing) { a.pause(); setPlaying(false); }
    else { await a?.play(); setPlaying(true); }
  };

  const toggleRecord = async () => {
    const a = audioRef.current;
    const stage = stageRef.current;
    if (!tracksRef.current.length || !stage || !a) { setStatus("先加歌再錄"); return; }
    const R = recRef.current;
    if (R.rec && R.rec.state !== "inactive") { R.rec.stop(); return; }
    loadTrack(0);
    scrollerRef.current.reset();
    chaptersRef.current = [{ t: 0, title: tracksRef.current[0].title }];
    recStartRef.current = performance.now();
    await a.play(true);
    setPlaying(true);
    const stream = stage.captureStream(30);
    const track = a.audioTrack();
    if (track) stream.addTrack(track);
    const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus") ? "video/webm;codecs=vp9,opus" : "video/webm";
    R.chunks = [];
    R.rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 10_000_000 });
    R.rec.ondataavailable = (e) => { if (e.data.size) R.chunks.push(e.data); };
    R.rec.onstop = () => {
      const blob = new Blob(R.chunks, { type: "video/webm" });
      setDownloadUrl(URL.createObjectURL(blob));
      if (chaptersRef.current.length > 1) {
        setChaptersText(chaptersRef.current.map((c) => `${fmtTime(c.t)} ${c.title}`).join("\n"));
      } else setChaptersText("");
      setRecording(false);
      setPlaying(false);
      audioRef.current?.pause();
      setStatus("錄好了、下載影片（多首歌的話 YouTube 章節也一起給你）");
    };
    R.rec.start(200);
    setRecording(true);
    setDownloadUrl("");
    setChaptersText("");
    setStatus(tracksRef.current.length > 1 ? `錄製中、${tracksRef.current.length} 首會連播到底自動停` : "錄製中、歌放完會自動停");
  };

  const renderMp4 = async () => {
    if (!tracksRef.current.length) { setStatus("先加歌再渲染"); return; }
    if (!supportsOfflineRender()) { setStatus("這個瀏覽器不支援離線渲染（需要 WebCodecs 與存檔權限）"); return; }
    // 先挑一組「這台真的能編」的格式：優先 H.264+AAC(mp4)，缺就退 VP9/VP8+Opus(webm)。
    // 不綁瀏覽器、避免開存檔後才掛掉吐 0MB 空檔。
    const supW = stageRef.current?.width || 1920;
    const supH = stageRef.current?.height || 1080;
    const plan = await pickExportPlan(supW, supH, exportFps);
    if (!plan) { setStatus("你的瀏覽器沒有可用的影片編碼器（H.264／VP9／VP8 都無），無法匯出"); return; }
    let handle: FileSystemFileHandle;
    try {
      handle = await (window as unknown as {
        showSaveFilePicker: (o: object) => Promise<FileSystemFileHandle>;
      }).showSaveFilePicker({
        suggestedName: `九墨-${tracksRef.current[0].title}${plan.ext}`,
        types: [{ description: `${plan.label} 影片`, accept: { [plan.mime]: [plan.ext] } }],
      });
    } catch { return; }
    try {
      audioRef.current?.pause();
      setPlaying(false);
      setStatus("解碼音檔中…");
      setRenderPct(0);
      cancelRenderRef.current = false;
      offlineActiveRef.current = true;
      const ac = new AudioContext();
      const offTracks: OfflineTrack[] = [];
      for (const t of tracksRef.current) {
        if (!t.file) continue; // 載入的專案音檔尚未重新加，跳過
        const buf = await ac.decodeAudioData(await t.file.arrayBuffer());
        offTracks.push({ buffer: buf, lrc: t.lrc || [], title: t.title });
      }
      void ac.close();
      if (offTracks.length === 0) { // 載入的專案不含音檔 → 避免產生空影片壞檔，給明確提示
        setStatus("這些歌的音檔還沒載入（載入的專案不含音檔）→ 請重新「加歌」再輸出");
        setRenderPct(-1); offlineActiveRef.current = false; return;
      }
      const W = stageRef.current?.width || 1920;
      const H = stageRef.current?.height || 1080;
      const m = mutRef.current;
      setStatus("離線渲染中、切走分頁也照跑");
      const b = bodyRef.current;
      const { chapters } = await renderOffline({
        tracks: offTracks, width: W, height: H, fps: exportFps, gap: 1.5,
        effect: m.effect, params: m.params, palette: m.palette, paperMode: m.paperMode,
        fonts: m.fonts, sealOn: m.sealOn, fileHandle: handle, plan,
        composition: compRef.current, mediaCache: mediaCacheRef.current,
        body: b && stampCanvasRef.current ? { source: stampCanvasRef.current, koi: actorRef.current instanceof InkKoiActor, ...b } : undefined,
        onProgress: (d, tot) => setRenderPct(Math.min(99, Math.round((d / tot) * 100))),
        isCancelled: () => cancelRenderRef.current,
        trim: clipRef.current ? { start: clipRef.current.start, end: clipRef.current.end } : undefined,
      });
      if (offTracks.length > 1) setChaptersText(chapters);
      setStatus(`${plan.label} 渲染完成、檔案已存到你選的位置`);
    } catch (e) {
      const msg = (e as Error)?.message || "";
      setStatus(msg.includes("取消") ? "已取消渲染" : `渲染失敗：${msg.slice(0, 100)}`);
    } finally {
      setRenderPct(-1);
      offlineActiveRef.current = false;
    }
  };

  const downloadChapters = () => {
    const blob = new Blob([chaptersText], { type: "text/plain" });
    const aEl = document.createElement("a");
    aEl.href = URL.createObjectURL(blob);
    aEl.download = "九墨-YouTube章節.txt";
    aEl.click();
  };

  // 播放條裁切：拖選一段 → clip{start,end}；點一下=seek；clip 存在時拖兩端把手微調
  const barFrac = (clientX: number) => {
    const el = barElRef.current; if (!el) return 0;
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  };
  const onBarPointerDown = (e: ReactPointerEvent) => {
    const a = audioRef.current; const el = barElRef.current;
    if (!a?.loaded || !a.duration || !isFinite(a.duration) || !el) return;
    el.setPointerCapture?.(e.pointerId);
    const frac = barFrac(e.clientX), sec = frac * a.duration, cl = clipRef.current;
    let mode: "new" | "start" | "end" = "new";
    if (cl) { // 靠近既有把手(±10px)就拖那一端，否則拖出新範圍
      const tol = 10 / el.getBoundingClientRect().width;
      if (Math.abs(frac - cl.start / a.duration) < tol) mode = "start";
      else if (Math.abs(frac - cl.end / a.duration) < tol) mode = "end";
    }
    trimDragRef.current = { mode, anchor: sec, moved: false };
  };
  const onBarPointerMove = (e: ReactPointerEvent) => {
    const d = trimDragRef.current, a = audioRef.current;
    if (!d || !a?.duration || !isFinite(a.duration)) return;
    const sec = barFrac(e.clientX) * a.duration;
    if (Math.abs(sec - d.anchor) > 0.15) d.moved = true;
    if (d.mode === "new") { if (d.moved) setClip({ start: Math.min(d.anchor, sec), end: Math.max(d.anchor, sec) }); }
    else if (d.mode === "start") setClip((c) => c ? { start: Math.min(sec, c.end - 0.3), end: c.end } : c);
    else setClip((c) => c ? { start: c.start, end: Math.max(sec, c.start + 0.3) } : c);
  };
  const onBarPointerUp = (e: ReactPointerEvent) => {
    const d = trimDragRef.current; trimDragRef.current = null;
    if (d && d.mode === "new" && !d.moved) audioRef.current?.seek(d.anchor); // 沒拖動=純點擊→seek
  };

  const switchEffect = (id: string) => {
    const e = EFFECTS.find((x) => x.id === id) || EFFECTS[0];
    setEffectId(id);
    setParams(defaultsOf(e));
    setVisualFxId(null); // 選墨韻 → 退出 2D 視效
    setGpuFxId(null);    // 也退出 GPU 光效
  };
  const setSlot = (slot: keyof Omit<Palette, "name">, hex: string) => {
    setPalette((p) => ({ ...p, name: "自訂", [slot]: hex }));
  };

  const activeEffect = EFFECTS.find((e) => e.id === effectId) || EFFECTS[0];

  return (
    <div className="min-h-screen bg-[#0a0809] text-white/85 pt-20 pb-8 px-4">
      <style dangerouslySetInnerHTML={{ __html: FONT_FACE_CSS }} />
      <div className="max-w-[1500px] mx-auto">
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <h1 className="text-base tracking-[0.35em] text-white/85 mr-2">九 墨 Studio</h1>
          <span className="text-[10px] text-white/30 tracking-widest border border-white/15 rounded-full px-2 py-0.5">Beta</span>
          <div className="flex-1" />
          <button type="button" className={`${BTN} ${orientation === "landscape" ? "border-white/45 text-white" : ""}`} onClick={() => setOrientation("landscape")}>16:9</button>
          <button type="button" className={`${BTN} ${orientation === "portrait" ? "border-white/45 text-white" : ""}`} onClick={() => setOrientation("portrait")}>9:16</button>
          <button type="button" className={`${BTN} ${orientation === "wide" ? "border-white/45 text-white" : ""}`} onClick={() => setOrientation("wide")}>2:1</button>
          <button type="button" className={`${BTN} ${orientation === "square" ? "border-white/45 text-white" : ""}`} onClick={() => setOrientation("square")}>1:1</button>
          <button type="button" className={`${BTN} ${resolution === "720" ? "border-white/45 text-white" : ""}`} onClick={() => setResolution("720")}>720p</button>
          <button type="button" className={`${BTN} ${resolution === "1080" ? "border-white/45 text-white" : ""}`} onClick={() => setResolution("1080")}>1080p</button>
          <button type="button" className={BTN} onClick={() => { const c = coreRef.current; if (c) testDrop(c, mutRef.current.effect, mutRef.current.palette, mutRef.current.paperMode); }}>試滴一墨</button>
          <button type="button" className={BTN} onClick={togglePlay}>{playing ? "⏸ 暫停" : "▶ 預覽"}</button>
          <button type="button" className={`${BTN} inline-flex items-center gap-1`} onClick={toggleFullscreen} title="全螢幕預覽"><Maximize size={13} /> 全螢幕</button>
          <button type="button" className={`${BTN} inline-flex items-center gap-1`} onClick={() => setShowHelp(true)} title="使用說明"><HelpCircle size={13} /> 說明</button>
          <button type="button" className={`${BTN} border-amber-200/45 text-amber-100 inline-flex items-center gap-1 ${recording || renderPct >= 0 ? "border-red-400/60 text-red-200" : ""}`} onClick={() => setExportOpen(true)}>
            <Film size={13} /> {recording ? "錄製中" : renderPct >= 0 ? `渲染 ${renderPct}%` : clip ? "輸出此段" : "輸出"}
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[300px_minmax(0,1fr)_360px] gap-4 items-start">
          {/* 左欄：7 模組 icon rail + 模組面板（vizzy 風） */}
          <div className="flex gap-2 lg:max-h-[calc(100vh-9rem)]">
            <div className="flex flex-col gap-1 shrink-0 pt-0.5">
              {LEFT_MODULES.map((mod) => {
                const Icon = mod.icon;
                return (
                  <button key={mod.id} type="button" title={mod.label} onClick={() => setLeftModule(mod.id)}
                    className={`flex flex-col items-center gap-0.5 w-11 py-1.5 rounded-lg border transition cursor-pointer ${leftModule === mod.id ? "border-white/40 bg-white/[0.07] text-white" : "border-transparent text-white/45 hover:text-white/80 hover:bg-white/[0.04]"}`}>
                    <Icon size={16} /><span className="text-[9px]">{mod.label}</span>
                  </button>
                );
              })}
              {/* 封面製作（分析下方）：開獨立 overlay 編輯器 */}
              <div className="h-px bg-white/10 my-1 mx-1.5" />
              <button type="button" title="封面製作" onClick={() => setCoverOpen(true)}
                className="flex flex-col items-center gap-0.5 w-11 py-1.5 rounded-lg border border-transparent text-white/45 hover:text-white/80 hover:bg-white/[0.04] transition cursor-pointer">
                <Frame size={16} /><span className="text-[9px]">封面</span>
              </button>
            </div>
            <div className="flex-1 min-w-0 space-y-3 overflow-y-auto pr-0.5">
              {leftModule === "composition" && (
            <LayerTree
              composition={composition}
              selectedId={selectedLayerId}
              onSelect={setSelectedLayerId}
              onAdd={addLayer}
              onRemove={deleteLayer}
              onToggleVisible={(id) => setComposition((c) => toggleLayerVisible(c, id))}
              onRename={(id, name) => setComposition((c) => updateLayer(c, id, { name }))}
              onReorder={reorderLayer}
            />
              )}
              {leftModule === "media" && (<>

            <div className="bg-white/[0.03] rounded-xl p-3 space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-[11px] text-white/40 tracking-wider">歌單（多首 = 長影片）</p>
                <button type="button" className="text-[11px] text-white/55 hover:text-white border border-white/15 hover:border-white/40 rounded-full px-2 py-0.5 transition" onClick={() => audioFileRef.current?.click()}>＋ 加歌</button>
              </div>
              <input ref={audioFileRef} type="file" accept="audio/*" multiple className="hidden"
                onChange={(e) => { if (e.target.files?.length) addAudioFiles(e.target.files); e.target.value = ""; }} />
              <input ref={lrcFileRef} type="file" accept=".lrc,.srt" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; const id = pendingLrcRef.current; if (f && id) bindLrc(id, f); e.target.value = ""; }} />
              {tracks.length === 0 && (
                <div
                  className="rounded-lg border border-dashed border-white/15 hover:border-white/35 p-4 text-center cursor-pointer transition"
                  onClick={() => audioFileRef.current?.click()}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => { e.preventDefault(); if (e.dataTransfer.files?.length) addAudioFiles(e.dataTransfer.files); }}
                >
                  <p className="text-white/40 text-[12px]">🎵 拖音檔進來（可多選）</p>
                </div>
              )}
              <div className="space-y-1.5 max-h-60 overflow-y-auto pr-0.5">
                {tracks.map((t, i) => (
                  <div key={t.id}
                    className={`rounded-lg border p-2 cursor-pointer transition ${i === currentIdx ? "border-white/35 bg-white/[0.05]" : "border-white/10 hover:border-white/25"}`}
                    onClick={() => loadTrack(i)}
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] text-white/30 w-4">{i + 1}</span>
                      <input
                        type="text" value={t.title}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => setTracks((prev) => { const next = prev.map((x) => x.id === t.id ? { ...x, title: e.target.value } : x); tracksRef.current = next; return next; })}
                        className="flex-1 min-w-0 bg-transparent text-[12px] text-white/80 outline-none border-b border-transparent focus:border-white/20"
                      />
                      <button type="button" className="text-white/25 hover:text-red-300 text-[12px] px-1" onClick={(e) => { e.stopPropagation(); removeTrack(t.id); }}>×</button>
                    </div>
                    <div className="flex items-center gap-2 mt-1 pl-5">
                      <span className="text-[10px] text-white/30 truncate flex-1">{t.lrcName || "未綁歌詞"}</span>
                      <button type="button" className="text-[10px] text-white/45 hover:text-white border border-white/15 rounded-full px-1.5 transition"
                        onClick={(e) => { e.stopPropagation(); pendingLrcRef.current = t.id; lrcFileRef.current?.click(); }}>
                        綁 LRC
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-white/[0.03] rounded-xl p-3 space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-[11px] text-white/40 tracking-wider">墨體（剪影活在墨裡）</p>
                {body ? (
                  <button type="button" className="text-[11px] text-white/45 hover:text-red-300 px-1" onClick={removeBody}>移除</button>
                ) : (
                  <button type="button" className="text-[11px] text-white/55 hover:text-white border border-white/15 hover:border-white/40 rounded-full px-2 py-0.5 transition" onClick={() => bodyFileRef.current?.click()}>＋ 放入</button>
                )}
              </div>
              <input ref={bodyFileRef} type="file" accept="image/*" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void loadBody(f); e.target.value = ""; }} />
              {!body && (
                <div className="space-y-2">
                  <div className="grid grid-cols-2 gap-1.5">
                    {BODY_PRESETS.filter((bp) => bp.id === "koi").map((bp) => (
                      <button key={bp.id} type="button"
                        className="px-2 py-1.5 rounded-lg text-[12px] border border-white/15 text-white/65 hover:text-white hover:border-white/40 transition cursor-pointer"
                        onClick={() => loadPreset(bp.id)}>
                        {bp.name}
                      </button>
                    ))}
                  </div>
                  <p className="text-[10px] text-white/25 leading-relaxed">牠們會在墨裡游動呼吸。也可以「＋ 放入」自己的黑剪影圖</p>
                </div>
              )}
              {body && (
                <div className="space-y-2">
                  <p className="text-[10px] text-white/35 truncate">{body.name}</p>
                  {([["size", "大小", 0.1, 0.9], ["x", "水平", 0.05, 0.95], ["y", "垂直", 0.05, 0.95], ["amount", "濃度", 0.2, 2.5], ["wiggle", "活性", 0, 1]] as const).map(([key, label, min, max]) => (
                    <div key={key}>
                      <label className="text-[10px] text-white/40 flex justify-between"><span>{label}</span><span className="text-white/55">{body[key].toFixed(2)}</span></label>
                      <input type="range" min={min} max={max} step={0.01} value={body[key]}
                        onChange={(e) => setBody((b) => b ? { ...b, [key]: parseFloat(e.target.value) } : b)}
                        className="w-full accent-red-400" />
                    </div>
                  ))}
                  <div className="flex gap-3">
                    <label className="flex items-center gap-1.5 text-[11px] text-white/60 cursor-pointer select-none">
                      <input type="checkbox" checked={body.drift} onChange={(e) => setBody((b) => b ? { ...b, drift: e.target.checked } : b)} className="accent-red-400" /> 漂移
                    </label>
                    <label className="flex items-center gap-1.5 text-[11px] text-white/60 cursor-pointer select-none">
                      <input type="checkbox" checked={body.pulse} onChange={(e) => setBody((b) => b ? { ...b, pulse: e.target.checked } : b)} className="accent-red-400" /> 隨樂律動
                    </label>
                  </div>
                  {body.colors && (
                    <div>
                      <label className="text-[10px] text-white/40 block mb-1">錦鯉純色（單選）</label>
                      <div className="flex gap-2">
                        {KOI_COLOR_LIST.map((c) => {
                          const on = body.colors?.[0] === c.key;
                          return (
                            <button key={c.key} type="button" title={c.label}
                              onClick={() => setBody((b) => b ? { ...b, colors: [c.key] } : b)}
                              className={`flex flex-col items-center gap-1 transition ${on ? "" : "opacity-55 hover:opacity-90"}`}>
                              <span className={`w-7 h-7 rounded-full border-2 ${on ? "border-white/90 scale-110 shadow" : "border-white/15"}`} style={{ background: c.hex }} />
                              <span className="text-[9px] text-white/45">{c.label}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
              </>)}
              {leftModule === "lyrics" && (<>

            <div className="bg-white/[0.03] rounded-xl p-3 space-y-3">
              {/* 「目前歌名」欄位已移除：檔名／章節自動沿用歌單裡的歌名（title 仍在背景同步） */}
              <div>
                <label className="text-[11px] text-white/40 tracking-wider">歌詞字體</label>
                <select
                  value={fontId} onChange={(e) => setFontId(e.target.value as LyricFontId)}
                  className="w-full mt-1 bg-black/40 border border-white/10 rounded-lg px-3 py-1.5 text-[13px] outline-none focus:border-white/30"
                >
                  {LYRIC_FONTS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
                </select>
              </div>
              <p className="text-[10px] text-white/30 leading-relaxed">落款印章與歌名顯示已改成圖層：左欄選「落款」可改印章文字/拖位置、選「歌名」文字層打歌名。</p>
            </div>
              </>)}

              {leftModule === "projects" && (
                <ProjectsPanel onSave={saveCurrentProject} onLoad={loadProjectById} />
              )}
              {leftModule === "effects" && (
                <div className="bg-white/[0.03] rounded-xl p-3 space-y-2">
                  <p className="text-[11px] text-white/40 tracking-wider">特效</p>
                  <p className="text-[10px] text-white/35 leading-relaxed">效果＝圖層：在「組成」加墨效層，選中後右欄出現分類效果縮圖牆與細部調整。全畫面後製濾鏡模組規劃中。</p>
                </div>
              )}
              {leftModule === "automations" && (
                <div className="bg-white/[0.03] rounded-xl p-3 space-y-2">
                  <p className="text-[11px] text-white/40 tracking-wider">自動化 · 關鍵影格{selectedLayer ? <span className="text-white/25"> · {selectedLayer.name}</span> : null}</p>
                  <AutomationsPanel
                    layer={selectedLayer}
                    getTime={() => audioRef.current?.currentTime ?? 0}
                    onChange={patchAutomations}
                    onBind={patchBindings}
                  />
                </div>
              )}
              {leftModule === "analyzers" && (
                <div className="bg-white/[0.03] rounded-xl p-3 space-y-3">
                  <p className="text-[11px] text-white/40 tracking-wider">音訊分析</p>
                  <div>
                    <label className="text-[11px] text-white/45 tracking-wider flex justify-between">
                      <span>偵測門檻（噪音地板）</span><span className="text-white/65">{noiseFloor} dB</span>
                    </label>
                    <input type="range" min={-95} max={-45} step={1} value={noiseFloor}
                      onChange={(e) => setNoiseFloor(parseInt(e.target.value))} className="w-full accent-red-400" />
                    <p className="text-[10px] text-white/30 leading-relaxed mt-1">
                      往右（高）＝更選擇性，只有夠大聲的人聲/鼓/主奏才衝上來、其餘趴下；往左（低）＝連微弱泛音都偵測（較滿軌）。預設 −66。
                    </p>
                  </div>
                </div>
              )}

              <p className="text-[10px] text-white/25 leading-relaxed px-1">{status}</p>
            </div>
          </div>

          {/* 中央：舞台 */}
          <div className="flex flex-col items-center gap-2 min-w-0">
            {unsupported ? (
              <div className="aspect-video w-full flex items-center justify-center rounded-xl bg-black/40">
                <p className="text-white/50 text-sm text-center px-8">這個瀏覽器不支援 WebGL2、換 Chrome / Safari / Edge 近期版本再來</p>
              </div>
            ) : (
              <canvas ref={stageRef} className="rounded-xl max-w-full" style={{ maxHeight: "72vh" }} />
            )}
            <div className="w-full flex flex-col gap-1 px-1">
              <div className="w-full flex items-center gap-3">
                <div ref={barElRef}
                  className="relative flex-1 h-2 rounded-full bg-white/8 cursor-pointer select-none touch-none"
                  onPointerDown={onBarPointerDown} onPointerMove={onBarPointerMove} onPointerUp={onBarPointerUp}
                  title="點一下跳到該處；左右拖曳選一段要輸出的範圍（如副歌）"
                >
                  <div ref={progressRef} className="absolute inset-y-0 left-0 bg-[#c43c30] rounded-full transition-none" style={{ width: "0%" }} />
                  {clip && duration > 0 && (
                    <>
                      <div className="absolute inset-y-0 bg-amber-300/20 border-x-2 border-amber-300/80 pointer-events-none"
                        style={{ left: `${(clip.start / duration) * 100}%`, width: `${((clip.end - clip.start) / duration) * 100}%` }} />
                      <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-2 h-4 rounded-sm bg-amber-300 shadow cursor-ew-resize"
                        style={{ left: `${(clip.start / duration) * 100}%` }} />
                      <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-2 h-4 rounded-sm bg-amber-300 shadow cursor-ew-resize"
                        style={{ left: `${(clip.end / duration) * 100}%` }} />
                    </>
                  )}
                </div>
                <span ref={timeRef} className="text-[11px] text-white/35 tabular-nums">0:00 / 0:00</span>
              </div>
              {clip && (
                <div className="flex items-center gap-2 text-[11px] text-amber-300/90 tabular-nums pl-0.5">
                  <span>✂ 只輸出此段 {fmtTime(clip.start)}–{fmtTime(clip.end)}（{fmtTime(clip.end - clip.start)}）</span>
                  <button type="button" onClick={() => setClip(null)} className="text-amber-300/55 hover:text-amber-200 underline-offset-2 hover:underline" title="清除裁切，恢復整首輸出">清除</button>
                </div>
              )}
            </div>
          </div>

          {/* 右欄：選中圖層的細節（vizzy 風縮圖牆 + 屬性，可滾動） */}
          <div className="space-y-3 lg:max-h-[calc(100vh-9rem)] lg:overflow-y-auto pr-1">
            {selectedLayer?.type === "effect" && (
              <div className="bg-white/[0.03] rounded-xl p-3">
                <p className="text-[11px] text-white/40 tracking-wider mb-2">效果（點選即套用）</p>
                <EffectPicker
                  inkEffects={EFFECTS}
                  inkSelectedId={effectId}
                  visualSelectedId={visualFxId}
                  gpuSelectedId={gpuFxId}
                  palette={palette}
                  onSelectInk={switchEffect}
                  onSelectGpu={selectGpu}
                  presets={presets}
                  onSavePreset={saveCurrentPreset}
                  onApplyPreset={applyPreset}
                  onDeletePreset={removePreset}
                />
              </div>
            )}

            <LayerInspector
              layer={selectedLayer}
              duration={duration}
              onPatchParams={patchParams}
              onPatchTransform={patchTransform}
              onPatchTiming={patchTiming}
              onUpload={uploadToLayer}
              onEditLyrics={() => {
                const hasOwn = selectedLayer?.type === "lyrics" && selectedLayer.params.lines.length > 0;
                if (!hasOwn && !tracksRef.current.length) { setStatus("先加歌綁歌詞，或在這層綁一組 LRC 再編秒數"); return; }
                setLyricEditorOpen(true);
              }}
            />

            {selectedLayer?.type === "effect" && (
              <>
                <Collapsible title="墨色 · 紙色">
                  <p className="text-[11px] text-white/40 tracking-wider">紙色</p>
                  <div className="flex gap-2">
                    <button type="button" className={`${BTN} flex-1 ${paperMode === "xuan" ? "border-white/50 text-white" : ""}`} onClick={() => applyPaper("xuan")}>宣紙</button>
                    <button type="button" className={`${BTN} flex-1 ${paperMode === "night" ? "border-white/50 text-white" : ""}`} onClick={() => applyPaper("night")}>夜紙</button>
                  </div>
                  <p className="text-[11px] text-white/40 tracking-wider pt-1">墨色（{autoColor ? "自動變色" : palette.name}）</p>
                  <label className="flex items-center gap-1.5 text-[11px] text-white/65 cursor-pointer select-none">
                    <input type="checkbox" checked={autoColor} className="accent-red-400"
                      onChange={(e) => setAutoColor(e.target.checked)} />
                    🎨 自動變色（播放時循環跑過所有配色）
                  </label>
                  {autoColor && <p className="text-[10px] text-white/30">墨色會沿下方四組配色平滑循環換色。下方手動色＝關掉自動變色時用的固定色。</p>}
                  <div className={`flex flex-wrap gap-1.5 ${autoColor ? "opacity-40" : ""}`}>
                    {PRESET_PALETTES.map((p) => (
                      <button key={p.name} type="button" onClick={() => setPalette(p)}
                        className={`px-2.5 py-1 rounded-full text-[11px] border transition cursor-pointer ${palette.name === p.name ? "border-white/50 text-white" : "border-white/15 text-white/55 hover:border-white/35"}`}>
                        <span className="inline-flex items-center gap-1">
                          <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: p.secondary }} />
                          {p.name}
                        </span>
                      </button>
                    ))}
                  </div>
                  <div className="grid grid-cols-3 gap-2 pt-1">
                    {(["primary", "secondary", "accent"] as const).map((slot) => (
                      <label key={slot} className="text-center cursor-pointer">
                        <input type="color" value={palette[slot]} onChange={(e) => setSlot(slot, e.target.value)}
                          className="w-full h-9 rounded-lg border border-white/15 bg-transparent cursor-pointer" />
                        <span className="text-[10px] text-white/40 block mt-1">{slot === "primary" ? "主色" : slot === "secondary" ? "輔色" : "對比色"}</span>
                      </label>
                    ))}
                  </div>
                  <p className="text-[10px] text-white/25">對比色給高低音突發插色用</p>
                </Collapsible>

                {visualFxId || gpuFxId ? (
                  // 非墨效果：只給真正吃得到的參數（墨量/流速/墨壽命對光效無作用）
                  <Collapsible title="光效參數">
                    <div>
                      <label className="text-[11px] text-white/40 tracking-wider flex justify-between">
                        <span>感應靈敏度</span><span className="text-white/60">{((params.sens as number) ?? 1).toFixed(1)}</span>
                      </label>
                      <input type="range" min={0.5} max={3} step={0.1} value={(params.sens as number) ?? 1}
                        onChange={(e) => setParams((p) => ({ ...p, sens: parseFloat(e.target.value) }))} className="w-full accent-red-400" />
                    </div>
                    {gpuFxId && (
                      <>
                        <div>
                          <label className="text-[11px] text-white/40 tracking-wider flex justify-between">
                            <span>泛光強度</span><span className="text-white/60">{Math.round(((params.bloom as number) ?? 1.35) * 100)}%</span>
                          </label>
                          <input type="range" min={0} max={2.5} step={0.05} value={(params.bloom as number) ?? 1.35}
                            onChange={(e) => setParams((p) => ({ ...p, bloom: parseFloat(e.target.value) }))} className="w-full accent-red-400" />
                        </div>
                        <div>
                          <label className="text-[11px] text-white/40 tracking-wider flex justify-between">
                            <span>整體亮度</span><span className="text-white/60">{Math.round(((params.gain as number) ?? 1) * 100)}%</span>
                          </label>
                          <input type="range" min={0.3} max={2.5} step={0.05} value={(params.gain as number) ?? 1}
                            onChange={(e) => setParams((p) => ({ ...p, gain: parseFloat(e.target.value) }))} className="w-full accent-red-400" />
                        </div>
                        <div>
                          <label className="text-[11px] text-white/40 tracking-wider flex justify-between">
                            <span>高低頻平衡</span><span className="text-white/60">{(() => { const b = (params.balance as number) ?? 0; return b === 0 ? "中性" : `${b > 0 ? "高頻" : "低頻"} ${Math.round(Math.abs(b) * 100)}%`; })()}</span>
                          </label>
                          <input type="range" min={-1} max={1} step={0.05} value={(params.balance as number) ?? 0}
                            onChange={(e) => setParams((p) => ({ ...p, balance: parseFloat(e.target.value) }))} className="w-full accent-red-400" />
                        </div>
                        {["gv-spectrum", "gv-dots", "gv-wave"].includes(gpuFxId) && (
                          <div>
                            <label className="text-[11px] text-white/40 tracking-wider flex justify-between">
                              <span>{gpuFxId === "gv-wave" ? "線寬" : gpuFxId === "gv-dots" ? "點大小" : "條寬"}</span><span className="text-white/60">{Math.round(((params.width as number) ?? 1) * 100)}%</span>
                            </label>
                            <input type="range" min={0.3} max={2} step={0.05} value={(params.width as number) ?? 1}
                              onChange={(e) => setParams((p) => ({ ...p, width: parseFloat(e.target.value) }))} className="w-full accent-red-400" />
                          </div>
                        )}
                        {["gv-spectrum", "gv-dots"].includes(gpuFxId) && (
                          <div>
                            <label className="text-[11px] text-white/40 tracking-wider flex justify-between">
                              <span>間距（疏密）</span><span className="text-white/60">{Math.round(((params.spacing as number) ?? 1) * 100)}%</span>
                            </label>
                            <input type="range" min={0.5} max={2.5} step={0.05} value={(params.spacing as number) ?? 1}
                              onChange={(e) => setParams((p) => ({ ...p, spacing: parseFloat(e.target.value) }))} className="w-full accent-red-400" />
                          </div>
                        )}
                        {["gv-spectrum", "gv-dots", "gv-wave"].includes(gpuFxId) && (
                          <>
                            <div>
                              <label className="text-[11px] text-white/40 tracking-wider block mb-1">頻率分布</label>
                              <select value={(params.scale as number) ?? 0}
                                onChange={(e) => setParams((p) => ({ ...p, scale: parseInt(e.target.value) }))}
                                className="w-full bg-white/5 border border-white/15 rounded px-2 py-1 text-[12px] text-white/80">
                                <option value={0}>對數 Log（預設）</option>
                                <option value={1}>線性 Linear</option>
                                <option value={2}>Bark（人耳臨界頻帶）</option>
                                <option value={3}>Mel（梅爾音高）</option>
                              </select>
                            </div>
                            <div>
                              <label className="text-[11px] text-white/40 tracking-wider block mb-1">加權（高低曲線）</label>
                              <select value={(params.weight as number) ?? 0}
                                onChange={(e) => setParams((p) => ({ ...p, weight: parseInt(e.target.value) }))}
                                className="w-full bg-white/5 border border-white/15 rounded px-2 py-1 text-[12px] text-white/80">
                                <option value={0}>預設（九墨）</option>
                                <option value={1}>A 加權（壓低頻）</option>
                                <option value={2}>B 加權</option>
                                <option value={3}>C 加權（近平坦）</option>
                              </select>
                            </div>
                          </>
                        )}
                        {gpuFxId === "gv-spectrum" && (
                          <>
                            <div>
                              <label className="text-[11px] text-white/40 tracking-wider block mb-1">形狀</label>
                              <select value={(params.shape as number) ?? 1}
                                onChange={(e) => setParams((p) => ({ ...p, shape: parseInt(e.target.value) }))}
                                className="w-full bg-white/5 border border-white/15 rounded px-2 py-1 text-[12px] text-white/80">
                                <option value={0}>曲線 Curve</option>
                                <option value={1}>長條 Bars</option>
                                <option value={2}>分段條 Stepped Bars</option>
                                <option value={3}>電平表 Level Meter</option>
                                <option value={4}>分段電平表 Stepped Level Meter</option>
                              </select>
                            </div>
                            <label className="flex items-center gap-2 text-[12px] text-white/60 cursor-pointer select-none">
                              <input type="checkbox" checked={(params.radial as boolean) ?? false}
                                onChange={(e) => setParams((p) => ({ ...p, radial: e.target.checked }))} className="accent-red-400" />
                              環狀（圓形放射）
                            </label>
                            {(params.radial as boolean) && (
                              <div>
                                <label className="text-[11px] text-white/40 tracking-wider flex justify-between">
                                  <span>旋轉速度</span><span className="text-white/60">{(() => { const s = (params.spin as number) ?? 0; return s === 0 ? "靜止" : `${s > 0 ? "順" : "逆"} ${Math.abs(s).toFixed(2)}`; })()}</span>
                                </label>
                                <input type="range" min={-2} max={2} step={0.05} value={(params.spin as number) ?? 0}
                                  onChange={(e) => setParams((p) => ({ ...p, spin: parseFloat(e.target.value) }))} className="w-full accent-red-400" />
                              </div>
                            )}
                            <label className="flex items-center gap-2 text-[12px] text-white/60 cursor-pointer select-none">
                              <input type="checkbox" checked={(params.mirrorV as boolean) ?? false}
                                onChange={(e) => setParams((p) => ({ ...p, mirrorV: e.target.checked }))} className="accent-red-400" />
                              上下鏡像
                            </label>
                            <label className="flex items-center gap-2 text-[12px] text-white/60 cursor-pointer select-none">
                              <input type="checkbox" checked={(params.mirrorH as boolean) ?? false}
                                onChange={(e) => setParams((p) => ({ ...p, mirrorH: e.target.checked }))} className="accent-red-400" />
                              左右鏡像
                            </label>
                            <label className="flex items-center gap-2 text-[12px] text-white/60 cursor-pointer select-none">
                              <input type="checkbox" checked={(params.outline as boolean) ?? false}
                                onChange={(e) => setParams((p) => ({ ...p, outline: e.target.checked }))} className="accent-red-400" />
                              鏤空描邊（長條）
                            </label>
                            <label className="flex items-center gap-2 text-[12px] text-white/60 cursor-pointer select-none">
                              <input type="checkbox" checked={(params.peakOn as boolean) ?? false}
                                onChange={(e) => setParams((p) => ({ ...p, peakOn: e.target.checked }))} className="accent-red-400" />
                              峰頂浮標
                            </label>
                            {!(params.radial as boolean) && (
                              <div>
                                <label className="text-[11px] text-white/40 tracking-wider flex justify-between">
                                  <span>水面倒影</span><span className="text-white/60">{(() => { const r = (params.reflex as number) ?? 0; return r < 0.01 ? "關" : `${Math.round(r * 100)}%`; })()}</span>
                                </label>
                                <input type="range" min={0} max={1} step={0.02} value={(params.reflex as number) ?? 0}
                                  onChange={(e) => setParams((p) => ({ ...p, reflex: parseFloat(e.target.value) }))} className="w-full accent-red-400" />
                              </div>
                            )}
                            <div>
                              <label className="text-[11px] text-white/40 tracking-wider flex justify-between">
                                <span>峰頂高度</span><span className="text-white/60">{Math.round(((params.cap as number) ?? 0.55) * 100)}%</span>
                              </label>
                              <input type="range" min={0.15} max={0.85} step={0.01} value={(params.cap as number) ?? 0.55}
                                onChange={(e) => setParams((p) => ({ ...p, cap: parseFloat(e.target.value) }))} className="w-full accent-red-400" />
                            </div>
                            <div>
                              <label className="text-[11px] text-white/40 tracking-wider flex justify-between">
                                <span>平滑 Smoothing</span><span className="text-white/60">{(() => { const s = (params.smoothing as number) ?? 0.6; return s < 0.03 ? "無" : `${Math.round(s * 100)}%`; })()}</span>
                              </label>
                              <input type="range" min={0} max={0.95} step={0.01} value={(params.smoothing as number) ?? 0.6}
                                onChange={(e) => setParams((p) => ({ ...p, smoothing: parseFloat(e.target.value) }))} className="w-full accent-red-400" />
                            </div>
                            <div>
                              <label className="text-[11px] text-white/40 tracking-wider block mb-1">聲道</label>
                              <select value={(params.channel as number) ?? 0}
                                onChange={(e) => setParams((p) => ({ ...p, channel: parseInt(e.target.value) }))}
                                className="w-full bg-white/5 border border-white/15 rounded px-2 py-1 text-[12px] text-white/80">
                                <option value={0}>混合 Mix</option>
                                <option value={1}>左聲道 Left</option>
                                <option value={2}>右聲道 Right</option>
                                <option value={3}>左右分離 Split</option>
                              </select>
                            </div>
                          </>
                        )}
                      </>
                    )}
                    <p className="text-[10px] text-white/25 leading-relaxed">
                      {gpuFxId ? "墨量 / 流速 / 墨壽命是墨系列專用、對光效沒作用，光效用這三個就好。" : "這個效果只吃靈敏度；想要泛光、亮度請改用上面的光效。"}
                    </p>
                  </Collapsible>
                ) : (
                  <Collapsible title={`${activeEffect.name}參數`}>
                    {activeEffect.paramSchema.map((def) =>
                      def.type === "range" ? (
                        <div key={def.key}>
                          <label className="text-[11px] text-white/40 tracking-wider flex justify-between">
                            <span>{def.label}</span>
                            <span className="text-white/60">{params[def.key]}{def.suffix || ""}</span>
                          </label>
                          <input type="range" min={def.min} max={def.max} step={def.step} value={params[def.key] as number}
                            onChange={(e) => setParams((p) => ({ ...p, [def.key]: parseFloat(e.target.value) }))}
                            className="w-full accent-red-400" />
                        </div>
                      ) : (
                        <label key={def.key} className="flex items-center gap-2 text-[12px] text-white/60 cursor-pointer select-none">
                          <input type="checkbox" checked={params[def.key] as boolean}
                            onChange={(e) => setParams((p) => ({ ...p, [def.key]: e.target.checked }))} className="accent-red-400" />
                          {def.label}
                        </label>
                      )
                    )}
                  </Collapsible>
                )}

                {(visualFxId || gpuFxId) && selectedLayer.transform && (
                  <Collapsible title="視效位置 · 大小">
                    {([
                      { k: "x" as const, label: "水平位置", min: 0, max: 1, def: 0.5, pct: true },
                      { k: "y" as const, label: "垂直位置", min: 0, max: 1, def: 0.5, pct: true },
                      { k: "w" as const, label: "寬度", min: 0.1, max: 1, def: 1, pct: true },
                      { k: "h" as const, label: "高度", min: 0.1, max: 1, def: 1, pct: true },
                    ]).map((s) => {
                      const val = (selectedLayer.transform?.[s.k] ?? s.def) as number;
                      return (
                        <div key={s.k}>
                          <label className="text-[11px] text-white/40 tracking-wider flex justify-between">
                            <span>{s.label}</span>
                            <span className="text-white/60">{Math.round(val * 100)}%</span>
                          </label>
                          <input type="range" min={s.min} max={s.max} step={0.01} value={val}
                            onChange={(e) => patchTransform(selectedLayer.id, { [s.k]: parseFloat(e.target.value) })}
                            className="w-full accent-red-400" />
                        </div>
                      );
                    })}
                    <div>
                      <label className="text-[11px] text-white/40 tracking-wider flex justify-between">
                        <span>旋轉角度</span>
                        <span className="text-white/60">{Math.round(selectedLayer.transform?.rot ?? 0)}°</span>
                      </label>
                      <input type="range" min={-180} max={180} step={1} value={selectedLayer.transform?.rot ?? 0}
                        onChange={(e) => patchTransform(selectedLayer.id, { rot: parseFloat(e.target.value) })}
                        className="w-full accent-red-400" />
                    </div>
                    <button type="button" onClick={() => patchTransform(selectedLayer.id, { x: 0.5, y: 0.5, w: 1, h: 1, rot: 0 })}
                      className="text-[10px] text-white/45 border border-white/15 rounded-full px-2.5 py-1 hover:border-white/35 hover:text-white/80 transition">
                      重設為全螢幕
                    </button>
                  </Collapsible>
                )}
              </>
            )}
          </div>

        </div>

        <Timeline
          composition={composition}
          duration={duration}
          selectedId={selectedLayerId}
          onSelect={setSelectedLayerId}
          onChangeTiming={patchTiming}
          getCurrentTime={() => audioRef.current?.currentTime || 0}
          onSeek={(t) => audioRef.current?.seek(t)}
          peaks={peaks}
          volume={volume}
          onVolume={setVolume}
          loop={loop}
          onLoopChange={setLoop}
        />
      </div>

      {lyricEditorOpen && (() => {
        const lyrLayer = selectedLayer?.type === "lyrics" ? selectedLayer : null;
        const ownLines = !!lyrLayer && lyrLayer.params.lines.length > 0;
        return (
          <LyricEditor
            title={ownLines ? lyrLayer!.name : tracks[currentIdx]?.title || ""}
            lines={ownLines ? lyrLayer!.params.lines : tracks[currentIdx]?.lrc || []}
            getCurrentTime={() => audioRef.current?.currentTime || 0}
            onSeek={(t) => audioRef.current?.seek(t)}
            onChange={(lines) => {
              if (ownLines && lyrLayer) {
                patchParams(lyrLayer.id, { lines });
              } else {
                setTracks((prev) => {
                  const next = prev.map((t, i) => (i === currentIdx ? { ...t, lrc: lines, lrcName: `已編輯（${lines.length} 句）` } : t));
                  tracksRef.current = next;
                  return next;
                });
                scrollerRef.current.setLines(lines);
              }
            }}
            onClose={() => setLyricEditorOpen(false)}
          />
        );
      })()}

      {exportOpen && (
        <ExportPanel
          orientation={orientation}
          resolution={resolution}
          onResolution={setResolution}
          fps={exportFps}
          onFps={setExportFps}
          duration={clip ? clip.end - clip.start : duration}
          recording={recording}
          renderPct={renderPct}
          downloadUrl={downloadUrl}
          chaptersText={chaptersText}
          title={title}
          onRecord={toggleRecord}
          onRenderMp4={renderMp4}
          onCancelRender={() => { cancelRenderRef.current = true; }}
          onDownloadChapters={downloadChapters}
          onClose={() => setExportOpen(false)}
        />
      )}

      <CoverEditor open={coverOpen} onClose={() => setCoverOpen(false)} />

      <HelpPanel open={showHelp} onClose={() => { setShowHelp(false); localStorage.setItem("jiumo-help-seen", "1"); }} />
    </div>
  );
}
