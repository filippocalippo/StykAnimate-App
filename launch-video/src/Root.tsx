import "./index.css";
import { Composition, Folder } from "remotion";
import { Launch } from "./Launch";
import { Hook } from "./scenes/Hook";
import { Reveal } from "./scenes/Reveal";
import { Pose } from "./scenes/Pose";
import { Timeline } from "./scenes/Timeline";
import { Rhythm } from "./scenes/Rhythm";
import { ImportScene } from "./scenes/Import";
import { ExportScene } from "./scenes/Export";
import { End } from "./scenes/End";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="StykAnimate-Launch"
        component={Launch}
        durationInFrames={1920}
        fps={60}
        width={1920}
        height={1080}
      />
      <Folder name="Scenes">
        <Composition
          id="Opening"
          component={Hook}
          durationInFrames={144}
          fps={60}
          width={1920}
          height={1080}
        />
        <Composition
          id="Product"
          component={Reveal}
          durationInFrames={288}
          fps={60}
          width={1920}
          height={1080}
        />
        <Composition
          id="Pose"
          component={Pose}
          durationInFrames={288}
          fps={60}
          width={1920}
          height={1080}
        />
        <Composition
          id="Timeline"
          component={Timeline}
          durationInFrames={288}
          fps={60}
          width={1920}
          height={1080}
        />
        <Composition
          id="Rhythm"
          component={Rhythm}
          durationInFrames={192}
          fps={60}
          width={1920}
          height={1080}
        />
        <Composition
          id="Import"
          component={ImportScene}
          durationInFrames={240}
          fps={60}
          width={1920}
          height={1080}
        />
        <Composition
          id="Export"
          component={ExportScene}
          durationInFrames={240}
          fps={60}
          width={1920}
          height={1080}
        />
        <Composition
          id="End"
          component={End}
          durationInFrames={240}
          fps={60}
          width={1920}
          height={1080}
        />
      </Folder>
    </>
  );
};
