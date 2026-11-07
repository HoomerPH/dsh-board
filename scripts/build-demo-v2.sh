#!/usr/bin/env bash
# Builds the polished 1080p demo v2 (animated cards, transitions, captions, music).
set -euo pipefail
cd "$(dirname "$0")/.."
UI="$(cat media/raw/video-path.txt)"
INTRO=$(ls -t media/anim/page@*.webm | tail -1)
OUTRO=$(ls -t media/anim/page@*.webm | head -1)
FONT=/usr/share/fonts/TTF/DejaVuSans-Bold.ttf
UI_LEN=29.4
INTRO_LEN=6.5
OUTRO_LEN=6.5
XF=0.6
TOTAL=41.2

caption() { # start end text
  local start=$1 end=$2 text=$3
  local alpha="if(lt(t,${start}),0,min(1,(t-${start})/0.4))*if(gt(t,${end}),0,min(1,(${end}-t)/0.4))"
  printf ",drawtext=fontfile=%s:text='%s':fontcolor=white:fontsize=40:box=1:boxcolor=black@0.58:boxborderw=22:x=(w-text_w)/2:y=h-150:alpha='%s':enable='between(t,${start},${end})'" "$FONT" "$text" "$alpha"
}

CAPS="$(caption 0.15 4.9 'Every ticket becomes an isolated agent run')"
CAPS+="$(caption 4.9 7.3 'Search, filter, jump across the whole board')"
CAPS+="$(caption 7.3 10.2 'Plan with the agent before any code runs')"
CAPS+="$(caption 10.2 15.6 'Review the diff, checks and transcript')"
CAPS+="$(caption 15.6 19.1 'Reject resumes the session · approve merges')"
CAPS+="$(caption 19.1 23.4 'Batch select, filter and route the queue')"
CAPS+="$(caption 23.4 26.1 'Insights, inbox and deep links, built in')"
CAPS+="$(caption 26.1 29.3 'Humans keep the gates')"

FILTER="[0:v]trim=0:${INTRO_LEN},setpts=PTS-STARTPTS,scale=1920:1080,setsar=1,fade=t=out:st=6.5:d=0.5[intro];"
FILTER+="[1:v]trim=0:${UI_LEN},setpts=PTS-STARTPTS,scale=1920:1080:flags=lanczos,setsar=1,"
FILTER+="drawtext=fontfile=${FONT}:text='dsh-board':fontcolor=white:fontsize=24:alpha='0.55':x=48:y=40${CAPS},fade=t=in:st=0:d=0.5,fade=t=out:st=29.0:d=0.4[ui];"
FILTER+="[2:v]trim=0:${OUTRO_LEN},setpts=PTS-STARTPTS,scale=1920:1080,setsar=1,fade=t=in:st=0:d=0.5[outro];"
FILTER+="[intro][ui]xfade=transition=fade:duration=${XF}:offset=5.9[a];"
# offset for ui->outro is intro + ui - xfade (bash integer math): 7 + 29 - 1 ≈ 35
FILTER+="[a][outro]xfade=transition=fade:duration=${XF}:offset=34.7[v];"
FILTER+="[3:a]atrim=0:42,apad=whole_dur=42,afade=t=out:st=39:d=2[a]"

ffmpeg -y -v error \
  -i "$INTRO" -i "$UI" -i "$OUTRO" -i media/anim/music.wav \
  -filter_complex "$FILTER" -map "[v]" -map "[a]" \
  -c:v libx264 -pix_fmt yuv420p -crf 21 -preset slow -r 30 -movflags +faststart \
  -c:a aac -b:a 160k -t 41.2 media/dsh-board-demo-v2.mp4

ffmpeg -y -v error -ss 17 -i media/dsh-board-demo-v2.mp4 -frames:v 1 media/poster-v2.png
echo "v2: $(du -h media/dsh-board-demo-v2.mp4 | cut -f1)"
