import {tupleMessages, messageTuple} from './localization-bindings.mjs';

import {t as interfaceText} from './localization.mjs';

/**
 * The joint's IK section: Use IK, and while it is on its options in
 * #node-ik-options (rendered and hidden while IK is off, so the switch's
 * aria-controls keeps its target): the pin and stretch switches, the chain
 * stepper, the bend direction (native radios, whose change handler sets it)
 * and the target's rotation.
 */
export function ikSection(ik) {
  return {id: 'ik', title: interfaceText("ikView.ik"), titleKey: "ikView.ik", rows: [
    {kind: 'grid', rows: [
      {kind: 'field-switch', id: 'node-is-ik', label: interfaceText("ikView.useIk"), labelKey: "ikView.useIk", tip: interfaceText("ikView.dragTheJointToMoveItsWholeChain"), tipKey: "ikView.dragTheJointToMoveItsWholeChain", checked: ik.enabled, controls: 'node-ik-options'},
    ]},
    {kind: 'group', id: 'node-ik-options', label: interfaceText("ikView.ikOptions"), labelKey: "ikView.ikOptions", hidden: !ik.enabled, rows: ik.enabled ? [
      {kind: 'grid', rows: [
        {kind: 'field-switch', id: 'node-ik-pinned', label: interfaceText("ikView.pinned"), labelKey: "ikView.pinned", checked: ik.pinned, tip: interfaceText("ikView.keepTheJointWhereItIsWhenThe"), tipKey: "ikView.keepTheJointWhereItIsWhenThe"},
        {kind: 'field-switch', id: 'node-ik-stretch', label: interfaceText("ikView.stretch"), labelKey: "ikView.stretch", checked: ik.allowStretch, tip: interfaceText("ikView.allowStretch"), tipKey: "ikView.allowStretch"},
      ]},
      {kind: 'stepper', id: 'node-ik-chain', label: interfaceText("ikView.chain"), labelKey: "ikView.chain", description: interfaceText("ikView.ikChainLength"), descriptionKey: "ikView.ikChainLength", value: ik.chainLength, min: 1, max: ik.maxLength, step: 1,
        down: {label: interfaceText("ikView.shorterChain"), labelKey: "ikView.shorterChain"}, up: {label: interfaceText("ikView.longerChain"), labelKey: "ikView.longerChain"}},
      {kind: 'segmented', mode: 'radio', name: 'node-ik-bend', label: interfaceText("ikView.direction"), labelKey: "ikView.direction", description: interfaceText("ikView.ikBendDirection"), descriptionKey: "ikView.ikBendDirection", value: ik.bendDirection,
        options: [messageTuple([-1, interfaceText("ikView.left")], {1: {key: "ikView.left", params: {}}}), messageTuple([0, interfaceText("ikView.both")], {1: {key: "ikView.both", params: {}}}), messageTuple([1, interfaceText("ikView.right")], {1: {key: "ikView.right", params: {}}})].map((_tuple) => {const [value, label] = _tuple; const _messages = tupleMessages(_tuple); return {value, label, ...(_messages[1] ? {labelKey: _messages[1].key, labelParams: _messages[1].params} : {}), description: interfaceText("ikView.bend", {value: label.toLowerCase()}), descriptionKey: "ikView.bend", descriptionParams: {value: label.toLowerCase()}};})},
      {kind: 'grid', rows: [
        {kind: 'number', id: 'node-ik-rotation', label: interfaceText("ikView.rotation"), labelKey: "ikView.rotation", description: interfaceText("ikView.ikTargetRotation"), descriptionKey: "ikView.ikTargetRotation", unit: '°', step: 1, precision: 2,
          value: Math.round(ik.target.rotation * 180 / Math.PI * 100) / 100},
      ]},
    ] : []},
  ]};
}
