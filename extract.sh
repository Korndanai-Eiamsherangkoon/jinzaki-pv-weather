#!/usr/bin/env bash
# Thailand from OpenStreetMap (Geofabrik daily extract, ODbL) → only the administrative boundaries (province 4, district 6,
# tambon 8) → GeoJSON lines for pv-presets.mjs. Needs osmium-tool. A few minutes on GitHub.
set -euo pipefail
cd /tmp
curl -sSfL --retry 3 -o th.osm.pbf https://download.geofabrik.de/asia/thailand-latest.osm.pbf
osmium tags-filter th.osm.pbf r/boundary=administrative -o admin.osm.pbf --overwrite
osmium export admin.osm.pbf -f geojsonseq -u type_id -a type,id --geometry-types=polygon -o admin.geojsonseq --overwrite
wc -l admin.geojsonseq
