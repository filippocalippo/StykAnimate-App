import { AbsoluteFill, useCurrentFrame } from "remotion";
import { C, enter } from "../design";
import { Runner } from "../components/Runner";
import { Arrow } from "../components/Graphics";

export const Rhythm = () => {
  const frame = useCurrentFrame();
  const section = Math.min(2, Math.floor(frame / 64));
  const local = frame % 64;
  const color = section === 1 ? C.ink : C.paper;
  const background = section === 0 ? C.blue : section === 1 ? C.lime : C.ink;
  return (
    <AbsoluteFill style={{ background, color, overflow: "hidden" }}>
      <div
        style={{
          position: "absolute",
          top: 55,
          left: 96,
          fontSize: 24,
          fontFamily: "Inter",
          letterSpacing: 4,
        }}
      >
        LESS BETWEEN YOU AND YOUR IDEAS.
      </div>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          paddingLeft: 96,
          fontFamily: "Space Grotesk",
          fontWeight: 700,
          fontSize: 325,
          lineHeight: 1,
          letterSpacing: -25,
          scale: 1.12 - enter(local, 0, 28) * 0.12,
          transformOrigin: "left center",
        }}
      >
        {["BUILD.", "POSE.", "PLAY."][section]}
      </div>
      <div
        style={{
          position: "absolute",
          right: 96,
          top: 190,
          width: 585,
          height: 650,
          borderRadius:
            section === 0 ? 32 : section === 1 ? 330 : "32px 260px 260px 32px",
          background:
            section === 0 ? "#FFFFFF16" : section === 1 ? "#1113180E" : C.blue,
          rotate: `${(1 - enter(local, 0, 30)) * 20}deg`,
          translate: `${(1 - enter(local, 0, 30)) * 600}px 0`,
        }}
      >
        {section === 2
          ? [1, 2, 3].map((i) => (
              <Runner
                key={i}
                frame={frame - i * 6}
                color={C.lime}
                opacity={0.15 / i}
                style={{
                  position: "absolute",
                  top: 30,
                  left: 95 - i * 35,
                  scale: 1.1,
                }}
              />
            ))
          : null}
        <Runner
          frame={section === 0 ? 10 : frame}
          color={section === 1 ? C.ink : C.paper}
          joints={section < 2}
          style={{ position: "absolute", top: 40, left: 104, scale: 1.1 }}
        />
      </div>
      <div
        style={{
          position: "absolute",
          bottom: 103,
          left: 112,
          display: "flex",
          alignItems: "center",
          gap: 25,
          fontFamily: "Inter",
          fontSize: 31,
        }}
      >
        <Arrow size={45} />
        {
          [
            "Start with a simple figure.",
            "Make every gesture yours.",
            "Let your story move.",
          ][section]
        }
      </div>
      <div
        style={{
          position: "absolute",
          bottom: 80,
          right: 110,
          fontFamily: "Space Grotesk",
          fontSize: 72,
          color: section === 1 ? "#11131844" : "#ffffff44",
        }}
      >
        0{section + 1}
      </div>
    </AbsoluteFill>
  );
};
