import { FACE_GLSL } from "./face";

export const FULLSCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const COMMON = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform float u_time;
uniform float u_tokens_per_second;
uniform float u_error_state;
uniform float u_model_confidence;
uniform float u_activity;
uniform float u_success;
uniform float u_speak;
uniform vec2 u_look;
uniform vec2 u_grid;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
float vnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), f.x), mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), f.x), mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
float tpsNorm() { return clamp(u_tokens_per_second / 60.0, 0.0, 2.5); }
`;

/**
 * Pass 1 — one texel per voxel cell. Raymarches the face and stores
 * r: lighting, g: depth, b: hit mask, a: rim (or halo proximity on a miss).
 */
const CELL_FRAG_BODY = /* glsl */ `
${COMMON}
${FACE_GLSL}

float map(vec3 p) {
  p.xz *= rot(u_look.x);
  p.yz *= rot(u_look.y);
  float e = u_error_state;
  p.x += sin(p.y * 9.0 + u_time * 14.0) * 0.1 * e;
  p.y += sin(p.x * 7.0 - u_time * 11.0) * 0.05 * e;
  p.z += sin(p.y * 5.0 + u_time * 6.0) * 0.08 * e;
  float d = faceSdf(p, u_speak);
#if ENTITY_MARCH_NOISE
  float unc = 1.0 - u_model_confidence;
  float n = vnoise(p * (4.0 + unc * 6.0) + vec3(0.0, 0.0, u_time * (0.4 + tpsNorm() * 1.5)));
  float calm = 1.0 - u_success * 0.8;
  d += (n - 0.5) * (0.03 + 0.25 * unc + 0.05 * u_activity) * calm;
#endif
  return d;
}

vec3 normalAt(vec3 p) {
  const vec2 k = vec2(1.0, -1.0);
  const float h = 0.004;
  return normalize(k.xyy * map(p + k.xyy * h) + k.yyx * map(p + k.yyx * h) +
                   k.yxy * map(p + k.yxy * h) + k.xxx * map(p + k.xxx * h));
}

void main() {
  vec2 aspect = vec2(u_grid.x / u_grid.y, 1.0);
  vec2 uv = (vUv * 2.0 - 1.0) * aspect;
  vec3 ro = vec3(0.0, -0.2, 4.2);
  vec3 rd = normalize(vec3(uv * 0.43, -1.0));

  float b = dot(ro, rd);
  float c = dot(ro, ro) - 2.4 * 2.4;
  float disc = b * b - c;
  if (disc < 0.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0); return; }

  float t = max(0.0, -b - sqrt(disc));
  float tEnd = -b + sqrt(disc);
  float minD = 1e3;
  bool hit = false;
  for (int i = 0; i < ENTITY_MARCH_STEPS; i++) {
    float d = map(ro + rd * t);
    minD = min(minD, d);
    if (d < 0.002) { hit = true; break; }
    t += d * ENTITY_MARCH_SCALE;
    if (t > tEnd) break;
  }

  if (!hit) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, exp(-minD * 9.0));
    return;
  }

  vec3 p = ro + rd * t;
  vec3 n = normalAt(p);
  vec3 key = normalize(vec3(0.45, 0.55, 0.8));
  float dif = clamp(dot(n, key), 0.0, 1.0);
  float fill = clamp(0.5 + 0.5 * dot(n, normalize(vec3(-0.6, -0.2, 0.5))), 0.0, 1.0);
  float rim = pow(1.0 - clamp(dot(n, -rd), 0.0, 1.0), 2.5);
#if ENTITY_AO
  float ao = clamp(map(p + n * 0.08) / 0.08, 0.0, 1.0);
#else
  float ao = 1.0;
#endif
  float lit = clamp((0.15 + 0.75 * dif + 0.18 * fill) * (0.55 + 0.45 * ao) + rim * 0.25, 0.0, 1.0);
  float depth = clamp((t - 3.0) / 1.8, 0.0, 1.0);
  gl_FragColor = vec4(lit, depth, 1.0, rim);
}
`;

/** Pass 2 — full resolution composite: voxel tiles, glyphs, particle spray, rain, tearing, RGB split. */
const COMPOSITE_FRAG_BODY = /* glsl */ `
${COMMON}
uniform sampler2D u_cells;
uniform vec2 u_resolution;

vec3 paletteFor(float lit) {
  vec3 green = mix(vec3(0.02, 0.45, 0.28), vec3(0.72, 1.0, 0.9), lit * lit);
  vec3 red = mix(vec3(0.7, 0.04, 0.08), vec3(1.0, 0.75, 0.7), lit * lit);
  vec3 ice = mix(vec3(0.05, 0.3, 0.5), vec3(0.85, 0.97, 1.0), lit * lit);
  vec3 col = mix(green, ice, u_success * 0.7);
  return mix(col, red, smoothstep(0.05, 0.6, u_error_state));
}

#if ENTITY_GLYPHS || ENTITY_RAIN
float glyph(vec2 local, float seed) {
  vec2 g = floor(local * vec2(5.0, 7.0));
  if (g.x < 0.0 || g.y < 0.0 || g.x > 4.0 || g.y > 6.0) return 0.0;
  g.x = min(g.x, 4.0 - g.x);
  float on = step(0.48, hash12(g + seed * 37.0));
  vec2 f = fract(local * vec2(5.0, 7.0));
  return on * step(0.12, f.x) * step(0.1, f.y);
}
#endif

#if ENTITY_RAIN
float rain(vec2 uv) {
  float cols = u_grid.x * 0.5;
  vec2 cell = vec2(floor(uv.x * cols), 0.0);
  float rows = cols * u_resolution.y / u_resolution.x * 1.4;
  float y = (1.0 - uv.y) * rows;
  float speed = (2.0 + hash12(cell) * 6.0) * (0.35 + tpsNorm() * 2.2 + u_error_state);
  float head = fract(hash12(cell + 7.0) + u_time * speed / rows) * (rows + 30.0);
  float trail = head - y;
  if (trail < 0.0 || trail > 26.0) return 0.0;
  vec2 local = vec2(fract(uv.x * cols), fract(y));
  float g = glyph(local, hash12(vec2(cell.x, floor(y))) + floor(u_time * 4.0 + hash12(cell) * 9.0));
  return g * pow(1.0 - trail / 26.0, 2.0) * (trail < 1.0 ? 2.0 : 1.0);
}
#endif

#if ENTITY_PARTICLES
float particles(vec2 uv, float aspect) {
  vec2 q = (uv - vec2(0.5, 0.5)) * vec2(aspect, 1.0);
  q.y -= 0.03;
  float r = length(q * vec2(1.0, 0.82));
  float a = atan(q.y, q.x);
  float total = 0.0;
  for (int layer = 0; layer < ENTITY_PARTICLE_LAYERS; layer++) {
    float fl = float(layer);
    float sectors = 48.0 + fl * 36.0;
    float speed = 0.06 + tpsNorm() * 0.35 + u_error_state * 0.8 + u_activity * 0.08 + (1.0 - u_model_confidence) * 0.3;
    vec2 lp = vec2(a / 6.2831853 * sectors, log(r) * sectors / 6.2831853 - u_time * speed * (6.0 + fl * 3.0));
    vec2 id = floor(lp);
    vec2 f = fract(lp);
    float h = hash12(id + fl * 91.7);
    float spray = 0.55 + 0.45 * abs(cos(a));
    float shell = smoothstep(0.26, 0.36, r) * (1.0 - smoothstep(0.42, 0.95 + u_error_state * 0.3, r));
    float density = shell * spray * (0.2 + (1.0 - u_model_confidence) * 0.6 + u_error_state * 0.3);
    if (h > density) continue;
    float s = 0.18 + hash12(id + 3.1) * 0.3;
    float sq = step(s, f.x) * step(f.x, 1.0 - s) * step(s, f.y) * step(f.y, 1.0 - s);
    float twinkle = 0.5 + 0.5 * sin(u_time * (2.0 + h * 9.0) + h * 40.0);
    total += sq * (0.35 + 0.65 * twinkle) * (1.0 - fl * 0.25);
  }
  return total;
}
#endif

vec3 scene(vec2 uv) {
#if ENTITY_PARTICLES
  float aspect = u_resolution.x / u_resolution.y;
#endif
  float unc = 1.0 - u_model_confidence;
  vec2 gp = uv * u_grid;
  vec2 cell = floor(gp);
  vec2 local = fract(gp);

  float flick = floor(u_time * (5.0 + tpsNorm() * 18.0));
#if ENTITY_GLYPHS
  float h = hash12(cell);
#endif
  float shatter = step(1.0 - unc * 0.85 - u_error_state * 0.2, hash12(cell + flick * 0.13));
  vec2 jitter = (vec2(hash12(cell + flick), hash12(cell - flick)) - 0.5) * (2.0 + unc * 10.0) * shatter;
  vec4 c = texture2D(u_cells, (cell + jitter + 0.5) / u_grid);
  float lit = c.r;
  float hit = c.b;

  float gap = mix(0.1, 0.24, 1.0 - lit) + shatter * 0.1;
  vec2 m = step(vec2(gap), local) * step(local, vec2(1.0 - gap));
  float tile = m.x * m.y;
  float bevel = 0.8 + 0.2 * (1.0 - local.y) * local.x;

  float shape = tile * bevel;
#if ENTITY_GLYPHS
  float glyphChance = 0.03 + unc * 0.55 + u_error_state * 0.25 + u_activity * 0.04;
  float isGlyph = step(1.0 - glyphChance, hash12(cell + floor(u_time * (2.0 + tpsNorm() * 6.0)) * 0.37));
  shape = mix(shape, glyph(local, h + flick), isGlyph);
#endif

  float erode = step(hash12(cell + floor(u_time * 1.5)), c.a * c.a * 0.55 + unc * 0.25);
  float faceMask = hit * shape * (1.0 - erode * 0.85);

  float depthFade = 1.0 - c.g * 0.35;
  vec3 col = paletteFor(lit) * lit * faceMask * depthFade * 1.25;

  float halo = (1.0 - hit) * c.a;
  col += paletteFor(0.6) * halo * 0.05;

#if ENTITY_PARTICLES
  float pt = particles(uv, aspect) * (1.0 - hit * tile);
  col += paletteFor(0.75) * pt * 0.55;
#endif

  float scanY = fract(u_time * (0.08 + tpsNorm() * 0.5));
  float scan = exp(-abs(uv.y - (1.0 - scanY)) * 60.0);
  col += paletteFor(0.9) * scan * 0.35 * (hit * tile + 0.15);

#if ENTITY_RAIN
  vec3 bg = paletteFor(0.4) * rain(uv) * (0.07 + u_activity * 0.06 + u_error_state * 0.1);
#else
  vec3 bg = vec3(0.0);
#endif
  vec2 gridLines = abs(fract(uv * u_grid / 8.0) - 0.5);
  float lines = step(0.485, max(gridLines.x, gridLines.y));
  bg += paletteFor(0.3) * lines * 0.025;
  return col + bg * (1.0 - faceMask);
}

void main() {
  vec2 uv = vUv;
#if ENTITY_TEAR || ENTITY_POST
  float unc = 1.0 - u_model_confidence;
  float e = u_error_state;
#endif

#if ENTITY_TEAR
  float band = floor(uv.y * 28.0);
  float tt = floor(u_time * 20.0);
  float tearOn = step(0.62 - e * 0.25, hash12(vec2(band, tt)));
  float tear = (hash12(vec2(tt, band)) - 0.5) * tearOn * (e * 0.22 + unc * 0.025);
  float bigTear = step(0.93, hash12(vec2(floor(u_time * 7.0), 3.0))) * e;
  tear += bigTear * 0.08 * sin(uv.y * 40.0 + u_time * 30.0);
  uv.x += tear;
#elif ENTITY_POST
  float tt = 0.0;
#endif

  vec3 col = scene(uv);
#if ENTITY_POST
  float split = 0.0015 + e * 0.012 + unc * 0.003;
  if (split > 0.002) {
    col.r = scene(uv + vec2(split, 0.0)).r;
    col.b = scene(uv - vec2(split, 0.0)).b;
  }
#endif

  float scanline = 0.88 + 0.12 * sin(gl_FragCoord.y * 3.14159);
  col *= scanline;
  vec2 v = vUv - 0.5;
  col *= 1.0 - dot(v, v) * 1.1;
#if ENTITY_POST
  col += (hash12(gl_FragCoord.xy + fract(u_time) * 100.0) - 0.5) * 0.035;
  col *= 1.0 + e * 0.35 * step(0.85, hash12(vec2(tt, 9.0)));
#endif
  gl_FragColor = vec4(max(col, 0.0), 1.0);
}
`;

/**
 * Desktop keeps the full march and the full-screen effects. The Deck variant is a tile blit:
 * a short march into a small voxel grid, then no rain, glyphs, particle shells, or RGB split.
 * Those effects run once per framebuffer pixel, which is what stalls an 8-CU APU under WebKitGTK.
 */
const SHADER_DEFINES = {
  full: {
    ENTITY_MARCH_STEPS: "72",
    ENTITY_MARCH_SCALE: "0.8",
    ENTITY_MARCH_NOISE: "1",
    ENTITY_AO: "1",
    ENTITY_PARTICLE_LAYERS: "3",
    ENTITY_PARTICLES: "1",
    ENTITY_POST: "1",
    ENTITY_RAIN: "1",
    ENTITY_GLYPHS: "1",
    ENTITY_TEAR: "1",
  },
  deck: {
    ENTITY_MARCH_STEPS: "20",
    ENTITY_MARCH_SCALE: "1.0",
    ENTITY_MARCH_NOISE: "0",
    ENTITY_AO: "0",
    ENTITY_PARTICLE_LAYERS: "1",
    ENTITY_PARTICLES: "0",
    ENTITY_POST: "0",
    ENTITY_RAIN: "0",
    ENTITY_GLYPHS: "0",
    ENTITY_TEAR: "0",
  },
} as const;

export function entityShaders(deck: boolean) {
  const header = Object.entries(deck ? SHADER_DEFINES.deck : SHADER_DEFINES.full)
    .map(([name, value]) => `#define ${name} ${value}`)
    .join("\n");
  return {
    cell: `${header}\n${CELL_FRAG_BODY}`,
    composite: `${header}\n${COMPOSITE_FRAG_BODY}`,
  };
}

export const CELL_FRAG = entityShaders(false).cell;
export const COMPOSITE_FRAG = entityShaders(false).composite;
