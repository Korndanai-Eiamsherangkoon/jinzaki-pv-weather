# jinzaki-pv-weather

Typical-year solar weather (PVGIS 5.3 TMY) for a point inside every tambon (ตำบล) of Thailand and every khet (เขต) of
Bangkok, ready for PV Simulation Studio in Jinzaki Office.

- `index.json`: every point (key, lat, lon, tambon / district / province names, monthly GHI and air temperature).
- `preset/<key>.json.gz`: the hourly year, compact (`jz: 1`: whole numbers, temperature and wind ×10, times as a pattern).
- Made by `pv-presets.mjs` (Actions › Weather presets). Points already here are skipped on the next run.

Sources: PVGIS © European Union, JRC (free, see https://joint-research-centre.ec.europa.eu/pvgis). Places and boundaries
© OpenStreetMap contributors (ODbL).
