import {messageError} from './localized-error.mjs';
import {drawingResourcesFor} from './drawing-resources.mjs';
import {movieclipAsset, isMovieclip} from './movieclips.mjs';
import {storedFrameReport} from './pivot-frame-draft.mjs';

const clone=value=>structuredClone(value);
export const editorMovieclipMethods={
  enterMovieclip(typeId=this.figure?.figure_type_id){
    if(drawingResourcesFor(this.report)?.stats.unpublished)throw messageError(new Error(''), "errors.editorMovieclips.finishDrawingPublicationBeforeEditingAMovieclip", {});
    const figure=this.report.figure_types.find(f=>f.figure_type_id===typeId);if(!isMovieclip(figure))throw messageError(new Error(''), "errors.editorMovieclips.chooseAMovieclip", {});
    if(movieclipAsset(figure).spatialMeshes)throw messageError(new Error(''), "errors.editorMovieclips.thisIsAnAttachedMeshPoseItsParent", {});
    if(this._drag)this.commitDrag();if(this._animationEdit)this.commitAnimationEdit();
    const scopes=this._movieclipScopes??[],parent={};
    for(const key of Object.keys(this))if(key!=='_movieclipScopes')parent[key]=this[key];
    const document=clone(movieclipAsset(figure).document);
    this.load(document,figure.name,{preserveDrawingResources:true});this._movieclipScopes=[...scopes,{parent,typeId,name:figure.name}];
    this._emit('movieclip-scope',{structural:true,timing:true});return this;
  },
  leaveMovieclip({save=true}={}){
    const scopes=this._movieclipScopes;if(!scopes?.length)return false;
    if(this._drag)this.commitDrag();if(this._animationEdit)this.commitAnimationEdit();
    if(save&&drawingResourcesFor(this.report)?.stats.unpublished)throw messageError(new Error(''), "errors.editorMovieclips.finishDrawingPublicationBeforeLeavingThisMovieclip", {});
    const changed=this.revision!==this._savedRevision;
    const scope=scopes.at(-1),document=save?storedFrameReport(this.report,{validate:false}):null;
    const duration=save?Math.max(1,this.totalTicks):0;
    drawingResourcesFor(this.report)?.dispose();
    // Revisions never repeat across the projects one editor holds (editor-sessions.mjs).
    const serial=this._revisionSerial;
    for(const key of Object.keys(this))if(key!=='_movieclipScopes')delete this[key];
    Object.assign(this,scope.parent);this._movieclipScopes=scopes.slice(0,-1);this._revisionSerial=Math.max(this._revisionSerial,serial);
    if(save&&changed)this._publishMovieclipEdit(scope.typeId,document,duration);
    this._invalidate({timing:true});this._emit('document',{structural:true,timing:true,movieclipScope:true});return true;
  },
};
