import {mergeEnglishMessages} from './catalog-validation.mjs';
/** Authoritative English interface catalog. Feature files own semantic keys. */
import common from './en-common.mjs';
import dialogs from './en-dialogs.mjs';
import overlays from './en-overlays.mjs';
import inspector from './en-inspector.mjs';
import timeline from './en-timeline.mjs';
import quick from './en-quick.mjs';
import toolOptions from './en-tool-options.mjs';
import features from './en-features/index.mjs';
export default mergeEnglishMessages(common, dialogs, overlays, inspector, timeline, quick, toolOptions, features);
