# 九墨 Jiumo · 水墨音樂可視化工作室

**繁體中文** · [English](./README.md)

![License: MIT](https://img.shields.io/badge/License-MIT-ffd56b.svg)
![Next.js](https://img.shields.io/badge/Next.js-16-000.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)
![PRs welcome](https://img.shields.io/badge/PRs-welcome-2ea44f.svg)

把你的歌變成一幅**會呼吸的水墨**。九墨是一個在瀏覽器裡跑、純前端的開源音樂可視化工作室 —— 上傳音檔，調墨色、加歌詞、套特效，即時預覽後直接輸出成影片。**免安裝、免帳號、不上傳到任何伺服器**（音檔只在你的瀏覽器裡處理）。

> Turn your music into living ink. A browser-based, client-side music visualizer studio: fluid ink simulation, GPU spectrum shaders, lyric scrolling, cover designer, and frame-accurate video export — all running locally in the browser.

<p align="center">
  <img src="docs/demo-ink.gif" alt="九墨 Studio — 水墨流動" width="560" />
  <br/><br/>
  <img src="docs/demo.gif" alt="九墨 Studio — 直式 + 液態玻璃控制板" width="220" />
</p>

---

## ✨ 特色

- **墨韻流體引擎** — 自研 WebGL2 Navier-Stokes 流體，墨會真實暈染、漩渦、擴散。墨流 / 墨滴 / 墨暈 / 旋墨 / 墨湧 / 墨太極 / 潑墨爆 多種墨效。
- **GPU 頻譜** — fragment shader 跑的頻譜：長條 / 曲線 / 電平表 / 環狀放射 / 水面倒影 / 峰頂浮標，可選對數 / 線性 / Bark / Mel 頻率刻度與 A/B/C 加權。
- **墨生物** — 程序生成、骨架物理驅動的墨錦鯉，在墨場裡游動拖墨；可上墨 / 白 / 金 / 銀純色。
- **圖層系統** — 背景圖（含濾鏡）、音訊圖、歌詞（LRC/SRC 卷軸直書）、文字、落款印章、Logo、控制板（液態玻璃）、透明度層，皆可關鍵影格 / 音訊綁定自動化。
- **封面製作** — 上傳底圖、加文字（描邊/陰影）、疊圖（去背混合）、美化特效，輸出最高 4K（桌機 8K）無損 PNG。
- **影片輸出** — WebCodecs 離線渲染（幀準確、比實時快），自動挑 H.264/MP4 或 VP9/WebM；可在播放條拖選範圍只輸出一小段。

## 🛠 技術

純前端 **Next.js (App Router) + React + TypeScript + Tailwind**。核心全部自己刻、零重量級依賴：

- `app/engine/fluid-core.ts` — WebGL2 流體模擬
- `app/engine/gpu-visuals.ts` — GPU 頻譜 / 光效 shader
- `app/engine/effects.ts` — 墨韻流體特效配方
- `app/inklab/ink-creature.ts` — 水墨生物骨架物理 + 暈染
- `app/engine/offline.ts` — WebCodecs 逐幀影片輸出
- `app/studio/studio-client.tsx` — 工作室主介面

執行階段只用到 `lucide-react`（圖示）、`mp4-muxer` / `webm-muxer`（封裝）。

## 🚀 快速開始

```bash
git clone https://github.com/techtrekleo/jiumo.git
cd jiumo
npm install
npm run dev
# 打開 http://localhost:3000
```

需要支援 **WebGL2** 與 **WebCodecs** 的瀏覽器（Chrome / Edge / 近期 Safari）。影片輸出需要 WebCodecs（Chromium 系最完整）。

### 一鍵部署

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Ftechtrekleo%2Fjiumo)

或任何能跑 Next.js 的平台（Netlify / Cloudflare Pages / 自架）。純前端、不需要任何環境變數或後端。

## 🔤 字體

`public/fonts/` 內附的字體皆為 **SIL Open Font License**（可商用、可嵌入）：莫大毛筆、游清松手寫、源泉圓體、思源宋體、霞鶩文楷，以及 Anton / Archivo Black / Bebas Neue。

## 🐟 拜託幫我做更多墨生物（會動的那種！）

說真的，這是我最想要有人幫忙的部分。

現在墨裡真正「活著」的只有**一隻** —— 墨錦鯉。牠有會彎曲的脊椎、會擺動的尾巴飄帶，游起來像真的活的。我超想要一整個這樣的生態：墨蛇、墨鰻、墨龍、成群的墨雀、墨蝶…是真的會「動」、有生命感的，不是只有一個形狀在飄。

問題是 **我在美術方面的天份就跟答辯一樣** —— 引擎我刻得出來，但生物我設計不來。所以如果你對這種「程序生成的生物動畫」有興趣，拜託來做幾隻。

從哪看：

- `app/inklab/ink-creature.ts` —— `Marrow`（骨架物理：頭部軌跡形成脊椎、行波擺動、尾飄帶）＋ `InkRenderer`（把骨架畫成會暈、會飄的墨體）。
- `app/inklab/ink-koi-actor.ts` —— `InkKoiActor`，就是墨錦鯉本人。**這是你的範本**：複製它，改 `Marrow` 的設定（節數、長度、寬度輪廓、尾巴），再微調 `InkRenderer`，就能變成墨蛇／墨鰻／墨龍…在墨裡游。

你設計牠「怎麼長、怎麼動」，墨的暈染、飄動、消散引擎全幫你搞定。做好開個 PR，你會讓我超級開心 🖤

<sub>（`app/engine/bodies.ts` 那邊也有一條簡單的 `BODY_PRESETS` 路，但那是整隻硬硬飄來飄去的固定剪影、不會像錦鯉那樣活起來。我真正想要的是錦鯉那種有骨架、會擺動的。）</sub>

## 📄 授權

[MIT](./LICENSE) © techtrekleo（九黎月 Jiuliyue）

歡迎 fork、改造、拿去做你自己的可視化工具。如果做了什麼酷東西，很歡迎回來分享 🖤
