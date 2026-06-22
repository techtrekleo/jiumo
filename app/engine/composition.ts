// 九墨圖層系統 — Phase 2-1 資料模型
// composition = Layer[]（陣列即 z 序：index 0 最底先畫、末端最上後畫）。
// 每種圖層自帶對應 params（discriminated union），右欄屬性面板由 params 形狀對應生成（2-4）。
// 渲染迴圈依 type dispatch（2-3）：背景先、影片最後。
//
// 範圍備註：Composition 只管「畫面圖層樹」。專案級資料（畫面方向、歌單佇列、
// 音檔/LRC 引用、專案名）屬 Project 包裝層（Phase 2-6 IndexedDB 存檔），不在此檔。

import { EFFECTS, defaultsOf, type ParamValues } from "./effects";
import { PRESET_PALETTES, type Palette, type PaperMode } from "./palette";
import { LYRIC_FONTS, type LyricFontId, type LyricLine } from "./lyrics";

// 文字/歌詞共用：描邊 / 陰影 / 霓虹 等樣式特效
export type TextEffect = "none" | "outline" | "shadow" | "neon" | "lines";
import { BODY_PRESETS } from "./bodies";

/* ───────────────────────── 圖層型別列舉 ───────────────────────── */

export type LayerType =
  | "background" // 背景：宣紙 / 夜紙 / 自訂紙色
  | "effect" //     墨效：INK-01~06，可疊加、各自 audio mapping
  | "body" //       墨體：剪影活在墨裡（內建 preset 或上傳圖）
  | "lyrics" //     歌詞：卷軸直書，綁某首歌的 LRC
  | "text" //       文字：歌名 / 自由文字
  | "image" //      圖片：印章 / 封面 / 角色立繪
  | "seal" //       落款：紅底直書印章（內建九墨品牌章 / 使用者自訂落款），可拖可縮
  | "cta" //        CTA 訂閱動畫：拇指/訂閱/鈴鐺 + 游標依序點擊變紅（給沒做片頭的人）
  | "player" //     控制板：lofi 播放器卡（雨淋濕背景 + 圓角矩形/半圓視窗 + 旋轉唱片 + 時間軸）
  | "alpha" //      透明度層：跟音樂跳動的疊色閃動（可整張或區域），讓底下的圖閃動
  | "video"; //     影片：片頭（播完才進主視覺）/ CTA 角落小窗

/* ───────────────────────── 共用變換：位置 + 大小 ───────────────────────── */

// 每個可擺放的圖層都有：使用者拖曳移動 / 縮放統一吃這個，不再各型別各自為政。
//   x, y = 圖層中心在畫面的比例座標（0~1）；scale = 整體縮放（1 = 原始大小）。
//   背景層沒有 transform（它就是整個畫面、不移動不縮放）。
export interface Transform {
  x: number;
  y: number;
  scale: number;
  w?: number; // 寬度（佔畫布比例，0~1）；效果層用來定義「框」，媒體層用 scale。未定義＝1（全寬）
  h?: number; // 高度（佔畫布比例，0~1）；同上。未定義＝1（全高）
  rot?: number; // 旋轉角度（度，順時針）；繞框中心旋轉。未定義＝0（不轉）
}

/* ───────────────────────── 時間軸：每層的起訖秒數 ───────────────────────── */

// 控制這層在「第幾秒到第幾秒」出現。end < 0 = 一直到結尾。
// 沒有 timing（undefined）= 整首歌全程顯示。
export interface Timing {
  start: number;
  end: number;
}

/* ───────────────────────── 自動化：關鍵影格 ───────────────────────── */

// 讓任一數值參數隨時間做動畫。一條 automation 綁一個 target、含多個關鍵影格（時間→值）。
//   target 路徑：
//     "x"/"y"/"scale"/"w"/"h"      → transform 欄位
//     "value:<key>"                → effect 層 params.values（sens/bloom/gain…）
//     "filter:<filterId>"          → background 層某濾鏡的 amount（強度）
//     "opacity"                    → image/seal 層不透明度
export type Easing = "linear" | "in" | "out" | "inout";
export interface Keyframe { t: number; v: number; ease: Easing }
export interface Automation { id: string; target: string; keys: Keyframe[] }

export function genAutomationId(): string {
  return `auto-${Math.random().toString(36).slice(2, 9)}`;
}

function easeT(e: Easing, f: number): number {
  switch (e) {
    case "in": return f * f;
    case "out": return 1 - (1 - f) * (1 - f);
    case "inout": return f < 0.5 ? 2 * f * f : 1 - Math.pow(-2 * f + 2, 2) / 2;
    default: return f; // linear
  }
}

// 取某條 automation 在時間 t（秒）的插值；無關鍵影格回 null，超出範圍夾在頭/尾。
export function sampleAutomation(a: Automation, t: number): number | null {
  const k = a.keys;
  if (!k.length) return null;
  if (t <= k[0].t) return k[0].v;
  if (t >= k[k.length - 1].t) return k[k.length - 1].v;
  for (let i = 0; i < k.length - 1; i++) {
    if (t >= k[i].t && t <= k[i + 1].t) {
      const span = k[i + 1].t - k[i].t || 1;
      const f = easeT(k[i].ease, (t - k[i].t) / span);
      return k[i].v + (k[i + 1].v - k[i].v) * f;
    }
  }
  return k[k.length - 1].v;
}

/* ───────────────────────── 音訊驅動：讓參數跟著音樂 ───────────────────────── */

// 把參數綁到某個音訊頻段，渲染時用即時音量推動（不是照時間，是照「現在的音樂」）。
//   source：低音/中音/高音/節拍(打點脈衝)/音量(整體)；min=安靜時的值、max=最大聲的值、gain=靈敏度。
export type AudioSource = "bass" | "mid" | "treble" | "beat" | "level";
export interface AudioBinding { id: string; target: string; source: AudioSource; min: number; max: number; gain: number }
// 每幀的即時音訊取樣（0~1，已平滑）；level=整體響度
export interface AudioSample { bass: number; mid: number; treble: number; beat: number; level: number }

// 一個音訊綁定在當下的值：把音量（×靈敏度、夾 0~1）映射到 [min, max]
export function sampleBinding(b: AudioBinding, audio: AudioSample): number {
  const raw = audio[b.source] ?? 0;
  const a = Math.min(1, Math.max(0, raw * b.gain));
  return b.min + (b.max - b.min) * a;
}

/* ───────────────────────── 文字/字幕 進場動畫 ───────────────────────── */

// 文字/字幕出現時的進場動畫（vizzy 風）。每個 toggle 可疊加；液化/扭曲是逐字持續效果。
//   進場以「出現時刻」起算、用 inDur + easing 補間；shake 是進場瞬間的晃動爆發。
export interface TextAnim {
  alpha?: boolean;   // 淡入
  blur?: boolean;    // 由模糊轉清晰
  scale?: boolean;   // 由小放大
  horiz?: boolean;   // 水平滑入
  vert?: boolean;    // 垂直滑入
  liquid?: boolean;  // 液化：逐字上下波動（持續）
  distort?: boolean; // 扭曲：逐字隨機抖動（持續）
  shake?: boolean;   // 進場晃動爆發
  inDur?: number;    // 進場時長（秒，預設 0.5）
  easing?: Easing;   // 進場緩動（預設 out）
  shakeAmp?: number; // 晃動幅度（px，預設 8）
  shakeFreq?: number;// 晃動頻率（Hz，預設 14）
  shakeDur?: number; // 進場晃動時長（秒，預設 0.4）
}

/* ───────────────────────── 各型別 params ───────────────────────── */

// 背景濾鏡：一條可堆疊的後製鏈，依陣列序套用在背景圖上（扭曲／模糊／色彩，見 bg-fx.ts）。
//   id   = 此濾鏡實例的唯一鍵（React key / 移除排序用，與效果型別無關）
//   fx   = 效果型別（bulge / fisheye / twirl / blur / grayscale / vhs …，對應 BG_EFFECTS）
//   amount = 強度（0~1），每個效果都吃這個當主要強度控制
export interface BgFilter {
  id: string;
  fx: string;
  amount: number;
  density?: number; // 粒子類專用：疏密度 0~1（低＝稀疏）
  speed?: number;   // 粒子類專用：基礎飄動速度 0~1.5
  angle?: number;   // 雪花＝行進方向角度（度，0=向下）；眼鏡反光＝傾斜角（0=水平）；crossglass＝線一角度
  angle2?: number;  // crossglass：線二角度（度，獨立於線一）
  posX?: number;    // 眼鏡反光：中心 X（0~1）
  posY?: number;    // 眼鏡反光：中心 Y（0~1）
  scale?: number;   // 眼鏡反光：整體大小
  colorA?: string;  // 眼鏡反光：漸層起色
  colorB?: string;  // 眼鏡反光：漸層終色
}

// 背景：imageUrl 上傳背景圖（null = 用 paperMode/customColor 純色紙）；customColor null = 用 paperMode 預設色
//   filters = 套在背景圖上的後製濾鏡鏈（純色紙不套，因濾鏡對單色無意義）
export interface BackgroundParams {
  paperMode: PaperMode;
  customColor: string | null; // 自訂背景色（hex）；null = 用 paperMode 預設紙色
  imageUrl: string | null;
  fileName: string;
  imageOpacity?: number;       // 背景圖不透明度（0~1，預設 1）→ 半透明時露出底下背景色
  filters: BgFilter[];
}

// 墨效：自帶墨色（三槽），對齊「墨效層×N 各自 audio mapping」。
// values = 該墨效 paramSchema（effects.ts）的當前值。
export interface EffectParams {
  effectId: string;       // 墨韻（ink）效果 id（gpuId=null 時用）
  gpuId: string | null;   // GPU 光效 id；非 null = 此層用音訊圖（GPU shader）、null = 用墨韻流體
  values: ParamValues;    // 此層效果參數（墨韻：density/sens/…；GPU：sens/bloom/gain/…）
  palette: Palette;       // 此層墨色（三槽）
  autoColor?: boolean;    // 自動變色：沿預設配色平滑循環跑過所有顏色（無 = 用固定 palette）
}

// 墨體來源：內建程序化 preset，或上傳的黑剪影圖（dataUrl 供存檔還原）
export type BodySource =
  | { kind: "preset"; presetId: string }
  | { kind: "image"; fileName: string; dataUrl: string };

// 墨體：tint = 此層獨立墨色（不跟隨墨效層）。位置/大小走共用 transform。
export interface BodyParams {
  source: BodySource;
  amount: number;
  wiggle: number;
  drift: boolean;
  pulse: boolean;
  tint: string;
}

// 歌詞：綁哪首歌的 LRC（歌單 track id；null = 不顯示）。字型沿用 LYRIC_FONTS。
// 雙語雙軌：同一首歌可同時顯示主 LRC（fontId）+ 副 LRC（翻譯／羅馬音）。
//   副軌資料在該曲上（Track.lrcAlt，Phase 2-6），此處只管顯示：開關／字型／相對字級／疊在上或下。
//   line-by-line 配對顯示，各自依自己時間戳同步（雙語 LRC 通常同時間戳，時間略異也撐得住）。
// 多組 LRC：每個歌詞層可綁自己的 LRC/SRT（lines）、自己的字型/特效/顏色，位置大小走共用 transform。
//   lines 空 + trackId 有 → 走「歌單綁定那首歌」的卷軸顯示（主歌詞）；
//   lines 有 → 走「該層自己的字幕式當前句」顯示（可多組、各自定位定樣式）。
export interface LyricsParams {
  trackId: string | null;
  fontId: LyricFontId;
  lines: LyricLine[];
  textEffects: TextEffect[]; // 可複選疊加（空陣列＝無）
  color: string;
  dualLanguage: boolean;
  secondaryFontId: LyricFontId;
  secondaryScale: number; //          副軌相對主軌字級（0.5–0.9，翻譯慣例小一號）
  secondaryOrder: "below" | "above"; // 副軌疊在主軌下方（預設）或上方（羅馬音常放上方）
  anim?: TextAnim; //                 字幕進場動畫（每句出現時觸發）
  lineMode?: "top" | "bottom" | "both"; // 白線夾：上線／下線／雙線（預設雙線）
}

// 文字：歌名 / 自由文字，獨立移動縮放。位置/大小走共用 transform。
//   （落款不再走文字層 → 改由圖片層上傳 logo，見 ImageParams）
export interface TextParams {
  content: string;
  fontId: LyricFontId;
  color: string;
  textEffects: TextEffect[]; // 可複選疊加（空陣列＝無）
  anim?: TextAnim; // 文字進場動畫（出現時觸發）
  lineMode?: "top" | "bottom" | "both"; // 白線夾：上線／下線／雙線（預設雙線）
}

// 圖片：印章 / 落款 logo / 封面 / 立繪 — 上傳圖、自行調整大小與位置（走共用 transform）。
//   opacity 此層獨有。落款就是「放一張 image 層、上傳 logo」。
export interface ImageParams {
  fileName: string;
  dataUrl: string;
  opacity: number;
}

// 落款印章。兩種模式：
//   brand  ＝固定品牌印章圖（劍豪體烤進 PNG，不外送字體檔、內容鎖定）。brandId 選哪枚：九墨 /seal-jiumo.png、九黎月 /seal-jiuliyue.png。
//   custom ＝使用者自訂落款：直書印文 + 站上自帶字型（皆 SIL OFL 可嵌入，不含授權禁嵌的劍豪體）+ 印泥色。
// 只要場上有「可見且有字」的 custom 落款，brand 落款會自動隱藏（讓位給使用者自己的章）。
// 位置/大小走共用 transform，開關/刪除走圖層樹。
export interface SealParams {
  mode: "brand" | "custom"; //          brand=固定品牌章；custom=自訂直書落款
  brandId?: "jiumo" | "jiuliyue"; //    brand 時選哪枚品牌章（內容鎖定、不可改）；舊存檔沒有 → 預設 jiumo
  text: string; //            custom：直書印文（建議姓名/字號 1–4 字）
  fontId: LyricFontId; //     custom：印文字型（站上自帶 woff2，無劍豪體）
  sealColor: string; //       custom：印泥底色（預設硃砂紅）
  textColor: string; //       custom：印文色（預設宣紙白）
  opacity: number;
}

// CTA 訂閱動畫：固定三連發（拇指/訂閱/鈴鐺 + 游標），內容不可改、只給品牌紅色與是否循環。
// 位置/大小走共用 transform；出現時段走 timing（動畫由 composition 時間驅動 → 預覽=匯出一致）。
export interface CtaParams {
  color: string; // 點到變的「紅」（預設品牌紅）
  loop: boolean; // true=循環播放 CTA 序列；false=播一次後停在全紅
}

// 控制板（lofi 播放器卡）：把整個背景罩上「雨淋濕」濾鏡，上方一個圓角矩形＋右側半圓組成的播放器視窗
//   （窗內顯示未被雨濾鏡壓暗的清晰背景圖＋陰影霓虹光），右緣夾一張會轉的唱片（邊緣光、中心墨紅標籤），
//   底部一條時間軸（進度＝composition 時間 / 總長，左=當前時間、右=總長）。位置/大小走共用 transform。
//   轉動與進度全由時間驅動 → 預覽=錄製=匯出一致。
export interface PlayerParams {
  wetColor: string; // 雨淋濕罩色（壓在整個背景上的冷色，預設深藍灰）
  accent: string;   // 唱片中心圓 + 時間軸進度色（預設墨紅）
  glow: string;     // 卡片/唱片的陰影霓虹光色（預設冷青）
  wet: number;      // 濕潤/變暗強度 0~1
  spin: number;     // 唱片轉速（圈/秒，可 0 靜止）
  bgBlur: number;   // 背景高斯模糊程度 0~1（卡片下方整片背景）
  frostBlur: number;// 播放器（玻璃面板）霜面模糊程度 0~1
  refract: number;  // 液態玻璃邊緣折射強度 0~1（背景在卡邊緣彎曲放大）
  aberration: number;// 邊緣色散 0~1（彩色折射邊）
}

// 透明度層（alpha）：在區域（或整張）疊一層色，透明度跟音樂跳動 → 讓底下的圖閃動。
//   區域/大小/旋轉走共用 transform；w=h=1 ＝整張。
export interface AlphaParams {
  color: string;   // 疊色（預設黑＝壓暗閃動；可改白做爆亮）
  intensity: number;// 跟拍跳動幅度 0~1（重音瞬間的最大不透明度）
  base: number;    // 常駐底色不透明度 0~1（恆定壓一層；0=只在重音時閃）
  mode: "beat" | "shimmer"; // beat=跟鼓點閃；shimmer=連續正弦微閃
  speed: number;   // shimmer 模式的閃動頻率（次/秒）
}

// 影片（vizzy 沒有，是九墨差異點）：
//   intro 片頭 = timeline 開頭播完才進主視覺；cta = 角落小窗，loop 或指定 [startAt, endAt] 時段插入。
//   小窗擺哪、多大走共用 transform。
export interface VideoParams {
  fileName: string;
  src: string;
  mode: "intro" | "cta";
  loop: boolean; //                  true=LOOP 循環；false=只播一次
  blend: "normal" | "screen"; //     screen = 黑底去背（純黑透明、亮部疊上，適合黑底特效影片）
  startAt: number;
  endAt: number;
}

// type → params 的對應表，給 Layer 與工廠函式共用，避免散落各處
export interface LayerParamsMap {
  background: BackgroundParams;
  effect: EffectParams;
  body: BodyParams;
  lyrics: LyricsParams;
  text: TextParams;
  image: ImageParams;
  seal: SealParams;
  cta: CtaParams;
  player: PlayerParams;
  alpha: AlphaParams;
  video: VideoParams;
}

/* ───────────────────────── Layer / Composition ───────────────────────── */

interface LayerBase {
  id: string;
  name: string; // 中文層名（左欄樹顯示）
  visible: boolean; // 👁 開關
  locked: boolean; // 鎖定：不可選取 / 不可拖曳（2-2 之後用得上）
  transform?: Transform; // 位置 + 大小：每個可擺放的層都有；背景層無（它就是整個畫面）
  timing?: Timing; // 時間軸：第幾秒到第幾秒顯示；無 = 全程
  automations?: Automation[]; // 關鍵影格：讓參數隨時間做動畫（無 = 靜態）
  audioBindings?: AudioBinding[]; // 音訊驅動：讓參數跟著音樂即時脈動（無 = 不跟音樂）
}

// discriminated union：type 決定 params 形狀
export type Layer = {
  [T in LayerType]: LayerBase & { type: T; params: LayerParamsMap[T] };
}[LayerType];

// 取特定型別的 Layer（例如 EffectLayer = LayerOf<"effect">）
export type LayerOf<T extends LayerType> = Extract<Layer, { type: T }>;

// 合成樹：陣列即 z 序（index 0 最底先畫、末端最上後畫）
export type Composition = Layer[];

/* ───────────────────────── 型別中繼資料（2-2 左欄樹用） ───────────────────────── */

export interface LayerTypeMeta {
  label: string; //    中文型別名
  multiple: boolean; // 可多個（墨效/墨體/文字/圖片/影片）vs 單例（背景/歌詞）
  rank: number; //      預設 z 排序權重，＋新增時依此插到合理高度；小=底層
}

export const LAYER_TYPE_META: Record<LayerType, LayerTypeMeta> = {
  background: { label: "背景", multiple: false, rank: 0 },
  effect: { label: "音訊圖", multiple: true, rank: 1 },
  body: { label: "墨體", multiple: true, rank: 2 },
  lyrics: { label: "歌詞", multiple: true, rank: 3 },
  text: { label: "文字", multiple: true, rank: 4 },
  image: { label: "圖片", multiple: true, rank: 5 },
  seal: { label: "落款", multiple: true, rank: 5.5 },
  cta: { label: "CTA動畫", multiple: true, rank: 5.7 },
  player: { label: "控制板", multiple: true, rank: 5.8 },
  alpha: { label: "透明度層", multiple: true, rank: 1.5 }, // 疊在音訊圖之上、閃動底下的背景/視覺
  video: { label: "影片", multiple: true, rank: 6 },
};

// 左欄＋新增選單的型別順序（依 rank）
export const LAYER_TYPE_ORDER: LayerType[] = (Object.keys(LAYER_TYPE_META) as LayerType[])
  .sort((a, b) => LAYER_TYPE_META[a].rank - LAYER_TYPE_META[b].rank);

/* ───────────────────────── 工廠 ───────────────────────── */

export function genLayerId(type: LayerType): string {
  return `${type}-${Math.random().toString(36).slice(2, 9)}`;
}

// 背景濾鏡實例 id（React key / 移除排序用）
export function genFilterId(): string {
  return `flt-${Math.random().toString(36).slice(2, 9)}`;
}

// 各型別的預設 params（對齊現況 studio 初始狀態）
function defaultParams<T extends LayerType>(type: T): LayerParamsMap[T] {
  switch (type) {
    case "background":
      return { paperMode: "xuan", customColor: null, imageUrl: null, fileName: "", imageOpacity: 1, filters: [] as BgFilter[] } satisfies BackgroundParams as LayerParamsMap[T];
    case "effect": {
      const e = EFFECTS[0];
      return { effectId: e.id, gpuId: null, values: defaultsOf(e), palette: { ...PRESET_PALETTES[0] }, autoColor: false } satisfies EffectParams as LayerParamsMap[T];
    }
    case "body": {
      const d = BODY_PRESETS[0].defaults; // size 移交 transform.scale，這裡只留行為參數
      return {
        source: { kind: "preset", presetId: BODY_PRESETS[0].id },
        amount: d.amount, wiggle: d.wiggle, drift: d.drift, pulse: d.pulse,
        tint: PRESET_PALETTES[0].primary, // 此層獨立墨色
      } satisfies BodyParams as LayerParamsMap[T];
    }
    case "lyrics":
      return {
        trackId: null, fontId: LYRIC_FONTS[0].id, lines: [] as LyricLine[], textEffects: [] as TextEffect[], color: "#1a1a1a",
        dualLanguage: false, secondaryFontId: LYRIC_FONTS[1]?.id ?? LYRIC_FONTS[0].id,
        secondaryScale: 0.62, secondaryOrder: "below",
      } satisfies LyricsParams as LayerParamsMap[T];
    case "text":
      return { content: "", fontId: LYRIC_FONTS[0].id, color: "#1a1a1a", textEffects: [] as TextEffect[] } satisfies TextParams as LayerParamsMap[T];
    case "image":
      return { fileName: "", dataUrl: "", opacity: 1 } satisfies ImageParams as LayerParamsMap[T];
    case "seal":
      // ＋新增 → 預設給「自訂落款」（使用者自己的章）；品牌章只由初始專案模板放（見 defaultComposition）
      return { mode: "custom", text: "落款", fontId: LYRIC_FONTS[0].id, sealColor: "#9e2b25", textColor: "#f4ede5", opacity: 1 } satisfies SealParams as LayerParamsMap[T];
    case "cta":
      return { color: "#9e2b25", loop: false } satisfies CtaParams as LayerParamsMap[T]; // 硃砂；預設片頭跑一次就墨隱消失
    case "player":
      return { wetColor: "#1c2b3a", accent: "#9e2b25", glow: "#6fb4d8", wet: 0.5, spin: 0.25, bgBlur: 0.6, frostBlur: 0.4, refract: 0.6, aberration: 0.5 } satisfies PlayerParams as LayerParamsMap[T]; // 深藍雨夜 + 墨紅唱片標籤 + 冷青霓虹 + 液態玻璃
    case "alpha":
      return { color: "#000000", intensity: 0.6, base: 0, mode: "beat", speed: 6 } satisfies AlphaParams as LayerParamsMap[T]; // 預設整張黑、跟鼓點閃
    case "video":
      return { fileName: "", src: "", mode: "intro", loop: false, blend: "normal", startAt: 0, endAt: 0 } satisfies VideoParams as LayerParamsMap[T];
    default: {
      const _exhaustive: never = type;
      return _exhaustive;
    }
  }
}

// 各型別的預設位置 + 大小（背景無 transform）
function defaultTransform(type: LayerType): Transform | undefined {
  switch (type) {
    case "background": return undefined;
    case "effect": return { x: 0.5, y: 0.5, scale: 1, w: 1, h: 1 }; // 預設全螢幕框
    case "body": return { x: 0.3, y: 0.55, scale: BODY_PRESETS[0].defaults.size };
    case "lyrics": return { x: 0.5, y: 0.5, scale: 1 };
    case "text": return { x: 0.5, y: 0.88, scale: 1 };
    case "image": return { x: 0.5, y: 0.5, scale: 1 };
    case "seal": return { x: 0.07, y: 0.8, scale: 1 }; // 預設左下角（沿用原程序印章位置）
    case "cta": return { x: 0.5, y: 0.8, scale: 0.85 }; // 預設下方置中（下三分之一）
    case "player": return { x: 0.5, y: 0.4, scale: 1 }; // 控制板預設上半部置中（卡＋唱片＋時間軸往下展開）
    case "alpha": return { x: 0.5, y: 0.5, scale: 1, w: 1, h: 1, rot: 0 }; // 預設整張、置中
    case "video": return { x: 0.5, y: 0.5, scale: 1 }; // 片頭預設置中滿版（scale=1）；可用大小拉桿縮小
  }
}

// 建一個圖層；params / transform 可覆寫部分欄位
export function createLayer<T extends LayerType>(
  type: T,
  overrides?: { name?: string; visible?: boolean; locked?: boolean; transform?: Partial<Transform>; params?: Partial<LayerParamsMap[T]> },
): LayerOf<T> {
  const base = defaultParams(type);
  const tf = defaultTransform(type);
  return {
    id: genLayerId(type),
    type,
    name: overrides?.name ?? LAYER_TYPE_META[type].label,
    visible: overrides?.visible ?? true,
    locked: overrides?.locked ?? false,
    params: { ...base, ...overrides?.params },
    ...(tf ? { transform: { ...tf, ...overrides?.transform } } : {}),
  } as LayerOf<T>;
}

// 初始合成樹：宣紙背景 + 一層墨流 + 歌詞 + 歌名文字 + 落款 logo（空圖、待用戶上傳）。
// 2-3 渲染迴圈改吃陣列後，這就是 studio 的開場狀態。
export function defaultComposition(): Composition {
  return [
    createLayer("background", { name: "宣紙背景" }),
    createLayer("effect", { name: "音訊圖" }),
    createLayer("lyrics", { name: "歌詞" }),
    createLayer("text", { name: "歌名", transform: { x: 0.5, y: 0.9 } }),
    createLayer("image", { name: "Logo（可上傳）", transform: { x: 0.86, y: 0.86, scale: 0.18 } }),
    createLayer("seal", { name: "落款", params: { mode: "brand" } }),
  ];
}

/* ───────────────────────── 圖層樹操作（純函式、回傳新陣列） ───────────────────────── */

// 依型別 rank 插到合理 z 位置（＋新增時用）：同 rank 群組的最上方
export function insertLayer(comp: Composition, layer: Layer): Composition {
  const rank = LAYER_TYPE_META[layer.type].rank;
  let idx = comp.length;
  for (let i = comp.length - 1; i >= 0; i--) {
    if (LAYER_TYPE_META[comp[i].type].rank <= rank) { idx = i + 1; break; }
    if (i === 0) idx = 0;
  }
  return [...comp.slice(0, idx), layer, ...comp.slice(idx)];
}

export function removeLayer(comp: Composition, id: string): Composition {
  return comp.filter((l) => l.id !== id);
}

// 移動圖層到新 index（拖曳排序，吃陣列 z 序 index）
export function moveLayer(comp: Composition, id: string, toIndex: number): Composition {
  const from = comp.findIndex((l) => l.id === id);
  if (from < 0) return comp;
  const next = [...comp];
  const [l] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(next.length, toIndex)), 0, l);
  return next;
}

// 左欄圖層樹的顯示順序：與陣列「相反」——
//   清單最上 = 最前層（comp 末端、後渲染），清單最下 = 底圖（comp[0] 背景、先渲染）。
//   Photoshop / Figma 慣例：由上到下 = 前景到背景。2-2 渲染清單、2-3 對位都讀這個約定。
export function displayOrder(comp: Composition): Layer[] {
  return [...comp].reverse();
}

// 清單顯示位置 → 陣列 z 序 index（顯示 0 = 清單最上 = 最前層）。拖曳放下時換算用。
export function displayIndexToArray(comp: Composition, displayIndex: number): number {
  return comp.length - 1 - displayIndex;
}

// 拖曳排序（在「顯示順序空間」直接重排再轉回陣列 z 序，免去 index 換算出錯）。
//   toDisplayIndex = 放下時的清單位置（0 = 最上＝最前層）。
export function moveLayerInDisplay(comp: Composition, id: string, toDisplayIndex: number): Composition {
  const display = displayOrder(comp);
  const from = display.findIndex((l) => l.id === id);
  if (from < 0) return comp;
  const [l] = display.splice(from, 1);
  display.splice(Math.max(0, Math.min(display.length, toDisplayIndex)), 0, l);
  return display.reverse();
}

// 改某層欄位（visible / name / locked / params 局部）
export function updateLayer(comp: Composition, id: string, patch: Partial<Omit<Layer, "id" | "type" | "params">> & { params?: Record<string, unknown> }): Composition {
  return comp.map((l) => {
    if (l.id !== id) return l;
    const { params, ...rest } = patch;
    return { ...l, ...rest, params: params ? { ...l.params, ...params } : l.params } as Layer;
  });
}

// 👁 一鍵開關：暫時隱藏一層但保留其全部參數（隨時切回來）。渲染迴圈（2-3）跳過 visible=false 的層。
export function toggleLayerVisible(comp: Composition, id: string): Composition {
  return comp.map((l) => (l.id === id ? { ...l, visible: !l.visible } : l));
}

// 拖曳移動 / 縮放：合併式更新某層 transform（背景無 transform 則略過）。2-2 的拖曳把手、2-4 的位置滑桿共用。
export function setLayerTransform(comp: Composition, id: string, patch: Partial<Transform>): Composition {
  return comp.map((l) => (l.id === id && l.transform ? { ...l, transform: { ...l.transform, ...patch } } : l));
}

// 舊頻譜（霓虹/鏡像條/鏡譜/簇譜）已合併進統一頻譜 gv-spectrum 並下架。
// 載入舊專案時把這些 gpuId 自動換成 gv-spectrum，避免該層變空白。2026-06。
const LEGACY_SPECTRUM_IDS = new Set(["gv-neon-bars", "gv-mirror-bars", "gv-mirror-neon", "gv-cluster"]);
export function migrateComposition(comp: Composition): Composition {
  return comp.map((l) => {
    if (l.type !== "effect") return l;
    const ep = l.params as EffectParams;
    if (ep.gpuId && LEGACY_SPECTRUM_IDS.has(ep.gpuId)) {
      return { ...l, params: { ...ep, gpuId: "gv-spectrum" } };
    }
    return l;
  });
}

// 把一個 target 路徑的值寫進（已複製的）transform / params。關鍵影格與音訊綁定共用。
function writeTarget(transform: Transform | undefined, params: Record<string, unknown>, target: string, v: number) {
  if (target === "x" || target === "y" || target === "scale" || target === "w" || target === "h") {
    if (transform) (transform as unknown as Record<string, number>)[target] = v;
  } else if (target.startsWith("value:")) {
    const vals = params.values as Record<string, unknown> | undefined;
    if (vals) vals[target.slice(6)] = v;
  } else if (target.startsWith("filter:")) {
    const fid = target.slice(7);
    const f = (params.filters as BgFilter[] | undefined)?.find((x) => x.id === fid);
    if (f) f.amount = v;
  } else if (target === "opacity") {
    params.opacity = v;
  }
}

// 把某時刻 t（秒）的關鍵影格 + 即時音訊綁定套進 composition，產生「解算後」的新 comp。
//   即時 frame loop 與離線渲染每幀都先跑這個 → 下游所有渲染（背景濾鏡/音訊圖/位置…）自動吃到動畫。
//   只有「有 automation 或 audioBinding 的圖層」會被複製，其餘原樣傳回（省記憶體）。
//   audio 有給時才套音訊綁定；同一 target 兩者都有 → 音訊綁定後套（覆蓋關鍵影格）。
export function applyAutomations(comp: Composition, t: number, audio?: AudioSample): Composition {
  let changed = false;
  const out = comp.map((l) => {
    const autos = l.automations;
    const binds = l.audioBindings;
    const hasA = !!autos && autos.length > 0;
    const hasB = !!binds && binds.length > 0 && !!audio;
    if (!hasA && !hasB) return l;
    const transform: Transform | undefined = l.transform ? { ...l.transform } : undefined;
    const params: Record<string, unknown> = { ...(l.params as unknown as Record<string, unknown>) };
    if (params.values) params.values = { ...(params.values as Record<string, unknown>) };
    if (params.filters) params.filters = (params.filters as BgFilter[]).map((f) => ({ ...f }));
    let any = false;
    if (hasA) for (const a of autos!) {
      const v = sampleAutomation(a, t);
      if (v == null) continue;
      any = true;
      writeTarget(transform, params, a.target, v);
    }
    if (hasB) for (const b of binds!) {
      any = true;
      writeTarget(transform, params, b.target, sampleBinding(b, audio!));
    }
    if (!any) return l;
    changed = true;
    return { ...l, transform, params } as unknown as Layer;
  });
  return changed ? out : comp;
}

// 時間軸：設定某層的起訖秒數（時間軸拖曳/輸入框共用）。patch.end<0 = 到結尾。
export function setLayerTiming(comp: Composition, id: string, patch: Partial<Timing>): Composition {
  return comp.map((l) => {
    if (l.id !== id) return l;
    const base = l.timing ?? { start: 0, end: -1 };
    return { ...l, timing: { ...base, ...patch } };
  });
}

// 這層在時間 t（秒）是否該顯示：不可見→否；無 timing→全程；end<0→到 duration。
export function isLayerActive(layer: Layer, t: number, duration: number): boolean {
  if (!layer.visible) return false;
  const tm = layer.timing;
  if (!tm) return true;
  const end = tm.end < 0 ? duration : tm.end;
  return t >= tm.start && t <= end;
}

// 取這層的有效起訖（給時間軸畫條用）：無 timing → [0, duration]，end<0 → duration。
export function effectiveTiming(layer: Layer, duration: number): Timing {
  const tm = layer.timing;
  if (!tm) return { start: 0, end: duration };
  return { start: tm.start, end: tm.end < 0 ? duration : tm.end };
}

// 「＋新增」選單能否加這個型別：單例型別（背景／歌詞）已存在就不給再加。
// 註：沒有任何強制存在的層 — 連背景、墨效都能整個 removeLayer 拿掉，不卡用戶。
export function canAddLayer(comp: Composition, type: LayerType): boolean {
  if (LAYER_TYPE_META[type].multiple) return true;
  return !comp.some((l) => l.type === type);
}
