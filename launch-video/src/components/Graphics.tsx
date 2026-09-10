import React from "react";
import {
  AbsoluteFill,
  Img,
  Interactive,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";
import { C, clamp, ease } from "../design";

export const Brand: React.FC<{
  dark?: boolean;
  size?: number;
  iconOnly?: boolean;
}> = ({ dark = false, size = 34, iconOnly = false }) => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      gap: size * 0.32,
      color: dark ? C.ink : C.paper,
    }}
  >
    <Img
      src={staticFile("mark.svg")}
      style={{ width: size * 1.25, height: size * 1.25 }}
    />
    {iconOnly ? null : (
      <span
        style={{
          fontFamily: "Space Grotesk",
          fontSize: size,
          fontWeight: 700,
          letterSpacing: -size * 0.04,
        }}
      >
        StykAnimate
      </span>
    )}
  </div>
);

export const Eyebrow: React.FC<{
  children: React.ReactNode;
  color?: string;
}> = ({ children, color = C.muted }) => (
  <div
    style={{
      fontFamily: "Inter",
      fontSize: 22,
      letterSpacing: 4,
      fontWeight: 500,
      color,
      textTransform: "uppercase",
      display: "flex",
      alignItems: "center",
      gap: 18,
    }}
  >
    <span style={{ width: 8, height: 8, background: color, borderRadius: 4 }} />
    {children}
  </div>
);

export const Grid: React.FC<{ light?: boolean; gap?: number }> = ({
  light = false,
  gap = 72,
}) => (
  <AbsoluteFill
    style={{
      pointerEvents: "none",
      backgroundImage: `linear-gradient(${light ? "#ffffff0b" : "#11131808"} 1px, transparent 1px),linear-gradient(90deg, ${light ? "#ffffff0b" : "#11131808"} 1px, transparent 1px)`,
      backgroundSize: `${gap}px ${gap}px`,
    }}
  />
);

export const FrameMeta: React.FC<{ label: string; dark?: boolean }> = ({
  label,
  dark = false,
}) => (
  <div
    style={{
      position: "absolute",
      left: 92,
      right: 92,
      bottom: 48,
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      color: dark ? "#777B83" : "#9197A5",
      fontFamily: "Inter",
      fontSize: 18,
      letterSpacing: 2,
    }}
  >
    <span>STYKANIMATE / {label}</span>
    <span style={{ display: "flex", gap: 8 }}>
      {[0, 1, 2, 3].map((i) => (
        <span
          key={i}
          style={{
            width: i === 0 ? 28 : 6,
            height: 6,
            borderRadius: 3,
            background: dark ? "#11131866" : "#ffffff88",
          }}
        />
      ))}
    </span>
  </div>
);

export const LineTitle: React.FC<{
  children: React.ReactNode;
  delay?: number;
  size?: number;
  color?: string;
}> = ({ children, delay = 0, size = 132, color }) => {
  const frame = useCurrentFrame();
  return (
    <div style={{ overflow: "hidden", paddingBottom: 12, marginBottom: -12 }}>
      <Interactive.Div
        name="Headline"
        style={{
          fontFamily: "Space Grotesk",
          fontSize: size,
          lineHeight: 1.02,
          fontWeight: 700,
          letterSpacing: -size * 0.064,
          color,
          translate: `0 ${interpolate(frame, [delay, delay + 32], [size * 1.2, 0], { ...clamp, easing: ease })}px`,
        }}
      >
        {children}
      </Interactive.Div>
    </div>
  );
};

export const Arrow: React.FC<{ size?: number; color?: string }> = ({
  size = 48,
  color = "currentColor",
}) => (
  <svg width={size} height={size} viewBox="0 0 48 48" fill="none">
    <path
      d="M8 24H38M25 10L39 24L25 38"
      stroke={color}
      strokeWidth="3.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export const Cursor: React.FC<{
  x: number;
  y: number;
  label?: string;
  click?: number;
}> = ({ x, y, label, click = 0 }) => (
  <div
    style={{
      position: "absolute",
      left: x,
      top: y,
      filter: "drop-shadow(0 5px 6px #0003)",
    }}
  >
    {click > 0 ? (
      <div
        style={{
          position: "absolute",
          width: 92,
          height: 92,
          left: -46,
          top: -46,
          border: `3px solid ${C.blue}`,
          borderRadius: "50%",
          scale: 1 + click,
          opacity: 1 - click,
        }}
      />
    ) : null}
    <svg width="44" height="52" viewBox="0 0 44 52">
      <path
        d="M4 3L36 28L22 30L16 45Z"
        fill={C.blue}
        stroke="white"
        strokeWidth="3"
        strokeLinejoin="round"
      />
    </svg>
    {label ? (
      <div
        style={{
          background: C.blue,
          color: "white",
          padding: "10px 18px",
          borderRadius: "4px 14px 14px 14px",
          fontFamily: "Inter",
          fontWeight: 600,
          fontSize: 22,
          position: "absolute",
          left: 34,
          top: 42,
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </div>
    ) : null}
  </div>
);
