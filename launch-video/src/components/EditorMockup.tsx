import React from "react";
import { Img, staticFile, useCurrentFrame } from "remotion";

export const EditorMockup: React.FC<{
  width?: number;
  animate?: boolean;
  frameOffset?: number;
  style?: React.CSSProperties;
}> = ({ width = 1440, animate = true, frameOffset = 0, style }) => {
  const frame = useCurrentFrame();
  const index = Math.floor((frame + frameOffset) / 4) % 24;
  return (
    <div
      style={{
        position: "relative",
        width,
        padding: width / 110,
        background:
          "linear-gradient(135deg, #535762, #181A20 25%, #24272E 75%, #6E7380)",
        borderRadius: width / 42,
        boxShadow: "0 80px 150px -50px #0008, 0 2px 2px #fff9 inset",
        ...style,
      }}
    >
      <div
        style={{
          height: width / 52,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          marginTop: -4,
          marginBottom: 5,
        }}
      >
        <div
          style={{
            width: 5,
            height: 5,
            borderRadius: "50%",
            background: "#454B5B",
            boxShadow: "0 0 0 2px #101217",
          }}
        />
      </div>
      <div
        style={{
          position: "relative",
          overflow: "hidden",
          borderRadius: width / 150,
          background: "#ECEEF3",
        }}
      >
        <Img
          src={staticFile(
            animate
              ? `captures/frame-${String(index).padStart(2, "0")}.png`
              : "captures/editor.png",
          )}
          style={{ display: "block", width: "100%" }}
        />
      </div>
      <div
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
          borderRadius: "inherit",
          border: "1px solid #ffffff50",
          background:
            "linear-gradient(135deg, #ffffff09, transparent 30%, transparent 80%, #ffffff06)",
        }}
      />
    </div>
  );
};
