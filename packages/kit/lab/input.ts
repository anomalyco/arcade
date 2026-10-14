import { observeKeyLayout } from "../client/controls"

function isCanvasOrBodyFocus(canvas: HTMLCanvasElement): boolean {
  const active = document.activeElement
  return active === canvas || active === document.body || active === document.documentElement || active === null
}

/** Canvas-owned gameplay keys (bound by physical `KeyboardEvent.code`). Panel focus and window blur always release held input. */
export class LabInput {
  private held=new Set<string>()
  enabled=false
  constructor(readonly canvas:HTMLCanvasElement){
    canvas.addEventListener("pointerdown",()=>canvas.focus({preventScroll:true}))
    window.addEventListener("keydown",event=>{
      observeKeyLayout(event)
      if(!this.enabled||event.metaKey||event.ctrlKey||event.altKey)return
      const target=(typeof event.composedPath==="function"?event.composedPath()[0]:event.target) as {tagName?:string;isContentEditable?:boolean}|null|undefined
      const tag=target?.tagName?.toUpperCase()
      if(tag==="INPUT"||tag==="TEXTAREA"||tag==="SELECT"||target?.isContentEditable)return
      if(!isCanvasOrBodyFocus(canvas))return
      if(document.activeElement!==canvas)canvas.focus({preventScroll:true})
      if(event.code==="Backquote"||event.key==="F8"){this.release();return}
      this.held.add(event.code)
      if(["Space","ArrowUp","ArrowDown","ArrowLeft","ArrowRight"].includes(event.code))event.preventDefault()
    })
    window.addEventListener("keyup",event=>{this.held.delete(event.code);if(event.code==="MetaLeft"||event.code==="MetaRight"||event.key==="Meta")this.release()})
    window.addEventListener("blur",()=>this.release())
    document.addEventListener("focusin",()=>{if(!isCanvasOrBodyFocus(canvas))this.release()})
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
