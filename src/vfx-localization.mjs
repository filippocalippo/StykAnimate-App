/** Presentation metadata keyed by saved effect/parameter IDs. Machine definitions stay unchanged. */
import {t} from './localization.mjs';
export const easingMessageKeys = Object.freeze({linear:'keyframeEasing.linear',auto:'keyframeEasing.auto', 'ease-in':'keyframeEasing.easeIn','ease-out':'keyframeEasing.easeOut',constant:'keyframeEasing.constant'});
export function effectNameMessage(clip, effect) {
  const same = clip.effects.filter(item=>item.type===effect.type), name={messageKey:effectMessages[effect.type].nameKey};
  return same.length>1 ? {messageKey:'vfxChannels.effectIndex',messageParams:{name,index:same.findIndex(item=>item.id===effect.id)+1}} : name;
}
export function effectParameterMessage(descriptor) {
  return {messageKey:descriptor.param==='enabled'?'vfxChannels.enabled':effectMessages[descriptor.effectType].params[descriptor.param].labelKey};
}
export function effectPropertyText(property, descriptor) {
  return descriptor ? t('vfxChannels.effectParameter',{name:{messageKey:effectMessages[descriptor.effectType].nameKey},parameter:effectParameterMessage(descriptor)}) : property;
}
export const effectMessages = Object.freeze({
  "turbulence": {
    "nameKey": "vfxCatalog.effect.turbulence",
    "categoryKey": "vfxCatalog.category.distort",
    "params": {
      "effectStrength": {
        "labelKey": "vfxCatalog.parameter.turbulence.effectStrength.label"
      },
      "amount": {
        "labelKey": "vfxCatalog.parameter.turbulence.amount.label"
      },
      "size": {
        "labelKey": "vfxCatalog.parameter.turbulence.size.label"
      },
      "evolution": {
        "labelKey": "vfxCatalog.parameter.turbulence.evolution.label"
      },
      "detail": {
        "labelKey": "vfxCatalog.parameter.turbulence.detail.label"
      },
      "seed": {
        "labelKey": "vfxCatalog.parameter.turbulence.seed.label"
      },
      "speed": {
        "labelKey": "vfxCatalog.parameter.turbulence.speed.label"
      }
    }
  },
  "tint": {
    "nameKey": "vfxCatalog.effect.tint",
    "categoryKey": "vfxCatalog.category.color",
    "params": {
      "effectStrength": {
        "labelKey": "vfxCatalog.parameter.tint.effectStrength.label"
      },
      "color": {
        "labelKey": "vfxCatalog.parameter.tint.color.label"
      },
      "mix": {
        "labelKey": "vfxCatalog.parameter.tint.mix.label"
      },
      "blend": {
        "labelKey": "vfxCatalog.parameter.tint.blend.label",
        "optionKeys": [
          "vfxCatalog.parameter.tint.blend.option.normal",
          "vfxCatalog.parameter.tint.blend.option.multiply",
          "vfxCatalog.parameter.tint.blend.option.screen",
          "vfxCatalog.parameter.tint.blend.option.overlay",
          "vfxCatalog.parameter.tint.blend.option.color",
          "vfxCatalog.parameter.tint.blend.option.add"
        ]
      }
    }
  },
  "glow": {
    "nameKey": "vfxCatalog.effect.glow",
    "categoryKey": "vfxCatalog.category.light",
    "params": {
      "effectStrength": {
        "labelKey": "vfxCatalog.parameter.glow.effectStrength.label"
      },
      "color": {
        "labelKey": "vfxCatalog.parameter.glow.color.label"
      },
      "radius": {
        "labelKey": "vfxCatalog.parameter.glow.radius.label"
      },
      "intensity": {
        "labelKey": "vfxCatalog.parameter.glow.intensity.label"
      },
      "mode": {
        "labelKey": "vfxCatalog.parameter.glow.mode.label",
        "optionKeys": [
          "vfxCatalog.parameter.glow.mode.option.outer",
          "vfxCatalog.parameter.glow.mode.option.inner",
          "vfxCatalog.parameter.glow.mode.option.both"
        ]
      },
      "spread": {
        "labelKey": "vfxCatalog.parameter.glow.spread.label"
      },
      "falloff": {
        "labelKey": "vfxCatalog.parameter.glow.falloff.label"
      },
      "coreColor": {
        "labelKey": "vfxCatalog.parameter.glow.coreColor.label"
      },
      "coreMix": {
        "labelKey": "vfxCatalog.parameter.glow.coreMix.label"
      },
      "blend": {
        "labelKey": "vfxCatalog.parameter.glow.blend.label",
        "optionKeys": [
          "vfxCatalog.parameter.glow.blend.option.normal",
          "vfxCatalog.parameter.glow.blend.option.add",
          "vfxCatalog.parameter.glow.blend.option.screen"
        ]
      },
      "source": {
        "labelKey": "vfxCatalog.parameter.glow.source.label",
        "optionKeys": [
          "vfxCatalog.parameter.glow.source.option.color",
          "vfxCatalog.parameter.glow.source.option.artwork"
        ]
      }
    }
  },
  "outline": {
    "nameKey": "vfxCatalog.effect.outline",
    "categoryKey": "vfxCatalog.category.light",
    "params": {
      "effectStrength": {
        "labelKey": "vfxCatalog.parameter.outline.effectStrength.label"
      },
      "color": {
        "labelKey": "vfxCatalog.parameter.outline.color.label"
      },
      "width": {
        "labelKey": "vfxCatalog.parameter.outline.width.label"
      },
      "opacity": {
        "labelKey": "vfxCatalog.parameter.outline.opacity.label"
      },
      "mode": {
        "labelKey": "vfxCatalog.parameter.outline.mode.label",
        "optionKeys": [
          "vfxCatalog.parameter.outline.mode.option.outside",
          "vfxCatalog.parameter.outline.mode.option.inside",
          "vfxCatalog.parameter.outline.mode.option.center"
        ]
      },
      "rounded": {
        "labelKey": "vfxCatalog.parameter.outline.rounded.label",
        "optionKeys": [
          "vfxCatalog.parameter.outline.rounded.option.off",
          "vfxCatalog.parameter.outline.rounded.option.on"
        ]
      },
      "only": {
        "labelKey": "vfxCatalog.parameter.outline.only.label",
        "optionKeys": [
          "vfxCatalog.parameter.outline.only.option.off",
          "vfxCatalog.parameter.outline.only.option.on"
        ]
      },
      "softness": {
        "labelKey": "vfxCatalog.parameter.outline.softness.label"
      }
    }
  },
  "shadow": {
    "nameKey": "vfxCatalog.effect.shadow",
    "categoryKey": "vfxCatalog.category.light",
    "params": {
      "effectStrength": {
        "labelKey": "vfxCatalog.parameter.shadow.effectStrength.label"
      },
      "color": {
        "labelKey": "vfxCatalog.parameter.shadow.color.label"
      },
      "radius": {
        "labelKey": "vfxCatalog.parameter.shadow.radius.label"
      },
      "offsetX": {
        "labelKey": "vfxCatalog.parameter.shadow.offsetX.label"
      },
      "offsetY": {
        "labelKey": "vfxCatalog.parameter.shadow.offsetY.label"
      },
      "opacity": {
        "labelKey": "vfxCatalog.parameter.shadow.opacity.label"
      },
      "spread": {
        "labelKey": "vfxCatalog.parameter.shadow.spread.label"
      },
      "mode": {
        "labelKey": "vfxCatalog.parameter.shadow.mode.label",
        "optionKeys": [
          "vfxCatalog.parameter.shadow.mode.option.outer",
          "vfxCatalog.parameter.shadow.mode.option.inner"
        ]
      }
    }
  },
  "blur": {
    "nameKey": "vfxCatalog.effect.blur",
    "categoryKey": "vfxCatalog.category.blur",
    "params": {
      "effectStrength": {
        "labelKey": "vfxCatalog.parameter.blur.effectStrength.label"
      },
      "mode": {
        "labelKey": "vfxCatalog.parameter.blur.mode.label",
        "optionKeys": [
          "vfxCatalog.parameter.blur.mode.option.gaussian",
          "vfxCatalog.parameter.blur.mode.option.directional",
          "vfxCatalog.parameter.blur.mode.option.zoom",
          "vfxCatalog.parameter.blur.mode.option.radial"
        ]
      },
      "radius": {
        "labelKey": "vfxCatalog.parameter.blur.radius.label"
      },
      "angle": {
        "labelKey": "vfxCatalog.parameter.blur.angle.label"
      },
      "centerX": {
        "labelKey": "vfxCatalog.parameter.blur.centerX.label"
      },
      "centerY": {
        "labelKey": "vfxCatalog.parameter.blur.centerY.label"
      }
    }
  },
  "grade": {
    "nameKey": "vfxCatalog.effect.grade",
    "categoryKey": "vfxCatalog.category.color",
    "params": {
      "effectStrength": {
        "labelKey": "vfxCatalog.parameter.grade.effectStrength.label"
      },
      "exposure": {
        "labelKey": "vfxCatalog.parameter.grade.exposure.label"
      },
      "contrast": {
        "labelKey": "vfxCatalog.parameter.grade.contrast.label"
      },
      "saturation": {
        "labelKey": "vfxCatalog.parameter.grade.saturation.label"
      },
      "temperature": {
        "labelKey": "vfxCatalog.parameter.grade.temperature.label"
      },
      "tint": {
        "labelKey": "vfxCatalog.parameter.grade.tint.label"
      },
      "shadows": {
        "labelKey": "vfxCatalog.parameter.grade.shadows.label"
      },
      "highlights": {
        "labelKey": "vfxCatalog.parameter.grade.highlights.label"
      },
      "gamma": {
        "labelKey": "vfxCatalog.parameter.grade.gamma.label"
      },
      "hue": {
        "labelKey": "vfxCatalog.parameter.grade.hue.label"
      }
    }
  },
  "pixelate": {
    "nameKey": "vfxCatalog.effect.pixelate",
    "categoryKey": "vfxCatalog.category.texture",
    "params": {
      "effectStrength": {
        "labelKey": "vfxCatalog.parameter.pixelate.effectStrength.label"
      },
      "size": {
        "labelKey": "vfxCatalog.parameter.pixelate.size.label"
      },
      "linked": {
        "labelKey": "vfxCatalog.parameter.pixelate.linked.label",
        "optionKeys": [
          "vfxCatalog.parameter.pixelate.linked.option.off",
          "vfxCatalog.parameter.pixelate.linked.option.on"
        ]
      },
      "sizeY": {
        "labelKey": "vfxCatalog.parameter.pixelate.sizeY.label"
      },
      "offsetX": {
        "labelKey": "vfxCatalog.parameter.pixelate.offsetX.label"
      },
      "offsetY": {
        "labelKey": "vfxCatalog.parameter.pixelate.offsetY.label"
      }
    }
  },
  "noise": {
    "nameKey": "vfxCatalog.effect.noise",
    "categoryKey": "vfxCatalog.category.texture",
    "params": {
      "effectStrength": {
        "labelKey": "vfxCatalog.parameter.noise.effectStrength.label"
      },
      "amount": {
        "labelKey": "vfxCatalog.parameter.noise.amount.label"
      },
      "size": {
        "labelKey": "vfxCatalog.parameter.noise.size.label"
      },
      "colored": {
        "labelKey": "vfxCatalog.parameter.noise.colored.label",
        "optionKeys": [
          "vfxCatalog.parameter.noise.colored.option.off",
          "vfxCatalog.parameter.noise.colored.option.on"
        ]
      },
      "pattern": {
        "labelKey": "vfxCatalog.parameter.noise.pattern.label",
        "optionKeys": [
          "vfxCatalog.parameter.noise.pattern.option.grain",
          "vfxCatalog.parameter.noise.pattern.option.clouds"
        ]
      },
      "contrast": {
        "labelKey": "vfxCatalog.parameter.noise.contrast.label"
      },
      "softness": {
        "labelKey": "vfxCatalog.parameter.noise.softness.label"
      },
      "seed": {
        "labelKey": "vfxCatalog.parameter.noise.seed.label"
      },
      "phase": {
        "labelKey": "vfxCatalog.parameter.noise.phase.label"
      },
      "speed": {
        "labelKey": "vfxCatalog.parameter.noise.speed.label"
      }
    }
  },
  "vignette": {
    "nameKey": "vfxCatalog.effect.vignette",
    "categoryKey": "vfxCatalog.category.color",
    "params": {
      "effectStrength": {
        "labelKey": "vfxCatalog.parameter.vignette.effectStrength.label"
      },
      "amount": {
        "labelKey": "vfxCatalog.parameter.vignette.amount.label"
      },
      "softness": {
        "labelKey": "vfxCatalog.parameter.vignette.softness.label"
      },
      "color": {
        "labelKey": "vfxCatalog.parameter.vignette.color.label"
      },
      "centerX": {
        "labelKey": "vfxCatalog.parameter.vignette.centerX.label"
      },
      "centerY": {
        "labelKey": "vfxCatalog.parameter.vignette.centerY.label"
      },
      "roundness": {
        "labelKey": "vfxCatalog.parameter.vignette.roundness.label"
      },
      "aspect": {
        "labelKey": "vfxCatalog.parameter.vignette.aspect.label"
      },
      "radius": {
        "labelKey": "vfxCatalog.parameter.vignette.radius.label"
      }
    }
  },
  "dissolve": {
    "nameKey": "vfxCatalog.effect.dissolve",
    "categoryKey": "vfxCatalog.category.distort",
    "params": {
      "effectStrength": {
        "labelKey": "vfxCatalog.parameter.dissolve.effectStrength.label"
      },
      "progress": {
        "labelKey": "vfxCatalog.parameter.dissolve.progress.label"
      },
      "size": {
        "labelKey": "vfxCatalog.parameter.dissolve.size.label"
      },
      "edge": {
        "labelKey": "vfxCatalog.parameter.dissolve.edge.label"
      },
      "color": {
        "labelKey": "vfxCatalog.parameter.dissolve.color.label"
      },
      "softness": {
        "labelKey": "vfxCatalog.parameter.dissolve.softness.label"
      },
      "seed": {
        "labelKey": "vfxCatalog.parameter.dissolve.seed.label"
      },
      "directional": {
        "labelKey": "vfxCatalog.parameter.dissolve.directional.label"
      },
      "angle": {
        "labelKey": "vfxCatalog.parameter.dissolve.angle.label"
      }
    }
  },
  "rgbSplit": {
    "nameKey": "vfxCatalog.effect.rgbSplit",
    "categoryKey": "vfxCatalog.category.distort",
    "params": {
      "effectStrength": {
        "labelKey": "vfxCatalog.parameter.rgbSplit.effectStrength.label"
      },
      "amount": {
        "labelKey": "vfxCatalog.parameter.rgbSplit.amount.label"
      },
      "angle": {
        "labelKey": "vfxCatalog.parameter.rgbSplit.angle.label"
      },
      "red": {
        "labelKey": "vfxCatalog.parameter.rgbSplit.red.label"
      },
      "green": {
        "labelKey": "vfxCatalog.parameter.rgbSplit.green.label"
      },
      "blue": {
        "labelKey": "vfxCatalog.parameter.rgbSplit.blue.label"
      }
    }
  },
  "wave": {
    "nameKey": "vfxCatalog.effect.wave",
    "categoryKey": "vfxCatalog.category.distort",
    "params": {
      "effectStrength": {
        "labelKey": "vfxCatalog.parameter.wave.effectStrength.label"
      },
      "strength": {
        "labelKey": "vfxCatalog.parameter.wave.strength.label"
      },
      "wavelength": {
        "labelKey": "vfxCatalog.parameter.wave.wavelength.label"
      },
      "angle": {
        "labelKey": "vfxCatalog.parameter.wave.angle.label"
      },
      "phase": {
        "labelKey": "vfxCatalog.parameter.wave.phase.label"
      },
      "speed": {
        "labelKey": "vfxCatalog.parameter.wave.speed.label"
      }
    }
  },
  "shockwave": {
    "nameKey": "vfxCatalog.effect.shockwave",
    "categoryKey": "vfxCatalog.category.distort",
    "params": {
      "effectStrength": {
        "labelKey": "vfxCatalog.parameter.shockwave.effectStrength.label"
      },
      "radius": {
        "labelKey": "vfxCatalog.parameter.shockwave.radius.label"
      },
      "thickness": {
        "labelKey": "vfxCatalog.parameter.shockwave.thickness.label"
      },
      "strength": {
        "labelKey": "vfxCatalog.parameter.shockwave.strength.label"
      },
      "centerX": {
        "labelKey": "vfxCatalog.parameter.shockwave.centerX.label"
      },
      "centerY": {
        "labelKey": "vfxCatalog.parameter.shockwave.centerY.label"
      },
      "falloff": {
        "labelKey": "vfxCatalog.parameter.shockwave.falloff.label"
      }
    }
  },
  "bloom": {
    "nameKey": "vfxCatalog.effect.bloom",
    "categoryKey": "vfxCatalog.category.light",
    "params": {
      "effectStrength": {
        "labelKey": "vfxCatalog.parameter.bloom.effectStrength.label"
      },
      "threshold": {
        "labelKey": "vfxCatalog.parameter.bloom.threshold.label"
      },
      "softness": {
        "labelKey": "vfxCatalog.parameter.bloom.softness.label"
      },
      "radius": {
        "labelKey": "vfxCatalog.parameter.bloom.radius.label"
      },
      "intensity": {
        "labelKey": "vfxCatalog.parameter.bloom.intensity.label"
      },
      "color": {
        "labelKey": "vfxCatalog.parameter.bloom.color.label"
      }
    }
  },
  "lightSweep": {
    "nameKey": "vfxCatalog.effect.lightSweep",
    "categoryKey": "vfxCatalog.category.light",
    "params": {
      "effectStrength": {
        "labelKey": "vfxCatalog.parameter.lightSweep.effectStrength.label"
      },
      "position": {
        "labelKey": "vfxCatalog.parameter.lightSweep.position.label"
      },
      "angle": {
        "labelKey": "vfxCatalog.parameter.lightSweep.angle.label"
      },
      "width": {
        "labelKey": "vfxCatalog.parameter.lightSweep.width.label"
      },
      "softness": {
        "labelKey": "vfxCatalog.parameter.lightSweep.softness.label"
      },
      "intensity": {
        "labelKey": "vfxCatalog.parameter.lightSweep.intensity.label"
      },
      "color": {
        "labelKey": "vfxCatalog.parameter.lightSweep.color.label"
      },
      "speed": {
        "labelKey": "vfxCatalog.parameter.lightSweep.speed.label"
      },
      "loop": {
        "labelKey": "vfxCatalog.parameter.lightSweep.loop.label",
        "optionKeys": [
          "vfxCatalog.parameter.lightSweep.loop.option.off",
          "vfxCatalog.parameter.lightSweep.loop.option.on"
        ]
      }
    }
  },
  "crt": {
    "nameKey": "vfxCatalog.effect.crt",
    "categoryKey": "vfxCatalog.category.texture",
    "params": {
      "effectStrength": {
        "labelKey": "vfxCatalog.parameter.crt.effectStrength.label"
      },
      "amount": {
        "labelKey": "vfxCatalog.parameter.crt.amount.label"
      },
      "spacing": {
        "labelKey": "vfxCatalog.parameter.crt.spacing.label"
      },
      "curvature": {
        "labelKey": "vfxCatalog.parameter.crt.curvature.label"
      },
      "chromatic": {
        "labelKey": "vfxCatalog.parameter.crt.chromatic.label"
      },
      "phase": {
        "labelKey": "vfxCatalog.parameter.crt.phase.label"
      },
      "color": {
        "labelKey": "vfxCatalog.parameter.crt.color.label"
      },
      "roll": {
        "labelKey": "vfxCatalog.parameter.crt.roll.label"
      }
    }
  },
  "particles": {
    "nameKey": "vfxCatalog.effect.particles",
    "categoryKey": "vfxCatalog.category.generate",
    "params": {
      "effectStrength": {
        "labelKey": "vfxCatalog.parameter.particles.effectStrength.label"
      },
      "emission": {
        "labelKey": "vfxCatalog.parameter.particles.emission.label",
        "optionKeys": [
          "vfxCatalog.parameter.particles.emission.option.continuous",
          "vfxCatalog.parameter.particles.emission.option.burst"
        ]
      },
      "rate": {
        "labelKey": "vfxCatalog.parameter.particles.rate.label"
      },
      "count": {
        "labelKey": "vfxCatalog.parameter.particles.count.label"
      },
      "life": {
        "labelKey": "vfxCatalog.parameter.particles.life.label"
      },
      "look": {
        "labelKey": "vfxCatalog.parameter.particles.look.label",
        "optionKeys": [
          "vfxCatalog.parameter.particles.look.option.softGlow",
          "vfxCatalog.parameter.particles.look.option.spark",
          "vfxCatalog.parameter.particles.look.option.dot",
          "vfxCatalog.parameter.particles.look.option.ring",
          "vfxCatalog.parameter.particles.look.option.shard",
          "vfxCatalog.parameter.particles.look.option.smoke",
          "vfxCatalog.parameter.particles.look.option.star",
          "vfxCatalog.parameter.particles.look.option.bokeh",
          "vfxCatalog.parameter.particles.look.option.flame",
          "vfxCatalog.parameter.particles.look.option.cartoonCloud",
          "vfxCatalog.parameter.particles.look.option.cartoonFlame",
          "vfxCatalog.parameter.particles.look.option.leaf",
          "vfxCatalog.parameter.particles.look.option.petal",
          "vfxCatalog.parameter.particles.look.option.snowflake",
          "vfxCatalog.parameter.particles.look.option.drop",
          "vfxCatalog.parameter.particles.look.option.heart",
          "vfxCatalog.parameter.particles.look.option.cartoonStar",
          "vfxCatalog.parameter.particles.look.option.pixel",
          "vfxCatalog.parameter.particles.look.option.lightning",
          "vfxCatalog.parameter.particles.look.option.wisp",
          "vfxCatalog.parameter.particles.look.option.rock",
          "vfxCatalog.parameter.particles.look.option.splat",
          "vfxCatalog.parameter.particles.look.option.burst"
        ]
      },
      "color": {
        "labelKey": "vfxCatalog.parameter.particles.color.label"
      },
      "size": {
        "labelKey": "vfxCatalog.parameter.particles.size.label"
      },
      "speed": {
        "labelKey": "vfxCatalog.parameter.particles.speed.label"
      },
      "direction": {
        "labelKey": "vfxCatalog.parameter.particles.direction.label"
      },
      "spread": {
        "labelKey": "vfxCatalog.parameter.particles.spread.label"
      },
      "gravity": {
        "labelKey": "vfxCatalog.parameter.particles.gravity.label"
      },
      "shape": {
        "labelKey": "vfxCatalog.parameter.particles.shape.label",
        "optionKeys": [
          "vfxCatalog.parameter.particles.shape.option.targetPoint",
          "vfxCatalog.parameter.particles.shape.option.circle",
          "vfxCatalog.parameter.particles.shape.option.body",
          "vfxCatalog.parameter.particles.shape.option.line"
        ]
      },
      "radius": {
        "labelKey": "vfxCatalog.parameter.particles.radius.label"
      },
      "endSize": {
        "labelKey": "vfxCatalog.parameter.particles.endSize.label"
      },
      "sizeMode": {
        "labelKey": "vfxCatalog.parameter.particles.sizeMode.label",
        "optionKeys": [
          "vfxCatalog.parameter.particles.sizeMode.option.auto",
          "vfxCatalog.parameter.particles.sizeMode.option.growOrShrink",
          "vfxCatalog.parameter.particles.sizeMode.option.puffOut",
          "vfxCatalog.parameter.particles.sizeMode.option.pop",
          "vfxCatalog.parameter.particles.sizeMode.option.flicker"
        ]
      },
      "variation": {
        "labelKey": "vfxCatalog.parameter.particles.variation.label"
      },
      "drag": {
        "labelKey": "vfxCatalog.parameter.particles.drag.label"
      },
      "wind": {
        "labelKey": "vfxCatalog.parameter.particles.wind.label"
      },
      "turbulence": {
        "labelKey": "vfxCatalog.parameter.particles.turbulence.label"
      },
      "flow": {
        "labelKey": "vfxCatalog.parameter.particles.flow.label"
      },
      "swirl": {
        "labelKey": "vfxCatalog.parameter.particles.swirl.label"
      },
      "rotation": {
        "labelKey": "vfxCatalog.parameter.particles.rotation.label",
        "optionKeys": [
          "vfxCatalog.parameter.particles.rotation.option.auto",
          "vfxCatalog.parameter.particles.rotation.option.random",
          "vfxCatalog.parameter.particles.rotation.option.followMotion",
          "vfxCatalog.parameter.particles.rotation.option.upright",
          "vfxCatalog.parameter.particles.rotation.option.none"
        ]
      },
      "spin": {
        "labelKey": "vfxCatalog.parameter.particles.spin.label"
      },
      "stretch": {
        "labelKey": "vfxCatalog.parameter.particles.stretch.label"
      },
      "fade": {
        "labelKey": "vfxCatalog.parameter.particles.fade.label"
      },
      "twinkle": {
        "labelKey": "vfxCatalog.parameter.particles.twinkle.label"
      },
      "shading": {
        "labelKey": "vfxCatalog.parameter.particles.shading.label"
      },
      "glow": {
        "labelKey": "vfxCatalog.parameter.particles.glow.label"
      },
      "trail": {
        "labelKey": "vfxCatalog.parameter.particles.trail.label"
      },
      "outline": {
        "labelKey": "vfxCatalog.parameter.particles.outline.label",
        "optionKeys": [
          "vfxCatalog.parameter.particles.outline.option.off",
          "vfxCatalog.parameter.particles.outline.option.on"
        ]
      },
      "outlineColor": {
        "labelKey": "vfxCatalog.parameter.particles.outlineColor.label"
      },
      "outlineWidth": {
        "labelKey": "vfxCatalog.parameter.particles.outlineWidth.label"
      },
      "colorMode": {
        "labelKey": "vfxCatalog.parameter.particles.colorMode.label",
        "optionKeys": [
          "vfxCatalog.parameter.particles.colorMode.option.overLifetime",
          "vfxCatalog.parameter.particles.colorMode.option.randomPerParticle"
        ]
      },
      "blend": {
        "labelKey": "vfxCatalog.parameter.particles.blend.label",
        "optionKeys": [
          "vfxCatalog.parameter.particles.blend.option.auto",
          "vfxCatalog.parameter.particles.blend.option.glow",
          "vfxCatalog.parameter.particles.blend.option.solid"
        ]
      },
      "space": {
        "labelKey": "vfxCatalog.parameter.particles.space.label",
        "optionKeys": [
          "vfxCatalog.parameter.particles.space.option.leaveATrail",
          "vfxCatalog.parameter.particles.space.option.followTarget"
        ]
      },
      "ground": {
        "labelKey": "vfxCatalog.parameter.particles.ground.label",
        "optionKeys": [
          "vfxCatalog.parameter.particles.ground.option.off",
          "vfxCatalog.parameter.particles.ground.option.on"
        ]
      },
      "layer": {
        "labelKey": "vfxCatalog.parameter.particles.layer.label",
        "optionKeys": [
          "vfxCatalog.parameter.particles.layer.option.inFrontOfTarget",
          "vfxCatalog.parameter.particles.layer.option.behindTarget"
        ]
      },
      "delay": {
        "labelKey": "vfxCatalog.parameter.particles.delay.label"
      },
      "step": {
        "labelKey": "vfxCatalog.parameter.particles.step.label",
        "optionKeys": [
          "vfxCatalog.parameter.particles.step.option.onesSmooth",
          "vfxCatalog.parameter.particles.step.option.twos",
          "vfxCatalog.parameter.particles.step.option.threes"
        ]
      },
      "seed": {
        "labelKey": "vfxCatalog.parameter.particles.seed.label"
      },
      "gravityAngle": {
        "labelKey": "vfxCatalog.parameter.particles.gravityAngle.label"
      },
      "fadeIn": {
        "labelKey": "vfxCatalog.parameter.particles.fadeIn.label"
      },
      "bounce": {
        "labelKey": "vfxCatalog.parameter.particles.bounce.label"
      },
      "prefill": {
        "labelKey": "vfxCatalog.parameter.particles.prefill.label",
        "optionKeys": [
          "vfxCatalog.parameter.particles.prefill.option.auto",
          "vfxCatalog.parameter.particles.prefill.option.off",
          "vfxCatalog.parameter.particles.prefill.option.on"
        ]
      },
      "timeScale": {
        "labelKey": "vfxCatalog.parameter.particles.timeScale.label"
      },
      "unique": {
        "labelKey": "vfxCatalog.parameter.particles.unique.label",
        "optionKeys": [
          "vfxCatalog.parameter.particles.unique.option.off",
          "vfxCatalog.parameter.particles.unique.option.on"
        ]
      },
      "x": {
        "labelKey": "vfxCatalog.parameter.particles.x.label"
      },
      "y": {
        "labelKey": "vfxCatalog.parameter.particles.y.label"
      }
    }
  },
  "aura": {
    "nameKey": "vfxCatalog.effect.aura",
    "categoryKey": "vfxCatalog.category.generate",
    "params": {
      "effectStrength": {
        "labelKey": "vfxCatalog.parameter.aura.effectStrength.label"
      },
      "style": {
        "labelKey": "vfxCatalog.parameter.aura.style.label",
        "optionKeys": [
          "vfxCatalog.parameter.aura.style.option.fire",
          "vfxCatalog.parameter.aura.style.option.electric",
          "vfxCatalog.parameter.aura.style.option.shadow",
          "vfxCatalog.parameter.aura.style.option.holy",
          "vfxCatalog.parameter.aura.style.option.ice",
          "vfxCatalog.parameter.aura.style.option.wind",
          "vfxCatalog.parameter.aura.style.option.cartoon",
          "vfxCatalog.parameter.aura.style.option.spirit"
        ]
      },
      "color": {
        "labelKey": "vfxCatalog.parameter.aura.color.label"
      },
      "intensity": {
        "labelKey": "vfxCatalog.parameter.aura.intensity.label"
      },
      "height": {
        "labelKey": "vfxCatalog.parameter.aura.height.label"
      },
      "density": {
        "labelKey": "vfxCatalog.parameter.aura.density.label"
      },
      "turbulence": {
        "labelKey": "vfxCatalog.parameter.aura.turbulence.label"
      },
      "dust": {
        "labelKey": "vfxCatalog.parameter.aura.dust.label",
        "optionKeys": [
          "vfxCatalog.parameter.aura.dust.option.off",
          "vfxCatalog.parameter.aura.dust.option.on"
        ]
      },
      "flames": {
        "labelKey": "vfxCatalog.parameter.aura.flames.label",
        "optionKeys": [
          "vfxCatalog.parameter.aura.flames.option.off",
          "vfxCatalog.parameter.aura.flames.option.on"
        ]
      },
      "glow": {
        "labelKey": "vfxCatalog.parameter.aura.glow.label",
        "optionKeys": [
          "vfxCatalog.parameter.aura.glow.option.off",
          "vfxCatalog.parameter.aura.glow.option.on"
        ]
      },
      "embers": {
        "labelKey": "vfxCatalog.parameter.aura.embers.label",
        "optionKeys": [
          "vfxCatalog.parameter.aura.embers.option.off",
          "vfxCatalog.parameter.aura.embers.option.on"
        ]
      },
      "trail": {
        "labelKey": "vfxCatalog.parameter.aura.trail.label",
        "optionKeys": [
          "vfxCatalog.parameter.aura.trail.option.off",
          "vfxCatalog.parameter.aura.trail.option.on"
        ]
      },
      "blend": {
        "labelKey": "vfxCatalog.parameter.aura.blend.label",
        "optionKeys": [
          "vfxCatalog.parameter.aura.blend.option.auto",
          "vfxCatalog.parameter.aura.blend.option.glow",
          "vfxCatalog.parameter.aura.blend.option.solid"
        ]
      },
      "delay": {
        "labelKey": "vfxCatalog.parameter.aura.delay.label"
      },
      "step": {
        "labelKey": "vfxCatalog.parameter.aura.step.label",
        "optionKeys": [
          "vfxCatalog.parameter.aura.step.option.onesSmooth",
          "vfxCatalog.parameter.aura.step.option.twos",
          "vfxCatalog.parameter.aura.step.option.threes"
        ]
      },
      "seed": {
        "labelKey": "vfxCatalog.parameter.aura.seed.label"
      },
      "width": {
        "labelKey": "vfxCatalog.parameter.aura.width.label"
      },
      "layer": {
        "labelKey": "vfxCatalog.parameter.aura.layer.label",
        "optionKeys": [
          "vfxCatalog.parameter.aura.layer.option.behindAndInFront",
          "vfxCatalog.parameter.aura.layer.option.behindTarget",
          "vfxCatalog.parameter.aura.layer.option.inFrontOfTarget"
        ]
      },
      "prefill": {
        "labelKey": "vfxCatalog.parameter.aura.prefill.label",
        "optionKeys": [
          "vfxCatalog.parameter.aura.prefill.option.auto",
          "vfxCatalog.parameter.aura.prefill.option.off",
          "vfxCatalog.parameter.aura.prefill.option.on"
        ]
      },
      "timeScale": {
        "labelKey": "vfxCatalog.parameter.aura.timeScale.label"
      },
      "unique": {
        "labelKey": "vfxCatalog.parameter.aura.unique.label",
        "optionKeys": [
          "vfxCatalog.parameter.aura.unique.option.off",
          "vfxCatalog.parameter.aura.unique.option.on"
        ]
      }
    }
  },
  "beam": {
    "nameKey": "vfxCatalog.effect.beam",
    "categoryKey": "vfxCatalog.category.generate",
    "params": {
      "effectStrength": {
        "labelKey": "vfxCatalog.parameter.beam.effectStrength.label"
      },
      "style": {
        "labelKey": "vfxCatalog.parameter.beam.style.label",
        "optionKeys": [
          "vfxCatalog.parameter.beam.style.option.energy",
          "vfxCatalog.parameter.beam.style.option.laser",
          "vfxCatalog.parameter.beam.style.option.cartoon",
          "vfxCatalog.parameter.beam.style.option.spiral",
          "vfxCatalog.parameter.beam.style.option.lightning",
          "vfxCatalog.parameter.beam.style.option.fireBreath"
        ]
      },
      "color": {
        "labelKey": "vfxCatalog.parameter.beam.color.label"
      },
      "width": {
        "labelKey": "vfxCatalog.parameter.beam.width.label"
      },
      "intensity": {
        "labelKey": "vfxCatalog.parameter.beam.intensity.label"
      },
      "charge": {
        "labelKey": "vfxCatalog.parameter.beam.charge.label"
      },
      "travel": {
        "labelKey": "vfxCatalog.parameter.beam.travel.label"
      },
      "wobble": {
        "labelKey": "vfxCatalog.parameter.beam.wobble.label"
      },
      "aimX": {
        "labelKey": "vfxCatalog.parameter.beam.aimX.label"
      },
      "aimY": {
        "labelKey": "vfxCatalog.parameter.beam.aimY.label"
      },
      "aimUid": {
        "labelKey": "vfxCatalog.parameter.beam.aimUid.label"
      },
      "aimHandle": {
        "labelKey": "vfxCatalog.parameter.beam.aimHandle.label"
      },
      "arcs": {
        "labelKey": "vfxCatalog.parameter.beam.arcs.label"
      },
      "sparks": {
        "labelKey": "vfxCatalog.parameter.beam.sparks.label"
      },
      "chargeParticles": {
        "labelKey": "vfxCatalog.parameter.beam.chargeParticles.label",
        "optionKeys": [
          "vfxCatalog.parameter.beam.chargeParticles.option.off",
          "vfxCatalog.parameter.beam.chargeParticles.option.on"
        ]
      },
      "orb": {
        "labelKey": "vfxCatalog.parameter.beam.orb.label",
        "optionKeys": [
          "vfxCatalog.parameter.beam.orb.option.off",
          "vfxCatalog.parameter.beam.orb.option.on"
        ]
      },
      "splash": {
        "labelKey": "vfxCatalog.parameter.beam.splash.label",
        "optionKeys": [
          "vfxCatalog.parameter.beam.splash.option.off",
          "vfxCatalog.parameter.beam.splash.option.on"
        ]
      },
      "layer": {
        "labelKey": "vfxCatalog.parameter.beam.layer.label",
        "optionKeys": [
          "vfxCatalog.parameter.beam.layer.option.inFrontOfTarget",
          "vfxCatalog.parameter.beam.layer.option.behindTarget"
        ]
      },
      "blend": {
        "labelKey": "vfxCatalog.parameter.beam.blend.label",
        "optionKeys": [
          "vfxCatalog.parameter.beam.blend.option.auto",
          "vfxCatalog.parameter.beam.blend.option.glow",
          "vfxCatalog.parameter.beam.blend.option.solid"
        ]
      },
      "delay": {
        "labelKey": "vfxCatalog.parameter.beam.delay.label"
      },
      "step": {
        "labelKey": "vfxCatalog.parameter.beam.step.label",
        "optionKeys": [
          "vfxCatalog.parameter.beam.step.option.onesSmooth",
          "vfxCatalog.parameter.beam.step.option.twos",
          "vfxCatalog.parameter.beam.step.option.threes"
        ]
      },
      "seed": {
        "labelKey": "vfxCatalog.parameter.beam.seed.label"
      },
      "strands": {
        "labelKey": "vfxCatalog.parameter.beam.strands.label",
        "optionKeys": [
          "vfxCatalog.parameter.beam.strands.option.off",
          "vfxCatalog.parameter.beam.strands.option.on"
        ]
      },
      "prefill": {
        "labelKey": "vfxCatalog.parameter.beam.prefill.label",
        "optionKeys": [
          "vfxCatalog.parameter.beam.prefill.option.auto",
          "vfxCatalog.parameter.beam.prefill.option.off",
          "vfxCatalog.parameter.beam.prefill.option.on"
        ]
      },
      "timeScale": {
        "labelKey": "vfxCatalog.parameter.beam.timeScale.label"
      },
      "unique": {
        "labelKey": "vfxCatalog.parameter.beam.unique.label",
        "optionKeys": [
          "vfxCatalog.parameter.beam.unique.option.off",
          "vfxCatalog.parameter.beam.unique.option.on"
        ]
      },
      "x": {
        "labelKey": "vfxCatalog.parameter.beam.x.label"
      },
      "y": {
        "labelKey": "vfxCatalog.parameter.beam.y.label"
      }
    }
  },
  "smoke": {
    "nameKey": "vfxCatalog.effect.smoke",
    "categoryKey": "vfxCatalog.category.generate",
    "params": {
      "effectStrength": {
        "labelKey": "vfxCatalog.parameter.smoke.effectStrength.label"
      },
      "style": {
        "labelKey": "vfxCatalog.parameter.smoke.style.label",
        "optionKeys": [
          "vfxCatalog.parameter.smoke.style.option.soft",
          "vfxCatalog.parameter.smoke.style.option.thick",
          "vfxCatalog.parameter.smoke.style.option.steam",
          "vfxCatalog.parameter.smoke.style.option.cartoon",
          "vfxCatalog.parameter.smoke.style.option.dust"
        ]
      },
      "color": {
        "labelKey": "vfxCatalog.parameter.smoke.color.label"
      },
      "amount": {
        "labelKey": "vfxCatalog.parameter.smoke.amount.label"
      },
      "size": {
        "labelKey": "vfxCatalog.parameter.smoke.size.label"
      },
      "rise": {
        "labelKey": "vfxCatalog.parameter.smoke.rise.label"
      },
      "wind": {
        "labelKey": "vfxCatalog.parameter.smoke.wind.label"
      },
      "life": {
        "labelKey": "vfxCatalog.parameter.smoke.life.label"
      },
      "emission": {
        "labelKey": "vfxCatalog.parameter.smoke.emission.label",
        "optionKeys": [
          "vfxCatalog.parameter.smoke.emission.option.continuous",
          "vfxCatalog.parameter.smoke.emission.option.burst"
        ]
      },
      "count": {
        "labelKey": "vfxCatalog.parameter.smoke.count.label"
      },
      "spread": {
        "labelKey": "vfxCatalog.parameter.smoke.spread.label"
      },
      "growth": {
        "labelKey": "vfxCatalog.parameter.smoke.growth.label"
      },
      "turbulence": {
        "labelKey": "vfxCatalog.parameter.smoke.turbulence.label"
      },
      "shading": {
        "labelKey": "vfxCatalog.parameter.smoke.shading.label"
      },
      "space": {
        "labelKey": "vfxCatalog.parameter.smoke.space.label",
        "optionKeys": [
          "vfxCatalog.parameter.smoke.space.option.leaveATrail",
          "vfxCatalog.parameter.smoke.space.option.followTarget"
        ]
      },
      "layer": {
        "labelKey": "vfxCatalog.parameter.smoke.layer.label",
        "optionKeys": [
          "vfxCatalog.parameter.smoke.layer.option.inFrontOfTarget",
          "vfxCatalog.parameter.smoke.layer.option.behindTarget"
        ]
      },
      "delay": {
        "labelKey": "vfxCatalog.parameter.smoke.delay.label"
      },
      "step": {
        "labelKey": "vfxCatalog.parameter.smoke.step.label",
        "optionKeys": [
          "vfxCatalog.parameter.smoke.step.option.onesSmooth",
          "vfxCatalog.parameter.smoke.step.option.twos",
          "vfxCatalog.parameter.smoke.step.option.threes"
        ]
      },
      "seed": {
        "labelKey": "vfxCatalog.parameter.smoke.seed.label"
      },
      "opacity": {
        "labelKey": "vfxCatalog.parameter.smoke.opacity.label"
      },
      "direction": {
        "labelKey": "vfxCatalog.parameter.smoke.direction.label"
      },
      "prefill": {
        "labelKey": "vfxCatalog.parameter.smoke.prefill.label",
        "optionKeys": [
          "vfxCatalog.parameter.smoke.prefill.option.auto",
          "vfxCatalog.parameter.smoke.prefill.option.off",
          "vfxCatalog.parameter.smoke.prefill.option.on"
        ]
      },
      "timeScale": {
        "labelKey": "vfxCatalog.parameter.smoke.timeScale.label"
      },
      "unique": {
        "labelKey": "vfxCatalog.parameter.smoke.unique.label",
        "optionKeys": [
          "vfxCatalog.parameter.smoke.unique.option.off",
          "vfxCatalog.parameter.smoke.unique.option.on"
        ]
      },
      "x": {
        "labelKey": "vfxCatalog.parameter.smoke.x.label"
      },
      "y": {
        "labelKey": "vfxCatalog.parameter.smoke.y.label"
      }
    }
  },
  "explosion": {
    "nameKey": "vfxCatalog.effect.explosion",
    "categoryKey": "vfxCatalog.category.generate",
    "params": {
      "effectStrength": {
        "labelKey": "vfxCatalog.parameter.explosion.effectStrength.label"
      },
      "style": {
        "labelKey": "vfxCatalog.parameter.explosion.style.label",
        "optionKeys": [
          "vfxCatalog.parameter.explosion.style.option.fireball",
          "vfxCatalog.parameter.explosion.style.option.cartoon",
          "vfxCatalog.parameter.explosion.style.option.plasma",
          "vfxCatalog.parameter.explosion.style.option.smokeBomb",
          "vfxCatalog.parameter.explosion.style.option.mushroomCloud",
          "vfxCatalog.parameter.explosion.style.option.firework",
          "vfxCatalog.parameter.explosion.style.option.electric",
          "vfxCatalog.parameter.explosion.style.option.magic",
          "vfxCatalog.parameter.explosion.style.option.dust",
          "vfxCatalog.parameter.explosion.style.option.pixel"
        ]
      },
      "color": {
        "labelKey": "vfxCatalog.parameter.explosion.color.label"
      },
      "size": {
        "labelKey": "vfxCatalog.parameter.explosion.size.label"
      },
      "intensity": {
        "labelKey": "vfxCatalog.parameter.explosion.intensity.label"
      },
      "density": {
        "labelKey": "vfxCatalog.parameter.explosion.density.label"
      },
      "debris": {
        "labelKey": "vfxCatalog.parameter.explosion.debris.label"
      },
      "smoke": {
        "labelKey": "vfxCatalog.parameter.explosion.smoke.label"
      },
      "sparks": {
        "labelKey": "vfxCatalog.parameter.explosion.sparks.label",
        "optionKeys": [
          "vfxCatalog.parameter.explosion.sparks.option.off",
          "vfxCatalog.parameter.explosion.sparks.option.on"
        ]
      },
      "dust": {
        "labelKey": "vfxCatalog.parameter.explosion.dust.label",
        "optionKeys": [
          "vfxCatalog.parameter.explosion.dust.option.off",
          "vfxCatalog.parameter.explosion.dust.option.on"
        ]
      },
      "flash": {
        "labelKey": "vfxCatalog.parameter.explosion.flash.label",
        "optionKeys": [
          "vfxCatalog.parameter.explosion.flash.option.off",
          "vfxCatalog.parameter.explosion.flash.option.on"
        ]
      },
      "ring": {
        "labelKey": "vfxCatalog.parameter.explosion.ring.label",
        "optionKeys": [
          "vfxCatalog.parameter.explosion.ring.option.off",
          "vfxCatalog.parameter.explosion.ring.option.on"
        ]
      },
      "fireball": {
        "labelKey": "vfxCatalog.parameter.explosion.fireball.label",
        "optionKeys": [
          "vfxCatalog.parameter.explosion.fireball.option.off",
          "vfxCatalog.parameter.explosion.fireball.option.on"
        ]
      },
      "blend": {
        "labelKey": "vfxCatalog.parameter.explosion.blend.label",
        "optionKeys": [
          "vfxCatalog.parameter.explosion.blend.option.auto",
          "vfxCatalog.parameter.explosion.blend.option.glow",
          "vfxCatalog.parameter.explosion.blend.option.solid"
        ]
      },
      "delay": {
        "labelKey": "vfxCatalog.parameter.explosion.delay.label"
      },
      "step": {
        "labelKey": "vfxCatalog.parameter.explosion.step.label",
        "optionKeys": [
          "vfxCatalog.parameter.explosion.step.option.onesSmooth",
          "vfxCatalog.parameter.explosion.step.option.twos",
          "vfxCatalog.parameter.explosion.step.option.threes"
        ]
      },
      "seed": {
        "labelKey": "vfxCatalog.parameter.explosion.seed.label"
      },
      "layer": {
        "labelKey": "vfxCatalog.parameter.explosion.layer.label",
        "optionKeys": [
          "vfxCatalog.parameter.explosion.layer.option.behindAndInFront",
          "vfxCatalog.parameter.explosion.layer.option.behindTarget",
          "vfxCatalog.parameter.explosion.layer.option.inFrontOfTarget"
        ]
      },
      "timeScale": {
        "labelKey": "vfxCatalog.parameter.explosion.timeScale.label"
      },
      "unique": {
        "labelKey": "vfxCatalog.parameter.explosion.unique.label",
        "optionKeys": [
          "vfxCatalog.parameter.explosion.unique.option.off",
          "vfxCatalog.parameter.explosion.unique.option.on"
        ]
      },
      "x": {
        "labelKey": "vfxCatalog.parameter.explosion.x.label"
      },
      "y": {
        "labelKey": "vfxCatalog.parameter.explosion.y.label"
      }
    }
  }
});
export const presetMessages = Object.freeze({
  "Power up": {
    "nameKey": "vfxCatalog.preset.powerUp",
    "categoryKey": "vfxCatalog.category.looks"
  },
  "Teleport": {
    "nameKey": "vfxCatalog.preset.teleport",
    "categoryKey": "vfxCatalog.category.looks"
  },
  "Impact": {
    "nameKey": "vfxCatalog.preset.impact",
    "categoryKey": "vfxCatalog.category.looks"
  },
  "Hologram": {
    "nameKey": "vfxCatalog.preset.hologram",
    "categoryKey": "vfxCatalog.category.looks"
  },
  "Ice": {
    "nameKey": "vfxCatalog.preset.ice",
    "categoryKey": "vfxCatalog.category.looks"
  },
  "Poison": {
    "nameKey": "vfxCatalog.preset.poison",
    "categoryKey": "vfxCatalog.category.looks"
  },
  "Neon": {
    "nameKey": "vfxCatalog.preset.neon",
    "categoryKey": "vfxCatalog.category.looks"
  },
  "Golden hour": {
    "nameKey": "vfxCatalog.preset.goldenHour",
    "categoryKey": "vfxCatalog.category.looks"
  },
  "Retro screen": {
    "nameKey": "vfxCatalog.preset.retroScreen",
    "categoryKey": "vfxCatalog.category.looks"
  },
  "Energy": {
    "nameKey": "vfxCatalog.preset.energy",
    "categoryKey": "vfxCatalog.category.looks"
  },
  "Hit flash": {
    "nameKey": "vfxCatalog.preset.hitFlash",
    "categoryKey": "vfxCatalog.category.looks"
  },
  "Ghost": {
    "nameKey": "vfxCatalog.preset.ghost",
    "categoryKey": "vfxCatalog.category.looks"
  },
  "Retro": {
    "nameKey": "vfxCatalog.preset.retro",
    "categoryKey": "vfxCatalog.category.looks"
  }
});
export const categoryMessages = Object.freeze({
  "Distort": "vfxCatalog.category.distort",
  "Color": "vfxCatalog.category.color",
  "Light": "vfxCatalog.category.light",
  "Blur": "vfxCatalog.category.blur",
  "Texture": "vfxCatalog.category.texture",
  "Generate": "vfxCatalog.category.generate",
  "Looks": "vfxCatalog.category.looks"
});
