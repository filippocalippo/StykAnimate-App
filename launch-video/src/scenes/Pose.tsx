import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { C, clamp, ease, enter } from "../design";
import {
  Cursor,
  Eyebrow,
  FrameMeta,
  Grid,
  LineTitle,
} from "../components/Graphics";
import { Runner } from "../components/Runner";

export const Pose = () => {
  const frame = useCurrentFrame();
  const runFrame =
    frame < 130
      ? interpolate(frame, [30, 115], [4, 18], { ...clamp, easing: ease })
      : 18 + (frame - 130);
  return (
    <AbsoluteFill
      style={{ background: C.ink, color: C.paper, overflow: "hidden" }}
    >
      <Grid light />
      <div style={{ position: "absolute", left: 100, top: 125 }}>
        <Eyebrow color={C.lime}>01 / Make it yours</Eyebrow>
      </div>
      <div style={{ position: "absolute", left: 96, top: 227, width: 800 }}>
        <LineTitle size={145}>One joint.</LineTitle>
        <LineTitle size={145} delay={8}>
          Endless
        </LineTitle>
        <LineTitle size={145} delay={16} color={C.lime}>
          possibility.
        </LineTitle>
        <div
          style={{
            fontFamily: "Inter",
            fontSize: 32,
            color: "#A4A9B4",
            marginTop: 38,
            lineHeight: 1.5,
            opacity: enter(frame, 30),
          }}
        >
          Build a figure. Shape a pose.
          <br />
          Give every movement character.
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: 1030,
          top: 170,
          width: 715,
          height: 715,
          borderRadius: "50%",
          border: "1px solid #ffffff14",
          background:
            "radial-gradient(circle, #313926 0%, #20272066 42%, transparent 70%)",
          scale: 0.8 + enter(frame) * 0.2,
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 48,
            border: "1px dashed #ffffff15",
            borderRadius: "50%",
            rotate: `${frame * 0.08}deg`,
          }}
        />
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            style={{
              position: "absolute",
              left: 95 - i * 72,
              top: 78,
              opacity: 0.12 - i * 0.025,
              scale: 1.2,
            }}
          >
            <Runner frame={runFrame - i * 7 - 8} color={C.lime} />
          </div>
        ))}
        <Runner
          frame={runFrame}
          color={C.paper}
          joints
          style={{ position: "absolute", left: 160, top: 72, scale: 1.2 }}
        />
        <div
          style={{
            position: "absolute",
            left: 8,
            bottom: 76,
            width: 710,
            height: 1,
            background: "#ffffff1f",
          }}
        />
      </div>
      <div
        style={{
          position: "absolute",
          left: 1090,
          top: 163,
          color: "#898F9A",
          fontFamily: "Inter",
          fontSize: 18,
          letterSpacing: 3,
        }}
      >
        POSE / {String((Math.floor(runFrame) % 48) + 1).padStart(2, "0")}
      </div>
      <div
        style={{
          opacity: interpolate(frame, [25, 45, 117, 142], [0, 1, 1, 0], clamp),
        }}
      >
        <Cursor
          x={interpolate(frame, [25, 64, 110], [1700, 1500, 1550], {
            ...clamp,
            easing: ease,
          })}
          y={interpolate(frame, [25, 64, 110], [740, 470, 425], {
            ...clamp,
            easing: ease,
          })}
          label="Pose joint"
          click={frame > 64 && frame < 88 ? (frame - 64) / 24 : 0}
        />
      </div>
      <div
        style={{
          position: "absolute",
          left: 1230,
          top: 858,
          display: "flex",
          alignItems: "center",
          gap: 13,
          color: C.lime,
          fontFamily: "Inter",
          fontSize: 25,
          opacity: enter(frame, 140),
        }}
      >
        <span
          style={{
            width: 11,
            height: 11,
            borderRadius: "50%",
            background: C.lime,
          }}
        />
        Bring it to life.
      </div>
      <FrameMeta label="BUILD / POSE / ANIMATE" />
    </AbsoluteFill>
  );
};
