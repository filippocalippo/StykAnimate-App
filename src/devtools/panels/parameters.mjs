/**
 * The Parameters tab (developer build only; docs/DEVTOOLS.md "Panels"): the live parameters registered so far, changed
 * while the app runs, reset, and saved or loaded as named sets. It is rebuilt when shown and after each change.
 */
import {button, element, table} from './dom.mjs';

export function createParametersTab({runtime}) {
  const {early} = runtime;
  const root = element('div');

  function build() {
    const rows = [...early.parameters.registry.values()].map(entry => {
      let input;
      if (typeof entry.default === 'boolean') input = element('input', {type: 'checkbox', checked: entry.value});
      else if (entry.options) input = element('select', {}, ...entry.options.map(option => element('option', {value: option, textContent: option, selected: option === entry.value})));
      else input = element('input', {type: typeof entry.default === 'number' ? 'number' : 'text', value: entry.value, min: entry.min ?? '', max: entry.max ?? '', step: entry.step ?? 'any', size: 8});
      input.onchange = () => { runtime.setParameter(entry.name, input.type === 'checkbox' ? input.checked : input.value); build(); };
      return [element('span', {textContent: entry.name, title: entry.description}), input, entry.default, entry.min, entry.max,
        button('Reset', () => { runtime.setParameter(entry.name, entry.default); build(); })];
    });
    const profile = element('input', {placeholder: 'profile name', size: 14});
    root.replaceChildren(
      element('div', {className: 'dt-row'}, profile, button('Save set', () => { if (profile.value) runtime.saveProfile(profile.value); build(); }),
        ...runtime.profiles().map(name => button(`Load ${name}`, () => { runtime.loadProfile(name); build(); })),
        button('Reset all', () => { for (const entry of early.parameters.registry.values()) runtime.setParameter(entry.name, entry.default); build(); })),
      rows.length ? table(['Parameter', 'Value', 'Default', 'Min', 'Max', ''], rows, [2, 3, 4]) : element('div', {className: 'dt-dim', textContent: 'No live parameter has registered yet: each registers when its code first runs.'}),
      element('div', {className: 'dt-dim', textContent: 'The current values persist for this developer profile; the shipping build always uses the defaults.'}));
  }

  return {name: 'Parameters', root, shown: build};
}
