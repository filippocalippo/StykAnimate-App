import { AbsoluteFill, useCurrentFrame } from "remotion";
import { C, enter } from "../design";
import { Arrow, Eyebrow, FrameMeta, LineTitle } from "../components/Graphics";
import { Runner } from "../components/Runner";

export const ExportScene = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill
      style={{ background: C.lime, color: C.ink, overflow: "hidden" }}
    >
      <div style={{ position: "absolute", left: 99, top: 107 }}>
        <Eyebrow color="#46582D">04 / Out into the world</Eyebrow>
      </div>
      <div style={{ position: "absolute", left: 94, top: 220 }}>
        <LineTitle size={133}>Made to move.</LineTitle>
        <LineTitle size={133} delay={8}>
          Ready to
        </LineTitle>
        <LineTitle size={133} delay={16}>
          share<span style={{ color: C.blue }}>.</span>
        </LineTitle>
      </div>
      <div
        style={{
          position: "absolute",
          left: 100,
          top: 723,
          fontFamily: "Inter",
          fontSize: 32,
          lineHeight: 1.5,
          color: "#475735",
          opacity: enter(frame, 30),
        }}
      >
        From your canvas
        <br />
        to their screen.
      </div>
      <div
        style={{
          position: "absolute",
          left: 1040,
          top: 179,
          width: 680,
          height: 700,
          background: "#11131812",
          borderRadius: 32,
          rotate: "9deg",
          translate: `0 ${(1 - enter(frame, 0, 50)) * 600}px`,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 976,
          top: 185,
          width: 719,
          height: 710,
          borderRadius: 30,
          background: C.ink,
          overflow: "hidden",
          boxShadow: "0 40px 70px #26310f44",
          rotate: `${-7 + enter(frame, 0, 160) * 3}deg`,
          translate: `0 ${(1 - enter(frame, 4, 45)) * 650}px`,
        }}
      >
        <div
          style={{
            padding: "25px 30px",
            display: "flex",
            justifyContent: "space-between",
            color: "#ffffff88",
            fontFamily: "Inter",
            fontSize: 20,
          }}
        >
          <span>YOUR NEXT GREAT ANIMATION</span>
          <span>↗</span>
        </div>
        <div
          style={{
            position: "absolute",
            top: 76,
            left: 16,
            right: 16,
            height: 516,
            borderRadius: 18,
            background: C.blue,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              position: "absolute",
              top: 170,
              left: -80,
              fontFamily: "Space Grotesk",
              fontSize: 170,
              letterSpacing: -11,
              fontWeight: 700,
              color: "#ffffff10",
              whiteSpace: "nowrap",
            }}
          >
            IN MOTION
          </div>
          <Runner
            frame={frame}
            color="white"
            style={{ position: "absolute", left: 165, top: -22, scale: 0.9 }}
          />
          <div
            style={{
              position: "absolute",
              left: 26,
              right: 26,
              bottom: 26,
              display: "flex",
              gap: 18,
              alignItems: "center",
              color: "white",
              fontFamily: "Inter",
              fontSize: 17,
            }}
          >
            <span>▶</span>
            <div
              style={{
                height: 4,
                flex: 1,
                background: "#ffffff44",
                borderRadius: 2,
              }}
            >
              <div
                style={{
                  height: 4,
                  width: `${((frame % 192) / 192) * 100}%`,
                  background: C.lime,
                  borderRadius: 2,
                }}
              />
            </div>
            <span>00:{String(Math.floor(frame / 60)).padStart(2, "0")}</span>
          </div>
        </div>
        <div
          style={{
            position: "absolute",
            bottom: 39,
            left: 31,
            right: 31,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            color: "white",
            fontFamily: "Space Grotesk",
            fontSize: 32,
            fontWeight: 500,
          }}
        >
          <span>Make something worth watching.</span>
          <Arrow size={30} />
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          right: 69,
          top: 280,
          display: "flex",
          flexDirection: "column",
          gap: 23,
        }}
      >
        {["MP4", "GIF", "SVG"].map((ext, i) => (
          <div
            key={ext}
            style={{
              width: 156,
              height: 102,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontFamily: "Space Grotesk",
              fontSize: 38,
              fontWeight: 700,
              borderRadius: 20,
              background: i === 0 ? C.paper : i === 1 ? C.ink : "white",
              color: i === 1 ? "white" : C.ink,
              boxShadow: "0 18px 38px #27370c25",
              rotate: `${[8, -5, 5][i]}deg`,
              scale: enter(frame, 36 + i * 16, 35),
            }}
          >
            {ext}
          </div>
        ))}
      </div>
      <FrameMeta label="MP4 / GIF / WEBM / SVG / AND MORE" dark />
    </AbsoluteFill>
  );
};
