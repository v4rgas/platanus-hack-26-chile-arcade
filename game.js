// WIP open-world arcade game. Read spec.md and dev/AGENT_RULES.md before editing.
// Everything lives inside this IIFE so SWC can mangle top-level names.
(() => {
// Top-level names in order of use count: SWC hands out mangled names in declaration order, so the
// most used ones get the 1-letter names (values are assigned where they used to be declared).
// (declaration order: these all get 1-letter names under SWC)
// hoisted plain values
// ===== MATH =====
let M = Math,
sin = M.sin, cos = M.cos, abs = M.abs, min = M.min, max = M.max, PI = M.PI, H2 = PI / 2, hyp = M.hypot, at2 = M.atan2,
WT = [.92, .92, .9],
// ===== MODELS =====
// Every model is an array of boxes in local space (+Z forward, y=0 ground).
MODELS = {},
DK = [.08, .08, .09],
// camera state (written by update, read by render)
cam = { f: 1, sh: 0 }, // e, w: set by restart(), t: by updateCam
// ===== WORLD: ENTITIES, TRAFFIC, LIGHTS, PEDESTRIANS =====
// ENT: flat list of plain objects. k=0 car (player car included), k=1 pedestrian.
// Undocumented internal fields use single capitals: A/F block center x/z (pedestrians), J/U/K velocity x/y/z
// (knocked cars, particles, debris), Y flee angle, Z wheel spin angle, W burning frames, V last wall-crash time,
// H sinking (player car in the sea).
ENT = [],
DX = [0, 1, 0, -1], DZ = [1, 0, -1, 0], // direction d -> forward; right of d is (-DZ, DX)
ply = { k: 1, sn: 4, ph: 0, u: 1 }, RM = [],
// hoisted helper functions (defined up front; nothing below calls them before their dependencies exist)
held = b => bt(HELD, b), // boolean
clamp = (v, a, b) => v < a ? a : v > b ? b : v,
as = () => abs(car.s), // |car speed|
rnd = (m = 2147483647) => (seed = seed * 16807 % m) / m, rs = () => rnd() - .5,
// 4x4 column-major matrices
// (element n = column i * 4 + row j; summed from 0 in k order, as the old loop did)
mul = (a, b) => a.map((_, n, __, i = n & 12, j = n & 3) => 0 + a[j] * b[i] + a[4 + j] * b[i + 1] + a[8 + j] * b[i + 2] + a[12 + j] * b[i + 3]),
// Model matrix: translate, yaw h (local +Z = forward = (sin h, cos h)), pitch p (nose up), roll r.
// (locals as default parameters: shorter than a block body once minified; never pass extra arguments)
modelMat = (x, y, z, h, p = 0, r = 0, c = cos(h), s = sin(h), cp = cos(p), sp = sin(p), cr = cos(r), sr = sin(r)) =>
  mul(mul([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, x, y, z, 1], [1, 0, 0, 0, 0, cp, -sp, 0, 0, sp, cp, 0, 0, 0, 0, 1]), [cr, sr, 0, 0, -sr, cr, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
// ===== GEOMETRY =====
// Vertex layout: pos(3) color(4: rgb + flag) normal(3) = 10 floats. Flag: 0 plain, +-2 glass, -1 textured
// (rg = atlas texel), >= 3 tiled env texture in world uv (TL).
// box(): x,z = center, y = bottom. col = [r,g,b] or [r,g,b,flag].
// A box with h < .05 only emits its top face (road markings, decals).
// Textured box (people skins): col = 6 atlas rects [x, y, w, h] in texels for the faces -X, +X, bottom, top,
// back, front. The texel coords go in color.rg with flag a = -1; u runs left to right as seen from outside, v top-down.
// gray (or any uniform) triple
gy = v => [v, v, v],
// TL: tiled env texture t (dev/ENV_GUIDE.md order, 0..19) tinted by c, s in tenths: uv scale 1 + 10 s (see FS)
TL = (t, c = gy(1), s = 0) => [...c, 3.1 + t + s],
box = (A, x, y, z, w, h, d, col, hs = [w / 2, h / 2, d / 2], cy = y + h / 2, c = C4(col), a, s) => {
  
  for (a = 0; a < 3; a++) for (s of [-1, 1]) {
    if (h < .05 && (a != 1 || s < 0)) continue;
    let b = (a + 1) % 3, e = (a + 2) % 3, r = col[0].map && col[a * 2 + (s > 0)], P = (i, j, p = [], u = a > 1 ? (1 + s * i) / 2 : (1 - (a ? 1 : s) * j) / 2, v = (1 - (a > 1 ? j : i)) / 2) => (
      p[a] = s * hs[a], p[b] = i * hs[b], p[e] = j * hs[e], [x + p[0], cy + p[1], z + p[2], ...r ? uvt(r, u, v) : c]);
    poly(A, [P(-1, -1), P(1, -1), P(1, 1), P(-1, 1)], [x, cy, z]);
  }
},
// 3-vector helpers (first 3 components of a and b): difference, unit vector, dot product
sub = (a, b) => [0, 1, 2].map(i => a[i] - b[i]),
// solid: the sea beyond the waterline (x = -48) or any obstacle (hg; out of the city: the countryside, cs)
solid = (x, z) => -48 > x || hg(x, z),
mark = (x, z, w, d, h = 2, i, j) => {
  for (i = fl(x - w / 2); i < x + w / 2; i++) for (j = fl(z - d / 2); j < z + d / 2; j++) GRID[gi(i, j)] = h;
},
// ===== SKINS + LOW-POLY PEOPLE =====
// Atlas: 9 skins of 32x32 side by side (0 player, 1..8 pedestrians; 1, 3, 6 female). Regions per dev/SKIN_GUIDE.md.
// People are built from lathes: stacked elliptical rings joined into an N-sided tapered prism with smooth normals.
// lathe(A, R, G, N): R = rings [y, rx, front rz, back rz, ...] bottom to top, G = atlas rects for the four arcs
// [front, +X side, back, -X side]. A facet belongs to the arc its center faces (front / back: |cos| > .4).
// u is the projection of the vertex as seen from that side (left to right, like box()), stretched to fill the
// rect; v runs top-down over the lathe height. Both ends are closed with fans.
// Colored lathe: G = [r, g, b] (no texture). X, Y, Z offset the whole lathe.
lathe = (A, R, G, N = 8, X = 0, Z = 0, Y = 0) => {
  let n = R.length / 4, Y1 = R[n * 4 - 4], L = [9, 9, 9, 9], H = [-9, -9, -9, -9], i, a, j, J, x, c, o;
  let t = i => (i - .5) * 2 * PI / N, q = (i, a = i * 2 * PI / N, c = cos(a)) => c > .4 ? 0 : -.4 > c ? 2 : sin(a) > 0 ? 1 : 3;
  let pu = (k, a) => [1 + sin(a), 1 - cos(a), 1 - sin(a), 1 + cos(a)][k] / 2;
  for (i = N; i--;) for (a of [t(i), t(i + 1)]) { let k = q(i), u = pu(k, a); L[k] = min(L[k], u); H[k] = max(H[k], u); }
  // vertex on ring j at angle a in arc k; caps (c = +-1): flat normal, o = 1 for the center
  // (P, Q, m: ring slope for the normal: neighbours' mean radius change over their height)
  let V = (j, a, k, c, o, J = j * 4, y = R[J], f = cos(a), r = G[k], u = o ? .5 : (pu(k, a) - L[k]) / (H[k] - L[k] || 1), v = (Y1 - y) / (Y1 - R[0]),
    P = max(J - 4, 0), Q = min(J + 4, n * 4 - 4), m = i => R[i + 1] + R[i + 2],
    N3 = c ? [0, c, 0] : [sin(a), (m(P) - m(Q)) / 2 / (R[Q] - R[P]), f]) => [X + !o * R[J + 1] * sin(a), Y + y, Z + !o * R[J + (f > 0 ? 2 : 3)] * f, ...G[0].map ? uvt(r, u, v) : C4(G), ...nrm(N3)];
  for (i = 0; i < N; i++) {
    let a = t(i), b = t(i + 1), k = q(i), L = [[0, 0, -1, 1], [0, b, -1], [0, a, -1], [n - 1, 0, 1, 1], [n - 1, a, 1], [n - 1, b, 1]];
    // [ring, angle, cap, center]: both end caps, then two triangles per side facet
    for (j = 0; j < n - 1; j++) L.push([j, a], [j, b], [j + 1, b], [j, a], [j + 1, b], [j + 1, a]);
    for ([J, x, c, o] of L) A.push(...V(J, x, k, c, o));
  }
},
// lathe rings: RR(y, r, y, r...) round rings; ellipsoid of half height h, radius r centered on y = 0
RR = (...a) => a.flatMap((v, i) => i & 1 ? [v, v, v] : v),
dl = (...a) => drawList.push(...a),
// glide param p to v with time constant k (never assign .value on a sounding param: it clicks)
aSet = (p, v, k = .05) => p.setTargetAtTime(v, aNow(), k),
// packed one-shot (dev/SOUND_GUIDE.md tables, quantized): layers separated by spaces, one char per field,
// code = char - 33. Wave / filter fields raw; pitch / cutoff 20 * 1.08^code Hz; times, volumes, Q .002 * 1.115^code
SX = s => s.split(' ').map(l => [...l].map((c, i) => (c = c.charCodeAt() - 33, i %= 6) ? i < 3 ? 20 * 1.08 ** c : .002 * 1.115 ** c : c)),
// one-shot. S = layers [wave, f0, f1=f0, dur, vol, delay=0, filter=0, c0=1.6e4, c1=c0, Q=1, attack=.002]
// wave 0 noise 1 sine 2 square 3 saw 4 triangle; filter 0 lowpass 1 highpass 2 bandpass. Pitch f0->f1 and cutoff
// c0->c1 glide over dur; gain rises in 'attack', then decays to silence at dur. v volume, p pan -1..1,
// r random spread (pitch, cutoff, timing; per call and per layer), x truthy: drive bus (saturation, grit, reverb)
play = (S, v = 1, p = 0, r = .1, x) => {
  if (!AC || aV > 48 || v < .01) return;
  let t = aNow() + .005, k = 1 + rs() * r, o = aPan(p, x ? aD : aO);
  for (let [w, f0, f1 = f0, d, g, dl = 0, ft = 0, c0 = 1.6e4, c1 = c0, q = 1, at = .002] of S) {
    let j = k * (1 + rs() * r), s = aSrc(w), f = aFlt(ft, q, c0), G = aGn(), a = G.gain, b = t + dl * j, e = b + d * j;
    w && aRamp(s[FQ], f0 * j, f1 * j, b, e);
    aRamp(f[FQ], c0 * j, c1 * j, b, e);
    a.setValueAtTime(0, b); a.linearRampToValueAtTime(g * v, b + at); a.exponentialRampToValueAtTime(1e-4, e);
    aCh(s, f, G, o);
    s.start(b, rnd()); s.stop(e + .02); aV++; s.onended = () => aV--;
  }
},
// world position of local point (u right-hand-left axis, v forward) of entity o. Local +X = driver (left) side.
loc = (o, v, u = 0, c = cos(o.a), s = sin(o.a)) => [o.x + u * c + v * s, o.z - u * s + v * c],
// a new star plays the growling stab
heat = v => { H = min(5.9, H + v); (H | 0) > W && play((SX('#EEMI!!ZOd #JJSIG!]Od $<<UKG!MD')), .35, 0, 0, 1); W = H | 0; if (v) L = 0; },
// money hook (also for the future plane): multiplier = 1 + stars, with a short "+$" popup
addMoney = (v, l) => {
  v = v * (1 + W) | 0;
  if (!v || E) return;
  // ding (variant D, at most one per 150 ms): coin slap + drawer thunk, then the last 1-4 (by amount) of
  // C6 E6 G6 C7 as muted bells + metal ring
  if (T - DT > 150) DT = T, play([...SX('!II?Y!#c]^ "=5BT!!Q'),
  ...[1047, 1319, 1568, 2093].slice((v < 100) + (v < 500) + (v < 2e3)).flatMap((f, i) => [[4, f, , .3, .25, i = .03 + i * .07, 0, 2600, 1200], [0, , , .14, 1.5, i, 2, f * 2.1, f * 2, 20]])]);
  MO += v; PT = 70; MU = 1;
  pop.setText('+$' + v + ' ' + l);
},
  car, J, P, gl, F, AC, foot, W, inP, near, PJ, T, E, TI;
// ===== INPUT =====
// DO NOT replace existing keys - they match the physical arcade cabinet wiring.
// To add local testing shortcuts, append extra keys to any array.
let CABINET_KEYS = {
  P1_U: ['w'],
  P1_D: ['s'],
  P1_L: ['a'],
  P1_R: ['d'],
  P1_1: ['u'],
  P1_2: ['i', ' '],
  P1_3: ['o'],
  P1_4: ['j'],
  P1_5: ['k'],
  P1_6: ['l'],
  P2_U: ['ArrowUp'],
  P2_D: ['ArrowDown'],
  P2_L: ['ArrowLeft'],
  P2_R: ['ArrowRight'],
  P2_1: ['r'],
  P2_2: ['t'],
  P2_3: ['y'],
  P2_4: ['f'],
  P2_5: ['g'],
  P2_6: ['h'],
  START1: ['Enter'],
  START2: ['2'],
};
let KEYMAP = {}, kn = k => k.length < 2 ? k.toLowerCase() : k,
HELD = {}, PRESSED = {},
keyCode = e => KEYMAP[kn(e.key)], bt = (S, b) => [...'' + ([, 14, 3, 25][b] || b)].some(n => S['P1_' + n] | S['P2_' + n]),
hit = b => bt(PRESSED, b),
// axis: 1 when a is held, -1 when b is held
ax = (a = 'L', b = 'R') => held(a) - held(b),
angDiff = (a, b) => at2(sin(b - a), cos(b - a)),
 sgn = M.sign, rou = M.round, fl = M.floor,
toward = (v, t, s) => v < t ? min(v + s, t) : max(v - s, t),
// packed numbers (NS): chars 32..126 minus the double quote, slash and backslash are indices 0..91 (ci); one char
// per value in -.40...39 ((index - 40) / 100), or two chars (first index 80..91) for -5.52..5.51, step .01
ci = c => (c = c.charCodeAt() - 32, c - (c > 2) - (c > 15) - (c > 60)),
// (p: pending first char of a two-char value, as index - 79)
NS = (s, p) => [...s].flatMap(c => (c = ci(c), p ? (c = (p * 92 + c - 644) / 100, p = 0, c) : c < 80 ? (c - 40) / 100 : (p = c - 79, []))),
// NS split in groups of n
NC = (s, n, v = NS(s)) => v.flatMap((_, i) => i % n ? [] : [v.slice(i, i + n)]),
seed = 13,
C4 = c => c.length > 3 ? c : [...c, 0],
// boxes packed with NS, 7 values each: color index into C (as index / 100), x, y, z, w, h, d
bl = (A, s, ...C) => NC(s, 7).map(([c, ...b]) => box(A, ...b, C[c * 100 | 0])),
// atlas texel coords for u, v (0..1) inside rect r = [x, y, w, h] (half-texel inset), flag f (-1 textured, -2 glass)
uvt = (r, u, v, f = -1) => [r[0] + .05 + u * (r[2] - .1), r[1] + .05 + v * (r[3] - .1), 0, f],
cross = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]],
 nrm = (v, l = hyp(...v) || 1) => v.map(x => x / l),
dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
// convex polygon of full vertices [x, y, z, c0..c3] (fan), flat normal pointing away from point o
poly = (A, V, o) => {
  let [p, q, s] = V, i, w;
  let n = nrm(cross(sub(q, p), sub(s, p)));
  if (dot(n, sub(p, o)) < 0) V.reverse(), n = n.map(k => -k);
  for (i = 2; i < V.length; i++) for (w of [V[0], V[i - 1], V[i]]) A.push(...w, ...n);
},
// triangle with per-vertex colors, facing away from o
tri = (A, p, q, r, cp, cq, cr, o) => poly(A, [[...p, ...C4(cp)], [...q, ...C4(cq)], [...r, ...C4(cr)]], o),
// irregular low-poly peak: 3 jittered 8-vertex rings (heights 0, .45h, .78h) and an apex; rock at the base,
// 'top' (snow on the Andes) from the upper ring up
mountain = (A, x, z, r, h, top, o = [x, h * .3, z], C = [[.4, .39, .4], [.47, .45, .44], top, top], K = [], f, s, j, i) => {
  
  for ([f, s] of [[0, 1], [.45, .62], [.78, .3], [1, 0]]) // (map callbacks: locals as extra default params after map's 3 arguments)
  K.push([...'01234567'].map((i, _, __, a = i * PI / 4 + rnd() * .5, q = r * s * (.75 + rnd() * .5)) =>
    [x + sin(a) * q, h * f * (s ? .85 + rnd() * .3 : 1), z + cos(a) * q]));
  for (j = 0; j < 3; j++) for (i = 0; i < 8; i++) {
    let a = K[j][i], b = K[j][(i + 1) % 8], c = K[j + 1][i], d = K[j + 1][(i + 1) % 8];
    tri(A, a, b, d, C[j], C[j], C[j + 1], o);
    j < 2 && tri(A, a, d, c, C[j], C[j + 1], C[j + 1], o);
  }
},
// two triangles (p q r s convex, in order), normal away from o; dq: double-sided (o far below / above p)
quad = (A, p, q, r, s, c, o) => poly(A, [p, q, r, s].map(v => [...v, ...C4(c)]), o),
dq = (A, p, q, r, s, c, y) => { for (y of [-999, 999]) quad(A, p, q, r, s, c, [p[0], y, p[2]]); },
// box with chamfered vertical edges (1 m cut): two crossing boxes plus a diagonal wall and roof corner each
chamf = (A, x, y, z, w, h, d, c, u, v) => {
  box(A, x, y, z, w, h, d - 2, c); box(A, x, y, z, w - 2, h, d, c);
  for (u of [-1, 1]) for (v of [-1, 1]) {
    let a = x + u * w / 2, b = z + v * (d / 2 - 1), e = x + u * (w / 2 - 1), g = z + v * d / 2, t = y + h;
    quad(A, [a, y, b], [e, y, g], [e, t, g], [a, t, b], c, [x, y, z]);
    tri(A, [a, t, b], [e, t, g], [e, t, b], c, c, c, [x, -99, z]);
  }
},
// ===== CITY =====
// Grid city: roads of width ROAD between square blocks of size BLOCK.
// (written as literals below: ROAD 12, BLOCK 30, PITCH 42 = ROAD + BLOCK, NB 9, SIZE 390 = NB * PITCH + ROAD)
// Collision grid, 1 m cells covering x in [X0, X0+512), z in [Z0, Z0+512): the city, the beach (x < 0)
// and the airport (z < 0). Each cell stores the obstacle height in meters (0 = free): the plane
// crashes when it is lower than that.
// grid origin X0 -50, Z0 -112 (literals)
GRID = new Uint8Array(512 * 512),
gi = (x, z) => z + 112 << 9 | x + 50, // row * 512 + column (x always inside -50..462)
// pier (wooden dock at z = PZ, x -80..-40, deck at y .5) and open water (sea minus the pier)
// PZ: pier z = 160
pier = (x, z) => x > -80 && -40 > x && abs(z - 160) < 1.6, wet = (x, z) => -48 > x && !pier(x, z),
// walkable for the on-foot player: the sea is free (swimming) out to x = -400
fs = (x, z) => -48 > x ? -400 > x : solid(x, z),
// obstacle height at a point: the grid over the city / beach / airport, the countryside around it
hg = (x, z) => x < 390 && z < 390 && z > -112 ? x > -50 && GRID[gi(x, z)] : cs(x, z),
// facade colors: 7 rgb triples packed one char per channel ((code - 35) / 100)
pal = p => [0, 1, 2].map(j => ('qmeacgxsiZUQi]UU_i}{w'.charCodeAt(p * 3 + j) - 35) / 100),
// BK: block kind per block (bi*NB+bj) for the minimap: 0 buildings, 1 park, 2 tower
BK = [], UMB = [], BN = [],
buildCity = () => {
  // BL: buildings [x, z, w, d, h, color, roof prop, its offset, street side x, street side z], BC: park blocks
  // [cx, cz]; their details / benches are added at the end so the layout keeps its rnd() sequence
  seed = 13; // fixed layout whatever rnd() ran before
  let A = CITY, BL = [], BC = [], cb = (...a) => box(A, ...a), cl = (...a) => lathe(A, ...a), MT = MODELS.mt = [];
  // cm: box on the ground, also marked solid (obstacle height m, default its height)
  let cm = (x, z, w, h, d, c, m = h) => (cb(x, 0, z, w, h, d, c), mark(x, z, w, d, m)), bi, bj, x, z, w, d, h, t, i, j, s, v, u, k, o, c, col, rf, ro, sx, sz, y, cx, cz, pk, b, kind;
  // MT: the mountain ring (drawn around the camera); mr: mountain at angle a (0 = east), distance d
  let mr = (a, d, ...m) => mountain(MT, d * cos(a), d * sin(a), ...m),
    // coast colors: red, awning / umbrella colors
    N = [1.6, .35, 1.2], RED = [.85, .2, .15], UC = [RED, [.2, .4, .8], [.95, .8, .2]],
    // palm: the PALM model leaning toward a random side, a bit scaled
    palm = (x, z, lx = rs(), lz = rs()) => {
      mark(x, z, 1, 1, 8);
      put(A, PALM, modelMat(x, 0, z, at2(lx, lz)), 1 + lz * .3);
    };
  cb(195, -.2, 195, 390, .2, 390, TL(6)); // asphalt
  for (bi = 0; bi < 9; bi++) for (bj = 0; bj < 9; bj++) {
    cx = bi * 42 + 27; cz = bj * 42 + 27;
    cb(cx, 0, cz, 30, .18, 30, TL(5)); // sidewalk
    // street furniture per block: trash bin, hydrant, two lamps over the road
    cl(RR(.18, .25, .95, .3, 1, .33, 1.1, .2), all([240, 32, 16, 16]), 8, cx + 14.2, cz - 5);
    cl(RR(.18, .13, .7, .1, .76, .14, .92, .03), [.8, .15, .1], 6, cx - 14.2, cz + 9);
    put(A, LAMP, modelMat(cx + 14.4, .18, cz + 9, H2));
    put(A, LAMP, modelMat(cx - 3, .18, cz + 14.4, 0));
    kind = rnd();
    // k: block kind (with seed 13 the alley block 29 is never a park; no park benches inside the landmark tower)
    BK.push(k = bi * 9 + bj == 40 ? 2 : kind < .14 ? 1 : 0);
    if (bi * 9 + bj == 29) {
      // start alley: block x 138..168, z 96..126. A 6 m alley (z 108..114) runs from a back
      // building (x < 144) east to the street at x = 168. Floor is dark asphalt; a dumpster inside.
      for (b of [[153, 103.25, 25, 22, 9.5], [153, 118.75, 25, 30, 9.5], [142.25, 111, 3.5, 18, 6]]) cm(...b, TL(3, [.8, .7, .64]));
      cb(156, .18, 111, 24, .01, 6, TL(6, gy(.7)));
      dump(152, 113);
      mark(152, 113, 2, 1.2);
    } else if (k > 1) {
      // landmark glass tower
      cm(cx, cz, 18, 120, 18, TL(1), 134);
      cb(cx, 120, cz, 10, 14, 10, [.4, .5, .6]);
    } else if (k) {
      // park with trees
      BC.push([cx, cz]);
      cb(cx, .18, cz, 26, .05, 26, TL(7));
      for (t = 0; t < 6; t++) {
        x = cx + rs() * 20; z = cz + rs() * 20;
        put(A, TREE[t % 3], modelMat(x, .18, z, x), .85 + (t & 1) * .3);
        mark(x, z, 1, 1, 8);
      }
    } else {
      // buildings start on a 3 m bay boundary (block edge x, z = 42 i + 15) and fill whole bays: facade tiles align
      let nx = rnd() < .5 ? 1 : 2, nz = rnd() < .5 ? 1 : 2; // inner block side 24 m
      for (i = 0; i < nx; i++) for (j = 0; j < nz; j++) {
        w = 24 / nx; d = 24 / nz; x = cx - 12 + w * (i + .5); z = cz - 12 + d * (j + .5);
        h = ((7 + rnd() * rnd() * 50) / 3.4 | 0) * 3.4 + .5; col = pal(rnd() * 7 | 0);
        rf = rnd() < .5;
        BL.push([x, z, w, d, h, col, rf, rf && rs() * w / 3, i * 2 - 1, j * 2 - 1]);
        mark(x, z, w, d, h + 3);
      }
    }
  }
  // dashed lane markings
  for (i = 0; i <= 9; i++) {
    c = i * 42 + 6;
    for (s = 1.5; s < 390; s += 6) if (s % 42 > 13) {
      cb(s, .01, c, 3, 0, .3, LY);
      cb(c, .01, s, .3, 0, 3, LY);
      if (!i) cb(-6, .01, s, .3, 0, 3, gy(.9)); // seaside avenue center line
    }
  }
  // ===== COAST (west): avenue x -12..0, sand x -48..-12, sea beyond (invisible wall at the waterline) =====
  // far ground, 20 km each way: plain fields east of the waterline (under the city and the country chunks), the sea
  // west of it. North / south of here the country chunks continue the coast.
  // (2 km tiles: one huge quad loses depth precision against the patches .3 m above it)
  for (x = 952; x < 2e4; x += 2e3) for (z = -19e3; z < 2e4; z += 2e3) cb(x, -.3, z, 2e3, 0, 2e3, TL(7));
  cb(-10048, -.1, 0, 2e4, 0, 4e4, TL(9));
  cb(-30, -.2, 139, 36, .2, 502, TL(8));     // sand
  cb(-6, -.2, 139, 12, .2, 502, TL(6));        // seaside avenue
  for (z = -100; z < 390; z += 21) palm(-14, z), rnd() < .5 && palm(-20 - rnd() * 22, z + 9);
  // umbrellas (pole + colored canopy)
  for (i = 0; i < 24; i++) {
    x = -42 + rnd() * 22; z = rnd() * 470 - 100;
    cb(x, 0, z, .12, 2.3, .12, TL(19));
    cl(RR(2, 1.5, 2.6, .05), TL(16, UC[i % 3]), 8, x, z);
    cb(x + 1, 0, z + .1, 1, .02, 2.2, TL(17, [[.95, .5, .6], [.3, .75, .7], WT][i % 3], .1)); // towel
    mark(x, z, .5, .5, 3);
    UMB.push([x + 1, z - .7]);
  }
  // pier: deck on posts from the sand into the sea
  cb(-60, .3, 160, 40, .2, 3, TL(18));
  for (x = -78; -44 > x; x += 5) for (v of [-1.3, 1.3]) cl(RR(-1.5, .2, .4, .17), TL(18, gy(.7)), 6, x, 160 + v);
  // lifeguard towers (legs, platform, cabin, roof) and kiosks
  for (z of [40, 200, 330]) {
    for (u of [-.9, .9]) for (v of [-.9, .9]) cb(-36 + u, 0, z + v, .2, 3, .2, TL(19));
    cb(-36, 3, z, 2.6, .2, 2.6, TL(18));
    cb(-36, 3.2, z, 2, 1.6, 2, RED);
    cl(RR(4.8, 2, 5.6, .05), WT, 4, -36, z); // hip roof
    mark(-36, z, 2.4, 2.4, 6);
  }
  for (z of [100, 280]) {
    cm(-17, z, 3, 2.6, 4, TL(18, [1.3, 1.2, .8]), 3);
    cb(-17, 2.6, z, 3.6, .25, 4.6, [.2, .5, .6]);
    // striped awning over the counter (avenue side)
    for (k = z - 2; k < z + 2; k++) dq(A, [-15.5, 2.5, k], [-15.5, 2.5, k + 1], [-14, 2, k + 1], [-14, 2, k], k & 1 ? WT : RED);
  }
  // ===== AIRPORT (south, z -110..0): fence with a gate at road 6, runway, taxiway, hangar, tower =====
  cb(195, -.2, -56, 390, .2, 112, TL(7));       // grass
  cb(185, .03, -60, 290, 0, 20, TL(6, gy(.85)));              // runway x 40..330, takeoff west to the sea
  // center line dashes; edge lights (small yellow boxes) on both edges
  for (x = 50; x < 325; x += 16) {
    cb(x, .05, -60, 8, 0, .6, WT);
    for (z of [-70.4, -49.6]) cb(x, 0, z, .3, .4, .3, [1, .85, .4]);
  }
  cb(258, .02, -25, 12, 0, 50, TL(6));                 // taxiway from the gate
  for ([x, w] of [[126, 252], [327, 126]]) cm(x, -1, w, 2.2, .3, TL(19));
  for (x of [251, 265]) cb(x, 0, -1, .6, 3.5, .6, RED);  // gate posts
  // hangar x 290..322, z -40..-12, open to the runway (south)
  for ([x, z, w, d] of [[306, -12, 32, .6], [290, -26, .6, 28], [322, -26, .6, 28]]) cm(x, z, w, 10, d, TL(3), 16);
  // curved (half-elliptic) roof, 8 strips, outside light / inside dark; gable fans front and back
  for (k = 0; k < 8; k++) {
    let Q = (k, z) => [306 - 16.3 * cos(k * PI / 8), 10 + 6 * sin(k * PI / 8), z], m = (k + .5) * PI / 8;
    for ([o, c] of [[[306, 10, -26], [.62, .64, .66]], [[306 - 99 * cos(m), 10 + 99 * sin(m), -26], [.4, .42, .45]]]) quad(A, Q(k, -40.3), Q(k + 1, -40.3), Q(k + 1, -11.7), Q(k, -11.7), c, o);
    for (z of [-12, -40]) for (s of [-9, 9]) tri(A, Q(k, z), Q(k + 1, z), [306, 10, z], WT, WT, WT, [306, 12, z + s]);
  }
  // control tower: tapered shaft, cabin widening upward, cap
  cl(RR(0, 2, 14, 1.4), [.85, .85, .8], 8, 200, -92);
  cl(RR(14, 2, 14.6, 2.6, 17, 3), [.3, .45, .55], 8, 200, -92);
  cl(RR(17, 3.3, 17.5, 3.2, 18.2, .3), gy(.3), 8, 200, -92);
  mark(200, -92, 5, 5, 18);
  // terminal x 155..205, z -18..-6 (office glass all around), parking lot x 208..248 with stall lines,
  // apron x 140..250, z -50..-20 (the parked planes), yellow lead lines (taxiway, apron), runway threshold stripes
  // at both ends, windsock pole (the sock 'ws' is drawn per frame), cones
  cm(180, -12, 50, 6, 12, TL(1), 7);
  cb(228, .02, -10, 40, 0, 14, TL(6, gy(.7)));
  for (x = 210; x < 248; x += 4) cb(x, .03, -10, .15, 0, 5, WT);
  cb(195, .02, -35, 110, 0, 30, TL(6, gy(1.15)));
  cb(258, .04, -25, .3, 0, 50, LY);
  cb(196, .04, -42, 124, 0, .3, LY);
  for (x of [45, 325]) for (z = -68; -52 > z; z += 2.4) cb(x, .05, z, 7, 0, 1.2, WT);
  cb(70, 0, -45, .12, 6, .12, WT);
  for (x = 150; x < 250; x += 16) cl(RR(0, .2, .6, .02), [1, .4, .1], 6, x, -47);
  // horizon curtain (same rnd() calls as the old fixed ranges, so the city details keep their layout): the snowy
  // Andes over the east, green-gray hills to the north and south, the open sea to the west
  for (z = -900; z < 1290; z += 140) mr(z / 1100 - .18, 1500 + rnd() * 250, 220 + rnd() * 120, 260 + rnd() * 200, gy(.97));
  for (x = 0; x < 990; x += 160) for (s of [1, -1]) mr(s * (1.2 + x / 1e3), 1150 + rnd() * 200, 180, 90 + rnd() * 90, gy(.5));
  // ===== BUILDING DETAIL =====
  // body (windows), plinth, cornice + parapet with a dark roof inside; low buildings get chamfered corners.
  // Taller ones get floor ledges or balcony columns; street-level awnings; roof water tank / AC units / antenna.
  // the "shoe shop" (the strip club meme), beach avenue: dark facade, pink neon high heel (outline) over a pink door.
  // Neon strips [z, y, Z, Y, t] on the facade (x 14.7): from (z, y) to (Z, Y), t thick, drawn from both sides:
  // sole (ball, arch), toe, vamp, collar, heel spike, back
  // (cu: this building is the club, x 21, z 153; N: neon pink)
  for ([x, z, w, d, h, col, rf, ro, sx, sz] of BL) {
    let cu = x == 21 && z == 153;
    if (cu) col = [.3, .12, .32], NC("vo_wwTawwTzHzgavo_wcyxawcyxJz)aJz)zR{<az4TzJTzgzCzgzYzgyi", 5).map(([z, y, Z, Y, t]) => { for (o of [0, 30]) quad(A, ...[[z, y], [z, y + t], [Z, Y + t], [Z, Y]].map(([z, y]) => [14.7, 5 + y * 1.4, 153 + z * 1.4]), N, [o, 6, 153]); });
    let tn = col.map(v => v * 1.15), dk = col.map(v => v * .75), lt = tn.map(v => min(1, v)), low = h < 16, r = rnd();
    let B = (y, hh, g, c, Q = A) => (low ? chamf : box)(Q, x, y, z, w + g, hh, d + g, c), G = [];
    // shopfront floor, facade tiles above (office glass on the tallest), low plinth, metal cornice, roof
    B(0, 3.4, 0, o = TL(2, tn), G);
    // ===== INTERIORS =====
    // Rule: the club (the shoe shop) and ~1 in 7 low buildings get a hollow front room on their x street side
    // (facade f, room center rx): the shopfront's street face is left out, an inside-out box (rewound triangles,
    // flipped normals: seen only from inside, culling hides the outer walls), two wall pieces + a lintel framing a
    // 4 m opening, neon bands. Club: stage + pole (the dancer is drawn in updateWorld); others: a bar counter.
    // RM: [crowd target x, z, facade direction, club] (crowds: updateWorld).
    let op = low && (cu || r > .86), f = x + sx * w / 2, rx = f - sx * 6, R = [];
    NC(0, 30, G).map(t => (!op || t[7] * sx < .9) && A.push(...t)); // (per triangle; [7]: normal x)
    if (op) {
      box(R, rx, .19, z, 11.4, 3.1, 11.4, TL(6, col.map(v => v * .5)));
      NC(0, 30, R).map(t => [0, 20, 10].map(j => A.push(...t.slice(j, j + 10).map((v, k) => k > 6 ? -v : v))));
      mark(rx, z, 10, 10, 0); mark(f, z, 1, 4, 0);
      for (j of [-1, 1]) cb(f - sx * .1, 0, z + j * (d / 4 + .5), .4, 3.4, d / 2 - 3, o), cb(rx - sx, 2.8, z + j * 5.6, 9.4, .1, .05, cu ? N : [.3, .6, 1]);
      cb(f - sx * .1, 2.6, z, .4, .8, 4, o);
      t = rx - sx * (cu ? 3 : 4);
      if (cu) cm(t, z, 5, .5, 5, [.5, .1, .35], 1), cl(RR(.5, .05, 3.3, .05), gy(.9), 6, t, z);
      else cm(t, z, 1, 1.1, 8, [.35, .2, .12]);
      RM.push([t, z, sx, cu]);
    }
    B(3.4, h - 3.4, 0, TL(h > 40 ? 1 : 0, tn));
    B(0, .4, .3, TL(3, dk));
    B(h - .5, 1, .5, TL(19, lt));
    cb(x, h + .5, z, w - .6, .01, d - .6, TL(4));
    if (!low && r < .4) for (y = 10.2; y < h - 3; y += 10.2) B(y, .45, .3, dk);
    else if (!low && r < .7) for (y = 6.8; y < h - 3; y += 6.8) for (u of [-.25, .25]) {
      // balconies at floor level, centered on a window bay
      v = x + u * w + 1.5;
      cb(v, y, z + sz * (d / 2 + .5), 2.2, .15, 1, lt);
      cb(v, y + .15, z + sz * (d / 2 + .97), 2.2, .8, .06, dk);
    }
    // awning (on the street side f)
    if (rnd() < .6) u = d * .3, v = f + sx * 1.4, dq(A, [f, 3.6, z - u], [f, 3.6, z + u], [v, 3, z + u], [v, 3, z - u], UC[rnd() * 3 | 0]);
    if (rf) {
      // water tank with a conical lid, or two AC units
      if (r > .5) cl(RR(.5, 1.1, 2.7, 1.1, 3.5, .1), [.5, .38, .28], 8, x + ro, z, h);
      else for (v of [-1, 1]) cb(x + ro, h + .5, z + v * 1.3, 1.6, 1, 1.4, [.7, .7, .68]);
    }
    if (r < .25) cb(x - ro, h + .5, z - d / 4, .1, 4 + r * 16, .1, DK); // antenna
  }
  // benches in parks
  // (BC: park blocks; BN: bench x, y, z, yaw, also for seated pedestrians)
  for ([cx, cz] of BC) for (i = 0; i < 3; i++) BN.push(b = [cx + rs() * 22, .18, cz + rs() * 22, rnd() * 6]), put(A, BENCH, modelMat(...b));
},
// Low-poly vehicles are textured with the atlas cell of the entity (e.o): car layout per dev/CAR_GUIDE.md.
// RC: atlas rect of region code c (8x8 grid cells, 0..15; 16+: the bus' wide side and split front, the plane's
// fuselage side and wing top).
RC = c => c < 16 ? [c % 4 * 8, c >> 2 << 3, 8, 8] : [[0, 0, 32, 16], [0, 16, 8, 5], [0, 21, 8, 3], [0, 0, 16, 8], [0, 8, 16, 8]][c - 16],
// convex textured face: V = [x, y, z, u, v] (u, v 0..1 over region c; c > 31: glass), normal away from point o
face = (A, V, c, o) => poly(A, V.map(([x, y, z, u, v]) => [x, y, z, ...uvt(RC(c & 31), u, v, -1 - (c > 31))]), o),
// Side-profile extrusion. D = [side code, then per point: z, y, half width, code of the strip to the next point].
// The convex profile (z, y) is extruded across the width; the half width per point lets the cabin lean inward.
// Side caps map the profile's bounding box (u from the front, v from the top); strips map u across the width,
// v from their higher end. Code < 0 skips that face.
ext = (A, D, s) => {
  // (codes are packed as code / 100)
  let [C, ...V] = NS(D), P = NC(0, 4, V), Z = P.map(p => p[0]), Y = P.map(p => p[1]);
  let z0 = min(...Z), z1 = max(...Z), y0 = min(...Y), y1 = max(...Y), o = [0, (y0 + y1) / 2, (z0 + z1) / 2];
  if (C >= 0) for (s of [-1, 1]) face(A, P.map(([z, y, h]) => [s * h, y, z, (z1 - z) / (z1 - z0), (y1 - y) / (y1 - y0)]), rou(C * 100), o);
  P.map(([z, y, h, c], i, _, [Z2, Y2, H2] = P[(i + 1) % P.length], f = +(y < Y2)) =>
    c < 0 || face(A, [[-h, y, z, 0, f], [h, y, z, 1, f], [H2, Y2, Z2, 1, 1 - f], [-H2, Y2, Z2, 0, 1 - f]], rou(c * 100), o));
},
// textured box: one region code for all faces, or six (-X, +X, bottom, top, back, front)
bx = (A, x, y, z, w, h, d, ...c) => box(A, x, y, z, w, h, d, (c[1] ? c : [c, c, c, c, c, c].flat()).map(RC)),
// wheel: 8-sided cylinder along X (hub code on both faces, tire code on the tread), centered on the origin
cyl = (n, r, w, hb, tr, A = MODELS[n] = [], o = gy(0), P = [...'01234567'].map(i => [cos(i = i * PI / 4 + PI / 8) * r, sin(i) * r]), s) => {
  
  for (s of [-w, w]) face(A, P.map(([c, d]) => [s, c, d, .5 + d / r / 2, .5 - c / r / 2]), hb, o);
  P.map(([c, d], i, _, [e, f] = P[(i + 1) % 8]) => face(A, [[-w, c, d, 0, 0], [w, c, d, 1, 0], [w, e, f, 1, 1], [-w, e, f, 0, 1]], tr, o));
},
CITY = [];
addEventListener('keydown', (e, c = keyCode(e)) => {
  if (c) { if (!HELD[c]) PRESSED[c] = 1; HELD[c] = 1; audioInit(); }
});
addEventListener('keyup', (e, c = keyCode(e)) => { if (c) HELD[c] = 0; });
((n, G, A, D) => {
// key -> arcade code map (filled at load, before any key event)
for (n in CABINET_KEYS) for (G of CABINET_KEYS[n]) KEYMAP[kn(G)] = n;
cyl('wc', .34, .12, 10, 11); // car
cyl('wb', .5, .16, 11, 15);  // bus
cyl('wm', .3, .05, 6, 7);    // motorbike
// sd sedan (+pc police, same mesh), cv convertible (windshield frame only). n+'d': driver door, hinge at the origin.
for ([n, G] of [['sd', "qwDz'yypw|zcykL_zcykoy}z'yyI"], ['cv', "Iy}z'yyoyOzNysoqzNysoyuz'yyI"]]) {
  A = MODELS[n] = []; D = MODELS[n + 'd'] = [];
  ext(A, ("JvcyTz Sv`y{z!MwDz'z#Vy}z'z#K{:yuz R{DyTy}V")); ext(A, G);
  // sill between the wheels and bumpers (dark), front seat backs, dashboard, steering wheel (driver side = +X)
  // [0 .28 0 1.8 .24 1.9] [0 .28 +-2.08 1.84 .24 .24] dark; [+-.42 1.02 -.85 .6 .35 .14] seats; [0 1.02 .57 1.5 .18 .4] [.42 1.12 .22 .34 .3 .05] dark
  bl(A, "JJgJz{c{'JJg{:{ ccJJgvg{ ccKxTz+x(y_nXKyLz+x(y_nXJJz+y[z]]yJJyLz6amiO", DK, [.3, .25, .22]);
  bx(D, 0, .5, -.55, .06, .48, 1.1, 0);
  if (n < 's') box(D, 0, .98, -.5, .04, .5, .9, [.18, .22, .28, 2]);
}
MODELS.pc = MODELS.sd;MODELS.pcd = MODELS.sdd;
})();
// bus (~10 m): one profile, the side maps the whole 32x16 side (windows over body), front glass over the lights
let bu = MODELS.bu = [],
// texel rects (32x32 cell): shirt front / back, its outer columns (sides), face, head side, hair, arm, arm side, hand, shoes
all = r => [r, r, r, r],
// ===== ENVIRONMENT MODELS (low-poly, copied into CITY by buildCity) =====
// put: append vertex array S to A transformed by matrix m (modelMat), positions scaled by s
// m * [p, w] for a column-major 4x4 m (w 1: point, 0: direction)
mv4 = (m, p, w) => [0, 1, 2, 3].map(j => m[j] * p[0] + m[j + 4] * p[1] + m[j + 8] * p[2] + m[j + 12] * w),
put = (A, S, m, s = 1, i) => {
  for (i = 0; i < S.length; i += 10) A.push(...mv4(m, S.slice(i, i + 3).map(v => v * s), 1).slice(0, 3), ...S.slice(i + 3, i + 7), ...mv4(m, S.slice(i + 7, i + 10), 0).slice(0, 3));
},
el = (h, r) => RR(...[-1, -.6, 0, .6, 1].flatMap(k => [k * h, r * (1.05 - k * k) ** .5])),
// trees: tapered trunk + 3 overlapping ellipsoid lobes, 3 variants (size, green)
TREE = [0, 1, 2].map(i => {
  let A = [];
  lathe(A, RR(0, .25, 3.4, .1), TL(10, gy(1), .1), 6);
  // [0 4.4 0 2 1.7] [.9 3.7 .6 1.5 1.2] [-.8 3.9 -.6 1.6 1.3]
  NC("J}kJ{2zqy}}#y_z]z>x-}8xBzgzH", 5).map(([x, y, z, r, h]) => lathe(A, el(h, r + i * .2), TL(11, [.9 + i * .1, 1 + x * .1, .9]), 7, x, z, y + i * .3));
  return A;
}),
// palm (leans toward +X): 6 ringed trunk sections along a curve, 7 drooping double-sided fronds, 3 coconuts
PALM = [], LAMP = [], BENCH = [], WD = TL(18, gy(1), .1),
// dumpster: body, slanted lid, four wheels
dump = (x, z, A = CITY, u, v) => {
  
  box(A, x, .3, z, 2, 1.1, 1.2, Array(6).fill([224, 32, 16, 16]));
  quad(A, [x - 1.05, 1.5, z - .65], [x + 1.05, 1.5, z - .65], [x + 1.05, 1.3, z + .65], [x - 1.05, 1.3, z + .65], [.15, .28, .2], [x, 0, z]);
  for (u of [-.8, .8]) for (v of [-.4, .4]) box(A, x + u, .18, z + v, .2, .3, .2, DK);
},
// ===== PEOPLE: POSE =====
// person(B, o, ph, v, md, g): draws a person with skin o on base matrix B (feet at the origin) and returns the
// right forearm matrix (the uzi hangs from it). One procedural pose for everybody, a few sin terms:
// ph: walk phase, v: speed (m/frame; walk .03-.06, run .1-.15), md: 0 on foot, 1 swimming crawl,
// 2 seated (v lifts the knees less: .5 on bikes), 3 lying (sunbathers; knocked people are ragdolls).
// g: arms override, 1 aiming the uzi (right arm forward, left supporting), 2 both reaching forward (carjack).
// Pitch + swings a hanging limb forward. On foot: legs / arms in counter phase (arms lag a bit), knees bend on
// the back swing, elbows bend more when running; bob, hip sway, torso counter-twist, run lean; idle breathing
// and weight shift.
// HP: hips -> mesh origin (the person meshes start .86 below the hips)
HP = modelMat(0, -.86, 0, 0),
person = (B, o, ph, v, md, g, lg) => {
  let fm = 74 >> o & 1, X = fm ? .185 : .2, s = sin(ph), w = md ? 0 : min(v * 25, 1), r = w && clamp(v * 11 - .7, 0, 1),
    id = !md * sin(T / 900) * (1 - w), A = w * (.4 + .45 * r), j, F;
  // hips: bob (lowest with the legs spread), sway toward the stance leg, idle weight shift
  let Hp = mul(B, modelMat(s * w * (.025 + fm * .025) + id * .015, .86 + w * .035 * (abs(cos(ph)) - 1), 0, 0)),
    // torso pivots at the hips: breathing, counter-twist against the legs, run lean, sway roll
    Tq = mul(mul(Hp, modelMat(0, sin(T / 600) * .006, 0, -s * w * .12, -r * .22 - w * .04, -s * w * (.04 + fm * .04) - id * .03)), HP);
  dl([fm ? 'qf' : 'q', Tq, , o]);
  // joint world positions for the ragdoll (JT): pelvis, head, then per side shoulder, elbow, hand, knee, foot
  JT = [tp(Hp), tp(Tq, 1.55, .08)];
  for (j of [1, -1]) {
    let k = j < 0, q = ph + k * PI, sq = sin(q);
    // [thigh, knee, upper arm, elbow, arm roll (out)]
    let [a, b, c, d, e] = [[A * sq + r * .1, -w * (.1 + (.7 + .8 * r) * max(0, -sin(q - .6))) - .03, -A * .8 * sin(q - .25) + r * .1, .15 + w * .15 + r * 1.3, j * .06],
      [.3 * sin(ph * 3 + j) - .1, -.25, -q, .35 + .35 * sq, j * .15], [1.5 - v, v * .3 - 1.4, .9, .5, j * .1], [.15, -.4, 0, .4, j * 1.3]][md];
    if (g > 1) c = 1.2, d = .5;
    if (g == 1) k ? (c = 1.5, d = e = 0) : (c = 1.25, d = .5, e = -.5);
    let U = mul(Hp, modelMat(j * .1, 0, 0, 0, a, md > 2 ? j * .25 : -k * lg || 0)), S = mul(Tq, modelMat(j * X, 1.36, 0, 0, c, e)), N = mul(U, modelMat(0, -.41, 0, 0, b));
    F = mul(S, modelMat(0, -.28, 0, 0, d));
    dl(['qu', S, , o], ['qa', F, , o]);
    JT.push(tp(S), tp(F), tp(F, -.3), tp(N), tp(N, -.41));
    // car drivers' legs are hidden by the body: skip their draws
    if (md - 2 || v) dl([k ? 'qR' : 'qL', U, , o], [k ? 'qT' : 'qS', N, , o]);
  }
  return F;
},
// draw entity e with its current pose (also used to start a ragdoll from it)
// swimmers lie face down at the surface (hips pivot); sunbathers (pitched) lie; people on benches sit (S); the
// player sits down at the end of a carjack, reaches for the door before, raises the uzi while shooting
pose = (e, sw = e.sw, p = e == ply, js = p && J && J.s > .5) =>
  person(sw ? mul(modelMat(e.x, -.12, e.z, e.a, -1.3), HP) : modelMat(e.x, e.y, e.z, e.a, e.p), e.sn, e.ph,
    e.v || e.S || 0, sw ? 1 : js || e.S ? 2 : e.p ? 3 : 0, p && !js && (AM > 0 && !sw ? 1 : J && J.g > .2 ? 2 : 0), e.lg),
// pose joints without drawing: run f, then drop what it queued
quiet = (f, n = drawList.length) => { f(); drawList.length = n; },
// ===== RAGDOLL =====
// Verlet particles [x, y, z, old x, old y, old z] at the 12 joints of JT (0 pelvis, 1 head, 2-6 / 7-11 the +X / -X
// side: shoulder, elbow, hand, knee, foot). Pelvis, head and shoulders form a rigid tetrahedron; limbs are
// distance bones; CS: the bone pairs (2 chars each, decoded by ci: space = 0), the last 3 only keep a minimum distance (knee off
// the chest, knees apart). Rest lengths come from the pose at the takeover.
JT, RQ = [],
CS = ` ! " (!"!("("$$% &&'())* ++,"&(+&+`, tp = (m, y = 0, z = 0) => mv4(m, [0, y, z], 1),
// limb matrix: hanging along -Y from joint r toward joint c, X near the hint X, origin k below r along that axis
seg = (r, c, X, k = 0, Y = nrm(sub(r, c)), Z = nrm(cross(X, Y))) => [...cross(Y, Z), 0, ...Y, 0, ...Z, 0, ...sub(r, Y.map(v => v * k)), 1],
// torso matrix (mesh space, feet at the origin): Y hips -> mid shoulders, X toward the +X shoulder, Z forward
frm = R => seg(R[2].map((v, i) => (v + R[7][i]) / 2), R[0], sub(R[2], R[7]), 1.36),
// one ragdoll: substeps (k rounded), returns the fastest particle speed
updRag = (R, k, p, i, it, a, b, l, n, j, s) => {
  // loop variables
  // fixed 60 Hz steps from a time accumulator (k < 1 on 120+ Hz screens); R.M: fastest particle of the last step
  for (R.A = (R.A || 0) + k; R.A >= 1; R.A--) {
    R.M = 0;
    for (p of R) {
      // damped Verlet step + gravity
      for (i = 3; i--;) { let v = (p[i] - p[i + 3]) * .985; p[i + 3] = p[i]; p[i] += v - (i == 1) * .006; }
      // ground (radius .1; 0 at sea: floats on the surface): no bounce, friction eats 15% of the sliding speed per frame
      let g = gh(p[0], p[2]) + .1;
      if (p[1] < g) p[1] = p[4] = g, p[3] += (p[0] - p[3]) * .15, p[5] += (p[2] - p[5]) * .15;
      R.M = max(R.M, hyp(...sub(p, p.slice(3))));
    }
    // body coherence: each joint's velocity is pulled 12% toward the body's mean (limbs follow instead of flailing)
    s = [0, 1, 2].map(i => R.reduce((a, p) => a + p[i] - p[i + 3], 0) / 12);
    for (p of R) for (i = 3; i--;) p[i + 3] += (p[i] - p[i + 3] - s[i]) * .12;
    for (it = 8; it--;) {
      for ([a, b, l, n] of R.C) {
        let P = R[a], Q = R[b], D = sub(Q, P), d = hyp(...D) || .01, f = (d - l) / d / 2;
        if (!n || d < l) for (i = 3; i--;) P[i] += D[i] * f, Q[i] -= D[i] * f;
      }
      // hinges: knees only bend backward, elbows forward. q: the bend around the body's X, linear in the middle
      // joint with gradient g = (end - root) x X; on the wrong side the joint moves along g to q = 0 (the + .1 bounds
      // the step when the limb lies along X). A fixed push along the body's Z diverged with the limb raised past
      // 90 degrees (mid-stride launches): the body thrashed and dug into walls
      let T = frm(R);
      for (j of [0, 5]) for (s of [1, -1]) {
        let m = R[j + 4 + s], r = R[s > 0 ? 0 : j + 2], e = R[j + 5 + s], q = dot(cross(sub(m, r), sub(e, m)), T), g = cross(sub(e, r), T);
        if (s * q < 0) for (i = 3; i--;) m[i] -= g[i] * q / (dot(g, g) + .1);
      }
    }
    // walls: a joint that ends a step in a wall cell goes back to its last free spot (X, Z), after the constraints, so
    // no joint (nor the pelvis the person gets up at) rests inside a wall; fs: the sea is open (bodies fly into the
    // water); a joint that starts inside one is free until it gets out
    for (p of R) fs(p[0], p[2]) ? p.X && (p[0] = p.X, p[2] = p.Z) : (p.X = p[0], p.Z = p[2]);
  }
  return R.M;
},
// lying still: the player / carjacked drivers get up after ~.7 s, the others stay down ~7 s and despawn
lay = e => { e.h = 2; e.f = e.u ? 40 : 400; },
// knock person e into a ragdoll: impact o = {s speed, t direction}; sp: spin, the push scales with
// 1 + sp * (height over the hips) (car: legs swept, bike: head first); B: base matrix of a seated start pose.
// An active ragdoll just takes the extra velocity. At most 6 simulate at once: the oldest lies still.
launch = (e, o, sp = -.7, B, i, j, p, s) => {
  // loop variables
  if (!e.h) {
    quiet(() => B ? person(B, e.sn, 0, .5, 2) : pose(e));
    let R = e.R = JT.map(([x, y, z]) => [x, y, z, x, y, z]);
    R.C = [];
    for (i = 0; i < 34;) { let a = ci(CS[i++]), b = ci(CS[i++]); R.C.push([a, b, hyp(...sub(R[a], R[b])) * (i > 28 ? .6 : 1), i > 28]); }
    // knees nudged forward so straight legs buckle
    let Z = frm(R);
    for (j of [5, 10]) for (i = 3; i--;) R[j][i + 3] -= Z[i + 8] * .03;
    RQ = RQ.filter(o => o.h == 1);
    RQ.push(e) > 6 && lay(RQ.shift());
  }
  // s: the impact capped (~65 km/h): faster hits throw as far, not further (GTA IV-like, not a cannon)
  let R = e.R, h = R[0][1];
  s = clamp(o.s, -.3, .3);
  for (p of R) { let f = (1 + sp * (p[1] - h)) * s; p[3] -= sin(o.t) * f; p[5] -= cos(o.t) * f; p[4] -= abs(s) * .25; }
  e.h = 1; e.f = 0;
  play(S_CRASH.slice(0, 2), ...spatial(e.x, e.z), .3, 1); // body thud
},
// skin for a new pedestrian / driver: beach (b) prefers swimwear, the city the dressed ones, sometimes any
// skin 4 (blue floral shirt, beard) is reserved for the player; 9 (officer) drives police cars, rarely walks
skin = b => rnd() < .8 ? (b ? '1356' : '2782')[rnd() * 4 | 0] : '12356789'[rnd() * 8 | 0], // digit strings (coerced by >> and *)
// ===== COUNTRYSIDE (procedural, around the city) =====
// No stored map: everything comes from a hash of integer coords. Cells of 14 m (cell gx covers x -57 + 14 gx ..
// +14, center 14 gx - 50; same in z), 9 x 9 cells per chunk of 126 m (chunk i centered on x = 126 i + 6, so its
// middle cell lies on the 42 m road grid). Country roads run through the chunk centers every 2 chunks (= every 6th
// city road: x = 258, 510, ... going north / south, z = ..., -246, 6, 258, 510, ... going east), a village sits at
// some crossroads. The city rect (x < 390, -112 < z < 390) and the coast (x < 9) have no cell content.
hs = (a, b) => abs(sin(a * 127.1 + b * 311.7) * 4e4) % 1,
RX = i => i > 0 && 1 & ~i, RZ = j => 1 & ~j,
// the 14 m cell centered at x, z lies fully outside the city rect
oc = (x, z) => x > 397 || z > 397 || -119 > z,
// cell content: 0, or the obstacle [width, depth, height, x, z, kind] (kind 0 tree, 1 house, 3 fence)
cel = (gx, gz, i = fl(gx / 9), j = fl(gz / 9), c = gx - i * 9 - 4, d = gz - j * 9 - 4, x = gx * 14 - 50, z = gz * 14 - 50, h = hs(gx, gz)) =>
  x > 9 && oc(x, z) && !(!c && RX(i) || !d && RZ(j)) && ((RX(i) && RZ(j) && hs(i, j) < .4 && c * c + d * d < 9 ? h < .6 : h < .03) ? [8, 7, 6, x, z, 1]
    : h < .14 ? [1, 1, 8, x + h * 40 - 4, z + h * 70 - 7, 0] : h < .2 && [14, .3, 1.2, x, z - 6.8, 3]),
// country obstacle height at x, z (the same cells the chunks draw)
cs = (x, z, q = cel(fl((x + 57) / 14), fl((z + 57) / 14))) => q && abs(x - q[3]) < q[0] / 2 && abs(z - q[4]) < q[1] / 2 && q[2],
// OC: built chunks by key, [buffer, count, center, radius]
OC = {},
LY = [.9, .85, .5],
// chunk i, j: per cell fully outside the city: the coast strips (sand, avenue; 16 m long so they overlap the city's),
// a tinted field patch (the plain grass is the far ground), road pieces with 2 center dashes, and
// the cell's obstacle: tree, house (walls + hip roof), fence
mkC = (i, j, A = [], gx, gz, a, s) => {
  
  for (gx = i * 9; gx < i * 9 + 9; gx++) for (gz = j * 9; gz < j * 9 + 9; gz++) {
    let x = gx * 14 - 50, z = gz * 14 - 50, q = cel(gx, gz), t = ([, [1.2, 1.1, .6], [.95, .75, .5]])[hs(gx >> 1, gz >> 1) * 3 | 0];
    if (!oc(x, z)) continue;
    if (gx == 2) box(A, -30, .02, z, 36, 0, 16, TL(8)), box(A, -6, .02, z, 12, 0, 16, TL(6));
    x > 9 && box(A, x, .01, z, 14, 0, 14, TL(7, t)); // grass (or a field) on every cell: the hills need the ground
    for (a of [0, 1]) if (x > 0 && !(((a ? gz : gx) - 4) % 9) && (a ? RZ(j) : RX(i))) {
      box(A, x, .04, z, 12 + a * 4, 0, 16 - a * 4, TL(6));
      for (s of [-3.5, 3.5]) box(A, x + a * s, .06, z + !a * s, a ? 3 : .3, 0, a ? .3 : 3, LY);
    }
    if (q) {
      let [w, e, h, u, v, k] = q, y = h * .57;
      k > 2 ? box(A, u, 0, v, w, h, e, WD) : k ? (box(A, u, 0, v, w, y, e, TL(0, pal(gx % 7))),
        lathe(A, [y - .3, w * .75, e * .75, e * .75, y + e * .4, .3, .1, .1], [.6, .3, .22], 4, u, v))
        : put(A, TREE[gx % 3], modelMat(u, 0, v, gz));
    }
  }
  for (a = 0; a < A.length; a += 10) A[a + 1] += ht(A[a], A[a + 2]); // lift onto the hills
  return [...mkMesh(A), [i * 126 + 6, 5, j * 126 + 6], 95];
},
// ===== RENDERER (raw WebGL inside a Phaser Extern) =====
VY = 'varying vec4 C;varying vec3 N,W;',
CG, CH, prog, uV, uM, uF, uE, uG, uO, TX, meshes = {}, VM = [],
// Atlas PNG 480x48: cells 0 player, 1..9 pedestrians (9: officer), 10 car1 (teal sedan), 11 car2 (red convertible),
// 12 bus, 13 bike, 14 plane (dev/skins/plane_32.png; copied to 36..39 with recolored paint); row y 32..48: the 20 env tiles of dev/ENV_GUIDE.md in one strip (tile t at x = 16 t; the
// PALMA hoja background keyed to alpha 0 offline). On load it is copied into the canvas CV (1280x48) that adds 14: police (car1 repainted white
// and navy) and 15..35: car1, car2, bike with the paint recolored (7 colors each). TX: the GPU texture of CV
// (until then everything textured renders black).
IMG = new Image(),
CV,
gp = k => gl.getParameter(k),
// run f with TX bound on texture unit 0, restoring Phaser's active unit and binding afterwards
// (a: Phaser's active unit, b: its binding on unit 0, read after switching to it)
withTex = (f, a = gp(34016), b = (gl.activeTexture(33984), gp(32873))) => {
  gl.bindTexture(3553, TX); f(); gl.bindTexture(3553, b); gl.activeTexture(a);
},
upTex = () => {
  if (!gl || !CV) return;
  TX = gl.createTexture();
  // no flip / premultiply (Phaser changes them), NEAREST, CLAMP_TO_EDGE, no mipmaps
  withTex((S = [37440, 37441], v = S.map(gp), q, p = f => S.map((k, i) => gl.pixelStorei(k, f[i]))) => {
    p([0, 0]);
    gl.texImage2D(3553, 0, 6408, 6408, 5121, CV);
    p(v);
    for (q = 10244; q-- > 10240;) gl.texParameteri(3553, q, q < 10242 ? 9728 : 33071);
  });
},
mkMesh = (a, b = gl.createBuffer()) => (gl.bindBuffer(34962, b), gl.bufferData(34962, new Float32Array(a), 35044), [b, a.length / 10]),
initGL = (g, t, s, i, k) => {
  // loop variables
  gl = g;
  prog = gl.createProgram();
  [('attribute vec3 p,n;attribute vec4 c;uniform mat4 v,m;' + VY + 'void main(){vec4 w=m*vec4(p,1);W=w.xyz;N=(m*vec4(n,0)).xyz;C=c;gl_Position=v*w;}'), ('precision highp float;' + VY + 'uniform vec3 f,e;uniform float g,o;uniform sampler2D t;void main(){float a=C.a;if(abs(abs(a)-2.)<.5!=g>.5)discard;vec3 n=normalize(N),c=C.rgb;vec2 q=vec2(C.r+o,C.g);if(a>3.)q=fract((abs(n.y)>.5?W.xz/2.:vec2(abs(n.x)>abs(n.z)?-W.z*sign(n.x):W.x*sign(n.z),-W.y)/vec2(3,3.4))*fract(a)*10.)*15.+vec2(floor(a-3.)*16.+.5,32.5);if(a<0.||a>3.){vec4 k=texture2D(t,q/vec2(1280,48));if(k.a<.5)discard;c=(a<0.?vec3(1):c)*k.rgb;}c*=.62+.48*max(dot(n,vec3(.42,.8,.43)),0.)+.08*n.y;gl_FragColor=vec4(mix(c,f,min(max(distance(W,e)-90.,0.)/420.,.82)),1)*(1.-g*.65);}')].map((s, i, _, o = gl.createShader(35633 - i)) => { gl.shaderSource(o, s); gl.compileShader(o); gl.attachShader(prog, o); });
  // attribute locations fixed: p 0, c 1, n 2
  [...'pcn'].map((k, i) => gl.bindAttribLocation(prog, i, k));
  gl.linkProgram(prog);
  [uV, uM, uF, uE, uG, uO] = [...'vmfego'].map(k => gl.getUniformLocation(prog, k));
  // the static city in chunks of 84 m (2x2 blocks) by the first vertex of each triangle; triangles over 50 m
  // (ground, sea, mountains, long roads) share one always-drawn chunk. CH: [buffer, count, center xyz, radius]
  if (!CG) {
    CG = {};
    for (i = 0; i < CITY.length; i += 30) {
      t = CITY.slice(i, i + 30); let s = o => max(t[o], t[o + 10], t[o + 20]) - min(t[o], t[o + 10], t[o + 20]) > 50;
      (CG[s(0) || s(2) ? 0 : (t[0] + 500) / 84 << 5 | (t[2] + 500) / 84] ||= []).push(...t);
    }
  }
  CH = Object.values(CG).map((a, _, __, L = [0, 1, 2].map(j => a.filter((v, i) => i % 10 == j)), lo = L.map(v => min(...v)), hi = L.map(v => max(...v))) =>
    [...mkMesh(a), lo.map((v, j) => (v + hi[j]) / 2), hyp(...lo.map((v, j) => hi[j] - v)) / 2]);
  for (k in MODELS) meshes[k] = mkMesh(MODELS[k]);
  OC = {};
  upTex();
},
// o: skin index (atlas cell) for textured people
drawMesh = (ms, m, o) => {
  gl.bindBuffer(34962, ms[0]);
  [3, 4, 3].map((n, a) => gl.vertexAttribPointer(a, n, 5126, 0, 40, a * (a + 5) * 2));
  gl.uniformMatrix4fv(uM, 0, m);
  gl.uniform1f(uO, o * 32 || 0);
  gl.drawArrays(4, 0, ms[1]);
},
// list of things to draw this frame: [meshName, matrix, no glass, skin]
drawList,
// ===== AUDIO =====
// SUCIO procedural audio (ported from dev/sound-lab.js, see dev/SOUND_GUIDE.md). Everything is WebAudio nodes.
// AC context, aO master bus (-> limiter-like compressor), aZ 2 s shared white noise, aV live voices (cap 48),
// aD drive bus: asymmetric tanh clip (even + odd harmonics) -> aO, and in parallel -> street reverb (0.9 s decaying
// noise impulse, 30 % send). The lab's bitcrush (dirt) bus is cut for size.
// Loops: aE engine, aK skid, aS siren, aR scrape. aG gear, aT last throttle, aU throttle cut end time.
aO, aD, aZ, aV = 0, aE, aG, aT, aU, aK, aS, aR, aQ,
WV = [, 'sine', 'square', 'sawtooth', 'triangle'], FQ = 'frequency',
aNow = () => AC.currentTime,
// p jumps to a at time t, then glides exponentially to b at time e
aRamp = (p, a, b, t, e) => p.setValueAtTime(a, t).exponentialRampToValueAtTime(b, e),
aCh = (...n) => n.reduce((a, b) => a.connect(b)),
aGn = (gain = 0) => new GainNode(AC, { gain }),
// waveshaper tanh(k x + .4) - tanh(.4) (asymmetric: even + odd harmonics, exact 0 at rest)
aSh = (k, t = M.tanh) => new WaveShaperNode(AC, { curve: new Float32Array(513).map((_, i) => t(k * (i / 256 - 1) + .4) - t(.4)) }),
// fill channel c of buffer b with noise decaying as (1 - t)^e (e 0: plain white noise)
aFill = (b, c, e) => b.getChannelData(c).forEach((_, i, d) => d[i] = rs() * 2 * (1 - i / d.length) ** e),
// on every key press (browsers only start audio after a user gesture)
audioInit = () => {
  if (AC) return AC.resume();
  AC = new AudioContext();
  let r = AC.sampleRate, b = AC.createBuffer(2, r * .9, r);
  // safety limiter: only peaks over -12 dB
  aCh(aO = aGn(.8), new DynamicsCompressorNode(AC, { threshold: -12, knee: 6, ratio: 10 }), AC.destination);
  aCh(aD = aSh(4), aO);
  aFill(b, 0, 4); aFill(b, 1, 4);
  aCh(aD, aGn(.3), new ConvolverNode(AC, { buffer: b }), aO);
  aFill(aZ = AC.createBuffer(1, r * 2, r), 0, 0);
},
// source: w 0 = noise (shared buffer, looped), 1..4 = sine square sawtooth triangle
aSrc = w => w ? new OscillatorNode(AC, { type: WV[w] }) : new AudioBufferSourceNode(AC, { buffer: aZ, loop: 1 }),
aFlt = (t, Q, frequency) => new BiquadFilterNode(AC, { type: ['low', 'high', 'band'][t] + 'pass', Q, frequency }),
aPan = (pan, o = aO, n = new StereoPannerNode(AC, { pan })) => (n.connect(o), n),
// [volume, pan] of world point x, z heard from the camera (screen right = -X when looking along cam.w)
spatial = (x, z, dx = x - cam.e[0], dz = z - cam.e[2], d = hyp(dx, dz)) => [1 / (1 + d * d / 400), -sin(at2(dx, dz) - cam.w) * min(1, d / 6)],
// continuous voice: source w -> [inserts] -> filter (type t, Q q, cutoff c) -> gain (starts silent) -> panner;
// returns its params [source frequency, filter frequency, gain, pan]
aLp = (w, t, q, c, ...x) => {
  let s = aSrc(w), f = aFlt(t, q, c), g = aGn(), n = aPan(0);
  aCh(s, ...x, f, g, n); s.start();
  return [s[FQ], f[FQ], g.gain, n.pan];
},
// engine presets (SX-packed, quantized): [wave, Hz idle, Hz span, sub (half order) mix, exhaust noise mix,
// noise band (x firing Hz), gears (1 = none), cutoff base, +cutoff*rpm, volume, drive, firing jitter, -,
// +cutoff*throttle, -, intake]: 0 car (lumpy 4 cyl, rasp), 1 motorbike (harsh), 2 boat outboard (2-stroke), 3 prop plane (buzz)
// overrun pops / backfire: n short band-passed noise cracks
aPops = (n, v) => play([...Array(n)].map((_, i) => [0, , , .05, 1, i * .07 + rnd() * .05, 2, 400 + rnd() * 1500, 200, 2]), v, 0, .4, 1),
// once per frame (only with AC): e preset, v speed 0..1, th throttle 0..1, on 0 mutes (on foot, game over)
engine = (e, v, th, on, [w, h0, hs, sm, nm, nb, G, c0, cr, vol, dr, jt, , ct, , it] = SX(`$$?WYd&D[CiB!Y![ $*FP^i'MbBn?!_!_ #(=S]a"FVAk@!R!W $-3U]l"KUBg:!U!W`)[e]) => {
  
  // saw (firing pulses) + square at half order -> lowpass -> drive gain -> tanh shaper -> out;
  // exhaust noise -> bandpass whose gain is chopped by the saw (one burst per firing); intake hiss. aE[9]: wired
  let [o, s, sg, f, dg, g, n, am, ik] = aE ||= [aSrc(3), aSrc(2), aGn(), aFlt(0, 2, 500), aGn(), aGn(), aLp(0, 2, 1.5, 500), aGn(), aLp(0, 2, .8, 2e3)], x = min(v, .999) * G, gr = x | 0, V = on * vol;
  aE[9] ||= (o.connect(f), aCh(o, am, n[2]), o.start(), s.start(), aCh(s, sg, f, dg, aSh(5), g, aO));
  // gearbox: rpm climbs through each gear and falls back to ~half after an upshift
  let r = max(G > 1 ? gr ? .45 + .55 * (x - gr) : .15 + .85 * x : .15 + .85 * v, .15 + th * .25);
  if (gr > aG) aU = aNow() + .15, aPops(3, V * 1.5); // upshift: 150 ms throttle cut + exhaust bark
  aG = gr;
  // jittered firing: random per-frame pitch / level wobble, strongest at idle off throttle (lumpy idle)
  let T = aNow() < aU ? 0 : th, u = rs() * jt * (1.2 - T), hz = (h0 + hs * r) * (1 + u);
  o.type = WV[w];
  aSet(o[FQ], hz, .015); aSet(s[FQ], hz / 2, .015);
  aSet(f[FQ], c0 + cr * r + ct * T);
  aSet(sg.gain, sm * (1.3 - T), .1);
  aSet(dg.gain, .25 + dr * T * .25);
  aSet(g.gain, V * (.4 + .6 * T) * (1 + u * 4), .02);
  aSet(n[1], hz * nb);
  aSet(n[2], V * nm * (.4 + .6 * T), .06); aSet(am.gain, V * nm * .9, .06);
  aSet(ik[1], 1200 + 2e3 * r); aSet(ik[2], V * it * T * r);
  // lift-off at high rpm -> burst of pops; coasting -> crackle
  if (V && r > .4) aT - th > .5 ? aPops(3 + rnd() * 5 | 0, V * 1.3) : th < .1 && rnd() < .06 && aPops(1, V);
  aT = th;
},
// crash: sub thud, low-mid body, clipped crunch, 4 inharmonic metal resonances, debris (x 1)
S_CRASH = SX('"2&P^!!D !IIO[!!K8 !IIO^!#[MW !IIWl!#KK{ !IIUk!#VVy !IIRi!#_^x !IIOg6#ccy !IIRO@"b'),
// explosion: sub drop, distorted low boom, blast crack, 4 s rumble, 10 debris rattles (drive + reverb)
bang = (v = 1, p) => play([...SX('"5"]_!!H !II[^!!R/ !IITZ!!iD !IIgY?!@-ZI'), ...[...Array(10)].map(() => [0, , , .05, .4, .2 + rnd() * 1.6, 2, 600 + rnd() * 3e3, 500, 4])], v, p, .2, 1),
S_SPLASH = SX('!IIXY!!g? !IIOW!#RD[ "GWBO@ "K[?LG "ETCKL'),
// car horn: two detuned squares (~400 + 500 Hz), lowpassed
// glass (brittle): sharp high-passed crack + 14 short shards (2.5-10 kHz, 20-120 ms) over 200 ms
glass = (v = 1, p) => play([...SX('!IICX!"io !IIKO0"m'), ...[...Array(14)].map((f = 2500 + rnd() * 7500) => // (f: default for the undefined array value)
   [rnd() < .5 ? 1 : 4, f, f * .95, .02 + rnd() * .1, .09, rnd() * .2])], v, p, 0),
// ===== PLAYER CAR =====
// Arcade drift model: pointing angle 'a' (where the nose points) and travel angle 't' (where it moves).
// 't' chases 'a' at a rate set by traction; the handbrake cuts traction -> drift.
// (literals below: MAXS top speed .62, ACC .009, BRK .02, TURN .052)
// Same fields as traffic cars in ENT (k kind 0=car, m model, l/w half length/width) so the player can swap cars.
// vehicle entity: model m at x, z heading a, e: empty (parked). c: 0 car, 1 bike, 2 boat; l / w half length / width
// o: atlas cell (j: source index): police 14, bus 12; sedans, convertibles and bikes: the original paint or one
// of the 7 recolored variants built in the atlas canvas (cells 15 + source * 7 + color)
veh = (m, x, z, a, e, j = 'sdcvmo'.indexOf(m) / 2, c = m == 'bo' ? 2 : +(j > 1), b = m == 'bu', q = m == 'pc') => ({ m, x, z, a, t: a, s: 0, st: 0, y: 0, U: 0, ai: 0, rl: e && j > 1 ? .15 : 0, dr: 0, l: b ? 5 : [2.15, .95, 2.2][c], w: b ? 1.25 : [.95, .35, .9][c], e, c, h: 0, r: 0, q, b: 0, hp: q ? 160 : b ? 220 : 100, dm: q ? 9 : skin(c > 1), o: j < 0 ? q ? 14 : 12 : rnd() < .25 ? [10, 11, 13][j] : 15 + j * 7 + (rnd() * 7 | 0) }),
 // (state below without an initial value is set by restart())
// crash: SUCIO crunch (light bump: first 3 layers; hard: everything + glass) + a small camera kick
crash = i => {
  cam.sh = min(.35, i * 1.2);
  play(i > .3 ? S_CRASH : S_CRASH.slice(0, 3), min(1, .3 + i * 2), 0, .3, 1);
  i > .5 && glass(.6);
},
// inverse of loc: world point x, z in the local frame of o ([u, v])
lcl = (o, x, z, s = sin(o.a), c = cos(o.a), rx = x - o.x, rz = z - o.z) => [rx * c - rz * s, rx * s + rz * c],
// e: the vehicle (c: 0 car, 1 bike, 2 boat). Boats need open water; the player's car may roll into the sea (sinks).
carBlocked = (x, z, a, e = car, o = { x, z, a }, w = e.w - .05, l = e.l - .05) => {
  
  return [[-w, -l], [w, -l], [-w, l], [w, l], [0, e.l], [0, -e.l]].some(([u, v], _, __, [px, pz] = loc(o, v, u)) => e.c > 1 ? !wet(px, pz) : (e == car ? fs : solid)(px, pz));
},
updateCar = k => {
  let gas = held('U'), brake = held('D'), hand = held(2), sd, na, slip, nx, nz, impact;
  // bikes (c 1): faster, quicker accel, tighter turns, big lean. Boats (c 2): low traction (slides).
  let steerIn = ax(), bus = car.m == 'bu', bk = car.c == 1, mx = bus ? .42 : bk ? .713 : .62;
  car.st = toward(car.st, steerIn, .1 * k);
  // accel tapers with speed (0-100 km/h: car ~1.8 s, bike ~1.2 s); strong when gassing out of a reverse roll
  // air: off the ground (y), no gas and no grip
  if (gas && car.y < .1) car.s += .005 * k * (car.s < 0 ? 3 : bk ? 1.3 : 1) * (1.6 - max(car.s, 0) / mx);
  if (brake) car.s -= (car.s > .01 ? .02 : .0063) * k;
  sd = -12 > car.x; // sand (west of the seaside avenue): a bit more drag, much less traction (only these two factors change)
  car.s = clamp(car.s, -.2, mx) * ((hand ? .985 : gas ? .995 : .988) * (sd ? .994 : 1)) ** k;
  if (!gas && !brake && as() < .004) car.s = 0;
  // bicycle model: the front wheels steer (less at speed); each axle's lateral grip (saturating at ~7 deg of slip)
  // pushes the body sideways and turns it. Sand and water cut the grip, the handbrake lets the rear go (cars' rear
  // is a bit looser than the front: they rotate when pushed), so drifts and spins come from the tires.
  // f / l: forward / lateral speed in the car's frame, Y: yaw rate (car.yw), b: axle distance from the center
  let d = car.a, b = car.l * .6, f = cos(car.t - d) * car.s, l = sin(car.t - d) * car.s, Y = car.yw || 0,
    G = .012 * (sd ? .3 : 1) * (car.c > 1 ? .35 : 1) * (car.y < .1), dl = car.st * .7 * (bus || bk ? 1.3 : 1) / (1 + as() * 3),
    ti = (a, g) => -clamp(a * 8, -1, 1) * g * k, Ff, Fr;
  if (as() < .05) Y = f * M.tan(dl) / b / 2, l *= .5 ** k; // parking speed: the wheels just roll
  else Ff = ti(at2(l + Y * b, abs(f)) - dl * sgn(f), bk ? G * 1.08 : G), Fr = ti(at2(l - Y * b, abs(f)), G * (bk ? 1.08 : .85) * (hand ? .3 : 1)),
    Y = (Y + (Ff - Fr) * 1.7 / car.l) * .97 ** k, l += Ff + Fr;
  car.s = f < 0 ? -hyp(f, l) : hyp(f, l);
  car.t = d + M.atan(l / (f || 1e-6));
  na = d + Y * k;
  carBlocked(car.x, car.z, na) ? Y = 0 : car.a = na;
  car.yw = Y;
  slip = angDiff(car.t, car.a);
  car.dr = as() > .25 && abs(slip) > .22 ? car.dr + k : 0;
  let vz = cos(car.t) * car.s * k, before = as();
  nx = car.x + sin(car.t) * car.s * k;
  // SW: touching a wall this frame (scrape sound)
  if (carBlocked(nx, car.z, car.a)) car.s *= 1 - abs(sin(car.t)) * .85, SW = 1; else car.x = nx;
  nz = car.z + vz;
  if (carBlocked(car.x, nz, car.a)) car.s *= 1 - abs(cos(car.t)) * .85, SW = 1; else car.z = nz;
  // vertical (hills only, ht: curbs do not count): on the ground the car follows it (U: climb rate, G: last ground);
  // where the ground drops away faster than gravity it takes off (y above the ground); landing after ~.5 s pays
  d = ht(car.x, car.z); // (false on the coast: counts as 0)
  // (f: the last ground, or this one at the first frame)
  f = car.G ?? d;
  (b = f + car.y + car.U * k) > d ? (car.y = b - d, car.U -= .007 * k, car.ai += k) : (car.ai > 30 && addMoney(car.ai * 3, 'SALTO'), car.y = car.ai = 0, car.U = (d - f) / k);
  car.G = d; car.p = -M.atan(car.U / (as() + .05));
  impact = before - as();
  // wall crash money only once per 2 s of wall contact (no farming by grinding a wall)
  if (impact > .08) { crash(impact); dmg(car, impact * 150); T - car.V < 2e3 || addMoney(impact * 200, 'CHOQUE'); car.V = T; }
  car.ss = as() < .05 && !gas ? car.ss + k || k : 0; // frames stopped (exit hint)
  car.rl += (-car.st * as() * (bk ? .75 : .12) - slip * .1 * as() - car.rl) * min(1, .15 * k);
  if (bk && impact > .14 && !foot) bail(.15, car.t + PI); // into a wall: bounce back off it, not into it
  // a car or bike that reaches open water stops and sinks; the player ends up swimming next to it
  if (car.c < 2 && wet(car.x, car.z)) car.H = car.wr = 1, car.y = 0, exitCar(), play(S_SPLASH);
},
// ===== CAMERA =====
// c scales distance/height/look-ahead (1 = car, smaller = on foot)
updateCam = (k, x, y, z, yaw, speed, c = 1) => {
  cam.w += angDiff(cam.w, yaw) * min(1, .09 * k);
  let fx = sin(cam.w), fz = cos(cam.w), dist = 6.4 * c + speed * 1.6, sh;
  let e = cam.e, l = min(1, .14 * k);
  // ease toward the ideal eye (dist behind, raised)
  e[0] += (x - fx * dist - e[0]) * l; e[1] += (y + 2.9 * c + speed * .5 - e[1]) * l; e[2] += (z - fz * dist - e[2]) * l;
  // keep a fixed horizontal distance so the camera never lags too far behind
  let dx = e[0] - x, dz = e[2] - z, dl = hyp(dx, dz) || 1;
  e[0] = x + dx / dl * dist; e[2] = z + dz / dl * dist;
  sh = cam.sh *= .88 ** k;
  cam.t = [x + fx * 3 * c + rs() * sh, y + 1.3 + rs() * sh, z + fz * 3 * c];
  cam.f += (1 + speed * .3 - cam.f) * min(1, .1 * k);
},
// ground height: sidewalk inside blocks, asphalt on roads
// countryside hills: two sine fields, 0 in the city / beach / airport, rising over 60 m past their edges (false west
// of x 12: the coast stays flat). Chunk vertices are lifted by it, so roads, fences and trees follow; the crests are
// the jumps (motocross), with no ramp geometry
ht = (x, z) => 12 < x && max(0, sin(x * .06) * sin(z * .05) * 7 + sin(x * .017 + z * .022) * 5 + 2) * min(1, max(x - 390, z - 390, -112 - z, 0) / 60),
gh = (x, z) => pier(x, z) ? .5 : x % 42 >= 12 && z % 42 >= 12 && x < 390 && z < 390 ? .18 : ht(x, z),
// height of a person's feet: wading deeper into the sea down to -1.3 (only head and shoulders above water)
pg = (x, z) => wet(x, z) ? max(-1.3, (x + 48) * .6) : gh(x, z),
// Light phase (s) at intersection i,j for axis ax (0: roads along Z, 1: along X). <4.5 green, <6 yellow, else red.
// The X axis is shifted half a cycle; [6,7) and [13,14) are all-red gaps.
light = (i, j, ax) => (T / 1000 + i * 5 + j * 3 + ax * 7) % 14,
// node i, j of the 42 m road grid inside the city; rdn: a road passes node i, j along axis a (0: along Z, 1: along
// X): any city node, else the country roads (every 6th grid line; none through the airport or west of x = 6);
// sg: the road segment from node i, j heading d exists
inC = (i, j) => min(i, j) >= 0 && max(i, j) <= 9,
rdn = (i, j, a) => inC(i, j) || (j > -1 || -2 > j || i > 9) && !((a ? j : i) % 6) && i > -a,
sg = (i, j, d) => rdn(i, j, d & 1) && rdn(i + DX[d], j + DZ[d], d & 1),
// Traffic car on the lane before intersection i,j heading d (right-hand: lane = road center + 3 * right).
// pk: an empty parked car at the right curb (5.1 m from the center) mid-block, clear of the crosswalks
// random road-grid node within n / 2 of coordinate v
nr = (v, n) => (v / 42 | 0) + (rnd() * n | 0) - (n >> 1),
spawnCar = (minD, pk, m = 'sdsdsdcvsdcvbumo'.substr(rnd() * 8 << 1, 2), d = rnd() * 4 | 0, i = nr(F.x, 5), j = nr(F.z, 5)) => {
  
  if (!sg(i - DX[d], j - DZ[d], d)) return;
  let o = rnd() * 18 + 12, l = pk ? 5.1 : 3, x = i * 42 + 6 - DX[d] * o - DZ[d] * l, z = j * 42 + 6 - DZ[d] * o + DX[d] * l, xz = { x, z }, dd = dst(xz);
  if (dd < minD || dd > 120 || ENT.some(e => !e.k && dst(e, xz) < 12)) return;
  if (x < 20 && m == 'sd' && rnd() < .7) m = 'cv'; // convertibles are common next to the seaside avenue
  // police and parked cars pop in only out of view: far (in the fog) or behind the camera
  if ((m == 'pc' || pk) && dd < 95 && vis(x, z)) return;
  ENT.push({ ...veh(m, x, z, d * H2, pk), s: .2 * !pk, d, i, j, g: 0 });
},
// ground distance from a to b (default: the entity the world centers on)
dst = (a, b = F) => hyp(a.x - b.x, a.z - b.z),
// x, z (1 m up) inside the left / right planes of the last frame's view frustum (VM), with ~5 m to spare
vis = (x, z, [a, , , w] = mv4(VM, [x, 1, z], 1)) => abs(a) < w + 7,
// Pedestrian walking a loop around block (bi,bj) on the sidewalk, 1.2 m from the curb.
corner = (e, c = e.c) => loc({ x: e.A, z: e.F, a: c * H2 + .785 }, 19.2),
// new pedestrian (b: beach skins) walking around the block centered at cx, cz (corner c, direction r: true (= 1) or 3)
// (sp: speed, ~1 in 12 runs)
mkPed = (b, cx, cz) => ({ k: 1, sn: skin(b), A: cx, F: cz, c: rnd() * 4 | 0, r: rnd() < .5 || 3, a: 0, ph: 0, sp: rnd() < .08 ? .11 : .03 }),
populate = (dc, dp, n = 0, e, r, u, bi, bj, i, G, bs, f, x0, z0, x1, z1) => {
  for (e of ENT) n += !e.k;
  if (n < 54) spawnCar(dc, rnd() < .15); // 15% of the attempts: parked
  if (ENT.length - n < (F.x < 60 ? 50 : 44)) if (F.x < 60 && rnd() < .7) {
    // beach people near the player: sunbathers on the towels, bathers standing in the shallows, walkers on the sand
    r = rnd(); u = UMB[rnd() * 24 | 0]; e = mkPed(1, -32, F.z + rs() * 120);
    if (r < .55) e.I = 1, r < .4 ? ([e.x, e.z] = u, e.p = -H2) : (e.x = -49 - rnd() * 2.5, e.z = e.F);
    else [e.x, e.z] = corner(e);
    if (dst(e) > dp && abs(e.z - F.z) < 75) ENT.push(e);
  } else if (bi = nr(F.x, 3), bj = nr(F.z, 3), min(bi, bj) >= 0 && max(bi, bj) < 9) {
    // a pedestrian walking around block (bi, bj)
    e = mkPed(0, bi * 42 + 27, bj * 42 + 27); r = rnd(); G = [e]; bs = BN.filter(b => abs(b[0] - e.A) + abs(b[2] - e.F) < 25);
    [x0, z0] = corner(e); [x1, z1] = corner(e, e.c + e.r); f = rnd();
    e.x = x0 + (x1 - x0) * f; e.z = z0 + (z1 - z0) * f;
    // someone sitting on a free bench of this block's park (seated pose, idle until scared), or 2-3 people chatting
    // in a circle (idle, facing its center)
    if (r < .2 && bs[0]) [e.x, , e.z, e.a] = bs[rnd() * bs.length | 0], e.S = .02, e.I = 1;
    else if (r < .27) for (i = r < .24 ? 3 : 2; i--;) {
      u = G[i] = { ...e, sn: skin(0), I: 1, a: i * 2.1 + r * 40 };
      [u.x, u.z] = loc(u, -.6);
    }
    if (dst(e) > dp && !ENT.some(o => o.x == e.x)) ENT.push(...G);
  }
},
updTraffic = (e, k, f, n = 0) => {
  if (e.h > 0) { // knocked: slide and spin, then resume driving toward the lane target
    e.h -= k;
    solid(f = e.x + e.J * k, n = e.z + e.K * k) || (e.x = f, e.z = n);
    f = .93 ** k;
    e.J *= f; e.K *= f; e.t = e.a += e.r * k; e.r *= f; e.s = 0;
    return;
  }
  // boats; dead driver: no steering, rolls to a stop or into whatever is ahead
  if (e.c > 1 || !e.e && e.dd) return updBoat(e, k);
  if (e.e) return; // empty parked car / wreck
  if (e.q) return updCop(e, k);
  let d = e.d, o, da;
  // lane target 3 m right of the road center (left lane while overtaking a stopped car, ov frames)
  let c = e.g ? 6 : -7, ln = (e.ov -= k) > 0 ? -3 : 3, ox = e.i * 42 + 6 + DX[d] * c - DZ[d] * ln - e.x, oz = e.j * 42 + 6 + DZ[d] * c + DX[d] * ln - e.z, dist = hyp(ox, oz), want = .24;
  if (dist < 2) {
    if (e.g) { e.i += DX[d]; e.j += DZ[d]; e.g = 0; }
    else { // at the stop line: straight 50%, right/left 25%, only along roads; U-turn at a dead end (country)
      do d = (e.d + (n++ > 30 ? 2 : +'0013'[rnd() * 4 | 0])) % 4; while (!sg(e.i, e.j, d));
      e.d = d; e.g = 1;
    }
  }
  // want: target speed
  if (!e.g && inC(e.i, e.j) && light(e.i, e.j, d & 1) > 4.5) want = min(want, (dist - 4) * .04);
  // keep distance from cars ahead going the same way (and always from the player / knocked cars). A stopped
  // obstacle (empty car, wreck, dead driver) is passed on the other lane: creep while swerving around it.
  // People on the road (crossing, fleeing, the player) are waited for.
  for (o of ENT) if (o != e) {
    let [u, ah] = lcl(e, o.x, o.z), gap = ah - e.l - (o.l || .3), sv = (o.e || o.dd) && o != car;
    if (ah > 0 && ah < 18 && abs(u) < 2 && (o.k || o == car || o.h > 0 || o.e || cos(o.a - e.a) > .5)) {
      if (sv && e.g < 1) e.ov = 150;
      da = (gap - 3) * .03; want = min(want, sv && gap > 1 ? max(.06, da) : da);
    }
  }
  e.s = max(0, toward(e.s, want, (want < e.s ? .02 : .004) * k));
  da = angDiff(e.a, at2(ox, oz)) * min(1, .15 * k);
  e.t = e.a += da; e.st = clamp(da * 9, -1, 1);
  if (e.c) e.rl = clamp(-da * 4, -.4, .4); // bikes lean into turns
  [e.x, e.z] = loc(e, e.s * k);
},
updPed = (e, k, R) => {
  // knocked down (h): 1 ragdoll (follows the pelvis, lies still once ~.5 s slow or after ~7 s), 2 lying, then
  // despawn or (e.u: player, carjacked driver) 3: get up, the joints blend from the ragdoll to a standing pose
  // facing where the head was over .6 s, then run (f) / play on
  if (e.h) {
  R = e.R;
  if (e.h < 2) {
    // f: slow frames count fully, moving ones 1/12 (still after ~.5 s slow, or ~6 s in any case)
    if ((e.f += updRag(R, k) < .005 ? k : k / 12) > 30) lay(e);
    [e.x, , e.z] = R[0];
  } else if (e.h < 3) { if ((e.f -= k) < 0) e.u ? (e.h = 3, e.f = e.p = e.v = e.ph = 0, e.y = pg(e.x, e.z), e.G = R.map(p => [...p]), e.a = at2(R[1][0] - e.x, R[1][2] - e.z)) : e.x = -1e4; }
  else {
    let t = ss(0, 36, e.f += k);
    quiet(() => pose(e));
    R.map((p, i) => p.map((v, j) => p[j] = e.G[i][j] + (JT[i][j % 3] - e.G[i][j]) * t));
    if (t == 1) e.h = 0, e.f = 150;
  }
  return;
  }
  // (seated: hips on the bench seat)
  e.y = e.S ? -.11 : pg(e.x, e.z) + (e.p ? .12 : 0);
  let sp = e.sp, ta, x, z;
  // flee sideways from a fast player car coming at us
  let rx = e.x - car.x, rz = e.z - car.z, vx = sin(car.t), vz = cos(car.t), ah = rx * vx + rz * vz;
  if (car.s > .15 && ah > 0 && ah < 16 && abs(rx * vz - rz * vx) < 5) { e.f = 40; e.Y = at2(rx - ah * vx, rz - ah * vz); }
  if (e.f > 0) e.f -= k, sp = .1, ta = e.Y, R = 1;
  // idle: sunbather (lying, p), bather standing in the water, group, bench (S); walks on after ~1 min on average
  else if (e.I) sp = 0, ta = e.a, R = rnd() < 3e-4 * k / e.I;
  else {
    [x, z] = corner(e);
    ta = at2(x - e.x, z - e.z);
    // at a corner: turn it, or (every other corner, city blocks only) cross the street straight ahead to the next
    // block (u, v): wait facing the road until its cars get red (light phase 6-8 for that axis), then head for the
    // corner we came from, mirrored on the next block (c - r)
    if (hyp(x - e.x, z - e.z) < .6) {
      let u = rou(sin(e.a)) * 42, v = rou(cos(e.a)) * 42; // walking direction (along the block's edge)
      if (!(e.c & 1 && inC((e.A + u - 20) / 42, (e.F + v - 20) / 42))
        || (sp = 0, abs(light(rou(x / 42), rou(z / 42), !u) - 7) < 1 && (e.A += u, e.F += v, e.c -= 2 * e.r, 1)))
        e.c += e.r;
    }
  }
  if (R) e.p = e.I = e.S = 0;
  e.a += angDiff(e.a, ta) * min(1, .3 * k);
  [x, z] = loc(e, sp * k);
  if (!solid(x, z)) e.x = x, e.z = z;
  else if (!e.f) e.c += e.r; // blocked (beach palms, umbrellas): head for the next corner
  e.ph += (sp * 1.2 + .035) * k; e.v = sp;
},
// ===== BOATS, BIKES =====
// AI boats circle (r = 50 m) unless empty; any boat stops at the shore / pier
updBoat = (e, k) => {
  if (e.e || e.dd) e.s *= .97 ** k; else e.s = .3, e.a += .006 * k;
  e.t = e.a;
  let [nx, nz] = loc(e, e.s * k);
  carBlocked(nx, nz, e.a, e) ? e.s = 0 : (e.x = nx, e.z = nz);
},
// hard bike crash: the rider's ragdoll starts from the seated pose with the bike's momentum (head first), the
// bike falls on its side
bail = (s, t = car.t) => {
  exitCar();
  car.rl = 1.45; cam.sh = .6;
  launch(ply, { s: clamp(s, .15, .35), t }, .4, car.D); // D: the rider's seat matrix from the last draw
},
// ballistic step: velocity v*, gravity g
fly = (o, k, g) => { o.U -= g * k; o.x += o.J * k; o.y += o.U * k; o.z += o.K * k; },
updateWorld = (k, CE = { x: cam.e[0], z: cam.e[2] }, n, e, o, z, x, i, j, d, imp, RA, B, v, R, X) => {
  // camera ground position (people / drivers culled beyond 70 m)
  populate(60, 40);
  // room crowds: real pedestrians (idle for good: I huge) in two arcs facing the stage / counter (club 12, bar 5 +
  // the bartender behind the counter, j = -1), spawned within 60 m when none of the room's (e.rm) are left
  for (o of RM) if ([z, i, v, R] = o, n = R ? 11 : 4, hyp(z - F.x, i - F.z) < 60 && !ENT.some(e => e.rm == o)) for (j = n; j >= -!R; j--) {
    e = mkPed(0, z, i); x = j < 0 ? -1 : R ? 3.3 + (j & 1) * 1.5 : 1.3 + (j & 1); d = (j / n - .5) * 2.6;
    e.x = z + v * x * cos(d); e.z = i + x * sin(d); e.a = at2(z - e.x, i - e.z); e.I = 1e9; e.rm = o;
    ENT.push(e);
  }
  for (n = ENT.length; n--;) {
    e = ENT[n];
    // far away, or an abandoned car / wreck / dead driver left ~20 s that is out of view (no endless jams)
    if (e != car && e != ply) d = dst(e),
      !e.pm && (d > (e.k ? 80 : 130) || !e.k && (e.e || e.dd) && (e.wt = e.wt + k || k) > 1200 && (d > 40 || !vis(e.x, e.z))) ? ENT.splice(n, 1) : (e.k ? updPed : updTraffic)(e, k);
  }
  // collisions: player vs traffic, any moving car vs pedestrians (in the car's local frame)
  for (e of ENT) if (e != car && e != ply && !(e.k && e.h)) for (o of e.k ? ENT : [e]) if (!o.k && !(e.k && abs(o.s) < .05)) {
    let p = e.k ? e : car, rx = p.x - o.x, rz = p.z - o.z, s = sin(o.a), c = cos(o.a);
    let lat = abs(rx * c - rz * s), lon = abs(rx * s + rz * c);
    if (e.k) {
      if (lat < o.w + .3 && lon < o.l + .3) { // knock the pedestrian into the air
        launch(e, o);
        if (o == car) cam.sh = .3, heat(.4), addMoney(25, 'PEATON');
      }
    } else if (lat < o.w + (car.c ? car.w + .25 : 1.2) && lon < o.l + (car.c ? car.l + .05 : 2.2)) {
      let dl = hyp(rx, rz) || 1, nx = rx / dl * .3, nz = rz / dl * .3, vx = sin(car.t) * car.s, vz = cos(car.t) * car.s;
      imp = abs((vx - s * o.s) * nx + (vz - c * o.s) * nz) / .3;
      if (!carBlocked(car.x + nx, car.z + nz, car.a)) { car.x += nx; car.z += nz; }
      if (!solid(o.x - nx, o.z - nz)) { o.x -= nx; o.z -= nz; }
      if (imp > .04 && o.h <= 30) {
        if (!foot && as() > .15) heat(o.q ? 1 : imp > .1 ? .2 : 0); // player ramming police / hard ram
        crash(imp); addMoney(imp * 400, 'CHOQUE'); o.h = 70; o.r = rs() * imp * .5; car.s *= .5; dmg(car, imp * 120); dmg(o, imp * 120);
        if (car.c == 1 && imp > .1 && !foot) bail(imp * 2); }
      // the pushed car takes the player's velocity (bulldozing), and stays stunned while in contact
      o.h = max(o.h, 20); o.J = vx * .9; o.K = vz * .9; o.s = 0;
    }
    // near miss: passing within ~.3-1.7 m of a car's side at 85+ km/h (once per car)
    else if (!foot && !inP && !o.nm && as() > .4 && abs(lat - o.w - car.w - 1) < .7 && lon < o.l + car.l) o.nm = 1, addMoney(40, 'CASI');
  }
  // draw entities in view (vis); people (~9 draws each) are skipped beyond 70 m from the camera (deep in the fog, a
  // few pixels tall)
  // club: the dancer circles the pole (hip sway)
  if (dst({ x: 24, z: 153 }, CE) < 40) {
    d = T / 1200;
    person(modelMat(24 + .6 * sin(d), .68, 153 + .6 * cos(d), d + H2, 0, sin(T / 230) * .15), 6, T / 160, .012, 0, sin(T / 900) > 0 ? 2 : 0);
  }
  for (e of ENT) if (e.k) {
    // ragdoll (h): the person meshes between its joints (X: torso frame), RA ends as the -X forearm (uzi)
    if (!(dst(e, CE) > 70) && vis(e.x, e.z)) {
    if (e.h) {
      R = e.R; X = frm(R); o = e.sn;
      dl([74 >> o & 1 ? 'qf' : 'q', X, , o]);
      for (j of [0, 5]) dl(['qu', seg(R[j + 2], R[j + 3], X), , o], ['qa', RA = seg(R[j + 3], R[j + 4], X), , o],
        [j ? 'qR' : 'qL', seg(R[0].map((v, i) => v + X[i] * (j ? -.1 : .1)), R[j + 5], X), , o], [j ? 'qT' : 'qS', seg(R[j + 5], R[j + 6], X), , o]);
    } else RA = pose(e);
    if (e == ply && !e.sw) dl(['uz', RA]);
    }
  } else {
    let c = e.c, bu = e.l > 3;
    // boats bob on the waves (height, pitch; the bow lifts with speed) and leave a fading wake
    if (c > 1) {
      e.y = -.35 + sin(T / 400 + e.x) * .07; e.p = sin(T / 530 + e.z) * .04 - abs(e.s) * .12;
      if (abs(e.s) > .08 && rnd() < .6 * k) [x, z] = loc(e, -2.4, rs() * 1.5), fx(x, -.08, z, 'wk', 1, 50);
    }
    B = modelMat(e.x, gh(e.x, e.z) + e.y, e.z, e.a, e.p, e.rl);
    v = ([[.8, 1.35, -1.35, .34], [0, .65, -.65, .3], , [1.05, 3.3, -3.1, .5]])[i = bu ? 3 : c];
    if (vis(e.x, e.z)) {
    dl([e.m, B, e.sg, e.o]);
    // wheels: spin with the distance rolled (wa), the front ones steer with st
    if (v) {
      e.Z = (e.Z || 0) - e.s * k / v[3];
      for (z of [v[1], v[2]]) for (x of v[0] ? [v[0], -v[0]] : [0]) dl(['w' + 'cm b'[i] + (e.wr ? 'w' : ''), mul(B, modelMat(x, v[3], z, z > 0 ? e.st * .45 : 0, e.Z)), , e.o]);
    }
    if (e.q) dl(['b' + (W && T / 150 & 1), B]);
    // open driver door during a carjack (yaw negative swings the rear edge outward)
    if (e == J?.o && !c) dl([e.m + 'd', mul(B, modelMat(e.w, 0, e.l - 1.5, -J.g * 1.2)), e.sg, e.o]);
    // seated driver (torso + head) behind the wheel; slumped forward when shot
    if (!e.wr && dst(e, CE) < 70 && (!e.e || J && e == J.o && J.d && !J.p || e == car && !foot && !inP))
    {
      // bike rider leans forward with legs to the pegs; boat driver sits behind the windshield
      person(e.D = mul(B, c > 1 ? modelMat(0, .2, -.7, 0) : c ? modelMat(0, .05, -.68, 0, -.3) : modelMat(e.w * .44, bu ? .7 : -.15, bu ? 3.9 : -.23, 0, e.dd ? -.5 : 0)), e == car ? ply.sn : e.dm, 0, c == 1 ? .5 : 0, 2);
    }
    }
    // damage: smoke under 45 hp (also from wrecks), fire under 20 hp, explodes after ~4 s burning
    [x, z] = loc(e, e.l * .6); // hood
    if (e.hp < 45 && rnd() < (e.wr ? .04 : .12) * k) fx(x, 1.2, z, 'f0', .9, 60, .03, .03);
    if (e.hp < 20 && !e.wr) {
      fx(x, 1, z, 'f' + (1 + (rnd() < .5)), .5, 12, .06, .04);
      if ((e.W = e.W + k || k) > 240) explode(e);
    }
  }
  // traffic lights near the player: one pole per approach, at the corner right of the stop line
  let ci = F.x / 42 | 0, cj = F.z / 42 | 0;
  for (i = ci - 2; i <= ci + 2; i++) for (j = cj - 2; j <= cj + 2; j++) {
    x = i * 42 + 6; z = j * 42 + 6;
    if (inC(i, j) && dst({ x, z }) < 90) for (d = 4; d--;) {
      let q = light(i, j, d & 1), px = x - (DX[d] + DZ[d]) * 6.5, pz = z + (DX[d] - DZ[d]) * 6.5;
      vis(px, pz) && dl(['l' + (q < 4.5 ? 0 : q < 6 ? 1 : 2), modelMat(px, .18, pz, d * H2 + PI)]);
    }
  }
},
// ===== ON FOOT, ENTER / EXIT, CARJACK =====
// ply: on-foot player, a pedestrian entity (in ENT only while on foot). near: car within reach.
// J: carjack animation {o: car, t: frames, x/z: start, d: had a driver, g: door open 0..1, p: driver pulled}
NP, SW = 0,
exitCar = () => {
  car.e = 1; car.s = car.st = 0;
  let [x, z] = loc(car, car.l - 2.5, car.w + .6);
  if (solid(x, z)) [x, z] = loc(car, car.l - 2.5, -car.w - .6); // blocked: use the other side
  if (car.c > 1 && abs(car.z - 160) < 5 && car.x > -82) x = clamp(car.x, -78, -44), z = 160; // boat at the pier: step onto it
  toFoot(x, z, car.a); // facing like the car, so the camera stays behind
},
// the player stands at x, z facing a (back on foot after a car, a plane or a crash)
offFoot = () => ENT.splice(ENT.indexOf(ply), 1),
toFoot = (x, z, a, y = 0) => { ply.x = x; ply.z = z; ply.y = y; ply.a = a; ply.h = ply.p = ply.pc = 0; ENT.push(ply); foot = 1; inP = 0; },
updFoot = (k, p = ply, o, sw = wet(p.x, p.z) && -50 > p.x, sp, best) => {
  
  near = 0;
  if (p.h) return updPed(p, k); // knocked down: ragdoll, lie, get up
  // skydive (pc 1: free fall face down, 2: under the canopy): opens on B1 or by itself low, turn with L/R, drifts
  // forward; over a roof slide to the street; landing pays (it always opens in time: by itself at 35 m)
  if (p.pc) {
    if (p.pc < 2 && (hit(1) || p.y < 35)) p.pc = 2;
    p.vy = p.pc > 1 ? toward(p.vy, -.08, .02 * k) : max(p.vy - .006 * k, -.9);
    p.p = p.pc < 2 && 1.3; p.a += ax() * .03 * k;
    [p.x, p.z] = loc(p, (p.pc > 1 ? .1 : .2) * k);
    if (hg(p.x, p.z) > p.y) p.x = rou((p.x - 6) / 42) * 42 + 6;
    if ((p.y += p.vy * k) < (sp = pg(p.x, p.z))) p.y = sp, p.pc = p.p = 0, addMoney(300, 'PARACAIDAS');
    return;
  }
  // tank controls: U/D walk, L/R turn, B2 run. Deep water (sw): slow swim, arm strokes, no shooting.

  sw && !p.sw && play(S_SPLASH); // jumping into deep water
  p.sw = sw;
  sp = (held('U') - held('D') * .6) * (sw ? .045 : held(2) ? .11 : .05);
  p.a += ax() * .07 * k;
  let [nx, nz] = loc(p, sp * k);
  if (!fs(nx, p.z)) p.x = nx;
  if (!fs(p.x, nz)) p.z = nz;
  p.v = abs(sp); p.ph = sp || sw ? p.ph + (p.v * 1.2 + .035) * k : 0; // ~0.9 strides/s walking, ~1.6 running
  p.y = pg(p.x, p.z);
  // uzi: hold B3 for auto-fire (~10 shots/s); the arm stays raised a bit after releasing
  AM -= k;
  if (held(3) && !sw) { AM = 30; if ((SC -= k) <= 0) SC = 6, shoot(); }
  NP = PL.find(q => q.g && dst(p, q) < 6);
  if (NP && hit(1)) { // board a plane: walk to the door, hop in
    PJ = { t: 0, x: p.x, z: p.z }; P = NP;
    if (!P.n) P.n = 1, heat(1), addMoney(1000, 'AVION');
    return;
  }
  // cars, in each car's local frame: fast ones knock us down, others push us out of their box
  best = 1.6;
  for (o of ENT) if (!o.k) {
    let [u, v] = lcl(o, p.x, p.z), du = abs(u) - o.w - .3, dv = abs(v) - o.l - .3, gap = hyp(max(du, 0), max(dv, 0));
    if (du < 0 && dv < 0) {
      if (abs(o.s) > .12) { launch(p, o); cam.sh = .5; return; }
      [p.x, p.z] = du > dv ? loc(o, v, u - du * sgn(u)) : loc(o, v - dv * sgn(v), u);
    }
    if (gap < best && !o.wr) { best = gap; near = o; }
  }
  if (near && hit(1)) { // start the carjack: the car stops at once and loses its AI
    J = { o: near, t: 0, x: p.x, z: p.z, d: !near.e, g: 0 };
    heat(near.q ? 3 : J.d); // carjack: +1 star with a driver, +3 for a police car
    addMoney(near.c > 1 ? 400 : near.q ? 500 : near.l > 3 ? 300 : J.d ? 150 : 50, 'AUTO MOTO LANCHA BUS'.split(' ')[near.l > 3 ? 3 : near.c]);
    near.s = near.h = 0; near.e = 1;
  }
},
// smoothstep of the jack clock between frames a and b
ss = (a, b, t = J.t, u = clamp((t - a) / (b - a), 0, 1)) => u * u * (3 - 2 * u),
// Timeline (frames at 60 fps). Car: walk to the door 0-24, door opens 24-36, [driver pulled out 36-66],
// get in 36-54 (+30), door closes 54-66 (+30), then drive. Bike (no door): walk to its left side 0-24,
// [shove the rider off sideways 24-40], swing the leg over and sit 24-72 (+16). J.X: dismount, the bike
// timeline played backwards from the seat to the side, then on foot next to the bike (on its stand).
updJack = (k, o = J.o, p = ply, bk = o.c == 1, d = J.d ? bk ? 16 : 30 : 0, hz = o.l - 1.5, m = bk ? 24 : 36, n = bk ? 72 : 66) => {
  
  J.t += J.X ? -k : k;
  let [dx, dz] = loc(o, bk ? -.3 : hz - 1, bk ? .75 : o.w + .55), [sx, sz] = loc(o, bk ? -.68 : hz - .9, bk ? 0 : .4), f = ss(0, 24), f2 = ss(m + d, m + d + (bk ? 48 : 18));
  p.x = J.x + (dx - J.x) * f + (sx - dx) * f2;
  p.z = J.z + (dz - J.z) * f + (sz - dz) * f2;
  p.y = gh(p.x, p.z) + f2 * (bk ? .05 : -.35); // onto the saddle / sink into the seat
  p.a = f < 1 ? at2(dx - J.x, dz - J.z) : o.a - !bk * H2;
  p.p = bk && f2 > .5 ? (1 - 2 * f2) * .3 : 0; // lean to the bars
  p.lg = bk && sin(f2 * PI) * 1.3; // inner leg swung over the saddle
  p.ph = f % 1 || f2 % 1 ? p.ph + .1 * k : 0; p.v = bk && f2 > .5 ? .5 : p.ph && .06; J.s = f2;
  J.g = bk ? d && J.t > 24 && J.t < 40 : ss(24, 36) - ss(54 + d, 66 + d);
  if (d && J.t > m + 8 * bk && !J.p) {
    // driver pulled out of the seat (outward and back) / rider shoved off the bike's far side; lands, lies,
    // gets up and flees (updPed with u=1)
    let t = o.a + (bk ? -H2 : 2.2);
    J.p = { ...mkPed(0, (sx / 42 | 0) * 42 + 27, (sz / 42 | 0) * 42 + 27), sn: o.dm, x: sx, z: sz, y: bk ? .8 : .4, a: o.a + H2, u: !o.dd, Y: t };
    ENT.push(J.p); o.dd = 0;
    launch(J.p, { s: .08, t }, 0);
  }
  if (J.X ? J.t < 24 : J.t > n + d) J.X ? o.rl = .15 : (offFoot(), car = o, foot = 0), J = 0;
},
// ===== UZI, DAMAGE, EXPLOSIONS =====
// AM: frames the right arm stays raised, SC: fire cooldown (frames), TR: tracer {x,y,z,a,p,l,t}, FX: particles (max 60)
AM, SC = 0, TR = {}, FX,
// uniform (or per-axis) scale applied in model space
sc = (m, a, b = a, c = a) => mul(m, [a, 0, 0, 0, 0, b, 0, 0, 0, 0, c, 0, 0, 0, 0, 1]),
// particle: position, model, size, life (frames), random speed v, upward speed vy
fx = (x, y, z, m, s, l, v = 0, vy = 0) => FX.length < 60 && FX.push({ x, y, z, m, s, l, t: l, J: rs() * v, U: vy + rnd() * v * .5, K: rs() * v }),
// hitscan with arcade auto-aim: nearest ped / car within 45 m in a ~25 deg cone with line of sight
shoot = (p = ply, o, i, L = 45, tg, np = 0, a = p.a, dx, dz, d, ti = 'TIRO') => {
  
  
  for (o of ENT) if (o != p && !o.wr && !(o.k && o.h)) {
    dx = o.x - p.x; dz = o.z - p.z; d = hyp(dx, dz);
    if (o.k && d < 25) np = 1;
    if (d < L && abs(angDiff(p.a, i = at2(dx, dz))) < .44 && los(o, d)) L = d, tg = o, a = i;
  }
  if (tg) p.a += angDiff(p.a, a) * .3;
  a += rs() * .04; // spread
  if (!tg) for (L = 1; L < 45 && !solid(...loc({ ...p, a }, L)); L++);
  let [mx, mz] = loc(p, 1.1, -.3), my = p.y + 1.35, [hx, hz] = loc({ ...p, a }, L), hy = tg ? tg.k ? tg.y + 1.1 : 1 : my;
  dx = hx - mx; dz = hz - mz; let hl = hyp(dx, dz);
  TR = { x: mx, y: my, z: mz, a: at2(dx, dz), p: at2(hy - my, hl), l: hyp(hl, hy - my), t: 3 };
  fx(mx, my, mz, 'f3', .5, 2);
  for (i = 3; i--;) fx(hx, hy, hz, 'f2', .15, 10, .15, .02);
  play((SX('!II;`!#d[X #R?6T ";,D^!!M !IIGZ!!H; !II:[8#_^m !II8Z>#[Zo !IIPO0!`?')), .8, 0, .3, 1); rnd() < .33 && play((SX('"ff?IL "ll:CL "gf=EP "ii:BS')), .7); // shot (+ casings now and then)
  heat(np * .02);
  if (!tg) return;
  if (tg.k) return launch(tg, { s: .04, t: a }, 1.2), heat(.3), addMoney(25, ti);
  if (tg.q) heat(.15);
  // the shot enters the cabin: window shatters, the driver slumps, the car loses its AI
  if (!tg.e && !tg.dd && rnd() < .3) tg.dd = tg.sg = 1, tg.v = 0, heat(.3), addMoney(25, ti), glass(...spatial(tg.x, tg.z));
  addMoney(5, ti);
  dmg(tg, 8);
},
// n debris chunks (fireball / gray) flying from x, y, z: spread v, life t..2.3t frames, size s (0: full)
debris = (n, x, y, z, v, t, s) => { for (; n--;) BOOM.push({ x, y, z, J: rs() * v, U: rnd() * v * .8 + .1, K: rs() * v, t: t + rnd() * t * 1.3, m: n & 1 ? 'xo' : 'xg', a: rnd() * 6, s: s && s + rnd() * .3 }); },
// car damage (hp: 100 car, 160 police, 220 bus)
dmg = (e, v) => { if (!e.wr && (e.hp -= v) <= 0) explode(e); },
// explosion: flash + fireballs + debris, shake by distance, peds launched, nearby cars shoved and damaged
// (chain reactions), the player is knocked down within 4 m / ejected from his car. Leaves a burnt wreck.
explode = (e, q = e.q, i, o) => {
  
  e.wr = e.e = 1; e.q = e.dd = e.s = e.hp = 0; e.m += 'w';
  if (e == car && !foot && !inP) exitCar();
  debris(12, e.x, 1, e.z, .5, 50, .2);
  for (i = 14; i--;) fx(e.x + rs() * 3, .5 + rnd() * 2, e.z + rs() * 3, 'f' + (i % 2 + 1), 2 + rnd() * 2, 10 + rnd() * 25, .1, .04);
  bang(...spatial(e.x, e.z));
  cam.sh = max(.35, 1.2 - dst(e) / 40);
  addMoney(q ? 600 : 200, 'BOOM'); heat(+q);
  for (o of ENT) {
    let dx = o.x - e.x, dz = o.z - e.z, d = hyp(dx, dz) || 1;
    if (o.k) { if (d < (o == ply ? 4 : 8) && !(J && o == ply)) launch(o, { s: .25, t: at2(dx, dz) }, 0); }
    else if (o != e && d < 9) o.h = 40, o.J = dx / d * .25, o.K = dz / d * .25, o.r = rs() * .2, dmg(o, 80 - d * 8);
  }
},
// ===== POLICE / WANTED =====
// H heat (stars W = H|0, 0..5), L frames since a cop last saw the player,
// BT frames stopped next to a cop, SEEN: some cop sees the player this frame.
H, L, BT = 0, SEEN,
// line of sight: march the collision grid from cop e to the player in 2 m steps (d = distance)
los = (e, d, s) => { for (s = 2; s < d; s += 2) if (solid(e.x + (F.x - e.x) * s / d, e.z + (F.z - e.z) * s / d)) return 0; return 1; },
// (ld: aim a bit ahead of a moving player car)
updCop = (e, k, dx = F.x - e.x, dz = F.z - e.z, d = hyp(dx, dz), rx = e.x % 42 < 12, rz = e.z % 42 < 12, ld = foot ? 0 : car.s * 25, [tx, tz] = loc({ ...F, a: car.t }, ld)) => {
  // (knocked, parked or driver shot: handled by updTraffic, which calls this)
  e.v = d < 80 && F.y <= 40 && los(e, d);
  if (!(d < 30 || e.v) && (rx || rz)) {
    // far: Manhattan routing. On a road go to the next intersection toward the player;
    // at an intersection (rx && rz) step one block along the axis with the bigger gap.
    let ci = e.x / 42 | 0, cj = e.z / 42 | 0, ax = rz && (!rx || abs(dx) > abs(dz));
    tx = (ci + ax * (rx ? sgn(dx) : dx > 0)) * 42 + 6;
    tz = (cj + !ax * (rz ? sgn(dz) : dz > 0)) * 42 + 6;
  }
  // the sea is off limits: with the player out in the water, drive up to the shoreline (x -44) or the
  // routing target and wait there
  tx = max(tx, -44);
  let aim = angDiff(e.a, at2(dx = tx - e.x, dz = tz - e.z));
  // faster than traffic (.24), ignores lights; slows down for sharp turns; stops when the heat is gone
  let want = W && !(-44 > F.x && hyp(dx, dz) < 12) ? (.5 + W * .02) * (1 - min(abs(aim), 1.2) * .6) : 0;
  if (e.n > 0) { e.n -= k; want = -.15; } // reversing out of a jam
  e.s = toward(e.s, want, .012 * k);
  let na = e.a + clamp(aim, -.05, .05) * k * min(1, abs(e.s) * 6), ox = e.x, oz = e.z;
  if (!carBlocked(e.x, e.z, na, e)) e.a = na;
  e.t = e.a; e.st = clamp(aim * 2, -1, 1);
  // same grid checks as the player car: per axis, brake on solid (slides along walls)
  let [nx, nz] = loc(e, e.s * k);
  if (carBlocked(nx, e.z, e.a, e)) e.s *= .8; else e.x = nx;
  if (carBlocked(e.x, nz, e.a, e)) e.s *= .8; else e.z = nz;
  // stuck ~2 s without progress -> reverse ~1 s and retry
  if (want > 0 && hyp(e.x - ox, e.z - oz) < .03 * k) { if ((e.b += k) > 120) e.n = 60, e.b = 0; } else e.b = 0;
  if (!W && d > 60) e.x = -1e4; // heat gone: recycled once out of sight
},
updPolice = (k, n = 0, nd = 1e9, nc, e) => {
  
  SEEN = 0;
  for (e of ENT) if (e.q && e != car && !e.e && !e.dd) { n++; SEEN |= e.v; if (dst(e) < nd) nd = dst(e), nc = e; }
  if (n < (W && W + 1)) spawnCar(35, 0, 'pc'); // close enough that a chase starts
  // stars drop one at a time after 8 s unseen at 1-2 stars, 14 s at 3+
  L = SEEN ? 0 : L + k;
  if (W && L > (W < 3 ? 480 : 840)) { H = W = W - 1; L = 0; }
  // busted: on foot within 5 m of a cop, or stopped in a car (< ~6 km/h) within 7 m, for 2 s
  BT = W && !J && !E && !(-52 > ply.x && foot) && nd < (foot ? 5 : 7) && (foot || abs(F.s) < .03 && F.y <= 1) ? BT + k : 0;
  if (BT > 120) MO = MO / 2 | 0, E = 'PILLADO'; // busted: lose half the money, run over
  // siren of the nearest cop (yelp from 3 stars): distance and pan
  let [g, p] = nc ? spatial(nc.x, nc.z) : [0, 0];
  // siren voice e (saw -> hard clip -> bandpass 1.4 kHz): n 0 off, 1 wail (sine at .23 Hz), 2 yelp (rising saw at 3.2 Hz); nd: phase
  if (AC) {
    n = W && nc ? W > 2 ? 2 : 1 : 0; e = aS ||= aLp(3, 2, 1.2, 1400, aSh(6)); nd = aNow() * (n > 1 ? 3.2 : .23) % 1;
    aSet(e[0], 900 + 330 * (n > 1 ? nd * 2 - 1 : sin(nd * 6.28)), .02);
    aSet(e[2], n ? .3 * g : 0, .08); aSet(e[3], p, .1);
  }
},
// ===== PLANE =====
// P: the stealable plane {x, y (wheels height), z, a yaw, p pitch (nose up), r roll (+ = right wing down),
// s airspeed m/frame, v vertical speed, g on ground, u throttle 0..1, f airborne since the last landing,
// n already stolen, q propeller angle, i slot, o atlas cell}. inP: player flying it. PJ: boarding animation. BOOM: crash debris.
// Tuning (m/frame at 60 fps; x216 = km/h): top speed 1.15 (250 km/h), lift from .3, full lift at .55 (120 km/h),
// stall < .33, rotate on the runway above .42 (90 km/h), stick D = nose up (climb), U = nose down,
// pitch +-.6 rad and self-leveling, bank .9 rad, ceiling 250 m. Landing: throttle ~40% glides down gently.
// PL: all planes (i: slot), P: the one being boarded / flown. Slot 0 waits on the runway, 1 and 2 on the apron;
// each gets one of the 4 paint variants (o: atlas cell). A crashed plane respawns in its slot.
newPlane = i => ({ x: i ? 150 + i * 35 : 262, y: 0, z: i ? -34 : -60, a: i ? PI : -H2, p: 0, r: 0, s: 0, v: 0, g: 1, u: 0, q: 0, i, o: 36 + rnd() * 4 | 0 }),
BOOM, PL,
updPlane = (k, p = P, st = ax(), pi = ax('D', 'U'), ox = p.x, oz = p.z, gr) => {
  
  p.u = clamp(p.u + ax(2, 3) * .02 * k, 0, 1);
  // thrust pulls toward u * top speed; climbing costs speed, diving gains it
  p.s = max(0, p.s + ((p.u * 1.15 - p.s) * .005 - sin(p.p) * .004) * k);
  let lf = clamp((p.s - .3) / .25, 0, 1);
  if (p.g) {
    if (held(3)) p.s = max(0, p.s - .006 * k); // wheel brakes
    p.p = p.s > .42 && pi > 0 ? min(p.p + .01 * k, .25) : toward(p.p, 0, .02 * k);
    p.r = toward(p.r, 0, .05 * k);
    p.a += st * .02 * k * min(1, p.s * 5); // taxi steering
  } else {
    p.p = clamp(p.p + (pi ? pi * .015 : -p.p * .02) * k, -.6, .6); // the nose levels itself without input
    if (p.s < .33) p.p = toward(p.p, -.5, .012 * k); // stall: the nose drops
    p.r = toward(p.r, -st * .9, .03 * k);
    p.a -= sin(p.r) * .03 * k; // turn rate follows the bank
  }
  // vertical speed: lift along the nose when fast enough, sink when slow, banking costs a bit of lift
  p.v = toward(p.v, p.s * sin(p.p) * lf - (1 - lf) * .25 - abs(sin(p.r)) * .04, .01 * k);
  [p.x, p.z] = loc(p, cos(p.p) * p.s * k); p.y += p.v * k;
  if (p.y > 250) p.y = 250, p.v = min(p.v, 0);
  if (p.y > 8) p.f = 1;
  if (p.y <= (gr = ht(p.x, p.z))) {
    // touchdown: safe with a level attitude and a gentle sink rate, otherwise crash
    if (!p.g && (-.15 > p.p || abs(p.r) > .3 || -.2 > p.v)) return boom();
    if (p.f) addMoney(DA, DL), DA = 0, addMoney(1500, 'ATERRIZAJE'), p.f = 0; // bank low-flight money first
    p.y = gr; p.v = 0; p.g = 1;
  } else if (p.y > gr + .3) p.g = 0;
  // water, buildings, trees, fences (grid heights at the nose and both wingtips)
  if (p.g && -48 > p.x) return boom();
  for (let [u, w] of [[0, 4], [5], [-5]]) if (hg(...loc(p, u, w)) > p.y) {
    if (!p.g || p.s >= .2) return boom();
    p.x = ox, p.z = oz, p.s = 0;
  }
  p.q += (p.u * .5 + p.s) * k;
},
// crash: debris burst, loud boom, +2 stars, the plane is gone (a new one waits at the airport),
// the player is back on foot just behind the crash site (or the nearest intersection if that is blocked / water)
boom = () => {
  let p = loc(P, -20); // a bit behind the wreck, facing it (blocked: nearest road centers)
  toFoot(...solid(...p) ? p.map(v => clamp(rou((v - 6) / 42), 0, 9) * 42 + 6) : p, P.a);
  P = pcrash(P, 1);
},
// plane q crashes: debris burst, loud boom, camera shake s, s * 2 stars, optional reward m; a new plane takes its slot (returned)
pcrash = (q, s, m) => (debris(32, q.x, q.y + 1, q.z, .8, 60), bang(), cam.sh = s, heat(s * 2), m && addMoney(m, 'AVION DERRIBADO'), PL[q.i] = newPlane(q.i)),
// ===== HEAT RUN =====
// MO money, RT run time left (ms), E end state (0 running, else 'FIN' / 'PILLADO'),
// DA drift money being accumulated (banked when the drift ends), PT popup timer (frames).
// TI title alpha (1 = shown, timer frozen until the first input), RH restart-hold frames, MU money pulse
DM, SB = 0, DT = 0, MO, RT, DA, DL, PT = 0, RH, MU = 0, hud, tm, big, hint, pop, mm, mm0, st1, ah, TT, ring, rtx,
fmt = v => '$ ' + v.toLocaleString('en'),
// new run: player on foot in the alley, empty car at its mouth, no heat, fresh traffic
restart = () => {
  ENT.length = 0;
  car = veh('sd', 162.5, 111, H2, 1); car.o = 10; // the player's first car: the empty teal sedan at the alley's mouth
  // persistent vehicles (pm: never despawned): a parked convertible on the seaside avenue, parked bikes, moored
  // boats, boats cruising offshore with a driver, two empty cars in the airport terminal's parking lot
  ENT.push(car, ...[['cv', -3, 128, 0, 1], ['mo', 158, 113.3, H2, 1], ['mo', -3, 150, 0, 1], ['bo', -62, 163.2, -H2, 1], ['bo', -71, 156.8, -H2, 1],
  ['bo', -160, 95, 0], ['bo', -160, 225, 0], ['sd', 216, -10, 0, 1], ['cv', 232, -10, 0, 1]].map(a => ({ ...veh(...a), pm: 1 })));
  toFoot(149, 109.8, H2, .18);
  F = ply;
  J = H = W = L = E = MO = DA = inP = PJ = RH = AM = 0; RT = 18e4; TI = 1;
  P = (PL = [0, 1, 2].map(newPlane))[0]; BOOM = []; FX = [];
  cam.e = [145.8, 1.6, 109.8]; cam.w = H2;
  for (let n = 500; n--;) populate(15, 8);
},
// minimap: the whole map (x -110..390, z -112..390) at .19 px/m around its center (140, 139), rotated with
// the camera so forward is up. Local px = (center - world) * MS: world -X is screen right when facing +Z.
// The static layer mm0 is drawn once; per frame both layers are only rotated and mm (dots) redrawn.
// MS: map scale .19
mp = (x, z) => [(140 - x) * .19, (139 - z) * .19],
// world rect (x, z, width, depth) on graphics g
rect = (x, w, z = -6e3, d = 12e3, c = 0x333438) => mm0.fillStyle(c).fillRect(...mp(x + w, z + d), w * .19, d * .19),
// arrow icon for entity e (heading e.a): world forward (sin a, cos a) is local (-sin a, -cos a)
arrow = (e, s, w, c = 0xffee00, [x, y] = mp(e.x, e.z), u = -sin(e.a) * s, v = -cos(e.a) * s) => {
  
  mm.fillStyle(c).fillTriangle(x + u * 1.6, y + v * 1.6, x - u + v, y - v - u, x - u - v, y - v + u);
  // w: wing bar (planes), half length w * s across the heading
  w && mm.lineStyle(2, c).lineBetween(x + (v *= w), y - (u *= w), x - v, y + u);
},
drawMap = (SH = [23.75, -2.66, 3.5], c = cos(cam.w), s = sin(cam.w), x = F.x - 140, z = F.z - 139, f = max(0, 1 - 220 / hyp(x, z)) * .19, e) => {
  // map center: the city center, or following the player once 220 m away from it (the player stays in the frame);
  // both layers rotate about the frame center: position = frame center - rotated local offset (u, v) of the view center
  
  for (e of [mm0, mm.clear()]) e.setRotation(cam.w).setPosition(720 + f * (x * c - z * s), 80 + f * (x * s + z * c));
  // planes: yellow arrow with a wing bar
  for (e of PL) e != F && arrow(e, 3, 4 / 3);
  for (e of ENT) if (e != F && !e.k) e.c > 1 ? arrow(e, 2.5, 0, 0x80e0ff) : (e.q || e.e) && mm.fillStyle(e.q ? T / 150 & 1 ? 0xff2020 : 0x3050ff : 0xffffff).fillRect(...mp(e.x, e.z).map(v => v - 1.5), 3, 3);
  mm.fillStyle(0xff4fc8).lineStyle(1, 0xffffff).fillCircle(...SH).strokeCircle(...SH); // the shoe shop (mp(15, 153))
  arrow(F, 3.5); // the player
};
ext(bu, "ZsVyOzCSsV|?zCT~;|?zCyS~OzMzC]~OyOzCX"); // [16, -5, .45, 1.25, 9, -5, 3.05, 1.25, 10, 4.85, 3.05, 1.25, 49, 5.05, 1.35, 1.25, 18, 5.05, .45, 1.25, 14]
bx(bu, 0, .45, 3.4, 2.4, 2.5, .1, 12); // partition behind the driver (seats texture)
MODELS.bud = MODELS.sdd;
// police light bar b0/b1 (red and blue swap when flashing)
// base [0 1.56 -.3 1.3 .08 .3], lamps [+-.35 1.62 -.3 .55 .16 .28]
[0, 1].map(i => bl(MODELS['b' + i] = [], "JJzc+zHRiK&zi+yYZgLnzi+yYZg", gy(.1), i ? [1, .1, .1] : [.3, 0, 0], i ? [0, 0, .3] : [.1, .3, 1]));
// q / qf: torso + neck + head (base / female). Shoulder pivots at (+-X, 1.36) just inside the torso, hips at (+-.1, .86).
// Ring data packed one char per number (RG): y = .8 + .01 (code - 32), radii .005 (code - 32)
// limbs (l): y = -.44 + .01 (code - 32), radii .017 + .001 (code - 32)
((CL = [12, 8, 4, 4], MA = all([8, 8, 4, 4]), ZA = [0, 0, 4, 6], ZL = [4, 0, 4, 6], RG = (s, l) => [...s].map((c, i) => (c.charCodeAt() - 32) * (i % 4 ? l ? .001 : .005 : .01) + (i % 4 ? l ? .017 : 0 : l ? -.44 : .8)), BA = (y, h, a = [8, y, 4, h], b = [12, y, 4, h]) => [a, b, a, b], i, j, y, SEG = [], GR = TL(19, gy(.7)), ay = 5.5, az = 0, AV, WC, mo, bo, n = 0n, s = '', c) => {
[' >44,B669?44HG96TI64[B21`0,,', ' B68*J8@9:22EAA4NC>4TD43Z>00^/,,'].map((R, i) => {
  let A = MODELS[i ? 'qf' : 'q'] = [];
  lathe(A, RG(R), [([16, 16, 8, 16]), [23, 16, 1, 16], [24, 16, 8, 16], ([16, 16, 1, 16])]);
  lathe(A, RG('X++*e***'), MA, 6);
  // head: narrow chin, jaw, cheeks, temples, crown
  lathe(A, RG('^*.(c150j476r568z..1'), [[16, 0, 16, 16], CL, [0, 6, 8, 6], CL]);
});
// legs, pivot at the hip / knee: thighs qL / qR (+X / -X leg), shins + feet qS / qT. The +X leg takes the right
// half of the pants front and the left half of the back; outer columns on the sides.
[0, 1].map(k => {
  let x = 4 - 4 * k, b = 8 + 4 * k, R = (y, h) => [[x, y, 4, h], [x + 3, y, 1, h], [b, y, 4, h], [x, y, 1, h]], A;
  lathe(MODELS['q' + 'LR'[k]] = [], RG('!KPK8_ddOiis', 1), R(12, 10), 6);
  A = MODELS['q' + 'ST'[k]] = [];
  lathe(A, RG('&<<<<KFZNFKK', 1), R(22, 10), 6);
  box(A, 0, -.45, .05, .11, .09, .25, [ZL, ZL, ZA, ZA, ZL, ZL]);
});
// arms, pivot at the shoulder / elbow: upper arm qu, forearm + hand qa
lathe(MODELS.qu = [], RG('.577@=@@P<<<', 1), BA(0, 4), 6);
lathe(MODELS.qa = [], RG('3/11B9<<N577', 1), BA(4, 4), 6);
lathe(MODELS.qa, RG('(#774(33', 1), MA, 6);
for (i = 0; i < 6; i++) lathe(PALM, RR(0, .3 - i * .03, 1.25, .27 - i * .03), TL(12, gy(1), .1), 6, i * i * .05, 0, i * 1.2);
for (j = 0; j < 7; j++) {
  let c = cos(j * .9), s = sin(j * .9), F = (d, y, w) => [1.25 + c * d - s * w, 7.2 + y, s * d + c * w];
  // one leaf tile per frond (double-sided, transparent texels discarded), its diagonal along the frond:
  // base (u 0, v 1), sides at mid length bent up, tip (1, 0) drooping
  let b = F(0, 0, 0), l = F(1.8, .35, 1.8), r = F(1.8, .35, -1.8), t = F(3.6, -.8, 0), L = (u, v) => [208.5 + u * 15, 32.5 + v * 15, 0, -1];
  for (y of [-99, 99]) tri(PALM, b, l, r, L(0, 1), L(0, 0), L(1, 1), [0, y, 0]), tri(PALM, t, r, l, L(1, 0), L(1, 1), L(0, 0), [0, y, 0]);
}
for (j = 0; j < 3; j++) lathe(PALM, el(.15, .16), [.35, .25, .12], 5, 1.25 + cos(j * 2) * .25, sin(j * 2) * .25, 6.95);
// street lamp (arm toward +Z over the road): tapered pole, arm curving in 3 segments, head with a bright lens
lathe(LAMP, RR(0, .12, 5.6, .07), GR, 6);
box(SEG, 0, -.04, .35, .08, .08, .7, GR);
for (i of [1.2, .6, .1]) put(LAMP, SEG, modelMat(0, ay, az, 0, i)), ay += sin(i) * .7, az += cos(i) * .7;
lathe(LAMP, RR(-.3, .3, .05, .1), GR, 6, 0, az, ay);
box(LAMP, 0, ay - .32, az, .36, .04, .36, [1, .95, .75]);
// park bench: seat, backrest, two legs
bl(BENCH, "JJyLJzgRyOJJyY4zgyJPKx=JJRyLyJKydJJRyLyJ", WD, DK);
// seat [0 .42 0 1.6 .08 .45], back [0 .55 -.22 1.6 .4 .06], legs [+-.65 0 0 .08 .42 .4]
// traffic lights l0 (green) l1 (yellow) l2 (red): pole + housing + one lit lamp, facing +Z
[[.1, .9, .2], [1, .75, 0], [1, .1, .1]].map((c, i) => {
  let A = MODELS['l' + i] = [];
  lathe(A, RR(0, .1, 3.4, .07), gy(.3), 6);
  lathe(A, NS("|Nd^^}ud^^"), gy(.1)); // [3.2 .25 .19 .19 4.5 .25 .19 .19] // octagonal (beveled) housing
  box(A, 0, 3.32 + i * .38, .18, .28, .28, .06, c);
});
// small high-wing plane, origin at the fuselage center (wheels touch y = -1.2), textured from its atlas cell
// (dev/skins/plane_32.png, CAR_GUIDE "Plane atlas"; codes: 2 fuselage top, 3 belly, 6 wing bottom, 7 tail fin,
// 8 stabilizer, 9 (+32 glass) cockpit glass, 10 cowling, 11 propeller, 12 hub, 13 tire, 14 interior, 15 windsock,
// 19 fuselage side, 20 wing top)
AV = MODELS.av = [];
// fuselage side profile (starts at the windshield foot, the only concave corner, so the side fan stays inside):
// windshield, roof, tail top, tail end, belly, chin, nose (z, y, half width, strip code)
// [19, 2.5 .55 .55 41, 1.6 1.05 .5 2, -.4 1.05 .45 2, -3.3 .4 .1 3, -3.3 .05 .1 3, -.8 -.55 .55 3, 2.2 -.55 .58 10, 3.25 -.25 .42 10, 3.3 .35 .42 10]
ext(AV, "^{eyYyYyKzgz.yTL z.yOLuHyJTMuHOTMx-xGyYM{FxGy]T|S1yLT|XnyLT");
bx(AV, 0, 1.05, .9, 10, .14, 1.6, 6, 6, 6, 20, 6, 6); // wing on the roof
// tail fin [0 .35 -2.85 .1 1.3 1], stabilizer [0 .2 -2.9 3.2 .08 .9], cabin interior [0 -.1 1.3 .5 1 1.4] (small: the fuselage narrows toward the tail, a bigger box shows through) (seen through
// the glass), wheels [+-.9 -1.2 .6 .22 .6 .6], nose wheel [0 -1.2 2.6 .18 .5 .5] (hub on the sides, tire elsewhere),
// spinner [0 -.12 3.3 .36 .36 .4];
// then the propeller pp: two crossed bars [0 -1.1 0 .16 2.2 .06] [0 -.08 0 2.2 .16 .06], spun with the roll angle
WC = [12, 12, 13, 13, 13, 13];
NC("JnuvTzHz)J_uq|NRy}J@zHyTz)zRy}wcy_ay_y_x#wcy_ay_y_Jwc{o]yTyTJ>|XooyJJwmJZ{FPJBJ{FZP", 6).map((b, i) => bx(i > 6 ? (MODELS.pp = []) : AV, ...b, ...[[7], [8], [14], WC, WC, WC, [10], [11], [11]][i]));
// windsock (red / white bands, the plane atlas' spare cell; along +Y, laid forward when drawn) and the tower radar
// (post + dish panel, tilted when drawn)
lathe(MODELS.ws = [], RR(0, .3, 2, .12), all(RC(15)), 6);
// parachute: canopy dome (striped umbrella tile) on two lines from the shoulders
lathe(MODELS.ch = [], RR(2.5, 2.6, 3.4, 1.9, 3.7, .1), TL(16, [1, .45, .1]), 8);
[-.25, .25].map(x => box(MODELS.ch, x, 1.4, 0, .03, 1.2, .03, DK));
// explosion debris (orange / gray)
// particles: unit boxes centered on the origin, scaled per draw (f0 smoke, f1 fire, f2 spark, f3 flash)
// (xo 2 m, xg 1.2 m: explosion debris)
[[1, .55, .1], gy(.3), gy(.4), [1, .45, .1], [1, .8, .2], [1, 1, .8]].map((c, i, _, s = i ? i < 2 ? 1.2 : 1 : 2) => box(MODELS[i > 1 ? 'f' + (i - 2) : i ? 'xg' : 'xo'] = [], 0, -s / 2, 0, s, s, s, c));
box(MODELS.tr = [], 0, -.03, .5, .06, .06, 1, [1, .9, .5]);
box(MODELS.wk = [], 0, 0, 0, 1, 0, 1, [.95, .97, 1]); // boat wake (flat, top face only)
// motorbike (+Z forward, ~1.9 m), bike regions: 0 tank 1 seat 2 frame 3 fork 4 front 5 rear 8 engine 9 exhaust
// 10 handlebar 11 fairing 12 under. Wheels are drawn apart (wm).

// engine [0 .2 .05 .26 .3 .45], frame [0 .38 0 .14 .2 1.1], tank [0 .58 .25 .3 .22 .5], fairing [0 .48 .62 .36 .38 .16],
// seat [0 .66 -.32 .26 .1 .6], tail [0 .6 -.72 .2 .16 .22], fork [0 .3 .66 .07 .55 .07], bar [0 .9 .5 .72 .06 .06], exhaust [.17 .14 -.4 .09 .09 .6]
// Allocate once so each body part appends to the same mesh.
mo = MODELS.mo = [];
NC("J_OeiyOJqJX_z4Jy]diayTJyRyaoqZJye)eTy_Jy_x6_ZaJiyeQyYQJy}yTykPP[X SSy_", 6).map((b, i) => bx(mo, ...b, ...[[8], [2], [0], [11, 11, 12, 11, 11, 4], [1], [2, 2, 12, 1, 5, 2], [3], [10], [9]][i]));
// speedboat (~4.4 m): hull, pointed bow (two narrowing boxes), stripe, windshield, seat, outboard motor
bo = MODELS.bo = [];
// hull: lathe laid forward, pointed bow, flat transom; blue bottom = the same rings a bit wider, flat on top
let BR = NS("vjy}yYdxLz yYdz>yiyTa{UOTT"), HT = []; // [-2.05 .9 .55 .25 -.5 .92 .55 .25 1.2 .7 .5 .22 2.35 .05 .1 .1]
lathe(HT, BR, WT);
lathe(HT, BR.map((v, i) => i % 4 > 2 ? .02 : i % 4 ? v * 1.04 : v), [.15, .35, .6]);
put(bo, HT, modelMat(0, .55, -.1, 0, -H2));
bl(bo, "JJynyTzRyORKJynx8y}iyTLJ_v`nz)n", [.18, .22, .28, 2], [.5, .35, .25], DK); // windshield [0 .75 .5 1.4 .45 .08], seat [0 .75 -.7 .9 .3 .5], motor [0 .2 -2.15 .35 1 .35]
// burnt wrecks: every vehicle model darkened (rgb and the glass flag x.15: glass becomes opaque black)
// textured vertices (a < 0) become flat near-black
for (let n in MODELS) MODELS[n + 'w'] = MODELS[n].map((v, i, a, j = i % 10) => j > 2 && j < 7 ? a[i - j + 6] < 0 ? j < 6 ? .07 : 0 : v * .15 : v);
// uzi in forearm space (pivot at the elbow): hangs along -Y from the hand (points forward when the arm is raised), magazine toward -Z
box(MODELS.uz = [], 0, -.42, 0, .06, .2, .085, DK); // held in the hand (forearm ends ~-.3)
bl(MODELS.uz, "JJxMJMRMJJ'ANOV", DK);
// [0 -.49 0 .03 .08 .03] [0 -.34 -.09 .04 .05 .12]
// (_: the load event; the canvas, rc and CC as default params)
// copy cell s to cell n, paint pixels (teal or red families, not the 217-red tail lights) become f(u, v) scaled by
// the pixel's brightness (keeps the shading)
// (P: which pixels are paint, from r, g, b and the row v; default: the car paint test)
// CC: red, white, black, yellow, blue, green, silver
IMG.onload = (_, c = new OffscreenCanvas(1280, 48), x = c.getContext('2d'), rc = (n, s, f, P = (r, g) => (g > r + 25 || r > g + 70) && r != 217, i, d = x.getImageData(s * 32, 0, 32, 32), p = d.data) => {
    for (i = 0; i < 4096; i += 4) {
      let r = p[i], g = p[i + 1], b = p[i + 2], l = (r + g + b) / 300;
      if (P(r, g, b, i >> 7)) f(i / 4 % 32, i >> 7).map((c, j) => p[i + j] = c * l);
    }
    x.putImageData(d, n * 32, 0);
  }, CC = [[200, 35, 35], [240, 240, 235], [40, 42, 48], [235, 190, 40], [40, 80, 185], [45, 130, 70], [165, 170, 175]]) => {
  x.drawImage(IMG, 0, 0);
  // paint variants: cells 15 + source * 7 + color for the sedan, convertible, bike; then the plane (the PNG's cell 14,
  // before the police car takes it): cells 36..39 (40+ fall off the canvas), the light gray paint (fuselage, wings,
  // tail; rows above 24) recolored (colors / 2.3: the paint is bright)
  [10, 11, 13, 14].map((s, j) => CC.map((c, k) => rc(15 + j * 7 + k, s, () => j > 2 ? c.map(v => v / 2.3) : c, j > 2 ? (r, g, b, v) => abs(r - b) < 20 && g > 140 && v < 24 : void 0)));
  // police: navy roof and lower body sides, white elsewhere
  rc(14, 10, (u, v) => v < 8 && (u > 15 && u < 24 || u < 8 && v > 3) ? [30, 40, 90] : CC[1]);
  CV = c; upTex();
};
// the atlas (the 75-color PNG re-encoded as lossless WebP, pixel-identical: 2808 bytes) as one big base-92 number: printable ASCII minus the double quote, slash and backslash
// (denser than base64); decoded to bytes with BigInt, then handed to the image as base64
  for (c of "$A%R~T9`HYDfh'+Slv=;L PXZ-dKs>0G'bI3&a+dh]OZK[E3Q#ne+1<owms2> )#'BVRs.~jiEa&NH@6KZnVWWI9#@VuZjp%3r3M9#*WO8WaeRqePOwd,I_%}L*hl+A>D,~uH;F i}#[wGGl}XG&OWl_P 6xmjsXgFwB^#T]r 1MNO2SApA51.h@2?o*?Y[<I=t`:AAk8g[KUsFNaC4StSo^}_xGy#+avW1q4m:>dB].c hf$kmS4JL~A4w'k>p=fFh3Msd6FW?E?t]S|&vV<$@uPG|=*{~@N`)Y|&d:Njc|po*5:TR37tVTSFI@RGYZ%3kduDv_n<3+$6)wJMAP0uK{BK:c4^~MR|^u~[7^6]gj8M|HPLYw)hoQJaK:c8ax2;>`Z`SlFJ#jHL&`DC:Dp9O6ufA+&CRCcR*0c~w]iFJq<+WmFX&aP~VB[uQMmZ=#NN.)@dh5{508Qa&O,:svYB)9&JftuHfTGKltk;mV)+=3@WRaB[fv1J`H_@*@lTuO1>Y=u+*qm@FpOz@c!!6`l^iJk2C{?|{V`rXD]0:.r<4PFzcO08&DzFAN2^{Z`{Iepj$9H4ugD1Ma0oumDBlG32.^4vrm*qFh;>5L}$;GM@>,`|DSSMPW:T;18{l2*L4K]5t*2BQ=`>yo:rnQG@{LC ~Bctgf-a.1&m0IfJ1<b0lv>*aAl8isqGHK1.,'u+X%uDu'Jig$SZSJe-zgI'2c#hDzBhr`|M8k#h.5*zIK5bg:l{t=gG3bkpf_GoFIf2sy|,ZEMUM')CoHNa~c#O2Wx #p[sS,,k1?Qn+~3bajYR$}c:*rOH;iiWSvwKY#.h2~Q3%O&*v2G}Q-#x)D1^>Vg%D;y.t1{!zyn:o{g'lUL%>aghGjJSP~,&y,x{1r_#W!(tL!>k%de.UGG-yK(nIl8lPmr+(A=8AO:RF7,jRyVia_7B~?i1U~$:Y!Fzo2kl37P5X -&?%)O8C8dZa~_20j&AATblXM:SyM ^w`@?`]mT-1fys$}bhr+_mp1tL~rT82,0PI&eNK_@W){:N*#d',+.-zX|~,9diVq4oJa7-T=!2LfZ$2t+P1vJib1cUHand8u{k`66[`_<VbCI!{$I(~j8O#+~64,K0Ehvi!^(Rj-Uj3u8n~R>s1I=J.0{nU|32nS7!fU>k-u)!p!f;%b#th0Q.bMkZkJSN8GF8},-s|Ujo;KD{P=zV+$<pZ0;~$J%@qmY.:T93H6_sE#]JH4aXx(S165#]V|J9Nix(~-Jwi[,>CJw}d@6'%Qkll,E%k 7T),-07+RP&-`.-A:43oMk1CWuJdmpLOK5?RPdB>e<Dm(i|]~-x@WW'@p^,xN&2d6jgygqKK-@> hcNULaEul2Zb]gD,0Ci%+%Bfx3_+`w{5y,pxah6EoJh~:`kPbOPPuqi R-yN:F}[X!#pav`MY$rFL&xU>zniTWQafX6ULmXRC~#f#Sh]`SEm+A=7Xiu:8zd%<^&[P%rx7_JZjinj>@^]Q|g^aAQf{fBqA,&C;ZLHhoH?B';M-,'6o)!Rla>o3&&K=E6Y>`dfcMFH5:0cKNNVPyAgH~=Zkpv;i:4R1 o:1*z9b!Tl3$^'vVlIR&?~ItwnRTTGdg`Ph $?F>!ed-=lf{F]IAdj(yh6L_oNK8rFs>5Q^lCzgZ6W=Rm`x1mWeX1b>su,cI9(:GfyUoCh^<h`<Ekx8gD:L*Q+4(''&d0(Jlit9I7;&o5(9;6i}k|+xDm0C>oqJ7%7`j%y&9zONPnh`t~u-4+#];xB*>45IHH'LcF[SY)d-uEvAL3{Eu7D,W4>9O)h6gjEl#WKz%Gyn{B'C!lN'sK@NJ;AyVgpas-HN3J;nX3<%e7B66s6>n%1$By;[i07Yt43Nw-_z#K?bc>@1{b'zs1{nG275Q,8Z)&N6l$TPm_!Y~)2s4vr1f9sD0WkPQH#JI*t:Z9S_A98Qx=H2WuFU.0HI$1Dr^7ghv3?,yTXYT8KX|,G4SP|ba~(4SMh>U]|~$q*@o3V-<&IV`;bhR3nPiFHRZUWc@05&Q)!'77pE3xE)5QkRQAb:+6_dqEf((6ekJ+7R8gJ#JZiehlF#v<;z{>F-^(O[F$F1]V57-,#BLR7&G;m?b6+d^6uO:Ve`L|=%TnGFM@Gl'S-&n{gPsb2HL-&j}*o1X1]^>!hE`Gn<Zn($Wsw+QCfh|ZCkF8u~aBj(YfYr_,o4wWfvRZAtiCdB^?=]^`We)8A)Y(oMVS5pKQWjv]~2|,5|}9p(+Pi}C3<&2oaf[Ijo#f{1L]j,ZZfSd;Q:v,6l*s9*U|} 'di^|ICW+g'J2&ZL@j^k7:Q<e]e<3@et<?L7#54^7lwI}EOVb: ..,@IO<#{?dwvE=eSMxNej>I?`y{0}U{Ro%WA2uCZ)Q)L4:UgBN={1_Su'0ChG}ipZOc'-'vRc$3WWhmt+?`$GWYf&[Dn9yX(*|-Jn9w 51SIlE73 6Qeig3k:ir^ S{GC7:=!C 1l4H) 3JOAdA?yc840#}?* [7>:lq GU2lO3e5,yho@T` b-lHrjO`Vgg~ea^}'YyhC}pu^F-*J.v@DC'PUzZ<l?nj)IEh5=wE4#l)Py3 ^%oPXtp[6ei'B9&'If@-4Bd:@8Y39~K1#?c^68MD<% 'ajV6u#:U054EL^N<&NRoeerB^)T5_J@(R9;C9<1!: qetycW4W%ij.fuWdxduI3~xIY)pGWiDF|iab$}^u7'!,ieEW7mp4QU+PF%<a u*nQMb; X'5c)h8N=6('G%O&JUaJW2XQ}SZCgal$|]wA,RD7U_'~A @TDZwN*s2YXi]4;0WO:tm4N8kkrKu85|&{Mw^a&s]}V>%|%Q^>(uFypYqGYX9`+(j6}}IiluSkCfV+1H78XucswWIw0y^(ae2TCs]c,:!;tvN1?~Uobh@tM> 7rA,:<ejs$'g!:^-tWxz%dMBZ3%Kk_$Z1{GFZLuQe4+hcF$jN,{lK>hLE(:R:~oJxhYs~&VT{B>s$.,P35%H..1X}gsp9d%n}Z8^@S{(`DCAn`'SuC+t1vVcvq.7==&f_cb%soC=4)$<G4W0[tVt@0-e[O^qh$<2ezbB:){*fYRR9:Ai|~umgMVmlk+WA8Ld$[?GmPp$;ALgL^=}^!=&Plw~%2JlnYre=p-EB_X>#08>L7C$Pmr't>2HxI;gezjBX|BYu{t;M-Mm8pL;Ewkq)pe?8m#ODy!f?)OO`|9}EGoW72=B&-N&}l&:'Gy|Pd6o%HumGE_Eh?wQP>Kbo02wlKc>N[$k9~'OW&f-lLzwu=gB|^#o<KT0ncE1>R*M~r$qx(Ws!2e~xEg - Cy&F#[5hymW8inL##,%Euoh#;>Z5Nr+lZ9`q@2#r5F]P$6)g~HQ*)vLi=$]C w rO&i67!S!:sL{+gn}y-^Sj+_J_1IOuIP&B*,N&9#BE}PT&TBUa6-zzV[7v4t+A}P`EVm0*3h]gbN3:Bk78xQo") n = n * 92n + BigInt(ci(c));
  for (i = 2808; i--; n >>= 8n) s = String.fromCharCode(Number(n & 255n)) + s;
  IMG.src = 'data:image/webp;base64,' + btoa(s);
})();
new Phaser.Game({
  type: 2, // Phaser.WEBGL
  width: 800,
  height: 600,
  parent: 'game-root',
  backgroundColor: '#9ec7e6',
  scale: { mode: 3, autoCenter: 1 }, // Phaser.Scale.FIT, CENTER_BOTH
  fps: { limit: 61 }, // ~60 updates/s on 120/144/240 Hz screens too (61: 2 frames at 120 Hz pass the limit)
  // ===== PHASER SCENE =====
  scene: {
  // (_: Phaser's scene data; A: the object factory, tx: text helper, MP: minimap layer origin, LF: title font)
  create(_, r = this.renderer, A = this.add, tx = (x, y, o, f = 20, c = '#fff', t = '', s) => A.text(x, y, t, { fontFamily: 'monospace', fontSize: f, color: c, stroke: '#000', strokeThickness: 4, ...s }).setOrigin(o),
    LF = { fontFamily: '"Arial Black",sans-serif', fontStyle: 'bold italic', strokeThickness: 10 }) {
  buildCity();
  r.on('restorewebgl', _ = () => initGL(r.gl)); _();
  A.extern().render = (() => withTex((w = .3 - 3000) => { // w: near - far
  gl.enable(2929); gl.depthFunc(515); gl.depthMask(1); gl.clear(256); // DEPTH_TEST, LEQUAL, DEPTH_BUFFER_BIT
  gl.enable(2884); gl.disable(3042); // CULL_FACE on, BLEND off
  gl.useProgram(prog);
  for (let i = gp(34921); i--;) gl[(i < 3 ? 'en' : 'dis') + 'ableVertexAttribArray'](i); // attributes 0-2 on, the rest off
  // projection (fov cam.f, aspect 4:3, near .3, far 3000) x view (eye cam.e looking at cam.t)
  let t = 1 / M.tan(cam.f / 2), e = cam.e, z = nrm(sub(e, cam.t)), x = nrm([z[2], 0, -z[0]]), y = cross(z, x), d = a => -dot(a, e);
  let V = VM = mul([t * .75, 0, 0, 0, 0, t, 0, 0, 0, 0, 3000.3 / w, -1, 0, 0, 1800 / w, 0],
    [...[0, 1, 2].flatMap(i => [x[i], y[i], z[i], 0]), d(x), d(y), d(z), 1]);
  gl.uniformMatrix4fv(uV, 0, V);
  gl.uniform3fv(uF, [.62, .78, .9]);
  gl.uniform3fv(uE, e);
  gl.uniform1f(uG, 0); // pass 1: opaque (glass fragments discarded)
  // city chunks whose bounding sphere touches the view frustum (clip space, margin ~2.2 r for the side planes)
  for (let [b, n, c, r] of [...CH, ...Object.values(OC)]) { let [x, y, , w] = mv4(V, c, 1); w > -r && max(abs(x), abs(y)) < w + r * 2.2 && drawMesh([b, n], (modelMat(0, 0, 0, 0))); }
  let D = g => drawList.map(([k, m, s, o]) => g && s || drawMesh(meshes[k], m, o));
  D();
  // pass 2: only glass, premultiplied alpha .35, no depth writes
  gl.enable(3042); gl.blendFunc(1, 771); gl.depthMask(0); gl.uniform1f(uG, 1);
  D(1);
}));
  hud = tx(12, 8, 0, 32, '#5f5'); // money: green, pulses when it grows
  tm = tx(14, 46, 0, 22);
  pop = tx(14, 74, 0, 20, '#7f7');
  // title card over the live 3D scene: fades out on the first input, then the timer starts
  ring = A.graphics(); rtx = tx(400, 360, .5, 18);
  big = tx(400, 260, .5, 56).setAlign('center');
  ah = tx(790, 590, 1); // altitude / speed while flying
  // minimap (top-right 140x140): dark frame, static map layer, dynamic dots layer, border
  // sea; clips the layers. g: the static layer (AS asphalt): land, sand, avenue, city, airport, hangar, pier (none of
  // these touch the country roads drawn next except the same-colored city), country roads every 252 m, blocks
  let K = A.graphics().fillStyle(0x2a6aa0).fillRect(650, 10, 140, 140).createGeometryMask(), n; mm0 = A.graphics().setMask(K);
  [[-48, 12e3, , , 0x5a6648], [-48, 36, , , 0xd8c890], [-12, 12], [0, 390, 0, 390], [40, 290, -70, 20], [252, 12, -50, 50], [290, 32, -40, 28, 0x888888], [-80, 36, 156, 8, 0x8a6a48]].map(a => rect(...a));
  for (n = -24; n < 25; n++) n > 0 && rect(n * 252, 12), rect(0, 6e3, n * 252, 12);
  BK.map((b, n) => rect(12 + (n / 9 | 0) * 42, 30, 12 + n % 9 * 42, 30, [0x9a9890, 0x4d8a3a, 0x7aa0c8][b]));
  mm = A.graphics().setMask(K);
  A.graphics().lineStyle(2, 0xffffff).strokeRect(650, 10, 140, 140);
  // wanted stars: gray row with the filled (yellow) ones drawn over it
  tx(675, 152, 0, 30, '#666', '*****');
  st1 = tx(675, 152, 0, 30, '#fd0');
  // created last so they draw on top: title dim (darkens the scene and the HUD), title card, button hint
  DM = A.rectangle(400, 300, 800, 600, 0);
  // title card in the style of the cover logo: pink presenter line, white / yellow heavy italic title with a black
  // outline, black band with the edition (pink) and the goal
  // title lines [y, size, color, text], centered at x 400
  TT = [A.graphics().fillStyle(0).fillRoundedRect(160, 330, 480, 96, 22),
    ...[[150, 24, '#ffa8d8', 'BIPBOP LABS PRESENTS'], [214, 64, , 'GRAND THEFT'], [286, 76, '#ffc800', 'BANANA'],
    [361, 30, '#ff9ccf', 'PRE-REVENUE EDITION'], [405, 20, , '3 MINUTOS PARA HACER PLATA']].map(([y, f, c, t]) => tx(400, y, .5, f, c, t, LF))];
  hint = tx(400, 550, .5);
  restart();
  },
  update: (time, dt, k = min(dt / 16.67, 3), q, a, b, f, t, c, u, v, s) => {
  T = time;
  // hold B6 (L) ~1.5 s anywhere to restart; releasing early drains the ring
  RH = held(6) ? RH + k : max(0, RH - 4 * k);
  if (RH > 90) restart();
  if (TI == 1 && Object.values(PRESSED).some(v => v)) TI = .99; // a fresh press: the restart button still held keeps the title up
  if (TI < 1) TI = max(0, TI - .03 * k);
  if (E) { if (PRESSED.START1 || PRESSED.START2 || hit(1)) restart(); }
  else {
    if (TI < 1 && (RT -= k * 16.67) <= 0) RT = 0, E = 'SE ACABO EL TIEMPO';
    if (J) updJack(k);
    else if (PJ) { // boarding: walk to the left door (40 frames), hop in (15 frames)
  let p = ply, [dx, dz] = loc(P, .6, 1.5); f = min(1, (PJ.t += k) / 40);
  dx -= PJ.x; dz -= PJ.z;
  p.x = PJ.x + dx * f; p.z = PJ.z + dz * f;
  if (f < 1) p.a = at2(dx, dz), p.ph += .1 * k; else p.ph = 0;
  p.y = max(0, PJ.t - 40) * .08;
  if (PJ.t > 55) { offFoot(); inP = 1; foot = PJ = 0; }
}
    else if (foot) updFoot(k);
    else if (inP) {
      updPlane(k);
      // step out of the plane on the ground; in the air (12 m+) jump: skydive, the empty plane flies on and crashes
      if (inP && hit(1)) P.g ? P.s < .03 && (toFoot(...loc(P, 3), P.a), P.u = 0) : P.y > 12 && (toFoot(...loc(P, -3), P.a, P.y), ply.pc = 1, ply.vy = P.v, P.n = 2);
    } else {
      updateCar(k);
      // under ~10 km/h (not if the car just blew up). Bikes: swing the leg back over (reverse mount)
      if (hit(1) && as() < .05 && !foot) { let [x, z] = loc(car, -.3, .75); exitCar(); if (car.c == 1) J = { o: car, t: 72, x, z, X: 1 }; }
    }
    // drift money (~$40/s) or low-flight money (under 20 m, ~$24/s), banked (x multiplier) when it ends
    if (inP ? !P.g && P.y < 20 : !foot && car.c < 2 && car.dr > 20) DA += k * (inP ? .4 : .7), DL = inP ? 'RASANTE' : 'DRIFT';
    else if (DA) addMoney(DA, DL), DA = 0;
    // wanted bonus: every 10 s still on the run with 2+ stars (x the star multiplier)
    (SB += W > 1 ? k : -SB) > 600 && (SB = 0, addMoney(100, 'FUGA'));
  }
  F = foot ? ply : inP ? P : car;
  if (car.H) car.y = max(car.y - .006 * k, -3); // sinking car
  // reversing: follow the nose (car.a), not the travel angle, so the camera never swings to the front
  // on foot: over-the-shoulder, the camera pivot is 1.1 m to the player's right (right of heading a = (-cos a, sin a))
  if (foot) { a = PJ ? P.a - .7 : J ? J.o.a - .7 : ply.a; updateCam(k, ply.x - cos(a) * 1.1, max(ply.y, -.6) + .3, ply.z + sin(a) * 1.1, a, 0, J || PJ ? .9 : ply.pc ? 1.6 : .5);
    // never inside a vehicle: an eye within a vehicle's footprint rises over its roof
    for (q of ENT) if (!q.k) { [u, v] = lcl(q, cam.e[0], cam.e[2]); if (abs(u) < q.w + .4 && abs(v) < q.l + .4) cam.e[1] = max(cam.e[1], q.l > 3 ? 4.5 : 2.8); }
  }
  // plane: third camera profile (further back and higher), target follows part of the pitch
  else if (inP) updateCam(k, P.x, P.y, P.z, P.a, P.s / 1.15, 2.6), cam.t[1] += sin(P.p) * 12 - 3;
  else updateCam(k, car.x, gh(car.x, car.z) + car.y, car.z, car.s < 0 ? car.a : car.t, as() / .62);
  drawList = [];
  // ===== COUNTRY CHUNKS =====
  // chunks within 2 of the camera's chunk (at most one built per frame), freed beyond ~3.5;
  // the mountain ring follows the camera
  let [ex, , ez] = cam.e, I = rou((ex - 6) / 126), Jc = rou((ez - 6) / 126);
  for (q in OC) { [b, , c] = OC[q]; max(abs(c[0] - ex), abs(c[2] - ez)) > 440 && (gl.deleteBuffer(b), delete OC[q]); }
  c = 1;
  for (a = I - 2; a < I + 3; a++) for (b = Jc - 2; b < Jc + 3; b++) OC[[a, b]] || c && (c = 0, OC[[a, b]] = mkC(a, b));
  dl(['mt', modelMat(ex, 0, ez, 0), 1]);
  updateWorld(k);
  // windsock: swings with a slowly turning wind, droops when it calms
  dl(['ws', modelMat(70, 5.8, -45, T / 5e3 + sin(T / 1300), sin(T / 900) * .2 - .25 - H2), , 36]);
  ply.pc > 1 && dl(['ch', modelMat(ply.x, ply.y, ply.z, ply.a)]);
  for (q of PL) {
    // abandoned in the air (n 2): the nose drops and it crashes into whatever it reaches
    if (q.n > 1) {
      q.p = max(q.p - .004 * k, -.7); [q.x, q.z] = loc(q, q.s * k); q.y += (sin(q.p) * q.s - .05) * k;
      if (q.y < max(ht(q.x, q.z), hg(q.x, q.z))) pcrash(q, .5, 1000);
    }
    b = modelMat(q.x, q.y + 1.2, q.z, q.a, q.p, q.r); dl(['av', b, , q.o], ['pp', mul(b, modelMat(0, 0, 3.8, 0, 0, q.q)), , q.o]); }
  for (b of BOOM) {
    fly(b, k, .012); b.a += .1 * k; b.t -= k;
    if (b.y < 0) b.y = 0, b.J *= .7, b.K *= .7, b.U *= -.3;
    dl([b.m, sc(modelMat(b.x, b.y, b.z, b.a, b.a), b.s || 1)]);
  }
  BOOM = BOOM.filter(b => b.t > 0);
  // particles shrink as they die (smoke grows first); tracer lasts a few frames
  for (f of FX) {
    fly(f, k, 0);
    u = (f.t -= k) / f.l; s = f.s * (f.m == 'f0' ? sin(PI * u) : u);
    if (u > 0) dl([f.m, sc(modelMat(f.x, f.y, f.z, f.t * .1), s)]);
  }
  FX = FX.filter(f => f.t > 0);
  if ((TR.t -= k) > 0) dl(['tr', sc(modelMat(TR.x, TR.y, TR.z, TR.a, TR.p), 1, 1, TR.l)]);
  updPolice(k);
  // ===== SOUND (per frame) =====
  // engine by vehicle class (plane: preset 3), silent on foot / game over; tire screech from the drift slip;
  // metal scrape while grinding along a wall (SW is set by updateCar)
  let dr = !foot && !inP && !E, cs = as() / .62;
  if (AC) {
    engine(inP ? 3 : car.c, inP ? P.s / 1.15 : cs, inP ? P.u : held('U'), !foot && !E);
    // tire screech (s: slip 0..1, speed cs): band-passed noise + jittered triangle squeal; a: level, c: fade time
    s = dr && car.c < 2 && abs(angDiff(car.a, car.t)) * 3;
    aK ||= [aLp(0, 2, 4, 2e3), aLp(4, 0, 1, 5e3)];
    a = clamp(s * 2.2 - .3, 0, 1) * min(1, cs * 3);
    a *= a * (3 - 2 * a); // smoothstep
    [t, q] = aK; c = a > aQ ? .04 : .14; // fast in, slow out
    aQ = a;
    aSet(t[1], 1500 + 1800 * s); aSet(t[2], a * .3, c);
    aSet(q[0], 800 + 450 * s + 200 * cs + rnd() * 60, .02); // per-frame jitter = rubber chatter
    aSet(q[2], a * .1, c);
    // wall scrape level t
    t = dr && SW && min(1, as() * 3);
    aR ||= aLp(0, 2, 7, 1500);
    aSet(aR[1], 700 + rnd() * 2200, .02); aSet(aR[2], t * 1.5 * (.6 + rnd() * .4), t ? .03 : .12);
  }
  SW = 0;
  // ===== HUD =====
  t = RT / 1000 | 0;
  hud.setText(fmt(MO)).setScale(1 + .25 * (MU = max(0, MU - .06 * k)));
  tm.setText((t / 60 | 0) + ':' + ('0' + t % 60).slice(-2) + (W ? '  x' + (W + 1) : ''));
  for (t of TT) t.setAlpha(TI);
  DM.setAlpha(TI * .6);
  ring.clear();
  if (RH) ring.lineStyle(8, 0xffffff, .25).strokeCircle(400, 300, 40).lineStyle(8, 0x55ff55).beginPath().arc(400, 300, 40, -H2, RH / 45 * PI - H2).strokePath();
  rtx.setText(RH ? 'REINICIANDO' : '');
  pop.setAlpha((PT -= k) / 20);
  st1.setText('*'.repeat(W)).setVisible(!SEEN || T / 200 & 1);
  drawMap();
  u = 'B1  ';
  hint.setText(E ? 'START  REINICIAR' : DA ? DL + ' $' + (DA | 0) : J || PJ ? '' :
    foot ? ply.pc == 1 ? u + 'PARACAIDAS' : NP || near ? u + (NP || near.e ? 'SUBIR' : 'ROBAR') : TI > 0 ? 'PALANCA MOVER   B1 SUBIR AL AUTO   B2 DISPARAR' : '' :
    inP ? P.g ? (P.s < .03 ? u + 'BAJAR\n' : '') + 'B3 GAS  B2 FRENO  ABAJO SUBIR  ARRIBA BAJAR' : u + 'SALTAR' :
    car.ss > 30 ? u + 'BAJAR' : '');
  ah.setText(inP ? 'ALT ' + (P.y | 0) + 'm\n' + (P.s * 216 | 0) + ' km/h' : '');
  big.setText(E ? E + '\n' + fmt(MO) : '');
  for (c in PRESSED) PRESSED[c] = 0;
  },
  },
});
})();
