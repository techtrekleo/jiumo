// 九墨音訊引擎：載入、播放、頻段分析、鼓點/突發偵測、錄製音軌供應

export type AudioFrame = {
  bass: number;
  mid: number;
  treble: number;
  beat: boolean; // 一般鼓點
  bassSpike: boolean; // 重低音突發 → accent 插色
  trebleSpike: boolean; // 高音突發 → accent 插色
};

const SILENT_FRAME: AudioFrame = {
  bass: 0, mid: 0, treble: 0, beat: false, bassSpike: false, trebleSpike: false,
};

export class AudioEngine {
  el: HTMLAudioElement | null = null;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private dest: MediaStreamAudioDestinationNode | null = null;
  private freq: Uint8Array<ArrayBuffer> | null = null;
  // 左右聲道分離（給頻譜圖選聲道用）：source → splitter → analyserL/analyserR
  private splitter: ChannelSplitterNode | null = null;
  private analyserL: AnalyserNode | null = null;
  private analyserR: AnalyserNode | null = null;
  private freqL: Uint8Array<ArrayBuffer> | null = null;
  private freqR: Uint8Array<ArrayBuffer> | null = null;
  private bassEMA = 0;
  private trebleEMA = 0;
  private lastBeat = 0;
  private lastBassSpike = 0;
  private lastTrebleSpike = 0;
  onEnded: (() => void) | null = null;

  private source: MediaElementAudioSourceNode | null = null;

  // 音訊圖持久化：analyser/dest 只建一次、換歌只換 source
  // → 歌單連播時 MediaRecorder 的音軌不會斷
  load(file: File) {
    if (this.el) { this.el.pause(); this.el.src = ""; }
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 4096; // 高解析度：2048 bins → 每根 bar 獨立頻率、鼓聲只動小段（不再一大片）
      this.analyser.smoothingTimeConstant = this.smooth; // 跨幀平滑（0=乾脆即時、→1 越平滑）；可由 setSmoothing 調整
      // 噪音地板：預設 minDecibels≈-100 → 連微弱泛音都被映射成可見 bar（滿軌）。拉高到 -66 →
      // 低於 -66dB 的頻率全變 0、bar 趴下，只有夠大聲的（人聲/鼓/主奏）才衝上來＝選擇性偵測。
      this.analyser.minDecibels = this.floorDb; // 可由 setNoiseFloor 調整
      this.analyser.maxDecibels = -20;
      this.freq = new Uint8Array(new ArrayBuffer(this.analyser.frequencyBinCount));
      this.dest = this.ctx.createMediaStreamDestination();
      this.analyser.connect(this.ctx.destination);
      this.analyser.connect(this.dest);
      // 左右聲道：建一次 splitter + 左右 analyser（與 mono analyser 同設定），只當分析 tap 不接 destination
      this.splitter = this.ctx.createChannelSplitter(2);
      const mkA = () => {
        const a = this.ctx!.createAnalyser();
        a.fftSize = 4096; a.smoothingTimeConstant = this.smooth; a.minDecibels = this.floorDb; a.maxDecibels = -20;
        return a;
      };
      this.analyserL = mkA(); this.analyserR = mkA();
      this.splitter.connect(this.analyserL, 0);
      this.splitter.connect(this.analyserR, 1);
      this.freqL = new Uint8Array(new ArrayBuffer(this.analyserL.frequencyBinCount));
      this.freqR = new Uint8Array(new ArrayBuffer(this.analyserR.frequencyBinCount));
    }
    this.source?.disconnect();
    this.el = new Audio(URL.createObjectURL(file));
    this.el.volume = this.vol;
    this.source = this.ctx.createMediaElementSource(this.el);
    this.source.connect(this.analyser!);
    if (this.splitter) this.source.connect(this.splitter); // 同時餵左右聲道分析
    this.el.onended = () => this.onEnded?.();
  }

  private vol = 1;
  setVolume(v: number) { this.vol = Math.max(0, Math.min(1, v)); if (this.el) this.el.volume = this.vol; }
  get volume() { return this.vol; }

  // 偵測門檻（噪音地板，dB）：拉高 → 更選擇性（只偵測大聲的）、拉低 → 連微弱也偵測（較滿軌）
  private floorDb = -66;
  setNoiseFloor(db: number) { this.floorDb = db; for (const a of [this.analyser, this.analyserL, this.analyserR]) if (a) a.minDecibels = db; }
  get noiseFloor() { return this.floorDb; }

  // 頻譜跨幀平滑（smoothingTimeConstant，0=即時乾脆、→1 越平滑黏滯）。頻譜圖的 smoothing 開關用這個。
  private smooth = 0.6;
  setSmoothing(v: number) { this.smooth = Math.max(0, Math.min(0.95, v)); for (const a of [this.analyser, this.analyserL, this.analyserR]) if (a) a.smoothingTimeConstant = this.smooth; }
  get smoothing() { return this.smooth; }

  get loaded() { return !!this.el; }
  get playing() { return !!this.el && !this.el.paused; }
  get duration() { return this.el?.duration || 0; }
  get currentTime() { return this.el?.currentTime || 0; }

  async play(fromStart = false) {
    if (!this.el || !this.ctx) return;
    if (fromStart) this.el.currentTime = 0;
    await this.ctx.resume();
    await this.el.play();
  }
  pause() { this.el?.pause(); }
  seek(t: number) { if (this.el) this.el.currentTime = t; }

  audioTrack(): MediaStreamTrack | null {
    return this.dest?.stream.getAudioTracks()[0] || null;
  }

  // 原始頻譜 bins（2048 bins）。channel：mix=左右混合(預設)、left/right=單聲道。暫停時也回傳最後狀態。
  getFreq(channel: "mix" | "left" | "right" = "mix"): Uint8Array | null {
    if (channel === "left" && this.analyserL && this.freqL) { this.analyserL.getByteFrequencyData(this.freqL); return this.freqL; }
    if (channel === "right" && this.analyserR && this.freqR) { this.analyserR.getByteFrequencyData(this.freqR); return this.freqR; }
    if (!this.analyser || !this.freq) return null;
    this.analyser.getByteFrequencyData(this.freq);
    return this.freq;
  }

  // 每幀呼叫：頻段能量 + 鼓點/突發判定
  // density 控制觸發頻率、sens 控制觸發門檻（弱重音的歌調高靈敏度就有墨滴）
  analyse(now: number, density: number, sens = 1): AudioFrame {
    if (!this.analyser || !this.freq || !this.playing) return SILENT_FRAME;
    this.analyser.getByteFrequencyData(this.freq);
    // 頻段範圍對應 fftSize 4096（2048 bins，~10.8Hz/bin）：bass ~43-300Hz、mid ~340-2.7k、treble ~2k-7.8k
    let bass = 0; for (let i = 4; i <= 28; i++) bass += this.freq[i]; bass /= 25 * 255;
    let mid = 0; for (let i = 32; i <= 256; i++) mid += this.freq[i]; mid /= 225 * 255;
    let treble = 0; for (let i = 192; i <= 720; i++) treble += this.freq[i]; treble /= 529 * 255;
    this.bassEMA += (bass - this.bassEMA) * 0.05;
    this.trebleEMA += (treble - this.trebleEMA) * 0.05;

    // 三段獨立判定（各自 cooldown），不再 else-if 互斥 → 重低音爆點不會把高音/節拍擋死
    // sens 同時降門檻 + 縮短 cooldown（拉到最高 = 又敏感又密集），density 仍主控速率
    const rate = density * (0.5 + sens * 0.5); // sens=1→1x、sens=3→2x、sens=0.5→0.75x
    let beat = false, bassSpike = false, trebleSpike = false;
    if (bass > Math.max(this.bassEMA * (1 + 0.7 / sens), 0.42 / sens) && now - this.lastBassSpike > 800 / rate) {
      this.lastBassSpike = now; this.lastBeat = now; bassSpike = true;
    }
    if (treble > Math.max(this.trebleEMA * (1 + 0.45 / sens), 0.14 / sens) && now - this.lastTrebleSpike > 520 / rate) {
      this.lastTrebleSpike = now; trebleSpike = true;
    }
    if (!bassSpike && bass > this.bassEMA * (1 + 0.22 / sens) + 0.015 / sens && bass > 0.13 / sens && now - this.lastBeat > 300 / rate) {
      this.lastBeat = now; beat = true;
    }
    return { bass, mid, treble, beat, bassSpike, trebleSpike };
  }

  destroy() {
    if (this.el) { this.el.pause(); this.el.src = ""; this.el = null; }
    if (this.ctx) { void this.ctx.close(); this.ctx = null; }
  }
}

// 解碼音檔 → 降採樣成 count 個峰值（0~1，正規化）。給時間軸畫整條波形用。
export async function computePeaks(file: File, count = 900): Promise<number[]> {
  const ac = new AudioContext();
  try {
    const buf = await ac.decodeAudioData(await file.arrayBuffer());
    const ch = buf.getChannelData(0);
    const block = Math.max(1, Math.floor(ch.length / count));
    const peaks: number[] = [];
    for (let i = 0; i < count; i++) {
      let max = 0;
      const base = i * block;
      for (let j = 0; j < block; j++) { const v = Math.abs(ch[base + j] || 0); if (v > max) max = v; }
      peaks.push(max);
    }
    const norm = Math.max(0.01, ...peaks);
    return peaks.map((p) => p / norm);
  } finally {
    void ac.close();
  }
}
