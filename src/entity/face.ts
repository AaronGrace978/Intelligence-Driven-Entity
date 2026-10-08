/**
 * Signed distance field of the entity's head. Units: head ≈ 1, facing +z, y up.
 * `FACE_GLSL` and `faceSdf` describe the same shape; keep them in sync.
 */

export const FACE_GLSL = /* glsl */ `
float sdEllipsoid(vec3 p, vec3 r) {
  float k0 = length(p / r);
  float k1 = length(p / (r * r));
  return k0 * (k0 - 1.0) / k1;
}
float sdCapsule(vec3 p, vec3 a, vec3 b, float r) {
  vec3 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - r;
}
float sdCylY(vec3 p, float r, float h) {
  vec2 d = abs(vec2(length(p.xz), p.y)) - vec2(r, h);
  return min(max(d.x, d.y), 0.0) + length(max(d, 0.0));
}
float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}
float smax(float a, float b, float k) { return -smin(-a, -b, k); }

float faceSdf(vec3 p, float mouth) {
  vec3 q = vec3(abs(p.x), p.y, p.z);
  float d = sdEllipsoid(p - vec3(0.0, 0.15, -0.05), vec3(0.78, 0.95, 0.9));
  d = smin(d, sdEllipsoid(p - vec3(0.0, -0.42, 0.12), vec3(0.56, 0.52, 0.62)), 0.25);
  d = smin(d, sdEllipsoid(p - vec3(0.0, -0.8, 0.42), vec3(0.22, 0.16, 0.18)), 0.15);
  d = smin(d, sdEllipsoid(q - vec3(0.38, -0.08, 0.52), vec3(0.22, 0.16, 0.2)), 0.18);
  d = smin(d, sdCapsule(q, vec3(0.08, 0.3, 0.8), vec3(0.42, 0.3, 0.66), 0.075), 0.12);
  d = smax(d, -sdEllipsoid(q - vec3(0.27, 0.14, 0.84), vec3(0.17, 0.11, 0.16)), 0.08);
  d = smin(d, length(q - vec3(0.27, 0.13, 0.62)) - 0.13, 0.03);
  d = smin(d, sdCapsule(p, vec3(0.0, 0.22, 0.86), vec3(0.0, -0.12, 1.0), 0.06), 0.1);
  d = smin(d, sdEllipsoid(p - vec3(0.0, -0.14, 0.97), vec3(0.1, 0.08, 0.09)), 0.06);
  d = smin(d, sdEllipsoid(q - vec3(0.08, -0.16, 0.89), vec3(0.06, 0.05, 0.06)), 0.05);
  d = smin(d, sdEllipsoid(p - vec3(0.0, -0.34 + mouth * 0.02, 0.85), vec3(0.2, 0.045, 0.08)), 0.06);
  d = smin(d, sdEllipsoid(p - vec3(0.0, -0.45 - mouth * 0.06, 0.83), vec3(0.18, 0.05, 0.08)), 0.06);
  d = smax(d, -sdEllipsoid(p - vec3(0.0, -0.395 - mouth * 0.02, 0.93), vec3(0.16, 0.008 + mouth * 0.05, 0.1)), 0.02);
  d = smin(d, sdCylY(p - vec3(0.0, -1.15, -0.08), 0.42, 0.45), 0.2);
  return d;
}
`;

type V3 = [number, number, number];

const len3 = (x: number, y: number, z: number) => Math.hypot(x, y, z);
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));

function ellipsoid(px: number, py: number, pz: number, rx: number, ry: number, rz: number) {
  const k0 = len3(px / rx, py / ry, pz / rz);
  const k1 = len3(px / (rx * rx), py / (ry * ry), pz / (rz * rz));
  return (k0 * (k0 - 1)) / k1;
}

function capsule(p: V3, a: V3, b: V3, r: number) {
  const pa = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const ba = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const h = clamp((pa[0] * ba[0] + pa[1] * ba[1] + pa[2] * ba[2]) / (ba[0] ** 2 + ba[1] ** 2 + ba[2] ** 2), 0, 1);
  return len3(pa[0] - ba[0] * h, pa[1] - ba[1] * h, pa[2] - ba[2] * h) - r;
}

function cylY(px: number, py: number, pz: number, r: number, h: number) {
  const dx = Math.hypot(px, pz) - r;
  const dy = Math.abs(py) - h;
  return Math.min(Math.max(dx, dy), 0) + Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
}

function smin(a: number, b: number, k: number) {
  const h = clamp(0.5 + (0.5 * (b - a)) / k, 0, 1);
  return b + (a - b) * h - k * h * (1 - h);
}
const smax = (a: number, b: number, k: number) => -smin(-a, -b, k);

export function faceSdf(x: number, y: number, z: number, mouth = 0): number {
  const ax = Math.abs(x);
  const q: V3 = [ax, y, z];
  let d = ellipsoid(x, y - 0.15, z + 0.05, 0.78, 0.95, 0.9);
  d = smin(d, ellipsoid(x, y + 0.42, z - 0.12, 0.56, 0.52, 0.62), 0.25);
  d = smin(d, ellipsoid(x, y + 0.8, z - 0.42, 0.22, 0.16, 0.18), 0.15);
  d = smin(d, ellipsoid(ax - 0.38, y + 0.08, z - 0.52, 0.22, 0.16, 0.2), 0.18);
  d = smin(d, capsule(q, [0.08, 0.3, 0.8], [0.42, 0.3, 0.66], 0.075), 0.12);
  d = smax(d, -ellipsoid(ax - 0.27, y - 0.14, z - 0.84, 0.17, 0.11, 0.16), 0.08);
  d = smin(d, len3(ax - 0.27, y - 0.13, z - 0.62) - 0.13, 0.03);
  d = smin(d, capsule([x, y, z], [0, 0.22, 0.86], [0, -0.12, 1.0], 0.06), 0.1);
  d = smin(d, ellipsoid(x, y + 0.14, z - 0.97, 0.1, 0.08, 0.09), 0.06);
  d = smin(d, ellipsoid(ax - 0.08, y + 0.16, z - 0.89, 0.06, 0.05, 0.06), 0.05);
  d = smin(d, ellipsoid(x, y + 0.34 - mouth * 0.02, z - 0.85, 0.2, 0.045, 0.08), 0.06);
  d = smin(d, ellipsoid(x, y + 0.45 + mouth * 0.06, z - 0.83, 0.18, 0.05, 0.08), 0.06);
  d = smax(d, -ellipsoid(x, y + 0.395 + mouth * 0.02, z - 0.93, 0.16, 0.008 + mouth * 0.05, 0.1), 0.02);
  d = smin(d, cylY(x, y + 1.15, z + 0.08, 0.42, 0.45), 0.2);
  return d;
}

/**
 * Finds where a ray from `origin` along unit `dir` crosses the surface, by bisection
 * between an inside point and an outside point. Used to shrink-wrap a sphere onto the face.
 */
export function surfaceAlong(origin: V3, dir: V3, maxT = 2.5): number {
  let lo = 0;
  let hi = maxT;
  for (let i = 0; i < 28; i++) {
    const mid = (lo + hi) / 2;
    const d = faceSdf(origin[0] + dir[0] * mid, origin[1] + dir[1] * mid, origin[2] + dir[2] * mid);
    if (d < 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Depth (z of the front surface) sampled on an orthographic grid; `null` where the ray misses. */
export function heightField(cols: number, rows: number, xRange: [number, number], yRange: [number, number]) {
  const field: (number | null)[][] = [];
  for (let r = 0; r < rows; r++) {
    const y = yRange[1] - ((yRange[1] - yRange[0]) * r) / (rows - 1);
    const row: (number | null)[] = [];
    for (let c = 0; c < cols; c++) {
      const x = xRange[0] + ((xRange[1] - xRange[0]) * c) / (cols - 1);
      let z = 1.6;
      let hit: number | null = null;
      for (let i = 0; i < 80; i++) {
        const d = faceSdf(x, y, z);
        if (d < 0.002) {
          hit = z;
          break;
        }
        z -= Math.max(d, 0.004);
        if (z < -1.2) break;
      }
      row.push(hit);
    }
    field.push(row);
  }
  return field;
}
