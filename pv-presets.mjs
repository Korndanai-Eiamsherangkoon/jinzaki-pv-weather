// PV Simulation Studio weather presets (owner 2026-11-21: "a sunlight preset for every tambon in Thailand and every
// Bangkok khet; keep them in a GitHub repo"). Lives in the PUBLIC repo jinzaki-pv-weather (data only, no secrets):
// PVGIS 5.3 TMY for a point inside every ตำบล (OSM admin_level 8) and every เขต of Bangkok (admin_level 6 in TH-10).
// Free: Geofabrik + osmium for the places, PVGIS (no key), GitHub for the files, jsDelivr CDN for the browser.
// Files are compact (`jz: 1`, ints, ~35 KB instead of ~190 KB raw JSON); jinzaki-office src/studio/client.js turns them
// back into the PVGIS answer before the engine reads it. index.json lists every point (key = the same key the pv-weather
// edge function uses), and jinzaki-office tools/pv-presets-index.mjs copies it into the pv_weather table.
//   ./extract.sh                                   → /tmp/admin.geojsonseq (boundaries only)
//   node pv-presets.mjs                            → download what is missing into preset/ + index.json (this repo)
//   PRESET_PROVINCES="TH-10,TH-21" PRESET_LIMIT=20 PVGIS_URL=… (tests) · PRESET_MINUTES=300 stop time · PRESET_CONC=4
//   PRESET_DIR=. (where preset/ and index.json go)
import { mkdirSync, writeFileSync, readFileSync, existsSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const OUT = process.env.PRESET_DIR || '.';
const ONLY = (process.env.PRESET_PROVINCES || '').split(',').map((s) => s.trim()).filter(Boolean);
const LIMIT = Number(process.env.PRESET_LIMIT) || Infinity;
const MINUTES = Number(process.env.PRESET_MINUTES) || 300;
const CONC = Math.max(1, Math.min(8, Number(process.env.PRESET_CONC) || 4));
const SRC = process.env.PRESET_GEOJSONSEQ || '/tmp/admin.geojsonseq';
const PVGIS = process.env.PVGIS_URL || 'https://re.jrc.ec.europa.eu/api/v5_3/';
const DATA_VERSION = '1', VARS = 'G(h),Gb(n),Gd(h),T2m,WS10m'; // = supabase/functions/pv-weather (pvgis_tmy, no year range)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();

// same key as the edge function: sha256(provider|dataset|lat|lon|year|variables|version), first 32 hex
const keyOf = (lat, lon) => createHash('sha256').update(['pvgis_tmy', 'tmy', lat.toFixed(3), lon.toFixed(3), '', VARS, DATA_VERSION].join('|')).digest('hex').slice(0, 32);

// ---------- places: tambon + Bangkok khet, each with a point inside it ----------
const rings = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []);
const bboxOf = (polys) => { let b = [180, 90, -180, -90]; for (const poly of polys) for (const [x, y] of poly[0]) { b = [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)]; } return b; };
const inRing = (x, y, r) => { let inside = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, yi] = r[i], [xj, yj] = r[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside; } return inside; };
const inPolys = (x, y, polys) => polys.some((poly) => inRing(x, y, poly[0]) && !poly.slice(1).some((h) => inRing(x, y, h)));
const inArea = (x, y, a) => x >= a.bbox[0] && x <= a.bbox[2] && y >= a.bbox[1] && y <= a.bbox[3] && inPolys(x, y, a.polys);
const ringArea = (r) => { let s = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += r[j][0] * r[i][1] - r[i][0] * r[j][1]; return s / 2; };
// area-weighted centre of the biggest part; if that falls outside (a crescent-shaped tambon), the inside grid point nearest to it
function inside(polys) {
  const big = polys.reduce((a, p) => (Math.abs(ringArea(p[0])) > Math.abs(ringArea(a[0])) ? p : a), polys[0]);
  const r = big[0]; let A = 0, cx = 0, cy = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const f = r[j][0] * r[i][1] - r[i][0] * r[j][1]; A += f; cx += (r[j][0] + r[i][0]) * f; cy += (r[j][1] + r[i][1]) * f; }
  if (A) { cx /= 3 * A; cy /= 3 * A; } else { cx = r[0][0]; cy = r[0][1]; }
  if (inPolys(cx, cy, [big])) return [cx, cy];
  const b = bboxOf([big]); let best = null, bd = Infinity;
  for (let i = 1; i < 40; i++) for (let j = 1; j < 40; j++) {
    const x = b[0] + (b[2] - b[0]) * i / 40, y = b[1] + (b[3] - b[1]) * j / 40;
    if (!inPolys(x, y, [big])) continue; const d = (x - cx) ** 2 + (y - cy) ** 2; if (d < bd) { bd = d; best = [x, y]; }
  }
  return best || r[0];
}
const strip = (s, re) => String(s || '').trim().replace(re, '').trim();

const provs = [], dists = [], tambons = [];
for await (const line of createInterface({ input: createReadStream(SRC, 'utf8'), crlfDelay: Infinity })) {
  const l = line.replace(/^\x1e/, '').trim(); if (!l) continue;
  const f = JSON.parse(l); const t = f.properties || {}; if (!f.geometry || t.boundary !== 'administrative') continue;
  const polys = rings(f.geometry); if (!polys.length) continue;
  const a = { polys, bbox: bboxOf(polys), th: (t['name:th'] || t.name || '').trim(), en: (t['name:en'] || '').trim() || null, osm: String(f.id || '') };
  if (t.admin_level === '4' && /^TH-/.test(t['ISO3166-2'] || '')) provs.push({ ...a, iso: t['ISO3166-2'], th: strip(a.th, /^จังหวัด\s*/) });
  else if (t.admin_level === '6') dists.push({ ...a, th: strip(a.th, /^(อำเภอ|เขต|กิ่งอำเภอ)\s*/), khet: /^เขต/.test(a.th) });
  else if (t.admin_level === '8') tambons.push({ ...a, th: strip(a.th, /^(ตำบล|แขวง)\s*/) });
}
console.log('read', SRC, '· provinces', provs.length, '· districts', dists.length, '· tambon/khwaeng', tambons.length, '·', Math.round((Date.now() - t0) / 1000) + 's');
if (!ONLY.length && provs.length < 70) throw new Error('Only ' + provs.length + ' provinces in the extract; stopping');
const provOf = (x, y) => provs.find((p) => inArea(x, y, p));
const points = [];
for (const d of dists) {        // Bangkok: one preset per เขต (khwaeng are left out: the owner asked for khet)
  const [x, y] = inside(d.polys); const p = provOf(x, y);
  if (p?.iso === 'TH-10') points.push({ level: 'khet', name_th: d.th, name_en: d.en, district_th: d.th, province_th: p.th, iso: p.iso, osm: d.osm, lon: x, lat: y });
}
for (const t of tambons) {
  const [x, y] = inside(t.polys); const p = provOf(x, y);
  if (!p || p.iso === 'TH-10') continue;                       // outside Thailand, or a Bangkok khwaeng
  const d = dists.find((a) => inArea(x, y, a));
  points.push({ level: 'tambon', name_th: t.th, name_en: t.en, district_th: d?.th || null, province_th: p.th, iso: p.iso, osm: t.osm, lon: x, lat: y });
}
let todo = points.filter((p) => !ONLY.length || ONLY.includes(p.iso)).sort((a, b) => a.iso.localeCompare(b.iso) || String(a.district_th).localeCompare(String(b.district_th), 'th') || a.name_th.localeCompare(b.name_th, 'th'));
for (const p of todo) { p.lat = Math.round(p.lat * 1000) / 1000; p.lon = Math.round(p.lon * 1000) / 1000; p.key = keyOf(p.lat, p.lon); }
console.log('points:', todo.length, '(khet', todo.filter((p) => p.level === 'khet').length + ')');

const placeMeta = (p) => ({ level: p.level, name_th: p.name_th, name_en: p.name_en, district_th: p.district_th, province_th: p.province_th, iso: p.iso, osm: p.osm });
// two places on the same 3-decimal point share one file: every name goes on it
const byKey = new Map();
for (const p of todo) { const e = byKey.get(p.key); if (e) e.places.push(p); else byKey.set(p.key, { key: p.key, lat: p.lat, lon: p.lon, places: [p] }); }
let jobs = [...byKey.values()];

// ---------- what is already saved (index.json + its files) ----------
mkdirSync(OUT + '/preset', { recursive: true });
const INDEX = OUT + '/index.json';
const index = existsSync(INDEX) ? JSON.parse(readFileSync(INDEX, 'utf8')) : { about: '', points: {} };
index.about = 'PVGIS 5.3 TMY (EU JRC, free) for a point inside every tambon of Thailand and every Bangkok khet. Places © OpenStreetMap contributors (ODbL). Files: preset/<key>.json.gz, compact format jz:1. Made by tools of Jinzaki Office PV Simulation Studio.';
const have = new Set(Object.keys(index.points).filter((k) => existsSync(`${OUT}/preset/${k}.json.gz`)));
for (const j of jobs) if (have.has(j.key)) index.points[j.key].places = j.places.map((p) => placeMeta(p));   // names may change on the map
jobs = jobs.filter((j) => !have.has(j.key));
console.log('already saved:', have.size, '· to download:', jobs.length);
jobs = jobs.slice(0, LIMIT);

// ---------- PVGIS TMY → compact file ----------
// same as expand() in src/studio/client.js
function timesOf(years, minute) {
  const out = [], dim = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31], p = (n) => String(n).padStart(2, '0');
  for (let m = 0; m < 12; m++) for (let d = 1; d <= dim[m]; d++) for (let h = 0; h < 24; h++) out.push(`${years[m]}${p(m + 1)}${p(d)}:${p(h)}${minute}`);
  return out;
}
function compact(d) {
  const rows = d?.outputs?.tmy_hourly || [];
  if (rows.length < 8760) throw new Error('TMY has ' + rows.length + ' rows');
  const col = (k, m = 1) => rows.map((r) => Math.round(Number(r[k]) * m));
  const tcol = 'time(UTC)' in rows[0] ? 'time(UTC)' : 'time';
  const time = rows.map((r) => r[tcol]);
  // the times follow a fixed pattern (each month from its TMY year, every hour on the same minute): keep only the pattern
  const years = Array.from({ length: 12 }, (_, m) => time.find((s) => Number(s.slice(4, 6)) === m + 1)?.slice(0, 4));
  const minute = time[0].slice(11, 13);
  const rebuilt = timesOf(years, minute);
  const same = rebuilt.length === time.length && rebuilt.every((s, i) => s === time[i]);
  return { jz: 1, provider: 'pvgis_tmy', ...(same ? { time_pattern: { years, minute } } : { time }), inputs: { location: d.inputs?.location, meteo_data: d.inputs?.meteo_data },
    months_selected: d.outputs?.months_selected, scale: { 'T2m': 10, 'WS10m': 10 },
    cols: { 'G(h)': col('G(h)'), 'Gb(n)': col('Gb(n)'), 'Gd(h)': col('Gd(h)'), 'T2m': col('T2m', 10), 'WS10m': col('WS10m', 10) } };
}
const monthly = (c, d) => { const time = (d.outputs.tmy_hourly).map((r) => r['time(UTC)'] || r.time); const g = Array(12).fill(0), tt = Array(12).fill(0), n = Array(12).fill(0);
  time.forEach((s, i) => { const m = Number(s.slice(4, 6)) - 1; g[m] += Math.max(0, c.cols['G(h)'][i]); tt[m] += c.cols['T2m'][i] / 10; n[m]++; });
  return { ghi_month: g.map((v) => Math.round(v / 100) / 10), temp_month: tt.map((v, m) => Math.round(10 * v / (n[m] || 1)) / 10), ghi_year: Math.round(g.reduce((a, b) => a + b, 0) / 1000) }; };

let done = 0, failed = 0, bytes = 0;
const stopAt = t0 + MINUTES * 60000;
async function one(j) {
  const url = `${PVGIS}tmy?lat=${j.lat}&lon=${j.lon}&usehorizon=0&outputformat=json`;
  let d = null, err = '';
  for (let i = 0; i < 4 && !d; i++) {
    try { const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'JinzakiOffice-PVStudio/1.0' } }); const t = await r.text();
      if (r.ok) d = JSON.parse(t); else { err = r.status + ' ' + t.slice(0, 200); if (r.status === 400) break; await sleep(3000 * 2 ** i); } }
    catch (e) { err = String(e); await sleep(3000 * 2 ** i); }
  }
  if (!d) { failed++; console.log('  fail', j.places[0].province_th, j.places[0].name_th, j.lat, j.lon, err); return; }
  const c = compact(d); const gz = gzipSync(JSON.stringify(c), { level: 9 }); bytes += gz.length;
  const path = `preset/${j.key}.json.gz`;
  const md = d.inputs?.meteo_data || {};
  const meta = { format: 'jz1', radiation_db: md.radiation_db, meteo_db: md.meteo_db, year_min: md.year_min, year_max: md.year_max, elevation: d.inputs?.location?.elevation,
    months_selected: d.outputs?.months_selected, rows: c.cols['G(h)'].length, ...monthly(c, d), places: j.places.map(placeMeta) };
  writeFileSync(`${OUT}/${path}`, gz);
  index.points[j.key] = { lat: j.lat, lon: j.lon, bytes: gz.length, request_url: url, ...meta };
  done++;
}
const saveIndex = () => writeFileSync(INDEX, JSON.stringify(index));
let next = 0;
await Promise.all(Array.from({ length: CONC }, async () => {
  while (next < jobs.length && Date.now() < stopAt) {
    const j = jobs[next++]; await one(j);
    if ((done + failed) % 100 === 0) console.log(`  ${done + failed}/${jobs.length} · ${Math.round(bytes / 1048576)} MB · ${Math.round((Date.now() - t0) / 60000)} min`);
    if ((done + failed) % 200 === 0) saveIndex();
    await sleep(150);
  }
}));
saveIndex();
console.log(`done ${done}, failed ${failed}, left ${jobs.length - done - failed}, ${Math.round(bytes / 1048576)} MB, avg ${done ? Math.round(bytes / done / 1024) : 0} KB, ${Math.round((Date.now() - t0) / 60000)} min`);
if (jobs.length - done - failed > 0) console.log('Stopped at the time limit: run the workflow again to continue (saved points are skipped).');
if (failed > Math.max(10, jobs.length * 0.05)) process.exitCode = 1;
