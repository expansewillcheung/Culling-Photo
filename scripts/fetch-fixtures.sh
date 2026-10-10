#!/usr/bin/env bash
# Downloads CC0 RAW samples from raw.pixls.us into tests/fixtures/raw (gitignored).
set -euo pipefail
cd "$(dirname "$0")/../tests/fixtures/raw"
while read -r id path; do
  name=$(basename "$path" | sed 's/[^A-Za-z0-9.]/_/g')
  [ -s "$name" ] && continue
  url="https://raw.pixls.us/getfile.php/$id/nice/$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$path")"
  echo "fetch $name"; curl -sS --retry 3 -o "$name" "$url" &
done <<'LIST'
6402 Canon - EOS R6 Mark II - 3:2.cr3
4691 Canon - EOS R5 - RAW, 1.6 crop, dual-pixel (3:2).CR3
983 Canon - EOS 5D Mark IV - RAW (3:2).CR2
1835 Nikon - D850 - 12bit 12bit compressed (Lossless) (3:2).NEF
6616 Nikon - Z 8 - 8bit 8bit compressed (3:2).NEF
2414 Sony - ILCE-7M3 - 14bit 14bit compressed (3:2).ARW
4465 Sony - ILCE-1 - 14bit 14bit compressed (3:2).ARW
2783 Fujifilm - X-T3 - 14bit 14bit compressed (3:2).RAF
6122 Fujifilm - X-T5 - 14bit 14bit compressed (3:2).RAF
1993 Olympus - E-M1MarkII - 16bit (4:3).ORF
4096 Panasonic - DC-S5 - 3:2.RW2
2469 Pentax - K-1 - 14bit (3:2).PEF
4264 Apple - iPhone 12 Pro - 8bit (4:3).DNG
3345 Pentax - K-1 Mark II - 14bit (3:2).DNG
837 Samsung - NX1 - 14bit (3:2).srw
LIST
wait
