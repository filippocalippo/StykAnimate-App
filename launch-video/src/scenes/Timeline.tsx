import {
  AbsoluteFill,
  Img,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";
import { C, clamp, ease, enter } from "../design";
import { Eyebrow, FrameMeta, LineTitle } from "../components/Graphics";
import { Runner } from "../components/Runner";

export const Timeline = () => {
  const frame = useCurrentFrame();
  const captureIndex = Math.floor(frame / 5) % 24;
  return (
    <AbsoluteFill
      style={{ background: C.paper, color: C.ink, overflow: "hidden" }}
    >
      <div style={{ position: "absolute", left: 100, top: 98 }}>
        <Eyebrow color={C.blue}>02 / Every frame counts</Eyebrow>
      </div>
      <div style={{ position: "absolute", left: 96, top: 186 }}>
        <LineTitle size={155}>
          Find your <span style={{ color: C.blue }}>flow.</span>
        </LineTitle>
      </div>
      <div
        style={{
          position: "absolute",
          right: 124,
          top: 122,
          width: 400,
          fontFamily: "Inter",
          fontSize: 30,
          lineHeight: 1.45,
          color: "#626773",
          opacity: enter(frame, 18),
        }}
      >
        Shape the timing.
        <br />
        See the movement.
      </div>
      <div
        style={{
          position: "absolute",
          left: 108,
          right: 108,
          top: 375,
          display: "flex",
          justifyContent: "space-between",
        }}
      >
        {[0, 1, 2, 3, 4].map((i) => (
          <div
            key={i}
            style={{
              position: "relative",
              width: 311,
              height: 318,
              background: i === Math.floor(frame / 24) % 5 ? C.blue : "#E6E7E1",
              borderRadius: 20,
              overflow: "hidden",
              translate: `0 ${interpolate(frame, [10 + i * 6, 45 + i * 6], [240, 0], { ...clamp, easing: ease })}px`,
            }}
          >
            <div
              style={{
                position: "absolute",
                left: 20,
                top: 17,
                fontFamily: "Inter",
                fontSize: 18,
                color:
                  i === Math.floor(frame / 24) % 5 ? "#ffffff99" : "#7E858F",
              }}
            >
              0{i + 1}
            </div>
            <Runner
              frame={i * 9 + (frame > 145 ? frame - 145 : 0)}
              color={i === Math.floor(frame / 24) % 5 ? "white" : C.ink}
              style={{
                position: "absolute",
                left: -18,
                top: -160,
                scale: 0.58,
                transformOrigin: "center 80%",
              }}
            />
          </div>
        ))}
      </div>
      <div
        style={{
          position: "absolute",
          left: 108,
          top: 735,
          width: 1704,
          height: 221,
          overflow: "hidden",
          borderRadius: 18,
          border: "1px solid #D1D7E0",
          boxShadow: "0 20px 45px #141F3820",
          translate: `0 ${interpolate(frame, [35, 75], [240, 0], { ...clamp, easing: ease })}px`,
        }}
      >
        <Img
          src={staticFile(
            `captures/frame-${String(captureIndex).padStart(2, "0")}.png`,
          )}
          style={{ position: "absolute", width: 1704, top: -575, left: 0 }}
        />
      </div>
      <FrameMeta label="KEYFRAMES / TIMING / ONION SKIN" dark />
    </AbsoluteFill>
  );
};
