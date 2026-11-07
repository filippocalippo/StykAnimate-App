import {messageError} from './localized-error.mjs';
import {drawingResourcesFor} from './drawing-resources.mjs';
import {movieclipAsset, isMovieclip} from './movieclips.mjs';
import {storedFrameReport} from './pivot-frame-draft.mjs';
import {findFigureType} from './figure-types.mjs';

export const editorMovieclipMethods={
  /** The document of movieclip `typeId` and its name, for the load that enters it. The engine owner opens it from the project's tree instead. */
  _movieclipDocument(typeId){
    const figure=findFigureType(this.report.figure_types, typeId);if(!isMovieclip(figure))throw messageError(new Error(''), "errors.editorMovieclips.chooseAMovieclip", {});
    if(movieclipAsset(figure).spatialMeshes)throw messageError(new Error(''), "errors.editorMovieclips.thisIsAnAttachedMeshPoseItsParent", {});
    // The engine opens the clip's document from its text and builds the view itself: the clip's own record is not changed, so it is not copied first.
    return {document:movieclipAsset(figure).document,name:figure.name};
  },
  enterMovieclip(typeId=this.object?.figure_type_id){
    if(drawingResourcesFor(this.report)?.stats.unpublished)throw messageError(new Error(''), "errors.editorMovieclips.finishDrawingPublicationBeforeEditingAMovieclip", {});
    const {document,name}=this._movieclipDocument(typeId);
    if(this._drag)this.commitDrag();if(this._animationEdit)this.commitAnimationEdit();
    const scopes=this._movieclipScopes??[],parent={};
    for(const key of Object.keys(this))if(key!=='_movieclipScopes')parent[key]=this[key];
    this.load(document,name,{preserveDrawingResources:true});this._movieclipScopes=[...scopes,{parent,typeId,name}];
    this._emit('movieclip-scope',{structural:true,timing:true});return this;
  },
  leaveMovieclip({save=true}={}){
    const scopes=this._movieclipScopes;if(!scopes?.length)return false;
    if(this._drag)this.commitDrag();if(this._animationEdit)this.commitAnimationEdit();
    if(save&&drawingResourcesFor(this.report)?.stats.unpublished)throw messageError(new Error(''), "errors.editorMovieclips.finishDrawingPublicationBeforeLeavingThisMovieclip", {});
    const changed=this.revision!==this._savedRevision;
    const scope=scopes.at(-1),document=save?storedFrameReport(this.report,{validate:false}):null;
    const duration=save?Math.max(1,this.totalTicks):0;
    // Revisions never repeat across the projects one editor holds (editor-sessions.mjs).
    const serial=this._revisionSerial,clip={},clipReport=this.report;
    for(const key of Object.keys(this))if(key!=='_movieclipScopes'){clip[key]=this[key];delete this[key];}
    Object.assign(this,scope.parent);this._movieclipScopes=scopes.slice(0,-1);this._revisionSerial=Math.max(this._revisionSerial,serial);
    if(save&&changed){
      try{this._publishMovieclipEdit(scope.typeId,document,duration);}
      catch(error){
        // The project would not take the clip's edit (the engine is out of memory): the clip stays open, edited as it was, to leave again.
        for(const key of Object.keys(this))if(key!=='_movieclipScopes')delete this[key];
        Object.assign(this,clip);this._movieclipScopes=scopes;this._revisionSerial=Math.max(this._revisionSerial,serial);
        throw error;
      }
    }
    drawingResourcesFor(clipReport)?.dispose();
    this._invalidate({timing:true});this._emit('document',{structural:true,timing:true,movieclipScope:true});return true;
  },
};
