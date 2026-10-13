/** Canvas-owned gameplay keys. Panel focus and window blur always release held input. */
export class LabInput {
  private held=new Map<string,string>()
  enabled=false
  constructor(readonly canvas:HTMLCanvasElement){
    canvas.addEventListener("pointerdown",()=>canvas.focus({preventScroll:true}))
    addEventListener("keydown",event=>{
      if(!this.enabled||document.activeElement!==canvas||event.metaKey||event.ctrlKey)return
      if(event.code==="Backquote"){this.release();return}
      if(!this.held.has(event.code))this.held.set(event.code,event.key.toLowerCase())
      if(["Space","ArrowUp","ArrowDown","ArrowLeft","ArrowRight"].includes(event.code))event.preventDefault()
    })
    addEventListener("keyup",event=>{this.held.delete(event.code);if(event.key==="Meta")this.release()})
    addEventListener("blur",()=>this.release())
    document.addEventListener("focusin",()=>{if(document.activeElement!==canvas)this.release()})
  }
  release(){this.held.clear()}
  private has(...keys:string[]){
    if(!this.enabled)return false
    for(const k of keys){if(this.held.has(k))return true;for(const value of this.held.values())if(value===k)return true}
    return false
  }
  get up(){return this.has("KeyW","ArrowUp","w",",","<")}
  get down(){return this.has("KeyS","ArrowDown","s","o")}
  get left(){return this.has("KeyA","ArrowLeft","a")}
  get right(){return this.has("KeyD","ArrowRight","d","e")}
  get space(){return this.has("Space"," ")}
  get shift(){return this.has("ShiftLeft","ShiftRight","shift")}
}
