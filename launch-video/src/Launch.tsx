import { AbsoluteFill, Sequence, staticFile, useCurrentFrame } from "remotion";
import { Audio } from "@remotion/media";
import { TransitionSeries } from "@remotion/transitions";
import { Hook } from "./scenes/Hook";
import { Reveal } from "./scenes/Reveal";
import { Pose } from "./scenes/Pose";
import { Timeline } from "./scenes/Timeline";
import { Rhythm } from "./scenes/Rhythm";
import { ImportScene } from "./scenes/Import";
import { ExportScene } from "./scenes/Export";
import { End } from "./scenes/End";
import { C, enter } from "./design";

const Whip = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ pointerEvents: "none", overflow: "hidden" }}>
      <div
        style={{
          position: "absolute",
          top: -200,
          bottom: -200,
          width: 430,
          left: -700 + enter(frame, 0, 16) * 3100,
          background: C.blue,
          transform: "skewX(-17deg)",
          boxShadow: "100px 0 0 #DDFF74",
        }}
      />
    </AbsoluteFill>
  );
};

export const Launch = () => (
  <AbsoluteFill style={{ fontFamily: "Inter", background: C.ink }}>
    <TransitionSeries>
      <TransitionSeries.Sequence
        durationInFrames={144}
        name="This is your move"
      >
        <Hook />
      </TransitionSeries.Sequence>
      <TransitionSeries.Sequence durationInFrames={288} name="Meet StykAnimate">
        <Reveal />
      </TransitionSeries.Sequence>
      <TransitionSeries.Sequence
        durationInFrames={288}
        name="Pose / possibility"
      >
        <Pose />
      </TransitionSeries.Sequence>
      <TransitionSeries.Sequence durationInFrames={288} name="Find your flow">
        <Timeline />
      </TransitionSeries.Sequence>
      <TransitionSeries.Sequence
        durationInFrames={192}
        name="Build / pose / play"
      >
        <Rhythm />
      </TransitionSeries.Sequence>
      <TransitionSeries.Sequence
        durationInFrames={240}
        name="Your figures / bigger stage"
      >
        <ImportScene />
      </TransitionSeries.Sequence>
      <TransitionSeries.Sequence durationInFrames={240} name="Ready to share">
        <ExportScene />
      </TransitionSeries.Sequence>
      <TransitionSeries.Sequence
        durationInFrames={240}
        name="Make your next move"
      >
        <End />
      </TransitionSeries.Sequence>
    </TransitionSeries>
    {[432, 720, 1200, 1440, 1680].map((cut) => (
      <Sequence
        key={cut}
        from={cut - 7}
        durationInFrames={16}
        layout="none"
        name="Graphic whip"
      >
        <Whip />
      </Sequence>
    ))}
    <Audio src={staticFile("soundtrack.wav")} />
  </AbsoluteFill>
);
