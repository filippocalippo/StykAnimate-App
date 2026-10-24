// Imported endpoints materialize in document track order, independent of write touch order.
// Uses only the editor's existing camera commands, so this planner regression stands alone.
import {fileURLToPath} from 'node:url';
import {writeFileSync} from 'node:fs';
const out = fileURLToPath(new URL('../tests/edit/', import.meta.url));
writeFileSync(`${out}camera-bake-offset-sheet.scenario.json`, JSON.stringify({
  name: 'camera-bake-offset-sheet', document: 'camera-chain.document.json',
  editor: {layerTimeline: true, propertyChannels: true},
  steps: [
    ['applyCameraToFigures', [0], {ticks: [4, 2]}], ['@seek', 2], ['copyCamera'], ['undo'], ['copyCamera'], ['redo'], ['copyCamera'],
    ['@seek', 0], ['applyCameraToFigures', [0], {ticks: [1, 5]}], ['undo'], ['redo'],
  ],
}, null, 1) + '\n');
