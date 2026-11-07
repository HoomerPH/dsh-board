#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
IMG=media/free/images
if [ ! -f media/free/montage.mp4 ]; then
  ffmpeg -y -v error \
    -loop 1 -t 2.6 -i "$IMG/network.jpg" -loop 1 -t 2.6 -i "$IMG/circuit.jpg" \
    -loop 1 -t 2.6 -i "$IMG/flow.jpg" -loop 1 -t 2.6 -i "$IMG/code.jpg" \
    -filter_complex "\
[0:v]scale=2400:1350:force_original_aspect_ratio=increase,crop=2400:1350,zoompan=z='min(1.0+0.0009*on,1.09)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1920x1080:fps=30,eq=brightness=-0.30:contrast=1.12:saturation=0.30,colorbalance=bs=0.38:bm=0.16:gs=0.14:gm=0.06:rs=-0.06,curves=preset=darker,vignette=PI/4.5,noise=alls=4:allf=t+u,trim=0:2.35,setpts=PTS-STARTPTS[v0];\
[1:v]scale=2400:1350:force_original_aspect_ratio=increase,crop=2400:1350,zoompan=z='min(1.0+0.0010*on,1.09)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1920x1080:fps=30,eq=brightness=-0.32:contrast=1.12:saturation=0.28,colorbalance=bs=0.40:bm=0.18:gs=0.15:gm=0.07:rs=-0.06,curves=preset=darker,vignette=PI/4.5,noise=alls=4:allf=t+u,trim=0:2.35,setpts=PTS-STARTPTS[v1];\
[2:v]scale=2400:1350:force_original_aspect_ratio=increase,crop=2400:1350,zoompan=z='min(1.0+0.0008*on,1.09)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1920x1080:fps=30,eq=brightness=-0.34:contrast=1.10:saturation=0.25,colorbalance=bs=0.42:bm=0.18:gs=0.14:gm=0.06:rs=-0.06,curves=preset=darker,vignette=PI/4.5,noise=alls=4:allf=t+u,trim=0:2.35,setpts=PTS-STARTPTS[v2];\
[3:v]scale=2400:1350:force_original_aspect_ratio=increase,crop=2400:1350,zoompan=z='min(1.0+0.0007*on,1.08)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1920x1080:fps=30,eq=brightness=-0.36:contrast=1.12:saturation=0.25,colorbalance=bs=0.44:bm=0.20:gs=0.15:gm=0.07:rs=-0.06,curves=preset=darker,vignette=PI/4,noise=alls=4:allf=t+u,trim=0:2.35,setpts=PTS-STARTPTS[v3];\
[v0][v1]xfade=transition=fade:duration=0.35:offset=2.0[a];[a][v2]xfade=transition=fade:duration=0.35:offset=4.0[b];[b][v3]xfade=transition=fade:duration=0.35:offset=6.0[v]" \
    -map "[v]" -c:v libx264 -pix_fmt yuv420p -crf 19 -preset medium -r 30 -t 8.35 media/free/montage.mp4
fi
if [ ! -f media/free/music-49s.m4a ]; then
  ffmpeg -y -v error -i media/free/music.flac -t 49 -af "afade=t=in:st=0:d=1.5,afade=t=out:st=46.5:d=2.5" -c:a aac -b:a 160k media/free/music-49s.m4a
fi
UI="$(cat media/raw/video-path.txt)"
INTRO=$(ls -t media/anim/page@*.webm | tail -1)
OUTRO=$(ls -t media/anim/page@*.webm | head -1)
FONT=/usr/share/fonts/TTF/DejaVuSans-Bold.ttf
INTRO_LEN=6.5; MONT_LEN=8.35; UI_LEN=29.4; OUTRO_LEN=6.5; XF=0.6; TOTAL=49.0

caption() { local start=$1 end=$2 text=$3; local alpha="if(lt(t,${start}),0,min(1,(t-${start})/0.4))*if(gt(t,${end}),0,min(1,(${end}-t)/0.4))"; printf ",drawtext=fontfile=%s:text='%s':fontcolor=white:fontsize=40:box=1:boxcolor=black@0.58:boxborderw=22:x=(w-text_w)/2:y=h-150:alpha='%s':enable='between(t,${start},${end})'" "$FONT" "$text" "$alpha"; }

CAPS="$(caption 0.15 4.9 'Every ticket becomes an isolated agent run')"
CAPS+="$(caption 4.9 7.3 'Search, filter, jump across the whole board')"
CAPS+="$(caption 7.3 10.2 'Plan with the agent before any code runs')"
CAPS+="$(caption 10.2 15.6 'Review the diff, checks and transcript')"
CAPS+="$(caption 15.6 19.1 'Reject resumes the session · approve merges')"
CAPS+="$(caption 19.1 23.4 'Batch select, filter and route the queue')"
CAPS+="$(caption 23.4 26.1 'Insights, inbox and deep links, built in')"
CAPS+="$(caption 26.1 29.3 'Humans keep the gates')"

FILTER="[0:v]trim=0:${INTRO_LEN},setpts=PTS-STARTPTS,scale=1920:1080,setsar=1,settb=AVTB,fps=30,fade=t=out:st=6.5:d=0.5[intro];"
FILTER+="[1:v]trim=0:${MONT_LEN},setpts=PTS-STARTPTS,scale=1920:1080,setsar=1,settb=AVTB,fps=30,"
FILTER+="drawtext=fontfile=${FONT}:text='AI agents. Real branches. Human gates.':fontcolor=white:fontsize=48:box=1:boxcolor=black@0.45:boxborderw=24:x=(w-text_w)/2:y=h-190:alpha='if(lt(t,0.3),0,min(1,(t-0.3)/0.5))',fade=t=out:st=7.7:d=0.5[mont];"
FILTER+="[2:v]trim=0:${UI_LEN},setpts=PTS-STARTPTS,scale=1920:1080:flags=lanczos,setsar=1,settb=AVTB,fps=30,"
FILTER+="drawtext=fontfile=${FONT}:text='dsh-board':fontcolor=white:fontsize=24:alpha='0.55':x=48:y=40${CAPS},fade=t=in:st=0:d=0.4,fade=t=out:st=29.0:d=0.4[ui];"
FILTER+="[3:v]trim=0:${OUTRO_LEN},setpts=PTS-STARTPTS,scale=1920:1080,setsar=1,settb=AVTB,fps=30,fade=t=in:st=0:d=0.5[outro];"
FILTER+="[intro][mont]xfade=transition=fade:duration=${XF}:offset=5.9[a];"
FILTER+="[a][ui]xfade=transition=fade:duration=${XF}:offset=13.65[b];"
FILTER+="[b][outro]xfade=transition=fade:duration=${XF}:offset=42.45[v];"
FILTER+="[4:a]anull[a]"

ffmpeg -y -v error \
  -i "$INTRO" -i media/free/montage.mp4 -i "$UI" -i "$OUTRO" -i media/free/music-49s.m4a \
  -filter_complex "$FILTER" -map "[v]" -map "[a]" \
  -c:v libx264 -pix_fmt yuv420p -crf 21 -preset slow -r 30 -movflags +faststart \
  -c:a aac -b:a 160k -t ${TOTAL} media/dsh-board-demo-v3.mp4

ffmpeg -y -v error -ss 24 -i media/dsh-board-demo-v3.mp4 -frames:v 1 media/poster-v3.png
echo "v3: $(du -h media/dsh-board-demo-v3.mp4 | cut -f1)"
