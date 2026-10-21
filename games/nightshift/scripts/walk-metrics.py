"""Audit the captured controller tape and mux source, not appearance. No audio playback."""
import json, math, sys, wave
from pathlib import Path
from array import array

root=Path(sys.argv[1])
capture=json.loads((root/"input-trace.json").read_text())
frames=capture["trace"]
events=[e for f in frames for e in f["events"]]
deltas=[math.dist(a["offset"][:2],b["offset"][:2]) for a,b in zip(frames,frames[1:])]
roll=[abs(a["offset"][2]-b["offset"][2]) for a,b in zip(frames,frames[1:])]
with wave.open(str(root/"walk.wav")) as wav:
    samples=array("h",wav.readframes(wav.getnframes()))
    peak=max(abs(v) for v in samples)/32768
    rms=math.sqrt(sum((v/32768)**2 for v in samples)/len(samples))
    audio={"duration":len(samples)/wav.getnchannels()/wav.getframerate(),"sampleRate":wav.getframerate(),"channels":wav.getnchannels(),"peakDbFS":20*math.log10(max(peak,1e-10)),"rmsDbFS":20*math.log10(max(rms,1e-10)),"clippedSamples":sum(abs(v)>=32767 for v in samples)}
result={"frames":len(frames),"fps":capture["fps"],"errors":capture["errors"],"intentionalCameraCuts":capture["cuts"],"maxOffsetDeltaMm":max(deltas)*1000,"maxOffsetSpeedMetresPerSecond":max(deltas)*capture["fps"],"maxRollDeltaDegrees":max(roll)*180/math.pi,"maxRollDegrees":max(abs(f["offset"][2]) for f in frames)*180/math.pi,"finalReducedOffset":frames[-1]["offset"],"events":{kind:sum(e["kind"]==kind for e in events) for kind in ["step","cloth","scuff","bump","creak"]},"reducedMotionFootsteps":sum(e["kind"]=="step" for f in frames if f["reduced"] for e in f["events"]),"blockedFootsteps":sum(e["kind"]=="step" for f in frames if 525<=f["frame"]<540 for e in f["events"]),"audio":audio}
result["passed"]=not result["errors"] and max(deltas)*capture["fps"]<.2 and max(roll)*capture["fps"]<.08 and math.dist(frames[-1]["offset"],[0,0,0])<1e-8 and result["events"]["bump"]>=1 and result["reducedMotionFootsteps"]>=1 and result["blockedFootsteps"]==0 and audio["clippedSamples"]==0
(root/"input-metrics.json").write_text(json.dumps(result,indent=2))
print(json.dumps(result,indent=2))
assert result["passed"],"Input/audio proof did not satisfy bounds"
