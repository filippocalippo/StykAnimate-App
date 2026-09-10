import { Easing, interpolate, staticFile } from "remotion";
import { loadFont } from "@remotion/fonts";

loadFont({
  family: "Inter",
  url: staticFile("fonts/inter.woff2"),
  weight: "100 900",
});
loadFont({
  family: "Space Grotesk",
  url: staticFile("fonts/space-grotesk.woff2"),
  weight: "300 700",
});

export const C = {
  ink: "#111318",
  paper: "#F4F3EE",
  blue: "#145BFF",
  lime: "#DDFF74",
  muted: "#9398A5",
};
export const ease = Easing.bezier(0.16, 1, 0.3, 1);
export const clamp = {
  extrapolateLeft: "clamp",
  extrapolateRight: "clamp",
} as const;
export const enter = (frame: number, start = 0, duration = 30) =>
  interpolate(frame, [start, start + duration], [0, 1], {
    ...clamp,
    easing: ease,
  });
export const pulse = (frame: number) => Math.exp(-(frame % 24) / 6);
