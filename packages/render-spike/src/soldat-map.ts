import type { Camera, Geometry, ImageAsset } from "./types";
import { packVertices, type Regions } from "./geometry";
export const vertexShader = `#version 300 es
precision highp float;
in vec2 aPosition;in vec2 aUV;in vec4 aColor;
uniform vec4 uCamera;uniform bool uGradient;
out vec2 vUV;out vec4 vColor;
void main(){vec2 p=(aPosition-uCamera.xy)/uCamera.zw; if(uGradient)p.x=aPosition.x-.5;gl_Position=vec4(p.x*2.,-p.y*2.,0.,1.);vUV=aUV;vColor=vec4(aColor.rgb*aColor.a,aColor.a);}`;
export const fragmentShader = `#version 300 es
precision highp float;
in vec2 vUV;in vec4 vColor;uniform sampler2D uTexture;out vec4 fragColor;
void main(){fragColor=texture(uTexture,vUV)*vColor;}`;
interface TextureImage {
  source: HTMLImageElement | HTMLCanvasElement;
  repeat: boolean;
}
interface BufferRecord {
  buffer: WebGLBuffer;
  vao: WebGLVertexArrayObject;
  geometry: Geometry;
  runs: { key: string; offset: number; count: number }[];
  bytes: number;
}
/** Texture/sampler ownership stays entirely inside Extern's Yield/Rebind boundary.
 * Phaser's NPOT guard is never bypassed or patched. All source PNGs are straight
 * alpha; texImage2D is the sole PMA conversion. Retained CPU sources restore GL. */
export class TextureBank {
  readonly regions: Regions = new Map();
  readonly sources = new Map<string, TextureImage>();
  async load(
    assets: ImageAsset[],
    terrain: ImageAsset,
    edge: ImageAsset,
    base = "/content/",
  ) {
    const objects = [
      ...new Set(assets.flatMap((a) => a.frames.map((f) => f.object))),
    ];
    const decoded = await Promise.all(
      objects.map(async (key) => {
        const image = new Image();
        image.src = base + key;
        await image.decode();
        return { key, image };
      }),
    );
    const size = 4096,
      pad = 2;
    let page = 0,
      x = pad,
      y = pad,
      row = 0;
    let canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    let ctx = canvas.getContext("2d")!;
    const commit = () =>
      this.sources.set(`atlas${page}`, { source: canvas, repeat: false });
    for (const { key, image } of decoded) {
      if (image.width + pad * 2 > size || image.height + pad * 2 > size)
        throw Error(`Atlas image too large: ${key}`);
      if (x + image.width + pad > size) {
        x = pad;
        y += row + pad * 2;
        row = 0;
      }
      if (y + image.height + pad > size) {
        commit();
        page++;
        canvas = document.createElement("canvas");
        canvas.width = canvas.height = size;
        ctx = canvas.getContext("2d")!;
        x = y = pad;
        row = 0;
      }
      ctx.drawImage(image, x, y);
      ctx.drawImage(image, 0, 0, image.width, 1, x, y - pad, image.width, pad);
      ctx.drawImage(
        image,
        0,
        image.height - 1,
        image.width,
        1,
        x,
        y + image.height,
        image.width,
        pad,
      );
      ctx.drawImage(
        image,
        0,
        0,
        1,
        image.height,
        x - pad,
        y,
        pad,
        image.height,
      );
      ctx.drawImage(
        image,
        image.width - 1,
        0,
        1,
        image.height,
        x + image.width,
        y,
        pad,
        image.height,
      );
      this.regions.set(key, {
        key: `atlas${page}`,
        u0: x / size,
        v0: y / size,
        u1: (x + image.width) / size,
        v1: (y + image.height) / size,
      });
      x += image.width + pad * 2;
      row = Math.max(row, image.height);
    }
    commit();
    const decode = async (asset: ImageAsset) => {
      const image = new Image();
      image.src = base + asset.frames[0]!.object;
      await image.decode();
      return image;
    };
    this.sources.set("terrain", {
      source: await decode(terrain),
      repeat: true,
    });
    const edgeImage = await decode(edge),
      edgeCanvas = document.createElement("canvas");
    edgeCanvas.width = 2 ** Math.ceil(Math.log2(edge.width));
    edgeCanvas.height = 2 ** Math.ceil(Math.log2(edge.height));
    edgeCanvas.getContext("2d")!.drawImage(edgeImage, 0, 0);
    this.sources.set("edge", { source: edgeCanvas, repeat: false });
    this.regions.set("edge", {
      key: "edge",
      u0: 0,
      v0: 0,
      u1: edge.width / edgeCanvas.width,
      v1: edge.height / edgeCanvas.height,
    });
    const white = document.createElement("canvas");
    white.width = white.height = 1;
    const w = white.getContext("2d")!;
    w.fillStyle = "#fff";
    w.fillRect(0, 0, 1, 1);
    this.sources.set("white", { source: white, repeat: false });
    this.regions.set("white", { key: "white", u0: 0, v0: 0, u1: 1, v1: 1 });
  }
}
/** 20-byte static VBO renderer entered only through Phaser Extern.
 * There are no engine source modifications, texture wrapper mutations or private
 * renderer state assumptions. GL resources are explicitly deleted/recreated. */
export class SoldatMap {
  private program!: WebGLProgram;
  private textures = new Map<string, WebGLTexture>();
  private buffers = new Map<Geometry, BufferRecord>();
  private dynamic?: BufferRecord;
  private dynamicRuns: BufferRecord["runs"] = [];
  private cameraUniform!: WebGLUniformLocation;
  private gradientUniform!: WebGLUniformLocation;
  private scratch = new ArrayBuffer(20 * 6 * 16384);
  private scratchView = new DataView(this.scratch);
  private scratchBytes = new Uint8Array(this.scratch);
  drawCalls = 0;
  uploads = 0;
  generation = 0;
  constructor(
    readonly gl: WebGL2RenderingContext,
    readonly bank: TextureBank,
    readonly linear = true,
  ) {
    this.restore();
  }
  restore() {
    const gl = this.gl;
    this.textures.clear();
    this.buffers.clear();
    this.dynamic = undefined;
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw Error(gl.getShaderInfoLog(shader) ?? "Shader compile");
      return shader;
    };
    const vs = compile(gl.VERTEX_SHADER, vertexShader),
      fs = compile(gl.FRAGMENT_SHADER, fragmentShader);
    this.program = gl.createProgram()!;
    gl.attachShader(this.program, vs);
    gl.attachShader(this.program, fs);
    gl.linkProgram(this.program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS))
      throw Error(gl.getProgramInfoLog(this.program) ?? "Program link");
    this.cameraUniform = gl.getUniformLocation(this.program, "uCamera")!;
    this.gradientUniform = gl.getUniformLocation(this.program, "uGradient")!;
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    for (const [key, image] of this.bank.sources) {
      const texture = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        image.source,
      );
      gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_WRAP_S,
        image.repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE,
      );
      gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_WRAP_T,
        image.repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE,
      );
      gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_MIN_FILTER,
        this.linear ? gl.LINEAR : gl.NEAREST,
      );
      gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_MAG_FILTER,
        this.linear ? gl.LINEAR : gl.NEAREST,
      );
      this.textures.set(key, texture);
    }
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    this.generation++;
  }
  private createBuffer(geometry: Geometry, dynamic = false): BufferRecord {
    const gl = this.gl,
      buffer = gl.createBuffer()!,
      vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    let offset = 0;
    const runs = geometry.runs.map((r) => {
      const run = { key: r.key, offset, count: r.vertices.length };
      offset += run.count;
      return run;
    });
    const bytes = offset * 20;
    if (dynamic)
      gl.bufferData(gl.ARRAY_BUFFER, this.scratch.byteLength, gl.DYNAMIC_DRAW);
    else
      gl.bufferData(
        gl.ARRAY_BUFFER,
        packVertices(geometry.runs),
        gl.STATIC_DRAW,
      );
    for (const [name, size, type, normalized, start] of [
      ["aPosition", 2, gl.FLOAT, false, 0],
      ["aUV", 2, gl.FLOAT, false, 8],
      ["aColor", 4, gl.UNSIGNED_BYTE, true, 16],
    ] as const) {
      const location = gl.getAttribLocation(this.program, name);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, type, normalized, 20, start);
    }
    return { buffer, vao, geometry, runs, bytes };
  }
  begin(camera: Camera, width: number, height: number, clear: number[]) {
    const gl = this.gl;
    this.drawCalls = 0;
    gl.viewport(0, 0, width, height);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.DITHER);
    gl.colorMask(true, true, true, true);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(clear[0]! / 255, clear[1]! / 255, clear[2]! / 255, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindSampler(0, null);
    gl.uniform1i(gl.getUniformLocation(this.program, "uTexture"), 0);
    gl.uniform4f(
      this.cameraUniform,
      camera.x,
      camera.y,
      camera.width * Math.exp(camera.z),
      camera.height * Math.exp(camera.z),
    );
  }
  draw(geometry: Geometry, gradient = false) {
    if (!geometry.runs.length) return;
    let record = this.buffers.get(geometry);
    if (!record) {
      record = this.createBuffer(geometry);
      this.buffers.set(geometry, record);
      this.uploads++;
    }
    this.issue(record, gradient);
  }
  drawDynamic(geometry: Geometry) {
    if (!geometry.runs.length) return;
    const gl = this.gl;
    this.dynamic ??= this.createBuffer({ runs: [] }, true);
    let offset = 0,
      index = 0;
    for (const run of geometry.runs) {
      let command = this.dynamicRuns[index];
      if (!command) {
        command = { key: run.key, offset: 0, count: 0 };
        this.dynamicRuns[index] = command;
      }
      command.key = run.key;
      command.offset = offset / 20;
      command.count = run.vertices.length;
      this.dynamic.runs[index++] = command;
      for (const v of run.vertices) {
        if (offset + 20 > this.scratch.byteLength)
          throw Error("Dynamic vertex capacity exceeded");
        this.scratchView.setFloat32(offset, v.x, true);
        this.scratchView.setFloat32(offset + 4, v.y, true);
        this.scratchView.setFloat32(offset + 8, v.u, true);
        this.scratchView.setFloat32(offset + 12, v.v, true);
        for (let i = 0; i < 4; i++)
          this.scratchView.setUint8(offset + 16 + i, v.color[i] ?? 255);
        offset += 20;
      }
    }
    this.dynamic.runs.length = index;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dynamic.buffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.scratchBytes, 0, offset);
    this.issue(this.dynamic, false);
  }
  private issue(record: BufferRecord, gradient: boolean) {
    const gl = this.gl;
    gl.uniform1i(this.gradientUniform, gradient ? 1 : 0);
    gl.bindVertexArray(record.vao);
    for (const run of record.runs) {
      gl.bindTexture(gl.TEXTURE_2D, this.textures.get(run.key)!);
      gl.drawArrays(gl.TRIANGLES, run.offset, run.count);
      this.drawCalls++;
    }
    gl.bindVertexArray(null);
  }
  get resources() {
    return {
      textures: this.textures.size,
      buffers: this.buffers.size + (this.dynamic ? 1 : 0),
      vertexArrays: this.buffers.size + (this.dynamic ? 1 : 0),
      programs: 1,
      generation: this.generation,
    };
  }
  destroy() {
    const gl = this.gl;
    for (const texture of this.textures.values()) gl.deleteTexture(texture);
    for (const record of [
      ...this.buffers.values(),
      ...(this.dynamic ? [this.dynamic] : []),
    ]) {
      gl.deleteBuffer(record.buffer);
      gl.deleteVertexArray(record.vao);
    }
    gl.deleteProgram(this.program);
    this.textures.clear();
    this.buffers.clear();
    this.dynamic = undefined;
  }
}
