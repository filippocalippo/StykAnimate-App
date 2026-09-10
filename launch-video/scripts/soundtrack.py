"""Original 150 BPM electronic score and transition sound design; no sampled recordings."""
from pathlib import Path
import wave
import numpy as np

SR = 48000
DURATION = 32
BEAT = 0.4
rng = np.random.default_rng(517)
mix = np.zeros((SR * DURATION, 2), dtype=np.float64)

def add(signal, at, gain=1, pan=0):
    start = round(at * SR)
    if start >= len(mix):
        return
    if start < 0:
        signal = signal[-start:]
        start = 0
    n = min(len(signal), len(mix)-start)
    if n <= 0:
        return
    levels = np.array([np.sqrt((1-pan)/2), np.sqrt((1+pan)/2)])
    mix[start:start+n] += signal[:n, None] * levels * gain

def tone(freq, duration, kind='pluck'):
    t = np.arange(round(duration*SR)) / SR
    if kind == 'bass':
        s = np.sin(2*np.pi*freq*t) + .24*np.sin(2*np.pi*freq*2*t) + .10*np.sin(2*np.pi*freq*3*t)
        return np.tanh(s*1.3) * np.minimum(t/.008, 1) * np.exp(-t*7) * np.minimum((duration-t)/.035, 1)
    s = np.sin(2*np.pi*freq*t) + .3*np.sin(2*np.pi*freq*2.003*t) + .16*np.sin(2*np.pi*freq*3.002*t)
    return s * np.minimum(t/.004, 1) * np.exp(-t*9) * np.minimum((duration-t)/.03, 1)

def hz(midi): return 440 * 2**((midi-69)/12)

def kick():
    t = np.arange(round(.35*SR))/SR
    phase = 2*np.pi*(46*t+100*.019*(1-np.exp(-t/.019)))
    body = np.sin(phase)*np.exp(-t*12)
    click = rng.normal(0,1,len(t))*np.exp(-t*360)*.2
    return np.tanh(body*1.5)*.83+click

def hat(opened=False):
    t = np.arange(round((.20 if opened else .055)*SR))/SR
    n = rng.normal(0,1,len(t))
    hi = np.concatenate(([0],np.diff(n)))
    return hi*np.exp(-t*(25 if opened else 95))*.15

def clap():
    t = np.arange(round(.22*SR))/SR
    n = rng.normal(0,1,len(t))
    smooth = np.convolve(n,np.ones(4)/4,'same')
    band = smooth - np.convolve(smooth,np.ones(40)/40,'same')
    env = np.exp(-t*22)*.36
    for onset in [0,.011,.023]:
        env += np.where(t >= onset,np.exp(-np.maximum(t-onset,0)*160),0)*.45
    return band*env

# Pads: four spacious minor/add9 voicings, with a small stereo detune.
chords = [[50,57,60,64], [46,53,57,60], [53,60,64,67], [48,55,58,62]]
for block in range(10):
    start = block * 3.2
    t = np.arange(round(3.9*SR))/SR
    env = np.minimum(t/.16,1)*np.minimum((3.9-t)/.65,1)
    side = .35+.65*(1-np.exp(-(t % BEAT)*15))
    strength = .65 if start < 2.4 else 1
    for side_index, detune in [(-.65, .9988),(.65,1.0012)]:
        sig = np.zeros_like(t)
        for midi in chords[block % 4]:
            f=hz(midi)*detune
            sig += np.sin(2*np.pi*f*t)+.2*np.sin(2*np.pi*f*2*t)+.08*np.sin(2*np.pi*f*3*t)
        add(sig*env*side,start,.030*strength,side_index)

# Kick, tight claps, hat groove and syncopated bassline.
for beat in range(80):
    sec=beat*BEAT
    if sec >= 30.4: continue
    intro = sec < 2.4
    breakdown = 19.2 <= sec < 20
    add(kick(),sec,.62 if not intro else .38)
    if beat % 2 == 1 and not intro:
        add(clap(),sec,.46,0)
    if not breakdown:
        add(hat(),sec+.2,.38,(-1 if beat % 2 else 1)*.4)
        if not intro:
            add(hat(),sec+.1,.12,-.5)
            add(hat(beat % 4 == 3),sec+.3,.25,.5)
    midi = chords[int(sec/3.2)%4][0]-12
    for fraction, gain in [(0,.25),(.5,.20),(.75,.12)]:
        if intro and fraction != 0: continue
        add(tone(hz(midi + (12 if fraction == .75 else 0)),.22,'bass'),sec+fraction*BEAT,gain)

# A bright, repeating original melodic motif with stereo dotted delay.
motif=[0,2,1,3,2,1,3,1]
for step in range(148):
    sec=2.4+step*.2
    if sec >= 30.4: break
    chord=chords[int(sec/3.2)%4]
    midi=chord[motif[step%8]]+24
    note=tone(hz(midi),.5)
    gain=.072 if step%4 else .092
    if 16.8 <= sec < 20: gain*=1.25
    pan=(-.45 if step%2 else .45)
    add(note,sec,gain,pan)
    add(note,sec+.3,gain*.33,-pan)
    add(note,sec+.6,gain*.13,pan)

# Graphic transition whooshes: filtered stereo noise plus a resonant glide.
for cut in [2.4,7.2,12,16.8,20,24,28]:
    dur=.7
    t=np.arange(round(dur*SR))/SR
    raw=rng.normal(0,1,len(t))
    smooth=np.convolve(raw,np.ones(11)/11,'same')
    env=np.sin(np.pi*np.minimum(t/dur,1))**2
    phase=2*np.pi*(230*t + 1750*t*t)
    whoosh=(smooth*.45+np.sin(phase)*.09)*env
    add(whoosh,cut-.55,.3,-.3)
    add(whoosh,cut-.53,.22,.5)
    impact=tone(hz(26),.9,'bass')
    add(impact,cut,.55)

# Four precise opening ticks and one resolved closing chord.
for sec in [0,.4,.8,1.2]:
    add(tone(hz(86),.09),sec,.1,0)
for midi in [50,57,60,64,69]:
    t=np.arange(round(3.9*SR))/SR
    s=(np.sin(2*np.pi*hz(midi)*t)+.15*np.sin(2*np.pi*hz(midi)*2*t))*np.exp(-t*.9)*np.minimum(t/.012,1)
    add(s,28,.065,(midi-60)/30)

mix *= np.minimum(np.arange(len(mix))/SR/.012,1)[:,None]
mix *= np.minimum((DURATION-np.arange(len(mix))/SR)/.8,1)[:,None]
mix = np.tanh(mix*1.25)
mix *= .86 / max(np.abs(mix).max(),1e-8)
out=Path(__file__).resolve().parents[1]/'public'/'soundtrack-raw.wav'
with wave.open(str(out),'wb') as wav:
    wav.setnchannels(2)
    wav.setsampwidth(2)
    wav.setframerate(SR)
    wav.writeframes((mix*32767).astype('<i2').tobytes())
print(out)
