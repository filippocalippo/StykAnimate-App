import React from "react";
import { C } from "../design";

type Point = [number, number];
const limb = (p: Point, length: number, angle: number): Point => [
  p[0] + Math.sin(angle) * length,
  p[1] + Math.cos(angle) * length,
];

export const Runner: React.FC<{
  frame: number;
  color?: string;
  joints?: boolean;
  opacity?: number;
  style?: React.CSSProperties;
  phaseOffset?: number;
}> = ({
  frame,
  color = C.ink,
  joints = false,
  opacity = 1,
  style,
  phaseOffset = 0,
}) => {
  const phase = (frame / 48) * Math.PI * 2 + phaseOffset;
  const swing = Math.sin(phase);
  const hip: Point = [170, 265 - Math.cos(phase * 2) * 7];
  const shoulder: Point = [204, hip[1] - 116];
  const head: Point = [215, shoulder[1] - 61];
  const frontKnee = limb(hip, 99, swing * 0.92);
  const frontFoot = limb(
    frontKnee,
    91,
    swing * 0.35 - Math.max(0, -swing) * 1.25,
  );
  const backKnee = limb(hip, 99, -swing * 0.92);
  const backFoot = limb(
    backKnee,
    91,
    -swing * 0.35 - Math.max(0, swing) * 1.25,
  );
  const frontElbow = limb(shoulder, 78, -swing * 0.9);
  const frontHand = limb(frontElbow, 72, -swing * 0.9 + 1.65);
  const backElbow = limb(shoulder, 78, swing * 0.9);
  const backHand = limb(backElbow, 72, swing * 0.9 + 1.65);
  const path = (pts: Point[]) =>
    pts.map((p, i) => `${i ? "L" : "M"}${p[0]},${p[1]}`).join(" ");
  return (
    <svg
      width="360"
      height="520"
      viewBox="0 0 360 520"
      style={{ overflow: "visible", ...style }}
      opacity={opacity}
    >
      <ellipse
        cx="181"
        cy="480"
        rx={79 + Math.cos(phase * 2) * 8}
        ry="7"
        fill={color}
        opacity="0.08"
      />
      <g
        fill="none"
        stroke={color}
        strokeWidth="19"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d={path([hip, backKnee, backFoot])} opacity="0.35" />
        <path d={path([shoulder, backElbow, backHand])} opacity="0.35" />
        <path d={path([hip, shoulder])} strokeWidth="23" />
        <circle cx={head[0]} cy={head[1]} r="31" strokeWidth="17" />
        <path d={path([hip, frontKnee, frontFoot])} />
        <path d={path([shoulder, frontElbow, frontHand])} strokeWidth="17" />
      </g>
      {joints
        ? [
            hip,
            shoulder,
            frontKnee,
            frontFoot,
            frontElbow,
            frontHand,
            backKnee,
            backFoot,
          ].map((p, i) => (
            <g key={i}>
              <circle
                cx={p[0]}
                cy={p[1]}
                r="10"
                fill={i === 0 ? "#FFB23E" : "#FF5363"}
                stroke="white"
                strokeWidth="3"
              />
              <circle cx={p[0]} cy={p[1]} r="3" fill="white" />
            </g>
          ))
        : null}
    </svg>
  );
};
