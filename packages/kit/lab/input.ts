/** Canvas-owned gameplay keys (bound by physical `KeyboardEvent.code`). Panel focus and window blur always release held input. */
export class LabInput {
  private held=new Set<string>()
  enabled=false
  constructor(readonly canvas:HTMLCanvasElement){
    canvas.addEventListener("pointerdown",()=>canvas.focus({preventScroll:true}))
    window.addEventListener("keydown",event=>{
      if(!this.enabled||document.activeElement!==canvas||event.metaKey||event.ctrlKey)return
      if(event.code==="Backquote"){this.release();return}
      this.held.add(event.code)
      if(["Space","ArrowUp","ArrowDown","ArrowLeft","ArrowRight"].includes(event.code))event.preventDefault()
    })
    window.addEventListener("keyup",event=>{this.held.delete(event.code);if(event.code==="MetaLeft"||event.code==="MetaRight"||event.key==="Meta")this.release()})
    window.addEventListener("blur",()=>this.release())
    document.addEventListener("focusin",()=>{if(document.activeElement!==canvas)this.release()})
  }
  release(){this.held.clear()}
  private has(...codes:string[]){
    if(!this.enabled)return false
    for(const c of codes)if(this.held.has(c))return true
    return false
  }
  get up(){return this.has("KeyW","ArrowUp")}
  get down(){return this.has("KeyS","ArrowDown")}
  get left(){return this.has("KeyA","ArrowLeft")}
  get right(){return this.has("KeyD","ArrowRight")}
  get space(){return this.has("Space")}
  get shift(){return this.has("ShiftLeft","ShiftRight")}
}
