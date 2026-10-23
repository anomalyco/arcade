"""Author each stem with a telephone or wider-band small-room speaker treatment. Never plays audio."""
import json, subprocess, sys
from pathlib import Path
import numpy as np
from scipy.signal import butter, sosfilt
source, output, manifest = map(Path, sys.argv[1:])
rate=24000; rng=np.random.default_rng(874); records={}
output.mkdir(parents=True,exist_ok=True)
for path in sorted(source.glob('*.mp3')):
    meta=json.loads(path.with_suffix('.json').read_text())
    raw=subprocess.check_output(['ffmpeg','-v','error','-i',str(path),'-af','aresample=24000,asetrate=22800,aresample=24000','-ac','1','-f','f32le','-'])
    a=np.frombuffer(raw,dtype='<f4').copy(); active=np.flatnonzero(np.abs(a)>.002)
    if not len(active): raise ValueError(f'Silent stem {path}')
    a=a[max(0,active[0]-int(.15*rate)):min(len(a),active[-1]+int(.2*rate))]
    a*=.42/max(.001,np.max(np.abs(a)))
    phone=meta['room']=='floor'
    a=sosfilt(butter(4,[300,3400] if phone else [160,6200],btype='bandpass',fs=rate,output='sos'),a)
    dry=np.pad(a,(0,round(.3*rate))); a=dry.copy()
    # Same source, small early reflections; no theatrical long echo.
    for delay,gain in ([(.047,.14)] if phone else [(.023,.13),(.041,.1),(.067,.065),(.103,.035),(.171,.012)]):
        n=round(delay*rate);a[n:]+=dry[:-n]*gain
    if phone: a=np.round(a*512)/512
    # Match the lines perceptually without making a quiet whispered take jump up at its stressed word.
    target=10**((-39 if phone else -34)/20)
    a*=min(target/max(1e-8,np.sqrt(np.mean(a*a))),.42/max(.001,np.max(np.abs(a))))
    edge=min(int(.012*rate),len(a)//2);a[:edge]*=np.linspace(0,1,edge);a[-edge:]*=np.linspace(1,0,edge)
    file=output/(path.stem+'.mp3')
    subprocess.run(['ffmpeg','-v','error','-y','-f','f32le','-ar',str(rate),'-ac','1','-i','-','-c:a','libmp3lame','-b:a','128k',str(file)],input=a.astype('<f4').tobytes(),check=True)
    records[path.stem]={'duration':round(len(a)/rate,5),'speechEnd':round((len(a)-round(.3*rate))/rate,5),'filter':'phone' if phone else 'speaker','peakDbFS':round(float(20*np.log10(np.max(np.abs(a)))),2),'rmsDbFS':round(float(20*np.log10(np.sqrt(np.mean(a*a)))),2)}
if len(records)!=11: raise ValueError(f'Expected 11 lines, got {len(records)}')
manifest.write_text(json.dumps(records,indent=2)+'\n')
print(json.dumps(records,indent=2))
