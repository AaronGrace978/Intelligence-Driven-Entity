import { useEffect, useRef } from "react";
import * as THREE from "three";
import { budget, createPacer, drawingBufferSize } from "../lib/budget";
import { signal } from "../lib/signal";
import { entityShaders, FULLSCREEN_VERT } from "./shaders";

export default function ShaderEntity() {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current!;
    const CELL_ROWS = budget.cellRows;
    const renderer = new THREE.WebGLRenderer({
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(1);
    el.appendChild(renderer.domElement);

    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const quad = new THREE.PlaneGeometry(2, 2);

    const uniforms = {
      u_time: { value: 0 },
      u_tokens_per_second: { value: 0 },
      u_error_state: { value: 0 },
      u_model_confidence: { value: 1 },
      u_activity: { value: 0 },
      u_success: { value: 0 },
      u_speak: { value: 0 },
      u_look: { value: new THREE.Vector2() },
      u_grid: { value: new THREE.Vector2(160, CELL_ROWS) },
      u_resolution: { value: new THREE.Vector2(1, 1) },
      u_cells: { value: null as THREE.Texture | null },
    };

    const cellTarget = new THREE.WebGLRenderTarget(160, CELL_ROWS, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
    });
    uniforms.u_cells.value = cellTarget.texture;

    const shaders = entityShaders(budget.light);
    const cellScene = new THREE.Scene();
    const cellMat = new THREE.ShaderMaterial({ vertexShader: FULLSCREEN_VERT, fragmentShader: shaders.cell, uniforms });
    cellScene.add(new THREE.Mesh(quad, cellMat));

    const compScene = new THREE.Scene();
    const compMat = new THREE.ShaderMaterial({ vertexShader: FULLSCREEN_VERT, fragmentShader: shaders.composite, uniforms });
    compScene.add(new THREE.Mesh(quad, compMat));

    const light = budget.light;
    const resize = () => {
      const cssW = Math.max(1, el.clientWidth);
      const cssH = Math.max(1, el.clientHeight);
      const ratio = light ? 1 : Math.min(window.devicePixelRatio || 1, budget.pixelRatio);
      const buf = drawingBufferSize(cssW * ratio, cssH * ratio, budget.maxEdge);
      renderer.setSize(buf.width, buf.height, false);
      const cols = Math.max(1, Math.round((CELL_ROWS * buf.width) / buf.height));
      cellTarget.setSize(cols, CELL_ROWS);
      uniforms.u_grid.value.set(cols, CELL_ROWS);
      uniforms.u_resolution.value.set(buf.width, buf.height);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();

    const look = new THREE.Vector2();
    const pace = createPacer();
    let cellFrame = 0;
    let raf = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = pace(now);
      if (dt === null) return;
      const o = signal.tick(dt);
      uniforms.u_time.value += dt;
      uniforms.u_tokens_per_second.value = o.tokensPerSecond;
      uniforms.u_error_state.value = o.error;
      uniforms.u_model_confidence.value = o.confidence;
      uniforms.u_activity.value = o.activity;
      uniforms.u_success.value = o.success;
      uniforms.u_speak.value = o.speak;
      const t = uniforms.u_time.value;
      look.x += (signal.look.x * 0.35 + Math.sin(t * 0.31) * 0.12 - look.x) * Math.min(1, dt * 3);
      look.y += (signal.look.y * 0.2 + Math.sin(t * 0.23) * 0.05 - look.y) * Math.min(1, dt * 3);
      uniforms.u_look.value.copy(look);

      // The march is the expensive pass. While the Deck shader is on and the face is idle,
      // reuse the previous voxel field and only redraw the composite.
      const moving = o.speak > 0.02 || o.error > 0.02 || o.activity > 0.05 || o.success > 0.05;
      cellFrame++;
      if (!light || moving || cellFrame % 2 === 0) {
        renderer.setRenderTarget(cellTarget);
        renderer.render(cellScene, camera);
      }
      renderer.setRenderTarget(null);
      renderer.render(compScene, camera);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      cellTarget.dispose();
      cellMat.dispose();
      compMat.dispose();
      quad.dispose();
      renderer.dispose();
      el.removeChild(renderer.domElement);
    };
  }, []);

  return <div ref={host} className="entity-canvas" />;
}
