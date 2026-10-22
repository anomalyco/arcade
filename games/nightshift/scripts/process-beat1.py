"""One authored v4 stem per line, edited pauses, original telephone treatment. No playback."""
import json, subprocess, sys
from pathlib import Path
import numpy as np
from scipy.signal import butter, sosfilt
source, output, cues_path = map(Path,sys.argv[1:])
rate=24000; rng=np.random.default_rng(87); stems=[]; cues=[]; cursor=1.0
for path in sorted(source.glob('kit-??.mp3')):
    meta=json.loads(path.with_suffix('.json').read_text())
    raw=subprocess.check_output(['ffmpeg','-v','error','-i',str(path),'-af','aresample=24000,asetrate=22800,aresample=24000,atempo=0.95','-ac','1','-f','f32le','-'])
    a=np.frombuffer(raw,dtype='<f4').copy()
    active=np.flatnonzero(np.abs(a)>.002)
    if not len(active): raise ValueError(f'Silent stem: {path}')
    # Keep breath and mouth movement, trim only excess padding around the take.
    a=a[max(0,active[0]-int(.18*rate)):min(len(a),active[-1]+int(.22*rate))]
    a*=.42/max(.001,np.max(np.abs(a)))
    fade=min(len(a)//2,int(.012*rate));a[:fade]*=np.linspace(0,1,fade);a[-fade:]*=np.linspace(1,0,fade)
    end=cursor+len(a)/rate;stems.append((cursor,a));cues.append({'start':round(cursor,4),'end':round(end,4),'text':meta['subtitle']})
    cursor=end+meta['pause']
if len(stems)!=10: raise ValueError('Expected ten section-1 stems')
click=cursor;duration=click+2.4;voice=np.zeros(round(duration*rate))
for start,a in stems:
    at=round(start*rate);voice[at:at+len(a)]+=a
voice=sosfilt(butter(4,[300,3400],btype='bandpass',fs=rate,output='sos'),voice)
double=sosfilt(butter(2,[1000,2800],btype='bandpass',fs=rate,output='sos'),voice)
delay=round(.047*rate);voice[delay:]+=double[:-delay]*.14;voice=np.round(voice*512)/512
t=np.arange(len(voice))/rate
hiss=sosfilt(butter(2,[500,3400],btype='bandpass',fs=rate,output='sos'),rng.normal(0,.0018,len(voice)))
mix=voice+hiss*np.minimum(1,t*15)*np.clip((duration-t)*5,0,1)
for start,level in [(.12,.025),(click,.085)]:
    n=int(.025*rate);at=round(start*rate);mix[at:at+n]+=rng.normal(0,level,n)*np.exp(-np.arange(n)/(rate*.004))
mix+=.018*(np.sin(2*np.pi*350*t)+np.sin(2*np.pi*440*t))*np.clip((t-click-.15)*20,0,1)*np.clip((duration-t)*5,0,1)
# Preserve the quiet phone level; normalize only if headroom would be exceeded.
mix*=min(1,.8/max(.001,np.max(np.abs(mix))))
output.parent.mkdir(parents=True,exist_ok=True)
subprocess.run(['ffmpeg','-v','error','-y','-f','f32le','-ar',str(rate),'-ac','1','-i','-','-c:a','libmp3lame','-b:a','128k',str(output)],input=mix.astype('<f4').tobytes(),check=True)
cues_path.write_text(json.dumps({'duration':round(duration,4),'click':round(click,4),'cues':cues},indent=2)+'\n')
print(json.dumps({'duration':duration,'peakDbFS':20*np.log10(np.max(np.abs(mix))),'rmsDbFS':20*np.log10(np.sqrt(np.mean(mix*mix))),'stems':len(stems)}))
