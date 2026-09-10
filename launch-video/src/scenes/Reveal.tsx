import {
  AbsoluteFill,
  Interactive,
  interpolate,
  useCurrentFrame,
} from "remotion";
import { C, clamp, ease, enter } from "../design";
import { EditorMockup } from "../components/EditorMockup";
import { Eyebrow } from "../components/Graphics";

export const Reveal = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill
      style={{
        background: C.paper,
        color: C.ink,
        overflow: "hidden",
        perspective: 1800,
      }}
    >
      <div
        style={{
          position: "absolute",
          width: 1500,
          height: 700,
          background: "radial-gradient(ellipse, #A5BBFF77, transparent 65%)",
          left: 250,
          top: 300,
        }}
      />
      <div style={{ position: "absolute", left: 96, top: 64 }}>
        <Eyebrow color={C.blue}>Meet your next animation studio</Eyebrow>
      </div>
      <Interactive.Div
        name="Product name"
        style={{
          position: "absolute",
          left: 90,
          top: 123,
          fontFamily: "Space Grotesk",
          fontSize: 158,
          fontWeight: 700,
          letterSpacing: -11,
          translate: `0 ${interpolate(frame, [0, 36], [160, 0], { ...clamp, easing: ease })}px`,
          opacity: enter(frame),
        }}
      >
        StykAnimate<span style={{ color: C.blue }}>.</span>
      </Interactive.Div>
      <div
        style={{
          position: "absolute",
          right: 108,
          top: 160,
          fontFamily: "Inter",
          width: 350,
          fontSize: 31,
          lineHeight: 1.4,
          opacity: enter(frame, 24),
        }}
      >
        Bring your figures.
        <br />
        Build your next story.
      </div>
      <div
        style={{
          position: "absolute",
          left: 230,
          top: 332,
          transform: `translateY(${interpolate(frame, [0, 55], [450, 0], { ...clamp, easing: ease })}px) rotateX(${interpolate(frame, [0, 72, 250, 288], [32, 6, 1, -2], { ...clamp, easing: ease })}deg) rotateY(${interpolate(frame, [0, 90, 288], [-18, -3, 3], { ...clamp, easing: ease })}deg) rotateZ(${interpolate(frame, [0, 90, 288], [-7, -1, 1], { ...clamp, easing: ease })}deg) scale(${interpolate(frame, [0, 64, 238, 288], [0.82, 1, 1.015, 1.075], { ...clamp, easing: ease })})`,
        }}
      >
        <EditorMockup width={1460} />
      </div>
      <div
        style={{
          position: "absolute",
          top: 657,
          left: 104,
          background: C.blue,
          color: "white",
          borderRadius: 18,
          padding: "19px 27px",
          fontFamily: "Inter",
          fontSize: 25,
          fontWeight: 600,
          boxShadow: "0 18px 45px #145bff44",
          rotate: "-6deg",
          translate: `${-100 + enter(frame, 78) * 100}px 0`,
          opacity: enter(frame, 78),
        }}
      >
        From pose to possibility.
      </div>
    </AbsoluteFill>
  );
};
