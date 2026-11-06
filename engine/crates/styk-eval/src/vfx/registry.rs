//! The effect vocabulary (`VFX_REGISTRY` in src/vfx-registry.mjs): every type,
//! its typed parameters with their defaults and ranges, and `neutralVfx`.
//!
//! Each type is a struct with one field per saved parameter, in the order the
//! registry declares them (`effectStrength` first). Numbers are `f64`, colours
//! [`Color`], options their own enums, switches `bool` and discrete integers
//! (seeds, counts) `u32`. [`Params::get`] and [`Params::set`] address the same
//! fields by position in [`Kind::specs`], for the code that treats every
//! parameter alike (loading, keys, tweening, comparing with the editor).

use std::sync::Arc;

use crate::doc::Paint;

/// A parameter's value as saved, keyed and sampled: a number (colours given as
/// an RGB integer included), or a normalized paint for a colour given as one.
#[derive(Clone, Debug, PartialEq)]
pub enum ParamValue {
    Num(f64),
    Paint(Arc<Paint>),
}

/// How a parameter is saved and how it animates.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ParamKind {
    /// A continuous number: interpolates, and is clamped to its range when poses tween.
    Number,
    /// A discrete integer (seeds, counts): holds.
    Integer,
    /// Off or on, saved as 0 or 1: holds.
    Toggle,
    /// One of a list of options, saved as its index: holds.
    Choice,
    /// An RGB integer or a paint: interpolates as a colour.
    Color,
}

impl ParamKind {
    /// `descriptor.discrete`: the value holds between keys.
    pub fn discrete(self) -> bool {
        matches!(self, ParamKind::Integer | ParamKind::Toggle | ParamKind::Choice)
    }
}

/// One parameter of an effect type (a registry descriptor, without its interface fields).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Spec {
    /// The saved name (`params.<name>`, `vfx1:type:id:<name>`).
    pub name: &'static str,
    pub kind: ParamKind,
    /// For colours, the RGB integer.
    pub default: f64,
    pub min: f64,
    pub max: f64,
}

/// An effect colour: the legacy RGB integer (`0xRRGGBB`) or a normalized paint
/// (solid, linear, radial, angular or diamond, up to 32 stops).
#[derive(Clone, Debug, PartialEq)]
pub enum Color {
    Rgb(u32),
    Paint(Arc<Paint>),
}

/// A typed parameter field.
pub trait Param: Sized {
    const KIND: ParamKind;
    fn value(&self) -> ParamValue;
    /// `None` when `value` is not one this field holds (the loader checks ranges first).
    fn from_value(value: &ParamValue) -> Option<Self>;
}

impl Param for f64 {
    const KIND: ParamKind = ParamKind::Number;
    fn value(&self) -> ParamValue {
        ParamValue::Num(*self)
    }
    fn from_value(value: &ParamValue) -> Option<Self> {
        match value {
            ParamValue::Num(n) => Some(*n),
            ParamValue::Paint(_) => None,
        }
    }
}

impl Param for u32 {
    const KIND: ParamKind = ParamKind::Integer;
    fn value(&self) -> ParamValue {
        ParamValue::Num(*self as f64)
    }
    fn from_value(value: &ParamValue) -> Option<Self> {
        match value {
            ParamValue::Num(n) if n.fract() == 0.0 && (0.0..=u32::MAX as f64).contains(n) => Some(*n as u32),
            _ => None,
        }
    }
}

impl Param for bool {
    const KIND: ParamKind = ParamKind::Toggle;
    fn value(&self) -> ParamValue {
        ParamValue::Num(if *self { 1.0 } else { 0.0 })
    }
    fn from_value(value: &ParamValue) -> Option<Self> {
        match value {
            ParamValue::Num(n) if *n == 0.0 || *n == 1.0 => Some(*n == 1.0),
            _ => None,
        }
    }
}

impl Param for Color {
    const KIND: ParamKind = ParamKind::Color;
    fn value(&self) -> ParamValue {
        match self {
            Color::Rgb(rgb) => ParamValue::Num(*rgb as f64),
            Color::Paint(paint) => ParamValue::Paint(paint.clone()),
        }
    }
    fn from_value(value: &ParamValue) -> Option<Self> {
        match value {
            ParamValue::Num(n) if n.fract() == 0.0 && (0.0..=16777215.0).contains(n) => Some(Color::Rgb(*n as u32)),
            ParamValue::Num(_) => None,
            ParamValue::Paint(paint) => Some(Color::Paint(paint.clone())),
        }
    }
}

fn assign<T: Param>(field: &mut T, value: &ParamValue) -> bool {
    match T::from_value(value) {
        Some(v) => {
            *field = v;
            true
        }
        None => false,
    }
}

/// An option list (`choice(...)` in the registry): saved as the option's index.
macro_rules! choice {
    ($($(#[$meta:meta])* $name:ident { $($variant:ident),+ $(,)? })*) => {$(
        $(#[$meta])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
        #[repr(u8)]
        pub enum $name { $($variant),+ }
        impl $name {
            pub const ALL: &'static [$name] = &[$($name::$variant),+];
            /// The saved value: the option's position in the list.
            pub fn index(self) -> u8 {
                self as u8
            }
        }
        impl Param for $name {
            const KIND: ParamKind = ParamKind::Choice;
            fn value(&self) -> ParamValue {
                ParamValue::Num(*self as u8 as f64)
            }
            fn from_value(value: &ParamValue) -> Option<Self> {
                match value {
                    ParamValue::Num(n) if n.fract() == 0.0 && *n >= 0.0 => Self::ALL.get(*n as usize).copied(),
                    _ => None,
                }
            }
        }
    )*};
}

choice! {
    /// Glow placement.
    GlowPlacement { Outer, Inner, Both }
    /// Glow blending.
    GlowBlend { Normal, Add, Screen }
    /// Outline placement.
    OutlinePlacement { Outside, Inside, Center }
    /// Shadow placement.
    ShadowPlacement { Outer, Inner }
    BlurMode { Gaussian, Directional, Zoom, Radial }
    NoisePattern { Grain, Clouds }
    Emission { Continuous, Burst }
    ParticleLook { SoftGlow, Spark, Dot, Ring, Shard, Smoke, Star, Bokeh, Flame, CartoonCloud, CartoonFlame, Leaf, Petal, Snowflake, Drop, Heart, CartoonStar, Pixel, Lightning, Wisp, Rock, Splat, Burst }
    /// Particles "Emit from".
    EmitShape { TargetPoint, Circle, Body, Line }
    SizeMode { Auto, GrowOrShrink, PuffOut, Pop, Flicker }
    ParticleRotation { Auto, Random, FollowMotion, Upright, None }
    ColorMode { OverLifetime, RandomPerParticle }
    /// Blending of generated effects: Auto glows on dark scenes, stays solid on light ones.
    GeneratorBlend { Auto, Glow, Solid }
    /// Whether particles stay where they were born or move with their target.
    Space { LeaveTrail, FollowTarget }
    /// Generated artwork in front of or behind its target.
    DrawLayer { InFront, Behind }
    /// "Animate on" ones, twos or threes.
    AnimateOn { Ones, Twos, Threes }
    AuraStyle { Fire, Electric, Shadow, Holy, Ice, Wind, Cartoon, Spirit }
    BeamStyle { Energy, Laser, Cartoon, Spiral, Lightning, FireBreath }
    SmokeStyle { Soft, Thick, Steam, Cartoon, Dust }
    ExplosionStyle { Fireball, Cartoon, Plasma, SmokeBomb, MushroomCloud, Firework, Electric, Magic, Dust, Pixel }
}

const EFFECT_STRENGTH: Spec = Spec { name: "effectStrength", kind: ParamKind::Number, default: 1.0, min: 0.0, max: 1.0 };

/// Declares every effect type: a struct per type, [`Kind`] and [`Params`].
macro_rules! effects {
    ($(
        $(#[$meta:meta])*
        $variant:ident = $js:literal, $label:literal, $category:literal, generator: $generator:literal, scene_only: $scene_only:literal {
            $($field:ident: $ty:ty = ($name:literal, $default:expr, $min:expr, $max:expr)),* $(,)?
        }
    )*) => {
        $(
            $(#[$meta])*
            #[derive(Clone, Debug, PartialEq)]
            pub struct $variant {
                /// `effectStrength`: mixes the finished effect with its input (the opacity of a generated effect), 0–1.
                pub effect_strength: f64,
                $(pub $field: $ty,)*
            }
            impl $variant {
                /// The parameters in the registry's order, `effectStrength` first.
                pub const SPECS: &'static [Spec] = &[
                    EFFECT_STRENGTH,
                    $(Spec { name: $name, kind: <$ty as Param>::KIND, default: $default as f64, min: $min as f64, max: $max as f64 },)*
                ];
                const GET: &'static [fn(&Self) -> ParamValue] = &[|p| p.effect_strength.value(), $(|p| p.$field.value(),)*];
                const SET: &'static [fn(&mut Self, &ParamValue) -> bool] = &[|p, v| assign(&mut p.effect_strength, v), $(|p, v| assign(&mut p.$field, v),)*];
            }
            impl Default for $variant {
                fn default() -> Self {
                    $variant {
                        effect_strength: 1.0,
                        $($field: <$ty as Param>::from_value(&ParamValue::Num($default as f64)).expect("registry defaults are valid"),)*
                    }
                }
            }
        )*

        /// An effect type.
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
        pub enum Kind { $($variant,)* }

        impl Kind {
            /// Every type, in the registry's order.
            pub const ALL: &'static [Kind] = &[$(Kind::$variant,)*];
            /// The saved name (`effect.type`).
            pub fn name(self) -> &'static str {
                match self { $(Kind::$variant => $js,)* }
            }
            pub fn from_name(name: &str) -> Option<Kind> {
                match name { $($js => Some(Kind::$variant),)* _ => None }
            }
            /// The catalogue's English name.
            pub fn label(self) -> &'static str {
                match self { $(Kind::$variant => $label,)* }
            }
            pub fn category(self) -> &'static str {
                match self { $(Kind::$variant => $category,)* }
            }
            /// `isGeneratorType`: creates artwork instead of filtering it; lives only in effect clips.
            pub fn is_generator(self) -> bool {
                match self { $(Kind::$variant => $generator,)* }
            }
            /// `definition.scene`: a camera effect, offered for the scene only.
            pub fn scene_only(self) -> bool {
                match self { $(Kind::$variant => $scene_only,)* }
            }
            /// `VFX_SCENE_TYPES.has(type)` (src/vfx-registry.mjs): whether the effect may go in
            /// the scene's stack.
            pub fn on_scene(self) -> bool {
                matches!(self.name(), "tint" | "blur" | "grade" | "pixelate" | "noise" | "vignette" | "dissolve" | "rgbSplit" | "wave" | "shockwave" | "bloom" | "lightSweep" | "crt" | "turbulence" | "particles" | "beam" | "explosion" | "smoke")
            }
            /// The parameters, `effectStrength` first.
            pub fn specs(self) -> &'static [Spec] {
                match self { $(Kind::$variant => $variant::SPECS,)* }
            }
            /// The position of a parameter in [`Kind::specs`].
            pub fn param(self, name: &str) -> Option<usize> {
                self.specs().iter().position(|spec| spec.name == name)
            }
        }

        /// The resolved parameters of one effect.
        #[derive(Clone, Debug, PartialEq)]
        pub enum Params { $($variant($variant),)* }

        impl Params {
            pub fn kind(&self) -> Kind {
                match self { $(Params::$variant(_) => Kind::$variant,)* }
            }
            /// Every parameter at its default.
            pub fn defaults(kind: Kind) -> Params {
                match kind { $(Kind::$variant => Params::$variant($variant::default()),)* }
            }
            /// Parameter `index` of [`Kind::specs`].
            pub fn get(&self, index: usize) -> ParamValue {
                match self { $(Params::$variant(p) => $variant::GET[index](p),)* }
            }
            /// Sets parameter `index`; false when the value is not one it holds.
            pub fn set(&mut self, index: usize, value: &ParamValue) -> bool {
                match self { $(Params::$variant(p) => $variant::SET[index](p, value),)* }
            }
            pub fn effect_strength(&self) -> f64 {
                match self { $(Params::$variant(p) => p.effect_strength,)* }
            }
            pub fn set_effect_strength(&mut self, value: f64) {
                match self { $(Params::$variant(p) => p.effect_strength = value,)* }
            }
        }
    };
}

effects! {
    Turbulence = "turbulence", "Turbulent displacement", "Distort", generator: false, scene_only: false {
        amount: f64 = ("amount", 12, 0, 128),
        size: f64 = ("size", 48, 4, 512),
        evolution: f64 = ("evolution", 0, -10000, 10000),
        detail: u32 = ("detail", 3, 1, 4),
        seed: u32 = ("seed", 1, 0, 65535),
    }
    Tint = "tint", "Tint", "Color", generator: false, scene_only: false {
        color: Color = ("color", 0x66ccff, 0, 0xffffff),
        mix: f64 = ("mix", 0.5, 0, 1),
    }
    Glow = "glow", "Glow", "Light", generator: false, scene_only: false {
        color: Color = ("color", 0x66ccff, 0, 0xffffff),
        radius: f64 = ("radius", 12, 0, 128),
        intensity: f64 = ("intensity", 0.8, 0, 3),
        mode: GlowPlacement = ("mode", 0, 0, 2),
        spread: f64 = ("spread", 0, 0, 64),
        falloff: f64 = ("falloff", 1, 0.2, 4),
        core_color: Color = ("coreColor", 0xffffff, 0, 0xffffff),
        core_mix: f64 = ("coreMix", 0, 0, 1),
        blend: GlowBlend = ("blend", 0, 0, 2),
    }
    Outline = "outline", "Outline", "Light", generator: false, scene_only: false {
        color: Color = ("color", 0x111111, 0, 0xffffff),
        width: f64 = ("width", 3, 0, 64),
        opacity: f64 = ("opacity", 1, 0, 1),
        mode: OutlinePlacement = ("mode", 0, 0, 2),
        rounded: bool = ("rounded", 1, 0, 1),
        only: bool = ("only", 0, 0, 1),
    }
    Shadow = "shadow", "Shadow", "Light", generator: false, scene_only: false {
        color: Color = ("color", 0, 0, 0xffffff),
        radius: f64 = ("radius", 8, 0, 128),
        offset_x: f64 = ("offsetX", 8, -256, 256),
        offset_y: f64 = ("offsetY", 8, -256, 256),
        opacity: f64 = ("opacity", 0.5, 0, 1),
        spread: f64 = ("spread", 0, 0, 64),
        mode: ShadowPlacement = ("mode", 0, 0, 1),
    }
    Blur = "blur", "Blur", "Blur", generator: false, scene_only: false {
        mode: BlurMode = ("mode", 0, 0, 3),
        radius: f64 = ("radius", 4, 0, 128),
        angle: f64 = ("angle", 0, -180, 180),
        center_x: f64 = ("centerX", 0.5, 0, 1),
        center_y: f64 = ("centerY", 0.5, 0, 1),
    }
    Grade = "grade", "Color grading", "Color", generator: false, scene_only: false {
        exposure: f64 = ("exposure", 0, -5, 5),
        contrast: f64 = ("contrast", 1, 0, 3),
        saturation: f64 = ("saturation", 1, 0, 3),
        temperature: f64 = ("temperature", 0, -1, 1),
        tint: f64 = ("tint", 0, -1, 1),
        shadows: f64 = ("shadows", 0, -1, 1),
        highlights: f64 = ("highlights", 0, -1, 1),
        gamma: f64 = ("gamma", 1, 0.1, 4),
    }
    Pixelate = "pixelate", "Pixelate", "Texture", generator: false, scene_only: false {
        size: f64 = ("size", 8, 1, 128),
        linked: bool = ("linked", 1, 0, 1),
        size_y: f64 = ("sizeY", 8, 1, 128),
        offset_x: f64 = ("offsetX", 0, -128, 128),
        offset_y: f64 = ("offsetY", 0, -128, 128),
    }
    Noise = "noise", "Noise", "Texture", generator: false, scene_only: false {
        amount: f64 = ("amount", 0.12, 0, 1),
        size: f64 = ("size", 1, 1, 64),
        colored: bool = ("colored", 0, 0, 1),
        pattern: NoisePattern = ("pattern", 0, 0, 1),
        contrast: f64 = ("contrast", 1, 0, 4),
        softness: f64 = ("softness", 0, 0, 1),
        seed: u32 = ("seed", 1, 0, 65535),
        phase: f64 = ("phase", 0, 0, 1000000),
    }
    Vignette = "vignette", "Vignette", "Color", generator: false, scene_only: false {
        amount: f64 = ("amount", 0.4, 0, 1),
        softness: f64 = ("softness", 0.6, 0.01, 1),
        color: Color = ("color", 0, 0, 0xffffff),
        center_x: f64 = ("centerX", 0.5, 0, 1),
        center_y: f64 = ("centerY", 0.5, 0, 1),
        roundness: f64 = ("roundness", 1, 0, 1),
        aspect: f64 = ("aspect", 1, 0.2, 5),
        radius: f64 = ("radius", 1, 0.1, 2),
    }
    Dissolve = "dissolve", "Dissolve", "Distort", generator: false, scene_only: false {
        progress: f64 = ("progress", 0.35, 0, 1),
        size: f64 = ("size", 24, 1, 256),
        edge: f64 = ("edge", 0.08, 0, 0.5),
        color: Color = ("color", 0xff8800, 0, 0xffffff),
        softness: f64 = ("softness", 0.03, 0.001, 0.2),
        seed: u32 = ("seed", 1, 0, 65535),
    }
    RgbSplit = "rgbSplit", "RGB split", "Distort", generator: false, scene_only: false {
        amount: f64 = ("amount", 6, 0, 128),
        angle: f64 = ("angle", 0, -180, 180),
        red: f64 = ("red", 1, -2, 2),
        green: f64 = ("green", 0, -2, 2),
        blue: f64 = ("blue", -1, -2, 2),
    }
    Wave = "wave", "Wave distortion", "Distort", generator: false, scene_only: false {
        strength: f64 = ("strength", 8, 0, 128),
        wavelength: f64 = ("wavelength", 64, 4, 512),
        angle: f64 = ("angle", 0, -180, 180),
        phase: f64 = ("phase", 0, -360, 360),
    }
    Shockwave = "shockwave", "Shockwave", "Distort", generator: false, scene_only: true {
        radius: f64 = ("radius", 80, 0, 2000),
        thickness: f64 = ("thickness", 24, 1, 256),
        strength: f64 = ("strength", 12, -128, 128),
        center_x: f64 = ("centerX", 0.5, 0, 1),
        center_y: f64 = ("centerY", 0.5, 0, 1),
        falloff: f64 = ("falloff", 1, 0.2, 4),
    }
    Bloom = "bloom", "Bloom", "Light", generator: false, scene_only: false {
        threshold: f64 = ("threshold", 0.65, 0, 1),
        softness: f64 = ("softness", 0.2, 0.001, 1),
        radius: f64 = ("radius", 16, 0, 128),
        intensity: f64 = ("intensity", 0.8, 0, 3),
        color: Color = ("color", 0xffffff, 0, 0xffffff),
    }
    LightSweep = "lightSweep", "Light sweep", "Light", generator: false, scene_only: false {
        position: f64 = ("position", 0.5, -0.5, 1.5),
        angle: f64 = ("angle", 25, -180, 180),
        width: f64 = ("width", 0.2, 0.01, 1),
        softness: f64 = ("softness", 0.6, 0.01, 1),
        intensity: f64 = ("intensity", 0.8, 0, 3),
        color: Color = ("color", 0xffffff, 0, 0xffffff),
    }
    Crt = "crt", "CRT / scanlines", "Texture", generator: false, scene_only: true {
        amount: f64 = ("amount", 0.25, 0, 1),
        spacing: f64 = ("spacing", 3, 1, 32),
        curvature: f64 = ("curvature", 0, 0, 0.5),
        chromatic: f64 = ("chromatic", 0, 0, 16),
        phase: f64 = ("phase", 0, -32, 32),
        color: Color = ("color", 0, 0, 0xffffff),
    }
    Particles = "particles", "Particles", "Generate", generator: true, scene_only: false {
        emission: Emission = ("emission", 0, 0, 1),
        rate: f64 = ("rate", 6, 0, 200),
        count: f64 = ("count", 40, 1, 5000),
        life: f64 = ("life", 30, 1, 300),
        look: ParticleLook = ("look", 0, 0, 22),
        color: Color = ("color", 0x66ccff, 0, 0xffffff),
        size: f64 = ("size", 6, 0.5, 400),
        speed: f64 = ("speed", 3, 0, 120),
        direction: f64 = ("direction", -90, -180, 180),
        spread: f64 = ("spread", 60, 0, 360),
        gravity: f64 = ("gravity", 0, -3, 3),
        shape: EmitShape = ("shape", 0, 0, 3),
        radius: f64 = ("radius", 0, 0, 4000),
        end_size: f64 = ("endSize", 0.4, 0, 5),
        size_mode: SizeMode = ("sizeMode", 0, 0, 4),
        variation: f64 = ("variation", 0.4, 0, 1),
        drag: f64 = ("drag", 0, 0, 0.5),
        wind: f64 = ("wind", 0, -2, 2),
        turbulence: f64 = ("turbulence", 0, 0, 300),
        flow: f64 = ("flow", 0, 0, 300),
        swirl: f64 = ("swirl", 0, -30, 30),
        rotation: ParticleRotation = ("rotation", 0, 0, 4),
        spin: f64 = ("spin", 0, -45, 45),
        stretch: f64 = ("stretch", 2, 0, 20),
        fade: f64 = ("fade", 0.5, 0, 1),
        twinkle: f64 = ("twinkle", 0, 0, 1),
        shading: f64 = ("shading", 1, 0, 1),
        glow: f64 = ("glow", 0, 0, 2),
        trail: u32 = ("trail", 0, 0, 6),
        outline: bool = ("outline", 0, 0, 1),
        outline_color: Color = ("outlineColor", 0x16121c, 0, 0xffffff),
        outline_width: f64 = ("outlineWidth", 2, 0, 24),
        color_mode: ColorMode = ("colorMode", 0, 0, 1),
        blend: GeneratorBlend = ("blend", 0, 0, 2),
        space: Space = ("space", 0, 0, 1),
        ground: bool = ("ground", 0, 0, 1),
        layer: DrawLayer = ("layer", 0, 0, 1),
        delay: f64 = ("delay", 0, 0, 600),
        step: AnimateOn = ("step", 0, 0, 2),
        seed: u32 = ("seed", 1, 0, 65535),
        x: f64 = ("x", 0.5, -1, 2),
        y: f64 = ("y", 0.5, -1, 2),
    }
    Aura = "aura", "Aura", "Generate", generator: true, scene_only: false {
        style: AuraStyle = ("style", 0, 0, 7),
        color: Color = ("color", 0xffc93c, 0, 0xffffff),
        intensity: f64 = ("intensity", 1, 0, 3),
        height: f64 = ("height", 1, 0.2, 3),
        density: f64 = ("density", 1, 0.1, 4),
        turbulence: f64 = ("turbulence", 1, 0, 3),
        dust: bool = ("dust", 0, 0, 1),
        flames: bool = ("flames", 1, 0, 1),
        glow: bool = ("glow", 1, 0, 1),
        embers: bool = ("embers", 1, 0, 1),
        trail: bool = ("trail", 1, 0, 1),
        blend: GeneratorBlend = ("blend", 0, 0, 2),
        delay: f64 = ("delay", 0, 0, 600),
        step: AnimateOn = ("step", 0, 0, 2),
        seed: u32 = ("seed", 1, 0, 65535),
    }
    Beam = "beam", "Energy beam", "Generate", generator: true, scene_only: false {
        style: BeamStyle = ("style", 0, 0, 5),
        color: Color = ("color", 0x4fd2ff, 0, 0xffffff),
        width: f64 = ("width", 16, 1, 200),
        intensity: f64 = ("intensity", 1, 0, 3),
        charge: f64 = ("charge", 12, 0, 120),
        travel: f64 = ("travel", 6, 1, 60),
        wobble: f64 = ("wobble", 1, 0, 3),
        aim_x: f64 = ("aimX", 0.9, -1, 2),
        aim_y: f64 = ("aimY", 0.5, -1, 2),
        aim_uid: u32 = ("aimUid", 0, 0, 4294967295u32),
        aim_handle: u32 = ("aimHandle", 0, 0, 65535),
        arcs: u32 = ("arcs", 3, 0, 8),
        sparks: f64 = ("sparks", 1, 0, 4),
        charge_particles: bool = ("chargeParticles", 1, 0, 1),
        orb: bool = ("orb", 1, 0, 1),
        splash: bool = ("splash", 1, 0, 1),
        layer: DrawLayer = ("layer", 0, 0, 1),
        blend: GeneratorBlend = ("blend", 0, 0, 2),
        delay: f64 = ("delay", 0, 0, 600),
        step: AnimateOn = ("step", 0, 0, 2),
        seed: u32 = ("seed", 1, 0, 65535),
        x: f64 = ("x", 0.5, -1, 2),
        y: f64 = ("y", 0.5, -1, 2),
    }
    Smoke = "smoke", "Smoke", "Generate", generator: true, scene_only: false {
        style: SmokeStyle = ("style", 0, 0, 4),
        color: Color = ("color", 0x8a8794, 0, 0xffffff),
        amount: f64 = ("amount", 3, 0, 60),
        size: f64 = ("size", 24, 2, 400),
        rise: f64 = ("rise", 1.2, -6, 12),
        wind: f64 = ("wind", 0, -10, 10),
        life: f64 = ("life", 60, 4, 400),
        emission: Emission = ("emission", 0, 0, 1),
        count: f64 = ("count", 16, 1, 400),
        spread: f64 = ("spread", 12, 0, 2000),
        growth: f64 = ("growth", 3, 0.2, 8),
        turbulence: f64 = ("turbulence", 1, 0, 4),
        shading: f64 = ("shading", 1, 0, 1),
        space: Space = ("space", 0, 0, 1),
        layer: DrawLayer = ("layer", 0, 0, 1),
        delay: f64 = ("delay", 0, 0, 600),
        step: AnimateOn = ("step", 0, 0, 2),
        seed: u32 = ("seed", 1, 0, 65535),
        x: f64 = ("x", 0.5, -1, 2),
        y: f64 = ("y", 0.5, -1, 2),
    }
    Explosion = "explosion", "Explosion", "Generate", generator: true, scene_only: false {
        style: ExplosionStyle = ("style", 0, 0, 9),
        color: Color = ("color", 0xff8a2a, 0, 0xffffff),
        size: f64 = ("size", 1, 0.2, 5),
        intensity: f64 = ("intensity", 1, 0, 3),
        density: f64 = ("density", 1, 0.1, 4),
        debris: f64 = ("debris", 1, 0, 4),
        smoke: f64 = ("smoke", 1, 0, 4),
        sparks: bool = ("sparks", 1, 0, 1),
        dust: bool = ("dust", 1, 0, 1),
        flash: bool = ("flash", 1, 0, 1),
        ring: bool = ("ring", 1, 0, 1),
        fireball: bool = ("fireball", 1, 0, 1),
        blend: GeneratorBlend = ("blend", 0, 0, 2),
        delay: f64 = ("delay", 0, 0, 600),
        step: AnimateOn = ("step", 0, 0, 2),
        seed: u32 = ("seed", 1, 0, 65535),
        x: f64 = ("x", 0.5, -1, 2),
        y: f64 = ("y", 0.5, -1, 2),
    }
}

impl Kind {
    /// `effectAvailable`: whether the catalogue offers the type for the scene or for objects.
    pub fn available(self, scene: bool) -> bool {
        if scene {
            !matches!(self, Kind::Glow | Kind::Outline | Kind::Shadow | Kind::Aura)
        } else {
            !self.scene_only() && self != Kind::Vignette
        }
    }
}

impl Params {
    /// `neutralVfx`: an effect that leaves its input unchanged (dropped by
    /// [`crate::vfx::active`]). Generated effects are never neutral.
    pub fn neutral(&self) -> bool {
        if self.effect_strength() == 0.0 {
            return true;
        }
        match self {
            Params::Turbulence(p) => p.amount == 0.0,
            Params::Tint(p) => p.mix == 0.0,
            Params::Glow(p) => p.intensity == 0.0 && p.core_mix == 0.0,
            Params::Outline(p) => (p.width == 0.0 || p.opacity == 0.0) && !p.only,
            Params::Blur(p) => p.radius == 0.0,
            Params::Shadow(p) => p.opacity == 0.0,
            Params::Grade(p) => {
                p.exposure == 0.0 && p.contrast == 1.0 && p.saturation == 1.0 && p.temperature == 0.0 && p.tint == 0.0 && p.shadows == 0.0 && p.highlights == 0.0 && p.gamma == 1.0
            }
            Params::Pixelate(p) => p.size <= 1.0 && (p.linked || p.size_y <= 1.0),
            Params::Noise(p) => p.amount == 0.0,
            Params::Vignette(p) => p.amount == 0.0,
            Params::Dissolve(p) => p.progress == 0.0,
            Params::RgbSplit(p) => p.amount == 0.0,
            Params::Wave(p) => p.strength == 0.0,
            Params::Shockwave(p) => p.strength == 0.0,
            Params::Bloom(p) => p.intensity == 0.0,
            Params::LightSweep(p) => p.intensity == 0.0,
            Params::Crt(p) => p.amount == 0.0 && p.curvature == 0.0 && p.chromatic == 0.0,
            Params::Particles(_) | Params::Aura(_) | Params::Beam(_) | Params::Smoke(_) | Params::Explosion(_) => false,
        }
    }

    /// The generated effect's start delay (`delay`), or 0 for a filter.
    pub fn delay(&self) -> f64 {
        match self {
            Params::Particles(p) => p.delay,
            Params::Aura(p) => p.delay,
            Params::Beam(p) => p.delay,
            Params::Smoke(p) => p.delay,
            Params::Explosion(p) => p.delay,
            _ => 0.0,
        }
    }
}
