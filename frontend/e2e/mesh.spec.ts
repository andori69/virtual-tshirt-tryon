import fs from 'node:fs';
import path from 'node:path';
import { test } from '@playwright/test';

// Opt-in preview of the photo-built shirt meshes, undeformed: VFR_MESH_PREVIEW=1 npx playwright test e2e/mesh.spec.ts
// For each shirt in ./Tshirts: front, 45, 90 and 180 degrees, from above (neck opening) and from below (open hem).
// Saved to e2e/output/steps/mesh-<file>.png for review.
test.skip(!process.env.VFR_MESH_PREVIEW, 'set VFR_MESH_PREVIEW=1');

test('photo mesh turntable', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/');
  const items = await page.evaluate(async () => (await (await fetch('/api/wardrobe')).json()) as { file: string; mesh_url: string | null; garment_url: string; back_url: string | null }[]);
  fs.mkdirSync(path.join('e2e', 'output', 'steps'), { recursive: true });
  for (const it of items.filter((i) => i.mesh_url)) {
    await page.setContent('<html><body style="margin:0;background:#556"><div id="g" style="display:grid;grid-template-columns:repeat(3,360px)"></div></body></html>');
    await page.evaluate(async ({ it, base }) => {
      const THREE = await import(`${base}/node_modules/three/build/three.module.js`);
      THREE.ColorManagement.enabled = false; // photos are display-referred, as in the app
      const mesh = await (await fetch(base + it.mesh_url)).json();
      const load = (u: string) => new Promise<unknown>((r) => new THREE.TextureLoader().load(base + u, (t: { flipY: boolean }) => { t.flipY = false; r(t); }));
      const front = await load(it.garment_url), back = it.back_url ? await load(it.back_url) : null;
      const n = mesh.uv.length / 2;
      const pos = new Float32Array(n * 6), uv = new Float32Array(n * 4), uvB = new Float32Array(n * 4), side = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) for (const s of [0, 1]) {
        const j = i + s * n;
        pos[j * 3] = mesh.uv[2 * i] - 0.5; pos[j * 3 + 1] = -(mesh.uv[2 * i + 1] - 0.5); pos[j * 3 + 2] = (s ? -1 : 1) * mesh.depth[i];
        uv[j * 2] = mesh.uv[2 * i]; uv[j * 2 + 1] = mesh.uv[2 * i + 1];
        uvB[j * 2] = mesh.uvBack ? mesh.uvBack[2 * i] : mesh.uv[2 * i]; uvB[j * 2 + 1] = mesh.uvBack ? mesh.uvBack[2 * i + 1] : mesh.uv[2 * i + 1];
        side[j] = s;
      }
      const idx: number[] = [...mesh.trisFront];
      for (let k = 0; k < mesh.trisBack.length; k += 3) idx.push(mesh.trisBack[k] + n, mesh.trisBack[k + 2] + n, mesh.trisBack[k + 1] + n);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      g.setAttribute('uvB', new THREE.BufferAttribute(uvB, 2));
      g.setAttribute('side', new THREE.BufferAttribute(side, 1));
      g.setIndex(idx);
      g.computeVertexNormals();
      const mat = new THREE.ShaderMaterial({
        side: THREE.DoubleSide,
        uniforms: { mapF: { value: front }, mapB: { value: back ?? front }, hasBack: { value: back ? 1 : 0 } },
        vertexShader: `attribute vec2 uvB; attribute float side; varying vec2 vUv; varying vec2 vUvB; varying float vSide; varying vec3 vN;
          void main() { vUv = uv; vUvB = uvB; vSide = side; vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: `uniform sampler2D mapF; uniform sampler2D mapB; uniform float hasBack; varying vec2 vUv; varying vec2 vUvB; varying float vSide; varying vec3 vN;
          void main() {
            vec4 f = texture2D(mapF, vUv); vec4 b = texture2D(mapB, vUvB);
            vec3 c = vSide > 0.5 && hasBack > 0.5 ? b.rgb : f.rgb;
            vec3 N = normalize(vN); float inner = gl_FrontFacing ? 1.0 : 0.5;
            float l = 0.45 + 0.55 * max(dot(N * (gl_FrontFacing ? 1.0 : -1.0), normalize(vec3(-0.3, 0.5, 1.0))), 0.0);
            gl_FragColor = vec4(c * l * inner, 1.0);
          }`,
      });
      const views: [string, number, number][] = [['front', 0, 0], ['45', 45, 0], ['90', 90, 0], ['180', 180, 0], ['above', 0, 55], ['below', 0, -50]];
      for (const [label, yaw, pitch] of views) {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 360;
        const r = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
        r.outputColorSpace = THREE.LinearSRGBColorSpace;
        r.setClearColor(0x556677);
        const scene = new THREE.Scene();
        const m = new THREE.Mesh(g, mat);
        m.rotation.y = (yaw * Math.PI) / 180;
        scene.add(m);
        const cam = new THREE.PerspectiveCamera(30, 1, 0.01, 10);
        const p = (pitch * Math.PI) / 180;
        cam.position.set(0, 2.2 * Math.sin(p), 2.2 * Math.cos(p));
        cam.lookAt(0, 0, 0);
        r.render(scene, cam);
        const wrap = document.createElement('div');
        wrap.style.cssText = 'position:relative';
        wrap.appendChild(canvas);
        const t = document.createElement('div');
        t.textContent = `${it.file} ${label}`;
        t.style.cssText = 'position:absolute;top:4px;left:6px;color:#fff;font:12px sans-serif';
        wrap.appendChild(t);
        document.getElementById('g')!.appendChild(wrap);
      }
    }, { it, base: 'http://127.0.0.1:5173' });
    await page.locator('#g').screenshot({ path: path.join('e2e', 'output', 'steps', `mesh-${it.file.replace(/\W+/g, '_')}.png`) });
  }
});
