// 九墨流體核心：WebGL2 Navier-Stokes（curl 渦度 + 壓力投影 + 墨色擴散）
// 雙紙模式：宣紙（Beer-Lambert 吸收）/ 夜紙（加法發光）

import type { RGB, PaperMode } from "./palette";
import { PAPER_COLORS } from "./palette";

const VERT = `#version 300 es
precision highp float;
in vec2 aPosition;
out vec2 vUv; out vec2 vL; out vec2 vR; out vec2 vT; out vec2 vB;
uniform vec2 texelSize;
void main () {
  vUv = aPosition * 0.5 + 0.5;
  vL = vUv - vec2(texelSize.x, 0.0); vR = vUv + vec2(texelSize.x, 0.0);
  vT = vUv + vec2(0.0, texelSize.y); vB = vUv - vec2(0.0, texelSize.y);
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;
const HEAD = `#version 300 es
precision highp float; precision highp sampler2D;
in vec2 vUv; in vec2 vL; in vec2 vR; in vec2 vT; in vec2 vB;
out vec4 outColor;
`;
const F_ADVECT = HEAD + `
uniform sampler2D uVelocity; uniform sampler2D uSource;
uniform vec2 uVelTexel; uniform float uDt; uniform float uDissipation;
void main () {
  vec2 coord = vUv - uDt * texture(uVelocity, vUv).xy * uVelTexel;
  outColor = texture(uSource, coord) / (1.0 + uDissipation * uDt);
}`;
const F_SPLAT = HEAD + `
uniform sampler2D uTarget; uniform float uAspect;
uniform vec3 uColor; uniform vec2 uPoint; uniform float uRadius; uniform float uMaxVal;
uniform float uHard;
void main () {
  vec2 p = vUv - uPoint; p.x *= uAspect;
  float t = dot(p, p) / uRadius;
  float v = exp(-pow(t, uHard));
  outColor = vec4(min(texture(uTarget, vUv).xyz + v * uColor, vec3(uMaxVal)), 1.0);
}`;
const F_RADIAL = HEAD + `
uniform sampler2D uTarget; uniform float uAspect;
uniform vec2 uPoint; uniform float uRadius; uniform float uStrength;
void main () {
  vec2 p = vUv - uPoint; p.x *= uAspect;
  float g = exp(-dot(p, p) / uRadius);
  vec2 dir = p / (length(p) + 0.0001);
  outColor = vec4(texture(uTarget, vUv).xy + dir * g * uStrength, 0.0, 1.0);
}`;
const F_CURL = HEAD + `
uniform sampler2D uVelocity;
void main () {
  float L = texture(uVelocity, vL).y; float R = texture(uVelocity, vR).y;
  float T = texture(uVelocity, vT).x; float B = texture(uVelocity, vB).x;
  outColor = vec4(0.5 * (R - L - T + B), 0.0, 0.0, 1.0);
}`;
const F_VORT = HEAD + `
uniform sampler2D uVelocity; uniform sampler2D uCurl;
uniform float uCurlStrength; uniform float uDt;
void main () {
  float L = texture(uCurl, vL).x; float R = texture(uCurl, vR).x;
  float T = texture(uCurl, vT).x; float B = texture(uCurl, vB).x;
  float C = texture(uCurl, vUv).x;
  vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
  force /= length(force) + 0.0001;
  force *= uCurlStrength * C; force.y *= -1.0;
  vec2 vel = texture(uVelocity, vUv).xy + force * uDt;
  outColor = vec4(clamp(vel, vec2(-1000.0), vec2(1000.0)), 0.0, 1.0);
}`;
const F_BUOY = HEAD + `
uniform sampler2D uVelocity; uniform sampler2D uDye;
uniform float uGravity; uniform float uDt;
void main () {
  vec2 vel = texture(uVelocity, vUv).xy;
  float d = dot(texture(uDye, vUv).rgb, vec3(0.3333));
  vel.y -= uGravity * min(d, 1.5) * uDt;
  outColor = vec4(vel, 0.0, 1.0);
}`;
const F_DIV = HEAD + `
uniform sampler2D uVelocity;
void main () {
  float L = texture(uVelocity, vL).x; float R = texture(uVelocity, vR).x;
  float T = texture(uVelocity, vT).y; float B = texture(uVelocity, vB).y;
  vec2 C = texture(uVelocity, vUv).xy;
  if (vL.x < 0.0) L = -C.x; if (vR.x > 1.0) R = -C.x;
  if (vT.y > 1.0) T = -C.y; if (vB.y < 0.0) B = -C.y;
  outColor = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
}`;
const F_CLEAR = HEAD + `
uniform sampler2D uTexture; uniform float uValue;
void main () { outColor = uValue * texture(uTexture, vUv); }`;
const F_PRESS = HEAD + `
uniform sampler2D uPressure; uniform sampler2D uDivergence;
void main () {
  float L = texture(uPressure, vL).x; float R = texture(uPressure, vR).x;
  float T = texture(uPressure, vT).x; float B = texture(uPressure, vB).x;
  float div = texture(uDivergence, vUv).x;
  outColor = vec4((L + R + B + T - div) * 0.25, 0.0, 0.0, 1.0);
}`;
const F_GRAD = HEAD + `
uniform sampler2D uPressure; uniform sampler2D uVelocity;
void main () {
  float L = texture(uPressure, vL).x; float R = texture(uPressure, vR).x;
  float T = texture(uPressure, vT).x; float B = texture(uPressure, vB).x;
  vec2 vel = texture(uVelocity, vUv).xy - 0.5 * vec2(R - L, T - B);
  outColor = vec4(vel, 0.0, 1.0);
}`;
const F_DIFFUSE = HEAD + `
uniform sampler2D uSource; uniform float uAmount;
void main () {
  vec4 c = texture(uSource, vUv);
  vec4 avg = (texture(uSource, vL) + texture(uSource, vR) + texture(uSource, vT) + texture(uSource, vB)) * 0.25;
  outColor = mix(c, avg, uAmount);
}`;
const F_STAMP = HEAD + `
uniform sampler2D uTarget; uniform sampler2D uStamp;
uniform vec2 uPoint; uniform vec2 uSize; uniform float uAspect;
uniform vec3 uColor; uniform float uAmount; uniform float uMaxVal;
uniform float uTime; uniform float uWiggle; uniform float uBreath; uniform float uRot;
void main () {
  vec2 rel = vUv - uPoint;
  rel.x *= uAspect;
  float cr = cos(uRot), sr = sin(uRot); // 旋轉剪影（繞中心轉）
  rel = mat2(cr, -sr, sr, cr) * rel;
  vec2 suv = rel / uSize + 0.5;
  vec2 q = suv - 0.5;
  suv = q / (1.0 + uBreath) + 0.5;
  float edge = clamp(length(suv - 0.5) * 2.0, 0.0, 1.0);
  float w = uWiggle * (0.25 + edge * 0.75);
  suv.x += sin(suv.y * 7.0 + uTime * 3.1) * w;
  suv.y += sin(suv.x * 6.0 + uTime * 2.3 + 1.7) * w * 0.6;
  float shape = 0.0;
  if (suv.x >= 0.0 && suv.x <= 1.0 && suv.y >= 0.0 && suv.y <= 1.0) {
    vec4 px = texture(uStamp, vec2(suv.x, 1.0 - suv.y));
    float darkness = 1.0 - (px.r + px.g + px.b) / 3.0;
    shape = px.a * darkness;
  }
  outColor = vec4(min(texture(uTarget, vUv).xyz + shape * uColor * uAmount, vec3(uMaxVal)), 1.0);
}`;
const F_DISPLAY = HEAD + `
uniform sampler2D uDye; uniform vec3 uPaper; uniform float uMode;
void main () {
  vec3 d = texture(uDye, vUv).rgb;
  vec3 col;
  if (uMode < 0.5) {
    vec3 dd = pow(max(d, vec3(0.0)), vec3(0.62)) * 1.1;
    col = uPaper * exp(-dd * 1.35);
  } else {
    col = uPaper + (vec3(1.0) - exp(-d));
  }
  vec2 q = vUv - 0.5;
  col *= 1.0 - 0.16 * dot(q, q);
  float g = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  float f = fract(sin(dot(floor(gl_FragCoord.xy / 3.0), vec2(41.31, 17.77))) * 24634.633);
  col += (g - 0.5) * 0.022 + (f - 0.5) * 0.012;
  outColor = vec4(col, 1.0);
}`;

type FBO = {
  t: WebGLTexture; f: WebGLFramebuffer; w: number; h: number;
  attach: (id: number) => number;
};
type DoubleFBO = { readonly read: FBO; readonly write: FBO; swap: () => void; w: number; h: number };
type Prog = { p: WebGLProgram; u: Record<string, WebGLUniformLocation | null> };

export type StepParams = {
  curl: number;
  velDissipation: number;
  dyeDissipation: number;
  diffusion: number;
  gravity?: number; // 墨重下沉（滴墨入水的密度驅動、墨暈效果用）
};

export class FluidCore {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private progs!: Record<string, Prog>;
  private velocity!: DoubleFBO;
  private dye!: DoubleFBO;
  private pressure!: DoubleFBO;
  private divergence!: FBO;
  private curlFBO!: FBO;
  static SIM_BASE = 160;
  static DYE_BASE = 1024;
  static SPLAT_RADIUS = 0.0022;
  paperMode: PaperMode = "xuan";
  paperColorOverride: RGB | null = null; // 自訂背景色：覆蓋紙色（墨流坐在這色上）；null = 用 paperMode 預設
  ok = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", { alpha: false, depth: false, stencil: false, antialias: false });
    if (!gl || !gl.getExtension("EXT_color_buffer_float")) {
      this.gl = gl as WebGL2RenderingContext;
      return;
    }
    gl.getExtension("OES_texture_float_linear");
    this.gl = gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.progs = {
      advect: this.program(F_ADVECT), splat: this.program(F_SPLAT), radial: this.program(F_RADIAL),
      curl: this.program(F_CURL), vort: this.program(F_VORT), div: this.program(F_DIV),
      clear: this.program(F_CLEAR), press: this.program(F_PRESS), grad: this.program(F_GRAD),
      diffuse: this.program(F_DIFFUSE), stamp: this.program(F_STAMP), buoy: this.program(F_BUOY),
      display: this.program(F_DISPLAY),
    };
    this.rebuild();
    this.ok = true;
  }

  private compile(type: number, src: string): WebGLShader {
    const gl = this.gl;
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || "shader error");
    return s;
  }
  private program(fs: string): Prog {
    const gl = this.gl;
    const p = gl.createProgram()!;
    gl.attachShader(p, this.compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, this.compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || "link error");
    const u: Prog["u"] = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      if (info) u[info.name] = gl.getUniformLocation(p, info.name);
    }
    return { p, u };
  }
  private createFBO(w: number, h: number, ifmt: number, fmt: number): FBO {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, w, h, 0, fmt, gl.HALF_FLOAT, null);
    const f = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return {
      t, f, w, h,
      attach: (id: number) => { gl.activeTexture(gl.TEXTURE0 + id); gl.bindTexture(gl.TEXTURE_2D, t); return id; },
    };
  }
  private createDouble(w: number, h: number, ifmt: number, fmt: number): DoubleFBO {
    let a = this.createFBO(w, h, ifmt, fmt);
    let b = this.createFBO(w, h, ifmt, fmt);
    return {
      get read() { return a; },
      get write() { return b; },
      swap() { const t = a; a = b; b = t; },
      w, h,
    };
  }
  private res(base: number) {
    const aspect = this.canvas.width / this.canvas.height;
    const a = Math.max(aspect, 1 / aspect);
    const max = Math.round(base * a);
    return this.canvas.width > this.canvas.height ? { w: max, h: base } : { w: base, h: max };
  }
  rebuild() {
    const gl = this.gl;
    const s = this.res(FluidCore.SIM_BASE);
    const d = this.res(FluidCore.DYE_BASE);
    this.velocity = this.createDouble(s.w, s.h, gl.RG16F, gl.RG);
    this.dye = this.createDouble(d.w, d.h, gl.RGBA16F, gl.RGBA);
    this.pressure = this.createDouble(s.w, s.h, gl.R16F, gl.RED);
    this.divergence = this.createFBO(s.w, s.h, gl.R16F, gl.RED);
    this.curlFBO = this.createFBO(s.w, s.h, gl.R16F, gl.RED);
  }
  private blit(target: FBO | null) {
    const gl = this.gl;
    if (target) { gl.bindFramebuffer(gl.FRAMEBUFFER, target.f); gl.viewport(0, 0, target.w, target.h); }
    else { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, this.canvas.width, this.canvas.height); }
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
  }

  get aspect() { return this.canvas.width / this.canvas.height; }

  splatVel(x: number, y: number, dx: number, dy: number, radius: number) {
    const gl = this.gl, pr = this.progs.splat;
    gl.useProgram(pr.p);
    gl.uniform2f(pr.u["texelSize"], 1 / this.velocity.w, 1 / this.velocity.h);
    gl.uniform1i(pr.u["uTarget"], this.velocity.read.attach(0));
    gl.uniform1f(pr.u["uAspect"], this.aspect);
    gl.uniform2f(pr.u["uPoint"], x, y);
    gl.uniform3f(pr.u["uColor"], dx, dy, 0);
    gl.uniform1f(pr.u["uRadius"], radius);
    gl.uniform1f(pr.u["uMaxVal"], 1e6);
    gl.uniform1f(pr.u["uHard"], 1.0);
    this.blit(this.velocity.write);
    this.velocity.swap();
  }
  splatDye(x: number, y: number, color: RGB, radius: number, hard = 1.0) {
    const gl = this.gl, pr = this.progs.splat;
    gl.useProgram(pr.p);
    gl.uniform2f(pr.u["texelSize"], 1 / this.dye.w, 1 / this.dye.h);
    gl.uniform1i(pr.u["uTarget"], this.dye.read.attach(0));
    gl.uniform1f(pr.u["uAspect"], this.aspect);
    gl.uniform2f(pr.u["uPoint"], x, y);
    gl.uniform3f(pr.u["uColor"], color[0], color[1], color[2]);
    gl.uniform1f(pr.u["uRadius"], radius);
    gl.uniform1f(pr.u["uMaxVal"], 2.2);
    gl.uniform1f(pr.u["uHard"], hard);
    this.blit(this.dye.write);
    this.dye.swap();
  }
  radialPush(x: number, y: number, strength: number, radius: number) {
    const gl = this.gl, pr = this.progs.radial;
    gl.useProgram(pr.p);
    gl.uniform2f(pr.u["texelSize"], 1 / this.velocity.w, 1 / this.velocity.h);
    gl.uniform1i(pr.u["uTarget"], this.velocity.read.attach(0));
    gl.uniform1f(pr.u["uAspect"], this.aspect);
    gl.uniform2f(pr.u["uPoint"], x, y);
    gl.uniform1f(pr.u["uRadius"], radius);
    gl.uniform1f(pr.u["uStrength"], strength);
    this.blit(this.velocity.write);
    this.velocity.swap();
  }

  private stampTex: WebGLTexture | null = null;

  // 上傳剪影圖（黑剪影透明底 PNG、或白底黑圖都吃）
  setStamp(source: TexImageSource | null) {
    const gl = this.gl;
    if (this.stampTex) { gl.deleteTexture(this.stampTex); this.stampTex = null; }
    if (!source) return;
    this.stampTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + 5);
    gl.bindTexture(gl.TEXTURE_2D, this.stampTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  }
  get hasStamp() { return !!this.stampTex; }

  // 把剪影按 alpha×暗度印進墨場：amount 小劑量連續注入 = 形清晰、邊緣被流場拖走成絲
  imageSplat(x: number, y: number, sizeH: number, color: RGB, amount: number, time = 0, wiggle = 0, breath = 0, rot = 0) {
    if (!this.stampTex) return;
    const gl = this.gl, pr = this.progs.stamp;
    gl.useProgram(pr.p);
    gl.uniform2f(pr.u["texelSize"], 1 / this.dye.w, 1 / this.dye.h);
    gl.uniform1i(pr.u["uTarget"], this.dye.read.attach(0));
    gl.activeTexture(gl.TEXTURE0 + 1);
    gl.bindTexture(gl.TEXTURE_2D, this.stampTex);
    gl.uniform1i(pr.u["uStamp"], 1);
    gl.uniform2f(pr.u["uPoint"], x, y);
    gl.uniform2f(pr.u["uSize"], sizeH, sizeH);
    gl.uniform1f(pr.u["uAspect"], this.aspect);
    gl.uniform3f(pr.u["uColor"], color[0], color[1], color[2]);
    gl.uniform1f(pr.u["uAmount"], amount);
    gl.uniform1f(pr.u["uMaxVal"], 2.2);
    gl.uniform1f(pr.u["uTime"], time);
    gl.uniform1f(pr.u["uWiggle"], wiggle);
    gl.uniform1f(pr.u["uBreath"], breath);
    gl.uniform1f(pr.u["uRot"], rot);
    this.blit(this.dye.write);
    this.dye.swap();
  }

  step(dt: number, p: StepParams) {
    const gl = this.gl;
    gl.disable(gl.BLEND);
    const tx = 1 / this.velocity.w, ty = 1 / this.velocity.h;
    let pr = this.progs.curl;
    gl.useProgram(pr.p);
    gl.uniform2f(pr.u["texelSize"], tx, ty);
    gl.uniform1i(pr.u["uVelocity"], this.velocity.read.attach(0));
    this.blit(this.curlFBO);
    pr = this.progs.vort;
    gl.useProgram(pr.p);
    gl.uniform2f(pr.u["texelSize"], tx, ty);
    gl.uniform1i(pr.u["uVelocity"], this.velocity.read.attach(0));
    gl.uniform1i(pr.u["uCurl"], this.curlFBO.attach(1));
    gl.uniform1f(pr.u["uCurlStrength"], p.curl);
    gl.uniform1f(pr.u["uDt"], dt);
    this.blit(this.velocity.write);
    this.velocity.swap();
    if (p.gravity) {
      pr = this.progs.buoy;
      gl.useProgram(pr.p);
      gl.uniform2f(pr.u["texelSize"], tx, ty);
      gl.uniform1i(pr.u["uVelocity"], this.velocity.read.attach(0));
      gl.uniform1i(pr.u["uDye"], this.dye.read.attach(1));
      gl.uniform1f(pr.u["uGravity"], p.gravity);
      gl.uniform1f(pr.u["uDt"], dt);
      this.blit(this.velocity.write);
      this.velocity.swap();
    }
    pr = this.progs.div;
    gl.useProgram(pr.p);
    gl.uniform2f(pr.u["texelSize"], tx, ty);
    gl.uniform1i(pr.u["uVelocity"], this.velocity.read.attach(0));
    this.blit(this.divergence);
    pr = this.progs.clear;
    gl.useProgram(pr.p);
    gl.uniform2f(pr.u["texelSize"], tx, ty);
    gl.uniform1i(pr.u["uTexture"], this.pressure.read.attach(0));
    gl.uniform1f(pr.u["uValue"], 0.8);
    this.blit(this.pressure.write);
    this.pressure.swap();
    pr = this.progs.press;
    gl.useProgram(pr.p);
    gl.uniform2f(pr.u["texelSize"], tx, ty);
    gl.uniform1i(pr.u["uDivergence"], this.divergence.attach(0));
    for (let i = 0; i < 20; i++) {
      gl.uniform1i(pr.u["uPressure"], this.pressure.read.attach(1));
      this.blit(this.pressure.write);
      this.pressure.swap();
    }
    pr = this.progs.grad;
    gl.useProgram(pr.p);
    gl.uniform2f(pr.u["texelSize"], tx, ty);
    gl.uniform1i(pr.u["uPressure"], this.pressure.read.attach(0));
    gl.uniform1i(pr.u["uVelocity"], this.velocity.read.attach(1));
    this.blit(this.velocity.write);
    this.velocity.swap();
    pr = this.progs.advect;
    gl.useProgram(pr.p);
    gl.uniform2f(pr.u["texelSize"], tx, ty);
    gl.uniform2f(pr.u["uVelTexel"], tx, ty);
    gl.uniform1i(pr.u["uVelocity"], this.velocity.read.attach(0));
    gl.uniform1i(pr.u["uSource"], this.velocity.read.attach(0));
    gl.uniform1f(pr.u["uDt"], dt);
    gl.uniform1f(pr.u["uDissipation"], p.velDissipation);
    this.blit(this.velocity.write);
    this.velocity.swap();
    gl.uniform2f(pr.u["texelSize"], 1 / this.dye.w, 1 / this.dye.h);
    gl.uniform1i(pr.u["uVelocity"], this.velocity.read.attach(0));
    gl.uniform1i(pr.u["uSource"], this.dye.read.attach(1));
    gl.uniform1f(pr.u["uDissipation"], p.dyeDissipation);
    this.blit(this.dye.write);
    this.dye.swap();
    pr = this.progs.diffuse;
    gl.useProgram(pr.p);
    gl.uniform2f(pr.u["texelSize"], 1 / this.dye.w, 1 / this.dye.h);
    gl.uniform1i(pr.u["uSource"], this.dye.read.attach(0));
    gl.uniform1f(pr.u["uAmount"], p.diffusion);
    this.blit(this.dye.write);
    this.dye.swap();
  }

  render() {
    const gl = this.gl, pr = this.progs.display;
    const paper = this.paperColorOverride ?? PAPER_COLORS[this.paperMode];
    gl.useProgram(pr.p);
    gl.uniform2f(pr.u["texelSize"], 1 / this.canvas.width, 1 / this.canvas.height);
    gl.uniform1i(pr.u["uDye"], this.dye.read.attach(0));
    gl.uniform3f(pr.u["uPaper"], paper[0], paper[1], paper[2]);
    gl.uniform1f(pr.u["uMode"], this.paperMode === "xuan" ? 0 : 1);
    this.blit(null);
  }
}
