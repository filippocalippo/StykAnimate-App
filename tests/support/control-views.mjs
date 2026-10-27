// The inspector sections of a control group as the inspector renders them (HTML), for tests that read the markup.
import {renderInspector} from '../../src/inspector-kit.mjs';
import {ikSection} from '../../src/ik-view.mjs';
import {spatialSections} from '../../src/spatial-controls.mjs';
import {movieclipSections} from '../../src/movieclip-ui.mjs';

/** The IK section for the settings of one controller. */
export const ikControlsView = ik => renderInspector({kind: 'joint', sections: [ikSection(ik)]});

/** The spatial rig section of the selected figure; empty when it has none. */
export const spatialControlsView = editor => {
  const sections = spatialSections(editor);
  return sections.length ? renderInspector({kind: 'spatial-rig', sections}) : '';
};

/** The movieclip section of the selected figure. */
export const movieclipInspector = editor => renderInspector({kind: 'movieclip', sections: movieclipSections(editor)});
