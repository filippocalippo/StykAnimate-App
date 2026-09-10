import {
  AbsoluteFill,
  Interactive,
  interpolate,
  useCurrentFrame,
} from "remotion";
import { C, clamp, ease, enter } from "../design";
import { Arrow, Brand } from "../components/Graphics";

export const End = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill
      style={{ background: C.blue, color: C.paper, overflow: "hidden" }}
    >
      <div
        style={{
          position: "absolute",
          width: 1270,
          height: 1270,
          border: "1px solid #ffffff19",
          borderRadius: "50%",
          top: -330,
          right: -260,
          scale: 0.6 + enter(frame, 0, 110) * 0.4,
        }}
      />
      <div
        style={{
          position: "absolute",
          width: 1000,
          height: 1000,
          border: "1px solid #ffffff16",
          borderRadius: "50%",
          top: -195,
          right: -125,
          scale: 0.6 + enter(frame, 12, 110) * 0.4,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 103,
          top: 80,
          opacity: enter(frame, 0, 24),
        }}
      >
        <Brand size={43} />
      </div>
      <Interactive.Div
        name="Closing headline"
        style={{
          position: "absolute",
          left: 90,
          top: 254,
          fontFamily: "Space Grotesk",
          fontSize: 184,
          fontWeight: 700,
          lineHeight: 0.98,
          letterSpacing: -13,
          translate: `0 ${interpolate(frame, [0, 42], [250, 0], { ...clamp, easing: ease })}px`,
          opacity: enter(frame, 0, 20),
        }}
      >
        Make your
        <br />
        next <span style={{ color: C.lime }}>move.</span>
      </Interactive.Div>
      <div
        style={{
          position: "absolute",
          right: 143,
          top: 366,
          width: 330,
          height: 330,
          borderRadius: "50%",
          background: C.lime,
          color: C.ink,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          scale: interpolate(frame, [14, 55, 200, 239], [0, 1, 1, 1.03], {
            ...clamp,
            easing: ease,
          }),
          rotate: `${interpolate(frame, [14, 65], [-90, -35], { ...clamp, easing: ease })}deg`,
        }}
      >
        <Arrow size={176} />
      </div>
      <div
        style={{
          position: "absolute",
          left: 104,
          top: 783,
          fontFamily: "Inter",
          fontSize: 35,
          fontWeight: 500,
          display: "flex",
          alignItems: "center",
          gap: 28,
          opacity: enter(frame, 48, 30),
        }}
      >
        Create with StykAnimate <Arrow size={43} />
      </div>
      <div
        style={{
          position: "absolute",
          left: 104,
          right: 104,
          bottom: 85,
          borderTop: "1px solid #ffffff44",
          paddingTop: 30,
          display: "flex",
          justifyContent: "space-between",
          fontFamily: "Inter",
          fontSize: 23,
          color: "#ffffffaa",
        }}
      >
        <span>Your figures. Your timing. Your story.</span>
        <span>STYKANIMATE</span>
      </div>
    </AbsoluteFill>
  );
};
