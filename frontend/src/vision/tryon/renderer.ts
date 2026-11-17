/**
 * Three.js renderer for the 3D shirt, in display space: only the video is mirrored, never the shirt texture.
 *
 * Pass 1 (render target): depth-only occluders (neck, arms, hands) then the shirt, lit from the scene estimate.
 * Pass 2 (screen): the mirrored camera frame with the shirt over it (soft 2-3 px edges, face protection, contact
 * shadow/AO on the person, camera-matched blur and grain). Drawing the video here, from the same frame the pose came
 * from, keeps shirt and body in sync even when tracking runs slower than the camera.
 */
import * as THREE from 'three';
import type { SceneLight } from '../lighting';
import type { Rig, V3 } from './rig';
import { ShirtModel } from './shirt';

/** What the renderer draws: per-vertex arrays updated in place every frame. */
export type GarmentModel = {
  position: Float32Array; normal: Float32Array; uv: Float32Array; uv2: Float32Array; tex: Float32Array; ao: Float32Array;
  tanU: Float32Array; tanV: Float32Array; index: Uint32Array; reset(): void;
  cull?: 'front' | 'back';                            // which three.js side is the outside (none: draw both)
  mid?: { position: Float32Array; index: Uint32Array }; // surface between the shells: where the body sits
  collar?: { x: number; y: number; halfW: number };  // front crew opening in photo coords (collar band shading)
};

THREE.ColorManagement.enabled = false; // camera pixels and product photos are both display-referred; no conversion

const GARMENT_VS = /* glsl */ `
attribute vec2 uvB;
attribute float tex;
attribute float ao;
attribute vec3 tanU;
attribute vec3 tanV;
varying vec2 vUv; varying vec2 vUvB; varying float vTex; varying float vAo;
varying vec3 vN; varying vec3 vTU; varying vec3 vTV;
void main() {
  vUv = uv; vUvB = uvB; vTex = tex; vAo = ao; vN = normal; vTU = tanU; vTV = tanV;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const GARMENT_FS = /* glsl */ `
uniform sampler2D mapF; uniform sampler2D mapB; uniform float hasBack; uniform vec3 dominant;
uniform float exposure; uniform float contrast; uniform vec3 tint; uniform vec3 lightDir; uniform float ambient;
uniform vec2 texel; uniform float bump; uniform float fade; uniform float realism; uniform float debugShells;
uniform vec3 collar; // photo-space crew opening of the front shell: centre x, centre y, half-width (0 = none)
varying vec2 vUv; varying vec2 vUvB; varying float vTex; varying float vAo;
varying vec3 vN; varying vec3 vTU; varying vec3 vTV;
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 photo(sampler2D m, vec2 uv) {
  // Outside the photo, or where the cut-out is transparent, the shirt continues in its dominant colour.
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return dominant;
  vec4 c = texture2D(m, uv);
  return mix(dominant, c.rgb, smoothstep(0.3, 0.9, c.a));
}
void main() {
  if (debugShells > 0.5) { gl_FragColor = vTex < 0.5 ? vec4(0.15, 0.35, 1.0, 1.0) : vec4(1.0, 0.15, 0.15, 1.0); return; }
  vec3 front = photo(mapF, vUv);
  vec3 back = hasBack > 0.5 ? photo(mapB, vUvB) : dominant;
  vec3 albedo = mix(front, back, vTex);
  vec3 N = normalize(vN);
  if (realism > 0.5) {
    // Fold detail from the photo's own luminance (fabric texture, seams, baked creases).
    float l0 = luma(photo(mapF, vUv));
    float lx = luma(photo(mapF, vUv + vec2(texel.x, 0.0)));
    float ly = luma(photo(mapF, vUv + vec2(0.0, texel.y)));
    N = normalize(N - bump * ((lx - l0) * normalize(vTU) + (ly - l0) * normalize(vTV)) * (1.0 - vTex));
  }
  // Seen from behind (through the neck or a sleeve opening): the inside of the shirt, in shadow. The front photo
  // shows the inside back collar through its own neck opening, so that is what the inner surface samples.
  bool inner = N.z < -0.2; // edge-on surfaces (|N.z| small) are outside fabric, not the inside
  if (inner) { N = -N; albedo = photo(mapF, vUv) * 0.55; }
  // Collar: a ~2.5 cm rib band round the crew opening, slightly darker and with fine ribbing, plus a soft inner
  // shadow on the inside back just below the band.
  if (collar.z > 0.0) {
    float e = length((vUv - collar.xy) / vec2(0.95 * collar.z, 0.85 * collar.z)); // 1 = opening edge
    float band = 0.06 / collar.z;                                                  // band width in edge units
    if (!inner && vTex < 0.5 && e < 1.0 + band) albedo *= 0.82 + 0.06 * sin(atan(vUv.y - collar.y, vUv.x - collar.x) * 90.0);
    if (inner) albedo *= mix(0.6, 1.0, smoothstep(0.0, 0.5, abs(vUv.y - collar.y) / collar.z));
  }
  vec3 c = albedo;
  if (realism > 0.5) {
    // Wrap (half-Lambert) lighting: cloth scatters light, so grazing faces (shoulder tops, sides) fall off softly
    // instead of going dark.
    float diff = dot(N, normalize(lightDir)) * 0.5 + 0.5;
    diff *= diff;
    c *= (ambient + (1.0 - ambient) * diff) * vAo;
    c = (c - 0.45) * contrast + 0.45;
    c *= exposure * tint;
  }
  gl_FragColor = vec4(clamp(c, 0.0, 1.0) * fade, fade);
}`;

const COMPOSITE_FS = /* glsl */ `
uniform sampler2D tG; uniform sampler2D tMask; uniform sampler2D tVideo; uniform vec2 res; uniform float hasMask;
uniform vec2 headC; uniform vec2 headR; uniform float hasHead;
uniform float blurPx; uniform float grain; uniform float time; uniform float shadow; uniform vec2 shadowOff;
uniform float inpaint; uniform vec4 band; uniform float bodyX; uniform float stepPx;
uniform float shadeK; uniform float shadeRef; uniform float shadeR;
uniform vec4 segA[8]; uniform float segR[8]; // protected body parts: capsules (a.xy, b.xy) with radius, display px
varying vec2 vUv;
float capsule(vec2 p, vec2 a, vec2 b) { vec2 ab = b - a; float t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0); return length(p - a - ab * t); }
vec3 videoAt(vec2 q) { return texture2D(tVideo, vec2(1.0 - q.x / res.x, 1.0 - q.y / res.y)).rgb; }
float maskAt(vec2 q) { return texture2D(tMask, vec2(1.0 - q.x / res.x, q.y / res.y)).r; }
float lumAt(vec2 q) { return dot(videoAt(q), vec3(0.2126, 0.7152, 0.0722)); }
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
vec4 tap(vec2 o) { return texture2D(tG, vUv + o / res); }
void main() {
  // Camera-matched softness: a small gaussian over the shirt (premultiplied) also feathers every edge by ~2 px.
  float r = blurPx;
  vec4 g = tap(vec2(0.0)) * 0.25
    + (tap(vec2(r, 0.0)) + tap(vec2(-r, 0.0)) + tap(vec2(0.0, r)) + tap(vec2(0.0, -r))) * 0.125
    + (tap(vec2(r, r)) + tap(vec2(-r, r)) + tap(vec2(r, -r)) + tap(vec2(-r, -r))) * 0.0625;
  vec2 p = vec2(vUv.x * res.x, (1.0 - vUv.y) * res.y); // display px, y down
  // Face and hair are never covered: hard ellipse with a 2 px feather.
  if (hasHead > 0.5) {
    float e = length((p - headC) / headR);
    g *= smoothstep(1.0 - 2.0 / headR.x, 1.0 + 2.0 / headR.x, e);
  }
  // Shading transfer: the real, low-frequency light falloff across the body (heavily blurred so the customer's own
  // prints, logos and dark/light clothing don't carry through), relative to the torso's average, modulates the shirt.
  if (shadeK > 0.0 && g.a > 0.01) {
    float l = 0.0;
    for (int i = 0; i < 12; i++) {
      float a = 6.2831853 * float(i) / 12.0;
      l += lumAt(p + vec2(cos(a), sin(a)) * shadeR) + lumAt(p + vec2(cos(a), sin(a)) * shadeR * 0.45);
    }
    l /= 24.0;
    g.rgb *= mix(1.0, clamp(l / max(shadeRef, 0.04), 0.85, 1.12), shadeK);
  }
  // Grain matched to the camera, only on the shirt.
  g.rgb += (hash(p + time) - 0.5) * grain * g.a;
  // Contact shadow + ambient occlusion cast by the shirt onto the person just outside its edge.
  float m = 1.0;
  if (hasMask > 0.5) m = smoothstep(0.3, 0.7, texture2D(tMask, vec2(1.0 - vUv.x, 1.0 - vUv.y)).r);
  float s = 0.0;
  for (int i = 0; i < 8; i++) {
    float a = 6.2831853 * float(i) / 8.0;
    s += texture2D(tG, vUv + (shadowOff + vec2(cos(a), sin(a)) * 4.0) / res).a;
  }
  s = s / 8.0 * (1.0 - g.a) * m * shadow;
  vec3 base = texture2D(tVideo, vec2(1.0 - vUv.x, vUv.y)).rgb; // selfie view: mirror the camera only
  // Cover the customer's own clothes where they show past the shirt: person-mask pixels near the shirt, outside it,
  // and not face/hair/neck/arms/hands, take the background colour found by walking outward to the silhouette edge.
  if (inpaint > 0.5 && m > 0.5 && g.a < 0.98 && p.y > band.x && p.y < band.y && p.x > band.z && p.x < band.w) {
    float keep = 0.0;
    if (hasHead > 0.5) keep = 1.0 - smoothstep(1.05, 1.15, length((p - headC) / headR));
    for (int i = 0; i < 8; i++) if (segR[i] > 0.0) keep = max(keep, 1.0 - smoothstep(segR[i] - 1.5, segR[i] + 1.5, capsule(p, segA[i].xy, segA[i].zw)));
    if (keep < 1.0) {
      float dir = p.x < bodyX ? -1.0 : 1.0;
      for (int i = 1; i <= 48; i++) {
        vec2 q = p + vec2(dir * float(i) * stepPx, 0.0);
        if (q.x < 4.0 || q.x > res.x - 4.0) break; // frame edge: no background to borrow, leave the pixel alone
        if (maskAt(q) < 0.3) {
          vec2 r = q + vec2(dir * 3.0, 0.0);
          vec3 fill = (videoAt(r) + videoAt(r + vec2(0.0, 4.0)) + videoAt(r - vec2(0.0, 4.0))) / 3.0;
          base = mix(base, fill, (1.0 - keep) * smoothstep(0.5, 0.8, m) * (1.0 - g.a));
          break;
        }
      }
    }
  }
  gl_FragColor = vec4(base * (1.0 - s) * (1.0 - g.a) + g.rgb, 1.0);
}`;

export type RenderOpts = {
  shadeTransfer?: boolean; // modulate the shirt by the real (blurred) shading of the clothes underneath
  inpaint?: { x0: number; x1: number; y0: number; y1: number } | null; // band around the shirt to clean up
  light: SceneLight;      // already in display space (x flipped)
  realism: boolean;
  fade: number;
  wireframe: boolean;
  grain: number;
  time: number;
};

export class TryOnRenderer {
  private renderer: THREE.WebGLRenderer;
  private camera = new THREE.OrthographicCamera(0, 1, 0, 1, 0.1, 20000);
  private scene = new THREE.Scene();
  private rt: THREE.WebGLRenderTarget;
  private geo = new THREE.BufferGeometry();
  private mat: THREE.ShaderMaterial;
  private mesh: THREE.Mesh;
  private occ: THREE.Group = new THREE.Group();
  private body: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private occMat = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide });
  private cyl = new THREE.CylinderGeometry(1, 1, 1, 16, 1, true);
  private sph = new THREE.SphereGeometry(1, 16, 12);
  private post: { scene: THREE.Scene; cam: THREE.OrthographicCamera; mat: THREE.ShaderMaterial };
  private maskTex: THREE.DataTexture | null = null;
  private placeholder = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
  private attrs: Record<string, THREE.BufferAttribute> = {};
  private frame = document.createElement('canvas');
  private frameCtx = this.frame.getContext('2d')!;
  private W = 1;
  private H = 1;

  static create(canvas: HTMLCanvasElement): TryOnRenderer | null {
    try {
      return new TryOnRenderer(canvas);
    } catch (e) {
      console.warn('WebGL unavailable', e);
      return null;
    }
  }

  private constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, premultipliedAlpha: true, antialias: false });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.setClearColor(0x000000, 0);
    this.rt = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: true, samples: 4 });
    this.camera.position.z = 10000;
    this.placeholder.needsUpdate = true;

    this.bind(this.model);
    this.mat = new THREE.ShaderMaterial({
      vertexShader: GARMENT_VS, fragmentShader: GARMENT_FS, side: THREE.DoubleSide, transparent: false,
      uniforms: {
        mapF: { value: this.placeholder }, mapB: { value: this.placeholder }, hasBack: { value: 0 },
        dominant: { value: new THREE.Vector3(0.5, 0.5, 0.5) },
        exposure: { value: 1 }, contrast: { value: 1 }, tint: { value: new THREE.Vector3(1, 1, 1) },
        lightDir: { value: new THREE.Vector3(0, -0.3, 1) }, ambient: { value: 0.42 },
        texel: { value: new THREE.Vector2(1 / 1024, 1 / 1024) }, bump: { value: 1.6 }, fade: { value: 1 }, realism: { value: 1 },
        debugShells: { value: 0 }, collar: { value: new THREE.Vector3(0, 0, 0) },
      },
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.occ.renderOrder = 0;
    // Body: the person mask written into depth only, on a plane between the front and back shells. The front shell
    // draws over the body, the back shell disappears behind it (visible only beyond the silhouette), and the collar
    // opening is left out so the inside back collar shows there (where the neck occluder isn't).
    this.body = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.ShaderMaterial({
      colorWrite: false, side: THREE.DoubleSide,
      uniforms: { tMask: { value: this.placeholder }, hasMask: { value: 0 }, res: { value: new THREE.Vector2(1, 1) },
        neckC: { value: new THREE.Vector2() }, neckR: { value: new THREE.Vector2() } },
      vertexShader: 'void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `uniform sampler2D tMask; uniform float hasMask; uniform vec2 res; uniform vec2 neckC; uniform vec2 neckR;
        void main() {
          vec2 vS = vec2(gl_FragCoord.x, res.y - gl_FragCoord.y); // display px (y down)
          if (hasMask < 0.5 || texture2D(tMask, vec2(1.0 - vS.x / res.x, vS.y / res.y)).r < 0.5) discard;
          if (neckR.x > 0.0 && length((vS - neckC) / neckR) < 1.0) discard;
        }`,
    }));
    this.body.frustumCulled = false;
    this.body.renderOrder = -1;
    this.scene.add(this.occ, this.body, this.mesh);

    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const mat = new THREE.ShaderMaterial({
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: COMPOSITE_FS,
      blending: THREE.NoBlending, depthTest: false, depthWrite: false,
      uniforms: {
        tG: { value: this.rt.texture }, tMask: { value: this.placeholder }, tVideo: { value: this.placeholder }, hasMask: { value: 0 }, res: { value: new THREE.Vector2(1, 1) },
        headC: { value: new THREE.Vector2() }, headR: { value: new THREE.Vector2(1, 1) }, hasHead: { value: 0 },
        inpaint: { value: 0 }, band: { value: new THREE.Vector4() }, shadeK: { value: 0 }, shadeRef: { value: 0.4 }, shadeR: { value: 6 }, bodyX: { value: 0 }, stepPx: { value: 4 },
        segA: { value: Array.from({ length: 8 }, () => new THREE.Vector4()) }, segR: { value: new Array(8).fill(0) },
        blurPx: { value: 0.8 }, grain: { value: 0.02 }, time: { value: 0 }, shadow: { value: 0.35 }, shadowOff: { value: new THREE.Vector2(0, 6) } /* +v = up: pixels under the hem sample the shirt above */,
      },
    });
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));
    this.post = { scene, cam, mat };
  }

  model: GarmentModel = new ShirtModel();

  /** Switch between the procedural shirt and the photo-built mesh. */
  setModel(m: GarmentModel) {
    if (m === this.model) return;
    this.model = m;
    this.bind(m);
    // Closed shells: cull the faces that point away from the camera, so the inside never draws over the body.
    this.mat.side = m.cull === 'front' ? THREE.FrontSide : m.cull === 'back' ? THREE.BackSide : THREE.DoubleSide;
    this.mat.uniforms.collar.value.set(m.collar?.x ?? 0, m.collar?.y ?? 0, m.collar?.halfW ?? 0);
  }

  private bind(m: GarmentModel) {
    for (const name of Object.keys(this.attrs)) this.geo.deleteAttribute(name);
    this.attrs = {};
    const add = (name: string, arr: Float32Array, n: number) => {
      const a = new THREE.BufferAttribute(arr, n);
      a.setUsage(THREE.DynamicDrawUsage);
      this.geo.setAttribute(name, a);
      this.attrs[name] = a;
    };
    add('position', m.position, 3); add('normal', m.normal, 3); add('uv', m.uv, 2); add('uvB', m.uv2, 2);
    add('tex', m.tex, 1); add('ao', m.ao, 1); add('tanU', m.tanU, 3); add('tanV', m.tanV, 3);
    this.geo.setIndex(new THREE.BufferAttribute(m.index, 1));
  }

  setGarment(front: HTMLImageElement, back: HTMLImageElement | null, dominant: [number, number, number]) {
    const tex = (img: HTMLImageElement) => {
      const t = new THREE.Texture(img);
      t.flipY = false; // v = 0 is the top of the photo
      t.colorSpace = THREE.NoColorSpace;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.anisotropy = 4;
      t.needsUpdate = true;
      return t;
    };
    const u = this.mat.uniforms;
    for (const k of ['mapF', 'mapB'] as const) if (u[k].value !== this.placeholder) (u[k].value as THREE.Texture).dispose();
    u.mapF.value = tex(front);
    u.mapB.value = back ? tex(back) : this.placeholder;
    u.hasBack.value = back ? 1 : 0;
    u.dominant.value.set(...dominant);
    u.texel.value.set(1 / front.naturalWidth, 1 / front.naturalHeight);
    this.model.reset();
  }

  /**
   * Keeps a copy of the camera's current frame, taken right before pose detection reads the same frame, so the shirt
   * is never drawn on a newer frame than the one its pose came from (tracking can run slower than the camera).
   */
  captureFrame(video: HTMLVideoElement) {
    const W = video.videoWidth, H = video.videoHeight;
    if (this.frame.width !== W || this.frame.height !== H) { this.frame.width = W; this.frame.height = H; }
    this.frameCtx.drawImage(video, 0, 0, W, H);
    const u = this.post.mat.uniforms;
    if (u.tVideo.value === this.placeholder) {
      const t = new THREE.CanvasTexture(this.frame);
      t.colorSpace = THREE.NoColorSpace;
      t.generateMipmaps = false;
      t.minFilter = t.magFilter = THREE.LinearFilter;
      u.tVideo.value = t;
    }
    (u.tVideo.value as THREE.Texture).needsUpdate = true;
  }

  /** Camera frame only (nobody tracked, or no shirt chosen). */
  renderVideo(W: number, H: number) {
    this.resize(W, H);
    this.renderer.setRenderTarget(this.rt);
    this.renderer.clear();
    this.renderer.setRenderTarget(null);
    this.post.mat.uniforms.hasHead.value = 0;
    this.post.mat.uniforms.shadow.value = 0;
    this.renderer.render(this.post.scene, this.post.cam);
  }

  setMask(mask: { data: Float32Array; width: number; height: number } | null) {
    const u = this.post.mat.uniforms;
    if (!mask) { u.hasMask.value = 0; this.body.material.uniforms.hasMask.value = 0; return; }
    if (!this.maskTex || this.maskTex.image.width !== mask.width || this.maskTex.image.height !== mask.height) {
      this.maskTex?.dispose();
      this.maskTex = new THREE.DataTexture(new Uint8Array(mask.width * mask.height), mask.width, mask.height, THREE.RedFormat);
      this.maskTex.magFilter = this.maskTex.minFilter = THREE.LinearFilter;
    }
    const d = this.maskTex.image.data as Uint8Array;
    for (let i = 0; i < d.length; i++) d[i] = mask.data[i] * 255;
    this.maskTex.needsUpdate = true;
    u.tMask.value = this.maskTex;
    u.hasMask.value = 1;
    this.body.material.uniforms.tMask.value = this.maskTex;
    this.body.material.uniforms.hasMask.value = 1;
  }

  private resize(W: number, H: number) {
    if (W === this.W && H === this.H) return;
    this.W = W; this.H = H;
    this.renderer.setSize(W, H, false);
    this.rt.setSize(W, H);
    this.camera.left = 0; this.camera.right = W; this.camera.top = 0; this.camera.bottom = H;
    this.camera.updateProjectionMatrix();
    this.post.mat.uniforms.res.value.set(W, H);
  }

  /** Depth-only stand-ins for body parts that can be in front of the shirt (or hide its inside). */
  private placeOccluders(rig: Rig) {
    this.occ.clear();
    const capsule = (a: V3, b: V3, r: number) => {
      const d = new THREE.Vector3(b.x - a.x, b.y - a.y, b.z - a.z);
      const l = d.length();
      if (l > 1) {
        const c = new THREE.Mesh(this.cyl, this.occMat);
        c.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
        c.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
        c.scale.set(r, l, r);
        this.occ.add(c);
      }
      for (const p of [a, b]) {
        const s = new THREE.Mesh(this.sph, this.occMat);
        s.position.set(p.x, p.y, p.z);
        s.scale.setScalar(r);
        this.occ.add(s);
      }
    };
    const sp = rig.span;
    // Neck: hides the inside back of the collar, which a real neck covers.
    const chin: V3 = { x: rig.neck.x, y: rig.chinY ?? rig.neck.y - sp * 0.35, z: rig.neck.z };
    capsule({ ...rig.neck, y: rig.neck.y + sp * 0.02 }, chin, rig.neckHalf);
    for (const arm of [rig.arms.L, rig.arms.R]) {
      // Upper arm: only below the sleeve (the sleeve always covers its own stretch of arm); still in front of the
      // torso's side when the arm hangs beside it.
      if (arm.elbow) {
        const k = 0.6, s = arm.shoulder, e = arm.elbow;
        capsule({ x: s.x + (e.x - s.x) * k, y: s.y + (e.y - s.y) * k, z: s.z + (e.z - s.z) * k }, e, sp * 0.085);
      }
      // A forearm/hand clearly in front of the chest wins over the whole shirt (world depth alone is too noisy to
      // beat the shirt's surface reliably); otherwise it keeps its own depth and the torso can hide it.
      const fwd = (p: V3): V3 => (arm.front ? { ...p, z: sp * 4 } : p);
      if (arm.elbow && arm.wrist) {
        const e = arm.front ? { x: arm.elbow.x + (arm.wrist.x - arm.elbow.x) * 0.15, y: arm.elbow.y + (arm.wrist.y - arm.elbow.y) * 0.15, z: arm.elbow.z } : arm.elbow;
        capsule(fwd(e), fwd(arm.wrist), sp * 0.07);
      }
      if (arm.wrist) for (const h of arm.hand) capsule(fwd(arm.wrist), fwd(h), sp * 0.05);
    }
  }

  render(rig: Rig, o: RenderOpts) {
    this.resize(rig.W, rig.H);
    for (const a of Object.values(this.attrs)) {
      a.needsUpdate = true;
      a.clearUpdateRanges();
    }
    this.placeOccluders(rig);
    // Body depth: the shirt's own mid-surface (between the shells, turning with them) where the person mask is set;
    // without one (procedural shirt), a screen-sized plane at the body's mid-depth.
    const W = rig.W, H = rig.H, mid = this.model.mid;
    if (mid) {
      if (this.body.geometry.getIndex()?.array !== mid.index) {
        this.body.geometry.setAttribute('position', new THREE.BufferAttribute(mid.position, 3));
        this.body.geometry.setIndex(new THREE.BufferAttribute(mid.index, 1));
      }
      this.body.geometry.getAttribute('position').needsUpdate = true;
    } else {
      const bz = rig.top.z - rig.span * 0.05;
      this.body.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, bz, W, 0, bz, W, H, bz, 0, H, bz]), 3));
      this.body.geometry.setIndex([0, 1, 2, 0, 2, 3]);
    }
    const bu = this.body.material.uniforms;
    bu.res.value.set(W, H);
    bu.neckC.value.set(rig.neck.x, rig.neck.y + rig.neckHalf * 0.25);
    bu.neckR.value.set(rig.neckHalf * 1.35, rig.neckHalf * 1.15);

    const u = this.mat.uniforms;
    const L = o.light;
    u.exposure.value = L.exposure; u.contrast.value = L.contrast; u.tint.value.set(...L.tint);
    u.lightDir.value.set(L.lightDir[0], -L.lightDir[1], 0.9); // display y points down
    u.ambient.value = 0.5 - 0.25 * Math.min(1, Math.abs(L.lightDir[0])); // strong side light -> deeper shading
    u.fade.value = o.fade; u.realism.value = o.realism ? 1 : 0;
    this.mat.wireframe = o.wireframe;
    u.debugShells.value = o.wireframe ? 1 : 0; // wireframe view: front shell blue, back shell red

    const p = this.post.mat.uniforms;
    if (rig.head) {
      p.headC.value.set(rig.head.center.x, rig.head.center.y);
      p.headR.value.set(rig.head.rx, rig.head.ry);
      p.hasHead.value = 1;
    } else p.hasHead.value = 0;
    const sp = rig.span;
    p.blurPx.value = o.realism ? 0.9 * Math.max(1, rig.W / 1280) : 0.5; // ~2 px feather on every shirt edge
    p.shadeK.value = o.realism && o.shadeTransfer && L.torso != null ? 0.35 : 0;
    p.shadeRef.value = L.torso ?? 0.4;
    p.shadeR.value = Math.max(6, sp * 0.12);
    p.grain.value = o.realism ? o.grain : 0;
    p.shadow.value = o.realism ? 0.25 : 0;
    p.time.value = o.time % 1000;
    // Clothing clean-up band and the body parts it must never touch.
    p.inpaint.value = o.inpaint ? 1 : 0;
    if (o.inpaint) {
      p.band.value.set(o.inpaint.y0, o.inpaint.y1, o.inpaint.x0, o.inpaint.x1);
      p.bodyX.value = rig.top.x;
      p.stepPx.value = (rig.span * 0.7) / 48;
      const segs: [V3, V3 | null, number][] = [[rig.neck, { ...rig.neck, y: rig.chinY ?? rig.neck.y - sp * 0.3 }, rig.neckHalf * 1.1]];
      for (const a of [rig.arms.L, rig.arms.R]) {
        segs.push([a.shoulder, a.elbow, sp * 0.14], [a.elbow ?? a.shoulder, a.wrist, sp * 0.12]);
        const hc = a.hand.length ? { x: a.hand.reduce((t, h) => t + h.x, 0) / a.hand.length, y: a.hand.reduce((t, h) => t + h.y, 0) / a.hand.length, z: 0 } : null;
        segs.push([a.wrist ?? a.shoulder, a.wrist ? hc : null, sp * 0.12]);
      }
      segs.slice(0, 8).forEach(([a, b], i) => {
        p.segA.value[i].set(a.x, a.y, (b ?? a).x, (b ?? a).y);
        p.segR.value[i] = b ? segs[i][2] : 0;
      });
    }

    this.renderer.setRenderTarget(this.rt);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.post.scene, this.post.cam);
  }

  clear() {
    this.renderer.setRenderTarget(null);
    this.renderer.clear();
  }

  dispose() {
    this.geo.dispose();
    this.mat.dispose();
    this.rt.dispose();
    this.maskTex?.dispose();
    this.cyl.dispose();
    this.sph.dispose();
    this.renderer.dispose();
  }
}
