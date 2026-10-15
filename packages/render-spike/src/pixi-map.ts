import {
  Buffer,
  BufferUsage,
  Container,
  Geometry as PixiGeometry,
  GlProgram,
  ImageSource,
  Mesh,
  Shader,
  UniformGroup,
  WebGLRenderer,
} from "pixi.js";
import type { Camera, Geometry } from "./types";
import { packVertices } from "./geometry";
import { fragmentShader, vertexShader, TextureBank } from "./soldat-map";
interface RunMesh {
  mesh: Mesh<PixiGeometry, Shader>;
  buffer: Buffer;
  view: DataView;
  uniforms: { update: () => void };
}
/** Public Geometry/Shader fallback: same 20-byte vertex layout and GLSL,
 * no raw draw calls, custom render pipe, engine patches, or texture mutation. */
export class PixiMap {
  readonly stage = new Container();
  readonly renderer = new WebGLRenderer();
  private sources = new Map<string, ImageSource>();
  private statics = new Map<Geometry, RunMesh[]>();
  private dynamics: RunMesh[][] = [];
  private allMeshes: RunMesh[] = [];
  private program = GlProgram.from({
    vertex: vertexShader,
    fragment: fragmentShader,
    name: "SoldatPMA",
  });
  private camera = new Float32Array(4);
  private dynamicSlot = 0;
  drawCalls = 0;
  generation = 1;
  constructor(
    readonly bank: TextureBank,
    readonly linear = true,
  ) {}
  async init(canvas: HTMLCanvasElement, width: number, height: number) {
    await this.renderer.init({
      canvas,
      width,
      height,
      resolution: 1,
      antialias: false,
      backgroundAlpha: 1,
      backgroundColor: 0x202020,
      preserveDrawingBuffer: true,
      powerPreference: "high-performance",
      preferWebGLVersion: 2,
    });
    for (const [key, image] of this.bank.sources)
      this.sources.set(
        key,
        new ImageSource({
          resource: image.source,
          addressMode: image.repeat ? "repeat" : "clamp-to-edge",
          scaleMode: this.linear ? "linear" : "nearest",
          alphaMode: "premultiply-alpha-on-upload",
          autoGenerateMipmaps: false,
        }),
      );
    this.renderer.gl.disable(this.renderer.gl.DITHER);
  }
  begin(camera: Camera) {
    this.stage.removeChildren();
    this.dynamicSlot = 0;
    this.drawCalls = 0;
    this.camera[0] = camera.x;
    this.camera[1] = camera.y;
    this.camera[2] = camera.width * Math.exp(camera.z);
    this.camera[3] = camera.height * Math.exp(camera.z);
  }
  private create(geometry: Geometry, gradient: boolean): RunMesh[] {
    return geometry.runs.map((run) => {
      const bytes = packVertices([run]);
      // Pixi8.21 vertexCount assumes a four-byte backing view when stride is set.
      // The Float32Array is only a byte owner: aColor remains unorm8x4 at offset16.
      const buffer = new Buffer({
        data: new Float32Array(bytes),
        usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
        shrinkToFit: false,
      });
      const geom = new PixiGeometry({
        attributes: {
          aPosition: { buffer, format: "float32x2", stride: 20, offset: 0 },
          aUV: { buffer, format: "float32x2", stride: 20, offset: 8 },
          aColor: { buffer, format: "unorm8x4", stride: 20, offset: 16 },
        },
        topology: "triangle-list",
      });
      const uniforms = new UniformGroup({
        uCamera: { value: this.camera, type: "vec4<f32>" },
        uGradient: { value: gradient ? 1 : 0, type: "i32" },
      });
      const shader = new Shader({
        glProgram: this.program,
        resources: {
          uTexture: this.sources.get(run.key)!,
          soldatUniforms: uniforms,
        },
      });
      const mesh = new Mesh({ geometry: geom, shader });
      mesh.blendMode = "normal";
      const record = { mesh, buffer, view: new DataView(bytes), uniforms };
      this.allMeshes.push(record);
      return record;
    });
  }
  draw(geometry: Geometry, gradient = false) {
    if (!geometry.runs.length) return;
    let meshes = this.statics.get(geometry);
    if (!meshes) {
      meshes = this.create(geometry, gradient);
      this.statics.set(geometry, meshes);
    }
    for (const record of meshes) {
      record.uniforms.update();
      this.stage.addChild(record.mesh);
      this.drawCalls++;
    }
  }
  drawDynamic(geometry: Geometry) {
    if (!geometry.runs.length) return;
    const slot = this.dynamicSlot++;
    let meshes = this.dynamics[slot];
    if (!meshes) {
      meshes = this.create(geometry, false);
      this.dynamics[slot] = meshes;
    }
    if (meshes.length !== geometry.runs.length)
      throw Error("Dynamic ordered run layout changed");
    for (let i = 0; i < meshes.length; i++) {
      const record = meshes[i]!,
        run = geometry.runs[i]!;
      if (record.view.byteLength !== run.vertices.length * 20) {
        const bytes = new ArrayBuffer(run.vertices.length * 20);
        record.buffer.data = new Float32Array(bytes);
        record.view = new DataView(bytes);
      }
      let offset = 0;
      for (const v of run.vertices) {
        record.view.setFloat32(offset, v.x, true);
        record.view.setFloat32(offset + 4, v.y, true);
        record.view.setFloat32(offset + 8, v.u, true);
        record.view.setFloat32(offset + 12, v.v, true);
        for (let c = 0; c < 4; c++)
          record.view.setUint8(offset + 16 + c, v.color[c] ?? 255);
        offset += 20;
      }
      record.buffer.update();
      record.uniforms.update();
      this.stage.addChild(record.mesh);
      this.drawCalls++;
    }
  }
  finish() {
    this.renderer.render({ container: this.stage });
  }
  get resources() {
    return {
      textures: this.sources.size,
      buffers: this.allMeshes.length,
      programs: 1,
      generation: this.generation,
    };
  }
  destroy() {
    this.stage.removeChildren();
    for (const record of this.allMeshes) {
      record.mesh.geometry.destroy(true);
      record.mesh.shader?.destroy();
      record.mesh.destroy();
    }
    for (const source of this.sources.values()) source.destroy();
    this.program.destroy();
    this.renderer.destroy();
    this.sources.clear();
    this.statics.clear();
    this.dynamics = [];
    this.allMeshes = [];
  }
}
