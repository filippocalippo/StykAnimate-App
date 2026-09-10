import {
  AbsoluteFill,
  Interactive,
  interpolate,
  useCurrentFrame,
} from "remotion";
import { C, clamp, ease, enter } from "../design";
import { Brand, Arrow } from "../components/Graphics";
import { Runner } from "../components/Runner";

export const Hook = () => {
  const frame = useCurrentFrame();
  const beat = Math.min(3, Math.floor(frame / 24));
  const local = beat === 3 ? frame - 72 : frame % 24;
  const bg =
    beat === 0 ? C.paper : beat === 1 ? C.blue : beat === 2 ? C.lime : C.ink;
  const fg = beat === 0 || beat === 2 ? C.ink : C.paper;
  return (
    <AbsoluteFill
      style={{
        background: bg,
        color: fg,
        overflow: "hidden",
        fontFamily: "Space Grotesk",
      }}
    >
      <div style={{ position: "absolute", left: 92, top: 60 }}>
        <Brand dark={beat === 0 || beat === 2} size={30} />
      </div>
      <div
        style={{
          position: "absolute",
          right: 96,
          top: 67,
          fontFamily: "Inter",
          fontSize: 20,
          letterSpacing: 4,
        }}
      >
        ANIMATION STARTS HERE
      </div>
      {beat < 3 ? (
        <Interactive.Div
          name="Opening kinetic type"
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            fontWeight: 700,
            fontSize: beat === 2 ? 352 : 408,
            letterSpacing: -30,
            scale: interpolate(local, [0, 20], [1.15, 1], {
              ...clamp,
              easing: ease,
            }),
            translate: `0 ${interpolate(local, [0, 15], [110, 0], { ...clamp, easing: ease })}px`,
          }}
        >
          {["THIS", "IS", "YOUR"][beat]}
        </Interactive.Div>
      ) : (
        <>
          <div
            style={{
              position: "absolute",
              top: 260,
              left: 100,
              fontSize: 318,
              lineHeight: 1,
              fontWeight: 700,
              letterSpacing: -25,
              scale: 0.85 + enter(local, 0, 25) * 0.15,
              transformOrigin: "left center",
            }}
          >
            MOVE<span style={{ color: C.lime }}>.</span>
          </div>
          <div
            style={{
              position: "absolute",
              right: 114,
              top: 234,
              width: 500,
              height: 550,
              background: C.lime,
              borderRadius: 280,
              rotate: `${-18 + enter(local) * 9}deg`,
              scale: enter(local, 4, 26),
            }}
          >
            <Runner
              frame={frame}
              style={{ position: "absolute", left: 40, top: 15, scale: 1.08 }}
            />
          </div>
          <div
            style={{
              position: "absolute",
              left: 122,
              top: 660,
              fontFamily: "Inter",
              fontSize: 34,
              letterSpacing: -0.8,
              opacity: enter(local, 10),
            }}
          >
            Big ideas start with a little motion.
          </div>
          <div
            style={{
              position: "absolute",
              left: 120,
              bottom: 112,
              color: C.lime,
              translate: `${enter(local, 4) * 35}px 0`,
            }}
          >
            <Arrow size={78} />
          </div>
        </>
      )}
      <div
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          width: `${(frame / 144) * 100}%`,
          height: 7,
          background: beat === 3 ? C.lime : fg,
        }}
      />
    </AbsoluteFill>
  );
};
