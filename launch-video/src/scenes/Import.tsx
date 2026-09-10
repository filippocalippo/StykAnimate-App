import { AbsoluteFill, useCurrentFrame } from "remotion";
import { C, enter } from "../design";
import { EditorMockup } from "../components/EditorMockup";
import { Arrow, Eyebrow, FrameMeta, LineTitle } from "../components/Graphics";

export const ImportScene = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill
      style={{
        background: C.ink,
        color: C.paper,
        perspective: 1800,
        overflow: "hidden",
      }}
    >
      <div style={{ position: "absolute", left: 96, top: 112 }}>
        <Eyebrow color={C.lime}>03 / Keep creating</Eyebrow>
      </div>
      <div style={{ position: "absolute", top: 220, left: 94 }}>
        <LineTitle size={125}>Your figures.</LineTitle>
        <LineTitle size={125} delay={8}>
          A bigger
        </LineTitle>
        <LineTitle size={125} delay={16} color={C.lime}>
          stage.
        </LineTitle>
      </div>
      <div
        style={{
          position: "absolute",
          left: 100,
          top: 671,
          fontFamily: "Inter",
          fontSize: 30,
          color: "#9CA3B2",
          lineHeight: 1.5,
          opacity: enter(frame, 30),
        }}
      >
        Open your Pivot animations.
        <br />
        Bring your STK figures along.
      </div>
      <div
        style={{
          position: "absolute",
          left: 920,
          top: 218,
          transform: `rotateY(${-14 + enter(frame, 0, 180) * 6}deg) rotateZ(-5deg) translateX(${(1 - enter(frame, 14, 55)) * 900}px)`,
          transformOrigin: "left center",
        }}
      >
        <EditorMockup width={1220} frameOffset={38} />
      </div>
      <div
        style={{
          position: "absolute",
          top: 809,
          left: 786,
          display: "flex",
          gap: 24,
        }}
      >
        {[".PIV", ".STK", ".STYK"].map((label, i) => (
          <div
            key={label}
            style={{
              width: 216,
              height: 123,
              background: i === 0 ? C.blue : i === 1 ? C.lime : C.paper,
              color: i === 0 ? "white" : C.ink,
              borderRadius: 19,
              boxShadow: "0 24px 45px #0005",
              rotate: `${i === 0 ? -8 : i === 1 ? 3 : -2}deg`,
              translate: `0 ${(1 - enter(frame, 24 + i * 12, 38)) * 230}px`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 14,
              fontFamily: "Space Grotesk",
              fontSize: 44,
              fontWeight: 700,
              letterSpacing: -2,
            }}
          >
            <svg width="29" height="36" viewBox="0 0 29 36" fill="none">
              <path
                d="M3 2H17L26 11V34H3Z"
                stroke="currentColor"
                strokeWidth="2"
              />
              <path d="M17 2V11H26" stroke="currentColor" strokeWidth="2" />
            </svg>
            {label}
          </div>
        ))}
      </div>
      <div
        style={{
          position: "absolute",
          left: 634,
          top: 830,
          color: C.lime,
          opacity: enter(frame, 65),
        }}
      >
        <Arrow size={64} />
      </div>
      <FrameMeta label="PIVOT ANIMATIONS / REUSABLE FIGURES" />
    </AbsoluteFill>
  );
};
