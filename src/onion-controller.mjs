import {onionRangeSnapshot,onionRangeSettings} from './onion-range.mjs';

/** The settings the engine plans the onion skins from. */
const PLANNED=['onionMode','onionStep','onionRangeBefore','onionRangeAfter','onionScope','onionJoined','onionOpacity','onionFade','onionTint',
  'onionBeforeColor','onionAfterColor','onionShowOnTop'];

/** One owner for transient onion preferences. Views never persist during drag. */
export class OnionController {
  constructor({editor,getSettings,getEnabled,onCommit,onToggle,onRender,onError}){
    Object.assign(this,{editor,getSettings,getEnabled,onCommit,onToggle,onRender,onError});
    this.listeners=new Set();this.session=null;this.events=new AbortController();
    editor.addEventListener('change',event=>{
      if(this.session&&(['seek','document','history'].includes(event.detail?.kind)||editor.revision!==this.session.revision))this.cancel();
      // A pose in progress (a live edit) changes neither the keys the range counts nor the settings: the commit that ends it syncs.
      else if(!event.detail?.live)this.sync(false);
    },{signal:this.events.signal});
  }
  get settings(){return {...onionRangeSettings(this.getSettings()),...this.session?.patch};}
  snapshot(tick){return onionRangeSnapshot(this.editor,this.settings,tick);}
  /** What the engine plans the onion skins from (onion_skins.rs): the settings, the number of samples each side that the range
   * reaches in this document, the figures the interface hides and, for the scope of the selected ones, which are. */
  request({selected,hidden}){
    const settings=this.settings,range=settings.onionRangeBefore!=null||settings.onionRangeAfter!=null?this.snapshot():null;
    return {...Object.fromEntries(PLANNED.map(key=>[key,settings[key]??null])),
      onionBefore:range?range.before.count:settings.onionBefore,onionAfter:range?range.after.count:settings.onionAfter,
      hidden:[...hidden],selected:settings.onionScope==='selected'?[...selected]:[]};
  }
  subscribe(listener){this.listeners.add(listener);return ()=>this.listeners.delete(listener);}
  sync(render=true){for(const listener of this.listeners)listener();if(render)this.onRender?.();}
  begin(owner){
    if(this.session?.owner===owner)return;
    this.cancel();
    const range=this.snapshot();
    this.session={owner,patch:{},range,base:this.getSettings(),revision:this.editor.revision};
  }
  preview(owner,patch){
    if(this.session?.owner!==owner)return;
    if('onionRangeBefore' in patch||'onionRangeAfter' in patch||'onionMode' in patch||'onionStep' in patch){
      // Adopt the legacy pair together so changing sampling cannot reinterpret
      // the untouched side half-way through a gesture.
      this.session.patch={onionRangeBefore:this.session.range.before.span,onionRangeAfter:this.session.range.after.span,...this.session.patch};
    }
    Object.assign(this.session.patch,patch);this.sync();
  }
  commit(owner){
    if(this.session?.owner!==owner)return;
    const {patch,base}=this.session;
    this.session=null;
    const changed=Object.fromEntries(Object.entries(patch).filter(([key,value])=>value!==base[key]));
    try{if(Object.keys(changed).length)this.onCommit(changed);}
    catch(error){if(this.onError)this.onError(error);else throw error;}
    finally{this.sync();}
  }
  cancel(owner){
    if(!this.session||owner&&this.session.owner!==owner)return;
    this.session=null;this.sync();
  }
  change(owner,patch){this.begin(owner);this.preview(owner,patch);this.commit(owner);}
  toggle(){this.cancel();this.onToggle();this.sync();}
  destroy(){this.cancel();this.events.abort();this.listeners.clear();}
}
