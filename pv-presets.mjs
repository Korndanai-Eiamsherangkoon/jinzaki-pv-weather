// PV Simulation Studio weather presets (owner 2026-11-21: "a sunlight preset for every tambon in Thailand and every
// Bangkok khet; keep them in a GitHub repo"). Lives in the PUBLIC repo jinzaki-pv-weather (data only, no secrets):
// PVGIS 5.3 TMY for the point of every ตำบล (OCHA COD-AB list with lat/lon, 7,425) and every เขต of Bangkok.
// Free: the tambon list from GitHub (prasertcbs/thailand_gis), PVGIS (no key), GitHub for the files and the browser link.
// Files are compact (`jz: 1`, ints, ~35 KB instead of ~190 KB raw JSON); jinzaki-office src/studio/client.js turns them
// back into the PVGIS answer before the engine reads it. index.json lists every point (key = the same key the pv-weather
// edge function uses), and jinzaki-office tools/pv-presets-index.mjs copies it into the pv_weather table.
//   the workflow downloads the tambon list to /tmp/tambon.csv (PRESET_CSV)
//   node pv-presets.mjs                            → download what is missing into preset/ + index.json (this repo)
//   PRESET_PROVINCES="TH-10,TH-21" PRESET_LIMIT=20 PVGIS_URL=… (tests) · PRESET_MINUTES=300 stop time · PRESET_CONC=4
//   PRESET_DIR=. (where preset/ and index.json go)
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const OUT = process.env.PRESET_DIR || '.';
const ONLY = (process.env.PRESET_PROVINCES || '').split(',').map((s) => s.trim()).filter(Boolean);
const LIMIT = Number(process.env.PRESET_LIMIT) || Infinity;
const MINUTES = Number(process.env.PRESET_MINUTES) || 300;
const CONC = Math.max(1, Math.min(8, Number(process.env.PRESET_CONC) || 4));
const SRC = process.env.PRESET_CSV || '/tmp/tambon.csv';
const PVGIS = process.env.PVGIS_URL || 'https://re.jrc.ec.europa.eu/api/v5_3/';
const DATA_VERSION = '1', VARS = 'G(h),Gb(n),Gd(h),T2m,WS10m'; // = supabase/functions/pv-weather (pvgis_tmy, no year range)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();

// same key as the edge function: sha256(provider|dataset|lat|lon|year|variables|version), first 32 hex
const keyOf = (lat, lon) => createHash('sha256').update(['pvgis_tmy', 'tmy', lat.toFixed(3), lon.toFixed(3), '', VARS, DATA_VERSION].join('|')).digest('hex').slice(0, 32);

// ---------- places: every tambon (7,425, OCHA COD-AB via prasertcbs/thailand_gis, one point per tambon) + Bangkok khet ----------
// OpenStreetMap was tried first (2026-11-21): only 854 tambon boundaries are mapped there, so the official list is used.
const csv = (t) => { const [h, ...rows] = t.trim().split(/\r?\n/); const k = h.split(','); return rows.map((l) => { const v = l.split(','); return Object.fromEntries(k.map((x, i) => [x, v[i]])); }); };
const all = csv(readFileSync(SRC, 'utf8')).filter((r) => r.ADM3_PCODE && Number.isFinite(Number(r.lat)) && Number.isFinite(Number(r.lon)));
console.log('read', SRC, '· tambon/khwaeng', all.length);
if (!ONLY.length && all.length < 7000) throw new Error('Only ' + all.length + ' tambons in the list; stopping');
const iso = (pc) => 'TH-' + pc.slice(2, 4);
const clean = (s, re) => String(s || '').trim().replace(re, '').trim();
const points = [];
const khet = new Map();      // Bangkok: one preset per เขต = the middle of its khwaeng points (khwaeng left out: the owner asked for khet)
for (const r of all) {
  if (r.ADM1_PCODE === 'TH10') { const k = khet.get(r.ADM2_PCODE) || { r, lat: 0, lon: 0, n: 0 }; k.lat += Number(r.lat); k.lon += Number(r.lon); k.n++; khet.set(r.ADM2_PCODE, k); continue; }
  points.push({ level: 'tambon', name_th: clean(r.ADM3_TH, /^(ตำบล|แขวง)\s*/), name_en: r.ADM3_EN, district_th: clean(r.ADM2_TH, /^(อำเภอ|เขต)\s*/), province_th: clean(r.ADM1_TH, /^จังหวัด\s*/), iso: iso(r.ADM1_PCODE), osm: r.ADM3_PCODE, lat: Number(r.lat), lon: Number(r.lon) });
}
for (const [pc, k] of khet) points.push({ level: 'khet', name_th: clean(k.r.ADM2_TH, /^เขต\s*/), name_en: k.r.ADM2_EN, district_th: clean(k.r.ADM2_TH, /^เขต\s*/), province_th: 'กรุงเทพมหานคร', iso: 'TH-10', osm: pc, lat: k.lat / k.n, lon: k.lon / k.n });
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
index.about = 'PVGIS 5.3 TMY (EU JRC, free) for a point inside every tambon of Thailand and every Bangkok khet. Tambon list: OCHA COD-AB Thailand (HDX, CC BY-IGO) via github.com/prasertcbs/thailand_gis. Files: preset/<key>.json.gz, compact format jz:1. Made by tools of Jinzaki Office PV Simulation Studio.';
const have = new Set(Object.keys(index.points).filter((k) => existsSync(`${OUT}/preset/${k}.json.gz`)));
for (const j of jobs) if (have.has(j.key)) index.points[j.key].places = j.places.map((p) => placeMeta(p));   // names may change on the map
jobs = jobs.filter((j) => !have.has(j.key));
if (!ONLY.length) for (const k of Object.keys(index.points)) if (!index.points[k].provider && !byKey.has(k)) { delete index.points[k]; try { unlinkSync(`${OUT}/preset/${k}.json.gz`); } catch {} console.log('  removed old point', k); }
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
