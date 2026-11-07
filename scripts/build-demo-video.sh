#!/usr/bin/env bash
# Cuts media/dsh-board-demo.mp4 + .gif + poster.png from the raw recording
# produced by scripts/demo-video.mjs.
set -euo pipefail
cd "$(dirname "$0")/.."
RAW=media/raw
UI="$RAW/$(basename "$(cat "$RAW/video-path.txt")")"
FONT=/usr/share/fonts/TTF/DejaVuSans-Bold.ttf
UI_LEN=29.4

caption() { # index, start, end, text
  local i=$1 start=$2 end=$3 text=$4
  [ "$i" -gt 0 ] && printf ","
  printf "drawtext=fontfile=%s:text='%s':fontcolor=white:fontsize=31:box=1:boxcolor=black@0.62:boxborderw=16:x=(w-text_w)/2:y=h-116:enable='between(t,%s,%s)'" \
    "$FONT" "$text" "$start" "$end"
}

FILTER="[0:v]scale=1280:720,format=yuv420p,fade=t=in:st=0:d=0.5,fade=t=out:st=3.5:d=0.5[t];"
FILTER+="[1:v]trim=0:${UI_LEN},setpts=PTS-STARTPTS,scale=1280:720,format=yuv420p,"
FILTER+="$(caption 0 0.15 4.9 'Every ticket becomes an isolated agent run')"
FILTER+="$(caption 1 4.9 7.3 'Search, filter and jump across the whole board')"
FILTER+="$(caption 2 7.3 10.2 'Plan with the agent before any code runs')"
FILTER+="$(caption 3 10.2 15.6 'Review the diff, checks and worker transcript')"
FILTER+="$(caption 4 15.6 19.1 'Reject resumes the session · approve merges')"
FILTER+="$(caption 5 19.1 23.4 'Batch select, filter and route the queue')"
FILTER+="$(caption 6 23.4 26.1 'Insights, inbox and deep links, built in')"
FILTER+="$(caption 7 26.1 29.3 'Humans keep the gates — agents do the work')"
FILTER+=",fade=t=in:st=0:d=0.5[u];"
FILTER+="[2:v]scale=1280:720,format=yuv420p,fade=t=in:st=0:d=0.5,fade=t=out:st=4.5:d=0.5[o];"
FILTER+="[t][u][o]concat=n=3:v=1:a=0[v]"

ffmpeg -y -v error -loop 1 -t 4 -i "$RAW/title.png" -i "$UI" -loop 1 -t 5 -i "$RAW/outro.png" \
  -filter_complex "$FILTER" -map "[v]" \
  -c:v libx264 -pix_fmt yuv420p -crf 20 -preset slow -movflags +faststart \
  media/dsh-board-demo.mp4

ffmpeg -y -v error -ss 10.5 -t 12 -i "$UI" -vf "fps=12,scale=640:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse" \
  media/dsh-board-demo.gif

ffmpeg -y -v error -ss 15.5 -i "$UI" -frames:v 1 media/poster.png
echo "mp4: $(du -h media/dsh-board-demo.mp4 | cut -f1)  gif: $(du -h media/dsh-board-demo.gif | cut -f1)"
