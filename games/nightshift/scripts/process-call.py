"""uv run --with numpy --with scipy process-call.py STEM_DIR OUTPUT.mp3

Kit's authorized v4 performance, processed offline; never plays audio.
"""
import json
import subprocess
import sys
from pathlib import Path
import numpy as np
from scipy.signal import butter, sosfilt

source, output = map(Path, sys.argv[1:])
rate, duration = 24000, 16
rng = np.random.default_rng(87)
voice = np.zeros(rate * duration)
starts = [1.0, 4.5, 7.0, 11.6]
for i, start in enumerate(starts):
    raw = subprocess.check_output(["ffmpeg", "-v", "error", "-i", str(source / f"kit-jay-{i+1}.mp3"),
        "-af", "aresample=24000,asetrate=22800,aresample=24000,atempo=0.95", "-ac", "1", "-f", "f32le", "-"])
    samples = np.frombuffer(raw, dtype="<f4").copy()
    samples *= .48 / max(.001, np.max(np.abs(samples)))
    begin = round(start * rate)
    voice[begin:begin+len(samples)] += samples
voice = sosfilt(butter(4, [300, 3400], btype="bandpass", fs=rate, output="sos"), voice)
double = sosfilt(butter(2, [1000, 2800], btype="bandpass", fs=rate, output="sos"), voice)
delay = round(.047 * rate)
voice[delay:] += double[:-delay] * .14
# Quiet 10-bit codec grit, two very short line dropouts, stable seeded hiss.
voice = np.round(voice * 512) / 512
for start in [6.04, 10.2]:
    at = int(start*rate)
    voice[at:at+int(.024*rate)] *= .15
t = np.arange(len(voice))/rate
hiss = sosfilt(butter(2, [500, 3400], btype="bandpass", fs=rate, output="sos"), rng.normal(0, .0025, len(voice)))
mix = voice + hiss * np.minimum(1, t*15) * np.clip((duration-t)*5, 0, 1)
for start, level in [(0.15,.04),(5.9,.012),(10.7,.018),(14,.12)]:
    n = int(.025*rate); at = int(start*rate)
    mix[at:at+n] += rng.normal(0,level,n)*np.exp(-np.arange(n)/(rate*.004))
tone = .022*(np.sin(2*np.pi*350*t)+np.sin(2*np.pi*440*t))
mix += tone*np.clip((t-14.2)*20,0,1)*np.clip((duration-t)*5,0,1)
mix *= .8 / np.max(np.abs(mix))
output.parent.mkdir(parents=True, exist_ok=True)
subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(rate), "-ac", "1", "-i", "-",
    "-c:a", "libmp3lame", "-b:a", "128k", str(output)], input=mix.astype("<f4").tobytes(), check=True)
receipt = {"duration":duration,"stem_starts":starts,"pitch_ratio":.95,"tempo":.95,"band_hz":[300,3400],
    "double_delay_ms":47,"peak_dbfs":float(20*np.log10(np.max(np.abs(mix)))),"rms_dbfs":float(20*np.log10(np.sqrt(np.mean(mix*mix))))}
output.with_suffix(".json").write_text(json.dumps(receipt, indent=2))
print(json.dumps(receipt))
