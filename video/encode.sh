#!/usr/bin/env bash
# Mux composed frames + soundtrack into the deliverables.
set -euo pipefail
cd "$(dirname "$0")/out"
FPS=$(python3 -c "import json; print(json.load(open('timeline.json'))['fps'])")
ffmpeg -v error -y -framerate "$FPS" -i composed/%05d.jpg -i audio_mix.wav \
  -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -movflags +faststart -c:a aac -b:a 192k -shortest ../trompe_demo.mp4
ffmpeg -v error -y -framerate "$FPS" -i composed/%05d.jpg -i audio_sfx.wav \
  -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -movflags +faststart -c:a aac -b:a 192k -shortest ../trompe_demo_sfx_only.mp4
ffmpeg -v error -y -i ../trompe_demo.mp4 -c:v libx264 -preset slow -crf 27 -pix_fmt yuv420p -movflags +faststart \
  -c:a aac -b:a 128k ../trompe_demo_web.mp4                                     # small enough to keep in the repo
ffmpeg -v error -y -ss 3.4 -i ../trompe_demo.mp4 -frames:v 1 -q:v 2 ../trompe_demo_poster.jpg
ls -la ../trompe_demo*.mp4 ../trompe_demo_poster.jpg
