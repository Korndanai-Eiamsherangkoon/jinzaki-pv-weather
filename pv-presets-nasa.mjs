// NASA POWER hourly presets (owner 2026-11-21: "also fetch NASA POWER"): one file per NASA grid cell that holds at least one
// tambon / Bangkok khet, for the years in PRESET_YEARS (default 2023,2024,2025). NASA's grid is coarse (0.5° × 0.625°, ~55 × 68 km),
// so Thailand needs only a few hundred cells. Same request and key as the pv-weather edge function (provider nasa_power,
// historical, 3-decimal point, year, variables, data version 1), compact file (`jz: 1`, nasa: true, whole numbers ×10).
// Adds its points to index.json next to the PVGIS ones (provider / year / variables are written on each NASA point).
//   PRESET_CSV (tambon list) · PRESET_DIR · PRESET_YEARS=2023,2024,2025 · PRESET_LIMIT · PRESET_MINUTES · PRESET_CONC (default 2) · NASA_URL (tests)
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const OUT = process.env.PRESET_DIR || '.';
const SRC = process.env.PRESET_CSV || '/tmp/tambon.csv';
const YEARS = (process.env.PRESET_YEARS || '2023,2024,2025').split(',').map(Number).filter(Boolean);
const LIMIT = Number(process.env.PRESET_LIMIT) || Infinity;
const MINUTES = Number(process.env.PRESET_MINUTES) || 300;
const CONC = Math.max(1, Math.min(4, Number(process.env.PRESET_CONC) || 2));
const NASA = process.env.NASA_URL || 'https://power.larc.nasa.gov/api/temporal/hourly/point';
const VARS = 'ALLSKY_SFC_SW_DWN,ALLSKY_SFC_SW_DNI,ALLSKY_SFC_SW_DIFF,T2M,WS10M';   // = supabase/functions/pv-weather NASA_VARS
const DATA_VERSION = '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const keyOf = (lat, lon, year) => createHash('sha256').update(['nasa_power', 'historical', lat.toFixed(3), lon.toFixed(3), year, VARS, DATA_VERSION].join('|')).digest('hex').slice(0, 32);

// ---------- cells ----------
const [h, ...rows] = readFileSync(SRC, 'utf8').trim().split(/\r?\n/); const cols = h.split(',');
const cells = new Map();
for (const l of rows) {
  const v = l.split(','); const r = Object.fromEntries(cols.map((x, i) => [x, v[i]]));
  const la = Number(r.lat), lo = Number(r.lon); if (!Number.isFinite(la) || !Number.isFinite(lo)) continue;
  const lat = Math.round(la / 0.5) * 0.5, lon = Math.round((lo + 180) / 0.625) * 0.625 - 180;
  const k = lat.toFixed(3) + ',' + lon.toFixed(3);
  const c = cells.get(k) || { lat: Math.round(lat * 1000) / 1000, lon: Math.round(lon * 1000) / 1000, n: 0 }; c.n++; cells.set(k, c);
}
console.log('NASA cells with a tambon:', cells.size, '· years', YEARS.join(','));

mkdirSync(OUT + '/preset', { recursive: true });
const INDEX = OUT + '/index.json';
const index = existsSync(INDEX) ? JSON.parse(readFileSync(INDEX, 'utf8')) : { about: '', points: {} };
let jobs = [];
for (const c of cells.values()) for (const year of YEARS) { const key = keyOf(c.lat, c.lon, year); if (!(index.points[key] && existsSync(`${OUT}/preset/${key}.json.gz`))) jobs.push({ ...c, year, key }); }
console.log('to download:', jobs.length);
jobs = jobs.slice(0, LIMIT);

const pad = (n) => String(n).padStart(2, '0');
function compact(d, year) {
  const par = d?.properties?.parameter; const first = par?.ALLSKY_SFC_SW_DWN;
  if (!first) throw new Error('no ALLSKY_SFC_SW_DWN');
  const times = Object.keys(first);
  if (times.length < 8760) throw new Error('only ' + times.length + ' hours');
  const out = { jz: 1, nasa: true, provider: 'nasa_power', start: times[0], scale: 10, geometry: d.geometry, header: { sources: d.header?.sources, title: d.header?.title }, cols: {} };
  for (const k of VARS.split(',')) { const s = par[k]; if (!s) throw new Error('no ' + k); out.cols[k] = times.map((t) => Math.round(Number(s[t]) * 10)); }
  // a missing hour must be a missing hour: every key in time order, one per hour (checked here, expanded in client.js)
  for (let i = 1; i < times.length; i += 997) if (Number(times[i]) <= Number(times[i - 1])) throw new Error('times not in order');
  const ghi = out.cols.ALLSKY_SFC_SW_DWN; let sum = 0; times.forEach((t, i) => { if (t.startsWith(String(year)) && ghi[i] > 0) sum += ghi[i] / 10; });
  return { out, ghi_year: Math.round(sum / 1000), rows: times.length };
}
let done = 0, failed = 0, bytes = 0;
const stopAt = t0 + MINUTES * 60000;
async function one(j) {
  const q = new URLSearchParams({ parameters: VARS, community: 'RE', longitude: String(j.lon), latitude: String(j.lat), start: `${j.year - 1}1231`, end: `${j.year}1231`, 'time-standard': 'UTC', format: 'JSON' });
  const url = NASA + '?' + q.toString();
  let d = null, err = '';
  for (let i = 0; i < 5 && !d; i++) {
    try { const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'JinzakiOffice-PVStudio/1.0' } }); const t = await r.text();
      if (r.ok) d = JSON.parse(t); else { err = r.status + ' ' + t.slice(0, 200); if (r.status === 400 || r.status === 422) break; await sleep(5000 * 2 ** i); } }
    catch (e) { err = String(e); await sleep(5000 * 2 ** i); }
  }
  if (!d) { failed++; console.log('  fail', j.lat, j.lon, j.year, err); return; }
  let c; try { c = compact(d, j.year); } catch (e) { failed++; console.log('  bad data', j.lat, j.lon, j.year, e.message); return; }
  const gz = gzipSync(JSON.stringify(c.out), { level: 9 }); bytes += gz.length;
  writeFileSync(`${OUT}/preset/${j.key}.json.gz`, gz);
  index.points[j.key] = { lat: j.lat, lon: j.lon, bytes: gz.length, request_url: url, provider: 'nasa_power', dataset: 'historical', year: j.year, variables: VARS,
    format: 'jz1', radiation_db: 'NASA POWER', elevation: d.geometry?.coordinates?.[2], rows: c.rows, ghi_year: c.ghi_year, tambons_in_cell: j.n };
  done++;
}
let next = 0;
await Promise.all(Array.from({ length: CONC }, async () => {
  while (next < jobs.length && Date.now() < stopAt) {
    const j = jobs[next++]; await one(j);
    if ((done + failed) % 25 === 0) console.log(`  ${done + failed}/${jobs.length} · ${Math.round(bytes / 1048576)} MB · ${Math.round((Date.now() - t0) / 60000)} min`);
    if ((done + failed) % 50 === 0) writeFileSync(INDEX, JSON.stringify(index));
    await sleep(1500);
  }
}));
writeFileSync(INDEX, JSON.stringify(index));
console.log(`done ${done}, failed ${failed}, left ${jobs.length - done - failed}, ${Math.round(bytes / 1048576)} MB, avg ${done ? Math.round(bytes / done / 1024) : 0} KB, ${Math.round((Date.now() - t0) / 60000)} min`);
if (jobs.length - done - failed > 0) console.log('Stopped at the time limit: run again to continue (saved points are skipped).');
if (failed > Math.max(5, jobs.length * 0.05)) process.exitCode = 1;
