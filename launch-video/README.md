# StykAnimate — Make your next move

A 32-second launch film built with Remotion. 1920 × 1080, 60 fps, H.264 video and stereo AAC audio. Real editor captures, original vector character animation, oversized typography, dimensional screen mockups, and an original electronic score at 150 BPM.

## Watch and edit

- Master: `out/StykAnimate-launch-1080p.mp4`
- Lightweight preview: `out/StykAnimate-launch-preview.mp4`
- Scene review images: `out/review/`
- Start the editable Remotion Studio: `npm run dev`
- Studio composition: `http://localhost:3123/StykAnimate-Launch`

```sh
npm ci
npm run dev
npm run lint
npm run render:stills
npm run render:preview
npm run render
npm run verify
```

Rendering uses the installed Google Chrome on this Windows machine. Set `REMOTION_BROWSER_EXECUTABLE` to another Chrome executable when running elsewhere. All fonts, product captures, and audio are local, so rendering does not fetch creative assets from the network.

`npm run verify` decodes every frame of the master and checks its dimensions, frame rate, audio format, and 1,920-frame count. It writes `out/verification.json`. It uses the app's bundled FFmpeg; set `STYK_LAUNCH_FFMPEG` to another FFmpeg executable when needed.

## Edit structure

`src/Root.tsx` registers the full film and every scene separately. `src/Launch.tsx` contains the edit, soundtrack, and graphic transitions. Each scene has its own file in `src/scenes/`. `src/design.ts` contains colors and timing helpers. `src/components/` contains the reusable mockup, character, logo, and type components. Titles use Remotion Interactive elements. Procedural character and perspective motion are controlled in code.

| Time | Scene | Message |
| --- | --- | --- |
| 0:00–0:02.4 | Kinetic opener | This is your move. |
| 0:02.4–0:07.2 | Product reveal | Meet StykAnimate. |
| 0:07.2–0:12 | Posing | One joint. Endless possibility. |
| 0:12–0:16.8 | Timeline | Find your flow. |
| 0:16.8–0:20 | Rhythm montage | Build. Pose. Play. |
| 0:20–0:24 | Pivot imports | Your figures. A bigger stage. |
| 0:24–0:28 | Export | Made to move. Ready to share. |
| 0:28–0:32 | Closing card | Make your next move. |

The closing card says “Create with StykAnimate.” No launch URL, release date, pricing, or unverified availability claim is invented. Update `src/scenes/End.tsx` when those details are ready.

## Creative assets

- `public/mark.svg`: existing StykAnimate logo from the application.
- `public/captures/`: 24 real editor captures across frames 1–47 of the app's built-in First steps animation, captured using the actual Next frame control. The larger figure graphics are original illustrative motion studies.
- `public/fonts/`: Inter and Space Grotesk, with SIL Open Font License texts.
- `public/soundtrack.wav`: original synthesized electronic music and transition sounds, 48 kHz stereo. No commercial recordings or stock music samples.
- `scripts/soundtrack.py`: reproducible score source; requires Python and NumPy. It writes `public/soundtrack-raw.wav`. Master the result with FFmpeg:

```sh
ffmpeg -i public/soundtrack-raw.wav -af loudnorm=I=-14:TP=-1.0:LRA=7 -ar 48000 -ac 2 public/soundtrack.wav
```

Everything for this video lives in `launch-video/`; the application's source and existing edits are not changed.

Remotion's license terms apply to use of the framework; see the installed package's LICENSE.
