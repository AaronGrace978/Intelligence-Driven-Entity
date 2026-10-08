import { useEffect, useRef } from "react";
import { budget, createPacer } from "../lib/budget";
import { signal } from "../lib/signal";
import { heightField } from "./face";
import { hash1, perlin3 } from "./noise";

const COLS = 45;
const ROWS = 56;
const X_RANGE: [number, number] = [-1.0, 1.0];
const Y_RANGE: [number, number] = [-1.55, 1.15];
const SCALE = 330;
const CX = 500;
const CY = 470;
const COLUMN_STRIDE = 2;
/** Lifts contour lines by depth so features read even when the face is head-on. */
const RELIEF = 0.12;

interface Anchor {
  bx: number;
  by: number;
  bz: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  seed: number;
  mirror: number;
}

/** Catmull-Rom through the points, as cubic Béziers. */
function smoothPath(pts: Anchor[]): string {
  let d = `M${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += `C${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }
  return d;
}

function jaggedPath(pts: Anchor[]): string {
  return pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join("");
}

function linesToPath(lines: Anchor[][], smooth: boolean): string {
  return lines
    .filter((l) => l.length > 1)
    .map((l) => (smooth ? smoothPath(l) : jaggedPath(l)))
    .join("");
}

export default function VectorEntity() {
  const rowsRef = useRef<SVGPathElement>(null);
  const colsRef = useRef<SVGPathElement>(null);
  const eyesRef = useRef<SVGGElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const field = heightField(COLS, ROWS, X_RANGE, Y_RANGE);
    const grid: (Anchor | null)[][] = field.map((row, r) =>
      row.map((z, c) => {
        if (z === null) return null;
        const bx = X_RANGE[0] + ((X_RANGE[1] - X_RANGE[0]) * c) / (COLS - 1);
        const by = Y_RANGE[1] - ((Y_RANGE[1] - Y_RANGE[0]) * r) / (ROWS - 1);
        return { bx, by, bz: z, x: CX + bx * SCALE, y: CY - by * SCALE, vx: 0, vy: 0, seed: r * COLS + c, mirror: COLS - 1 - c };
      }),
    );
    const anchors = grid.flat().filter((a): a is Anchor => a !== null);

    const rowLines = (): Anchor[][] => {
      const out: Anchor[][] = [];
      for (const row of grid) {
        let run: Anchor[] = [];
        for (const a of row) {
          if (a) run.push(a);
          else if (run.length) (out.push(run), (run = []));
        }
        if (run.length) out.push(run);
      }
      return out;
    };
    const colLines = (): Anchor[][] => {
      const out: Anchor[][] = [];
      for (let c = 0; c < COLS; c += COLUMN_STRIDE) {
        let run: Anchor[] = [];
        for (let r = 0; r < ROWS; r++) {
          const a = grid[r][c];
          if (a) run.push(a);
          else if (run.length) (out.push(run), (run = []));
        }
        if (run.length) out.push(run);
      }
      return out;
    };
    const rows = rowLines();
    const cols = colLines();

    let time = 0;
    const pace = createPacer(0.05);
    let raf = 0;
    let yaw = 0;
    let pitch = 0;

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = pace(now);
      if (dt === null) return;
      time += dt;
      const o = signal.tick(dt);
      const unc = 1 - o.confidence;
      const tpsN = Math.min(2.5, o.tokensPerSecond / 60);
      const chaos = Math.min(1, o.error + Math.max(0, unc - 0.12) * 1.4);
      const calm = 1 - o.success;

      yaw += ((signal.look.x * 0.45 + Math.sin(time * 0.3) * 0.18) * calm - yaw) * Math.min(1, dt * 3);
      pitch += (signal.look.y * 0.25 * calm - pitch) * Math.min(1, dt * 3);
      const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);

      const stiffness = 90 + o.success * 260 - chaos * 70;
      const damping = 2 * Math.sqrt(stiffness) * (0.55 + o.success * 0.4);
      const waveSpeed = 2 + tpsN * 10;

      for (const a of anchors) {
        let { bx, by, bz } = a;
        const n = perlin3(bx * 3 + a.seed * 0.001, by * 3, time * (0.5 + o.activity * 2));
        bz += Math.sin(by * 11 - time * waveSpeed) * 0.025 * o.activity * calm;
        bz += n * (0.02 + unc * 0.2 + o.activity * 0.02) * calm;
        if (Math.abs(bx) < 0.24 && by > -0.52 && by < -0.3) by -= o.speak * 0.06 * (1 - Math.abs(bx) / 0.24);
        const rip = chaos * (0.25 + hash1(a.seed) * 0.5);
        bx += (bx * 0.6 + (hash1(a.seed + 1) - 0.5)) * rip * 0.35;
        by += (hash1(a.seed + 2) - 0.5) * rip * 0.35;

        const rx = bx * cy + bz * sy;
        const rz = -bx * sy + bz * cy;
        const ry = by * cp - rz * sp + rz * RELIEF;
        const tx = CX + rx * SCALE;
        const ty = CY - ry * SCALE;

        const ax = (tx - a.x) * stiffness - a.vx * damping;
        const ay = (ty - a.y) * stiffness - a.vy * damping;
        a.vx += ax * dt;
        a.vy += ay * dt;
        if (chaos > 0.05 && Math.random() < chaos * 0.06) {
          a.vx += (Math.random() - 0.5) * 1800 * chaos;
          a.vy += (Math.random() - 0.5) * 1800 * chaos;
        }
        a.x += a.vx * dt;
        a.y += a.vy * dt;
      }

      if (o.success > 0.05) {
        const blend = o.success * 0.5;
        for (const row of grid) {
          for (let c = 0; c < Math.floor(COLS / 2); c++) {
            const a = row[c];
            const b = row[COLS - 1 - c];
            if (!a || !b) continue;
            const midY = (a.y + b.y) / 2;
            const span = (b.x - a.x) / 2;
            const centre = (a.x + b.x) / 2;
            const snapC = centre + (CX - centre) * blend;
            a.y += (midY - a.y) * blend;
            b.y += (midY - b.y) * blend;
            a.x = snapC - span;
            b.x = snapC + span;
          }
        }
      }

      const smooth = chaos < 0.3;
      rowsRef.current!.setAttribute("d", linesToPath(rows, smooth));
      colsRef.current!.setAttribute("d", linesToPath(cols, smooth));

      const hue = 150 - Math.min(1, o.error * 1.6) * 150 + o.success * 45;
      const svg = svgRef.current!;
      svg.style.setProperty("--entity-hue", String(hue));
      svg.style.setProperty("--entity-glow", String(0.45 + o.activity * 0.4 + chaos * 0.4));

      const eyes = eyesRef.current!;
      const eyeR = 22 + o.activity * 6 + chaos * 14 * Math.random();
      Array.from(eyes.children).forEach((g, i) => {
        const side = i === 0 ? -1 : 1;
        const ex = 0.27 * side, ey = 0.13, ez = 0.8;
        const rx = ex * cy + ez * sy;
        const rz = -ex * sy + ez * cy;
        const ry = ey * cp - rz * sp + rz * RELIEF;
        const jx = chaos * (Math.random() - 0.5) * 30;
        const jy = chaos * (Math.random() - 0.5) * 30;
        g.setAttribute("transform", `translate(${(CX + rx * SCALE + jx).toFixed(1)} ${(CY - ry * SCALE + jy).toFixed(1)})`);
        const [ring, pupil, scanRing] = Array.from(g.children);
        ring.setAttribute("r", eyeR.toFixed(1));
        pupil.setAttribute("cx", (signal.look.x * 8).toFixed(1));
        pupil.setAttribute("cy", (-signal.look.y * 6).toFixed(1));
        pupil.setAttribute("r", (5 + o.speak * 3 + o.error * 6).toFixed(1));
        scanRing.setAttribute("transform", `rotate(${((time * (40 + tpsN * 300)) % 360).toFixed(1)})`);
      });
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="entity-canvas vector-host">
      <svg ref={svgRef} className="vector-svg" viewBox="0 0 1000 1000" preserveAspectRatio="xMidYMid meet">
        <defs>
          <filter id="vector-glow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="3.2" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <radialGradient id="vector-bg" cx="50%" cy="45%" r="60%">
            <stop offset="0" stopColor="hsl(var(--entity-hue) 100% 40% / 0.14)" />
            <stop offset="1" stopColor="transparent" />
          </radialGradient>
        </defs>
        <rect x="0" y="0" width="1000" height="1000" fill="url(#vector-bg)" />
        <g filter={budget.glow ? "url(#vector-glow)" : undefined}>
          <path ref={colsRef} className="vector-cols" />
          <path ref={rowsRef} className="vector-rows" />
          <g ref={eyesRef}>
            {[0, 1].map((i) => (
              <g key={i} className="vector-eye">
                <circle className="eye-ring" r="22" />
                <circle className="eye-pupil" r="5" />
                <g>
                  <circle className="eye-scan" r="34" />
                </g>
              </g>
            ))}
          </g>
        </g>
      </svg>
    </div>
  );
}
