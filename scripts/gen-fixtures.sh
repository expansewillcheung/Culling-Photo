#!/usr/bin/env bash
# Generates non-RAW fixtures (JPEG/PNG/WebP/AVIF/TIFF/HEIC/JXL, RAW+JPEG pair, rotated JPEG)
# and exiftool ground-truth JSON into tests/fixtures/gen. Requires exiftool, imagemagick,
# heif-enc (libheif-examples), cjxl (libjxl-tools), ffmpeg.
set -euo pipefail
cd "$(dirname "$0")/../tests/fixtures"
mkdir -p gen && cd gen
SRC=../raw/Nikon___Z_8___8bit_8bit_compressed__3_2_.NEF
exiftool -b -JpgFromRaw "$SRC" > base_full.jpg
convert base_full.jpg -resize 4000x4000 -quality 88 photo.jpg
exiftool -q -overwrite_original -TagsFromFile "$SRC" -exif:all --makernotes -Orientation=1 -n photo.jpg
cp photo.jpg rotated6.jpg && exiftool -q -overwrite_original -Orientation=6 -n rotated6.jpg
convert photo.jpg -resize 2000x2000 photo.png
convert photo.jpg -quality 85 photo.webp
convert photo.jpg -resize 2000x2000 -compress lzw photo.tif
heif-enc -A -q 60 -o photo.avif photo.png
heif-enc -q 70 -o photo.heic photo.jpg && exiftool -q -overwrite_original -TagsFromFile photo.jpg -exif:all photo.heic || true
cjxl -q 85 photo.jpg photo.jxl >/dev/null 2>&1
# RAW+JPEG pair (same basename, different ext)
cp ../raw/Sony___ILCE_7M3___14bit_14bit_compressed__3_2_.ARW DSC01234.ARW
exiftool -b -PreviewImage DSC01234.ARW > DSC01234.JPG
exiftool -q -overwrite_original -TagsFromFile DSC01234.ARW -exif:all --makernotes DSC01234.JPG
rm -f base_full.jpg
exiftool -j -n -G1 -a -ee ../raw/*.* ./* > ../groundtruth.json 2>/dev/null || true
ls -la
