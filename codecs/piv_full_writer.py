"""Serialize editable Pivot 5 projects, including figure and background tables.

The original source supplies omitted media bytes and unknown trailer metadata.
Unchanged tables use the conservative frame writer for exact source identity.
All rebuilt tables and frames are decoded again before a result is returned.
"""
from __future__ import annotations

import copy
import math
import heapq
from pathlib import Path
import struct
import zlib
from typing import Any

if __package__:
    from .piv_codec import PivError,MAX_PAYLOAD_BYTES,MAX_SEGMENTS,_decode,_builtin_man
    from .piv_document import _Writer,encode_piv_document
else:
    from piv_codec import PivError,MAX_PAYLOAD_BYTES,MAX_SEGMENTS,_decode,_builtin_man
    from piv_document import _Writer,encode_piv_document


def _asset_helpers():
    if __package__:
        from .piv_asset_writer import hydrate_side_tables,resolve_image_bytes
    else:
        from piv_asset_writer import hydrate_side_tables,resolve_image_bytes
    return hydrate_side_tables,resolve_image_bytes


def _side_encoder():
    if __package__:
        from .piv_side_tables import encode_side_tables
    else:
        from piv_side_tables import encode_side_tables
    return encode_side_tables


def _name(w,value,label):
    if not isinstance(value,str):raise PivError(label+' must be text')
    try:blob=value.encode('cp1252')
    except UnicodeEncodeError as exc:raise PivError(label+' must fit the native Windows ANSI encoding') from exc
    w.put('B',len(blob),label+' length')
    w.data.extend(blob)


def _positive_id(value,label):
    if isinstance(value,bool) or not isinstance(value,int) or value<1:
        raise PivError(label+' must be a positive integer')
    return value


def _alias_value(item,old,raw,alias,convert,default):
    """Accept either canonical raw fields or semantic aliases without ambiguity."""
    base=item.get(raw,default)
    old=old or {}
    alias_changed=alias in item and (alias not in old or item[alias]!=old[alias])
    raw_changed=raw in item and (raw not in old or item[raw]!=old[raw])
    if alias_changed:
        candidate=convert(item[alias])
        if raw_changed and raw in item and candidate!=base:
            raise PivError(f'Conflicting edits to {raw} and {alias}')
        return candidate
    return base


def _transparency(alpha):
    if isinstance(alpha,bool) or not isinstance(alpha,(int,float)) or not math.isfinite(alpha) or not 0<=alpha<=1:
        raise PivError('Color alpha must be between 0 and 1')
    return round((1-alpha)*255)


def _aux(segment,old):
    raw=segment.get('aux_code',0)
    if not isinstance(raw,int) or isinstance(raw,bool) or not 0<=raw<=255:raise PivError('Invalid segment auxiliary flags')
    old=old or {}
    static=segment.get('is_static',segment.get('flag_bits',{}).get('is_static'))
    if static is not None:
        if not isinstance(static,bool):raise PivError('is_static must be a boolean')
        old_static=old.get('is_static',bool(old.get('aux_code',0)&1))
        if not old or static!=old_static:
            if 'aux_code' in segment and raw!=old.get('aux_code',raw) and bool(raw&1)!=static:
                raise PivError('Conflicting static-node and auxiliary flag edits')
            raw=(raw&254)|int(static)
    return raw


def _choose_assets(figure,old):
    side=figure.get('side_tables')
    combined=[*figure.get('image_assets',[]),*figure.get('text_assets',[])]
    if side is None:return combined
    original_side=(old or {}).get('side_tables',[])
    original_combined=[*(old or {}).get('image_assets',[]),*(old or {}).get('text_assets',[])]
    side_changed=side!=original_side
    combined_changed=combined!=original_combined
    if combined_changed and not side_changed:return combined
    if combined_changed and side_changed and side!=combined:
        # Materialized asset metadata can differ between aliases; canonical
        # edits should use side_tables rather than divergent copies.
        if __package__:
            from .piv_document import _table_signature
        else:from piv_document import _table_signature
        if _table_signature(side)!=_table_signature(combined):
            raise PivError('Conflicting side_tables and image/text asset edits')
    return side


def _figure(w,figure,old,source_payload,workspace_root):
    label=f'figure {figure.get("figure_type_id")}'
    segments=figure.get('segments')
    if not isinstance(segments,list) or not 1<=len(segments)<=MAX_SEGMENTS:raise PivError(label+f' needs 1–{MAX_SEGMENTS} segments')
    original_segments={s['segment_id']:s for s in (old or {}).get('segments',[])}
    prepared=[]
    for segment in segments:
        s=copy.deepcopy(segment)
        reference=original_segments.get(s.get('_logical_segment_id',s.get('segment_id')))
        s['aux_code']=_aux(s,reference)
        s['transparency']=_alias_value(s,reference,'transparency','color_alpha',_transparency,0)
        s.setdefault('primitive_code',0);s.setdefault('color_rgb',[0,0,0]);s.setdefault('secondary',None)
        s.setdefault('bend_rad',0.)
        extra=s.get('extra') or [0,0,0]
        for key,value in zip(('extra_u16','extra_u8_a','extra_u8_b'),extra):s.setdefault(key,value)
        prepared.append(s)
    ids=[s['segment_id'] for s in prepared]
    if len(set(ids))!=len(ids) or any(isinstance(x,bool) or not isinstance(x,int) or not 1<=x<=65535 for x in ids):
        raise PivError(label+' has invalid or duplicate segment joint IDs')
    polygons=copy.deepcopy(figure.get('polyfills',[]))
    if not isinstance(polygons,list) or len(polygons)>20000:raise PivError(label+' has invalid polygon list')
    old_polygons={p.get('polyfill_id',i+1):p for i,p in enumerate((old or {}).get('polyfills',[]))}
    for i,poly in enumerate(polygons):
        poly['alpha_raw']=_alias_value(poly,old_polygons.get(poly.get('polyfill_id',i+1)),
            'alpha_raw','color_alpha',_transparency,0)
    # Semantic z values preserve relative layers even after deletions leave gaps.
    entries=[]
    for kind,items,array_name in (('segment',prepared,'segment_z_raw'),('poly',polygons,'poly_z_raw')):
        array=figure.get(array_name,[])
        old_array=(old or {}).get(array_name,[])
        use_array=len(array)==len(items) and (array!=old_array or (kind=='segment' and figure.get('_resolved_segment_z')))
        for i,item in enumerate(items):
            default=i if kind=='segment' else len(prepared)+i
            reference=(original_segments.get(item.get('_logical_segment_id',item.get('segment_id'))) if kind=='segment'
                else old_polygons.get(item.get('polyfill_id',i+1)))
            z=array[i] if use_array else _alias_value(item,reference,'z_order_runtime_raw','z_order',lambda value:value-1,default)
            if isinstance(z,bool) or not isinstance(z,(int,float)) or not math.isfinite(z):raise PivError('Invalid layer order')
            # Parent-before-child storage may reorder segment records. Equal
            # visual layers retain their original input order, matching the
            # renderer's stable sort (polygons precede segments on a tie).
            ordinal=item.get('_paint_input_index',i) if kind=='segment' else i
            entries.append((z,0 if kind=='poly' else 1,ordinal,kind,i))
    seg_z=[0]*len(prepared);poly_z=[0]*len(polygons)
    for rank,(_,_,_,kind,i) in enumerate(sorted(entries)):
        (seg_z if kind=='segment' else poly_z)[i]=rank
    style=figure.get('segment_decode',{}).get('global_style')
    sequential=seg_z==list(range(len(prepared))) and poly_z==list(range(len(prepared),len(prepared)+len(polygons)))
    flags=(int(all(s['primitive_code']==0 for s in prepared))
        |(int(all(s['aux_code']==0 for s in prepared))<<1)
        |(int(all(s['color_rgb']==[0,0,0] for s in prepared))<<2)
        |(int(all(s['transparency']==0 for s in prepared))<<3)
        |(int(sequential)<<4)|(int(ids==list(range(1,len(prepared)+1)))<<5)
        |(int(style is not None)<<6)|(int(all(s['secondary'] is None for s in prepared))<<7))
    w.put('B',flags,label+' compression flags');w.put('H',len(prepared),label+' segment count')
    for s in prepared:
        w.put('H',s['parent_id'],'segment parent')
        if not flags&32:w.put('H',s['segment_id'],'segment joint ID')
        w.put('f',s['length'],'segment length');w.put('d',s['angle_rad'],'segment angle')
        w.put('f',s['thickness'],'segment thickness')
        if not flags&1:w.put('B',s['primitive_code'],'primitive code')
        if not flags&2:w.put('B',s['aux_code'],'auxiliary flags')
        if not flags&4:w.array('B',s['color_rgb'],3,'segment RGB')
        if not flags&8:w.put('B',s['transparency'],'segment transparency')
        if not flags&128:
            secondary=s['secondary'];w.put('B',int(secondary is not None),'secondary presence')
            if secondary is not None:
                w.array('B',secondary['rgb'],3,'secondary RGB');w.put('B',secondary['a'],'secondary transparency')
        if s['primitive_code'] in (2,5):
            w.put('H',s['extra_u16'],'media table index')
            w.put('B',s['extra_u8_a'],'media endpoint flag');w.put('B',s['extra_u8_b'],'media reflection flag')
    bends=[(i,s['bend_rad']) for i,s in enumerate(prepared) if s['bend_rad']!=0]
    w.put('H',len(bends),'bend count')
    for index,value in bends:w.put('H',index,'bend record index');w.put('d',value,'bend angle')
    assets=_choose_assets(figure,old)
    if any(s['primitive_code'] in (2,5) for s in prepared):
        hydrate,_=_asset_helpers()
        hydrated=hydrate(assets,source_payload,workspace_root=workspace_root)
        kinds={s['primitive_code'] for s in prepared}
        if any((a['kind']=='image' and 2 not in kinds) or (a['kind']=='text' and 5 not in kinds) for a in hydrated):
            raise PivError(label+' has an asset table without a matching primitive kind')
        w.data.extend(_side_encoder()(hydrated,len(w.data),prepared))
    elif assets:
        raise PivError(label+' has media assets but no image/text segment references')
    w.put('H',len(polygons),'polygon count')
    for poly in polygons:
        vertices=poly['segment_ids']
        w.put('H',len(vertices),'polygon vertex count');w.array('B',poly.get('color_rgb',[0,0,0]),3,'polygon RGB')
        w.put('B',poly['alpha_raw'],'polygon transparency');w.array('H',vertices,len(vertices),'polygon vertices')
    if not flags&16:
        w.array('H',seg_z,len(prepared),'segment z indices');w.array('H',poly_z,len(polygons),'polygon z indices')
    if style is not None:
        old_style=(old or {}).get('segment_decode',{}).get('global_style') or {}
        def bits(value):
            if isinstance(value,bool) or not isinstance(value,(float,int)) or not math.isfinite(value):raise PivError('Invalid outline thickness')
            return struct.unpack('<I',struct.pack('<f',value))[0]
        raw=_alias_value(style,old_style,'u28','outline_thickness',bits,0)
        w.put('I',raw,'outline thickness bits');w.array('B',style.get('rgb',[0,0,0]),3,'outline RGB')
        transparency=_alias_value(style,old_style,'u30','outline_transparency',lambda value:value,0)
        w.put('B',transparency,'outline transparency')
    _name(w,figure.get('name','Figure'),label+' name')


def _background(w,bg,source_payload,workspace_root):
    kind=bg['kind'];w.put('B',kind,'background kind')
    if kind in (0,1):
        _,resolve=_asset_helpers()
        media=copy.deepcopy(bg)
        offset=media.get('record_offset')
        if offset is not None:
            if not isinstance(offset,int) or not 0<=offset<len(source_payload)-8:raise PivError('Invalid background source offset')
            media.setdefault('image_start',offset+9)
            media.setdefault('source_end',struct.unpack_from('<Q',source_payload,offset+1)[0])
        blob=resolve(media,source_payload,workspace_root=workspace_root)
        w.put('Q',len(w.data)+8+len(blob),'background image endpoint');w.data.extend(blob)
    elif kind==2:w.put('I',bg['color'],'background color')
    elif kind in (3,4):
        w.put('I',bg['color_a'],'gradient color A');w.put('I',bg['color_b'],'gradient color B')
        for key in ('x1','y1','x2','y2'):w.put('f',bg[key],'gradient '+key)
    else:raise PivError('Unsupported background kind')
    _name(w,bg.get('name','Background'),'background name')


def _same_builtin(a,b):
    # A limited geometry signature can silently lose palette, gradient,
    # opacity, draw-order or future supported semantic aliases on the default.
    if __package__:
        from .piv_document import _table_signature
    else:from piv_document import _table_signature
    return _table_signature(a)==_table_signature(b)


def _encode_project(source,document,workspace_root,force_rebuild):
    original,r,compressed=_decode(source)
    if original['version']!=5 or document.get('version')!=5:raise PivError('Full project serialization supports V5 only')
    # Explicit disk-media mode must resolve files even when only their path or
    # contents changed; the frame writer intentionally treats paths as metadata.
    if not force_rebuild and workspace_root is None:
        try:return encode_piv_document(source,document)
        except PivError:pass  # Table modifications use the full serialization path.
    doc=copy.deepcopy(document)
    figures=doc.get('figure_types')
    backgrounds=doc.get('backgrounds')
    if not isinstance(figures,list) or not isinstance(backgrounds,list):raise PivError('Figure/background tables must be lists')
    old_types={f['figure_type_id']:f for f in original['figure_types']}
    old_offsets={f.get('segment_decode',{}).get('records_start'):f for f in original['figure_types'] if not f.get('implicit')}
    ids=[_positive_id(f.get('figure_type_id'),'figure ID') for f in figures]
    if len(ids)!=len(set(ids)):raise PivError('Duplicate figure type IDs')
    builtin=next((f for f in figures if f['figure_type_id']==1),None)
    native=_builtin_man()
    custom=[f for f in figures if f['figure_type_id']!=1]
    # Native slot 1 cannot store edits. Materialize an edited default figure as
    # the first custom record and remap its instances to that ordinary type.
    edited_builtin=builtin is not None and not _same_builtin(builtin,native)
    if edited_builtin:custom.insert(0,builtin)
    mapping={1:1}
    mapping.update({f['figure_type_id']:i+2 for i,f in enumerate(custom)})
    joint_maps={1:{i:i for i in range(len(native['segments'])+1)}}
    pose_orders={}
    for f in custom:
        input_segments=f['segments']
        segment_ids=[s['segment_id'] for s in input_segments]
        if (any(isinstance(sid,bool) or not isinstance(sid,int) or sid<1 for sid in segment_ids)
            or len(set(segment_ids))!=len(segment_ids)):
            raise PivError('Segment joint IDs must be distinct positive integers')
        by_id={sid:i for i,sid in enumerate(segment_ids)}
        children={sid:[] for sid in segment_ids}
        ready=[]
        for i,segment in enumerate(input_segments):
            segment['_paint_input_index']=i
            parent=segment['parent_id']
            if parent==0:heapq.heappush(ready,i)
            elif parent not in by_id:raise PivError('Segment references a deleted parent joint')
            else:children[parent].append(i)
        order=[]
        while ready:
            index=heapq.heappop(ready);order.append(index)
            for child in children[segment_ids[index]]:heapq.heappush(ready,child)
        if len(order)!=len(input_segments):raise PivError('Cyclic segment topology')
        pose_orders[f['figure_type_id']]=order
        # Resolve requested layers before changing record order so their visual
        # ranks survive the required native parent-before-child traversal.
        old=old_types.get(f['figure_type_id']) or old_offsets.get(f.get('segment_decode',{}).get('records_start'))
        old_segments={s['segment_id']:s for s in (old or {}).get('segments',[])}
        original_array=(old or {}).get('segment_z_raw',[])
        current_array=f.get('segment_z_raw',[])
        explicit_array=len(current_array)==len(input_segments) and current_array!=original_array
        layer_values=[current_array[i] if explicit_array else _alias_value(segment,old_segments.get(segment['segment_id']),
            'z_order_runtime_raw','z_order',lambda value:value-1,i) for i,segment in enumerate(input_segments)]
        f['segments']=[input_segments[i] for i in order]
        f['segment_z_raw']=[layer_values[i] for i in order]
        f['_resolved_segment_z']=True
        # Native point arrays are indexed by joint ID. Logical sparse/deleted
        # IDs therefore need dense native remapping, including external joins.
        dense=set(segment_ids)==set(range(1,len(segment_ids)+1))
        joint_map={0:0,**{sid:sid if dense else i+1 for i,sid in enumerate(sorted(segment_ids))}}
        joint_maps[f['figure_type_id']]=joint_map
        for segment in f['segments']:
            old_sid=segment['segment_id']
            segment['_logical_segment_id']=old_sid
            segment['segment_id']=joint_map[old_sid]
            if segment['parent_id'] not in joint_map:raise PivError('Segment references a deleted parent joint')
            segment['parent_id']=joint_map[segment['parent_id']]
        for poly in f.get('polyfills',[]):
            if any(sid not in joint_map for sid in poly['segment_ids']):raise PivError('Polygon references a deleted joint')
            poly['segment_ids']=[joint_map[sid] for sid in poly['segment_ids']]
    bg_ids=[_positive_id(bg.get('background_id'),'background ID') for bg in backgrounds]
    if len(bg_ids)!=len(set(bg_ids)):raise PivError('Duplicate background IDs')
    bg_map={0:0,**{old:i+1 for i,old in enumerate(bg_ids)}}
    w=_Writer();w.put('B',5,'version')
    w.put('I',doc['canvas_width'],'canvas width');w.put('I',doc['canvas_height'],'canvas height')
    w.put('H',len(backgrounds)+1,'background slots')
    for bg in backgrounds:_background(w,bg,r.data,workspace_root)
    w.put('H',len(custom)+2,'figure slots')
    for f in custom:
        old=old_types.get(f['figure_type_id']) or old_offsets.get(f.get('segment_decode',{}).get('records_start'))
        _figure(w,f,old,r.data,workspace_root)
    # A valid one-frame scaffold lets the existing parser validate all rebuilt
    # table counts/topology/media before its canonical frame writer runs.
    w.data.extend(struct.pack('<IH B H H B I',1,1,0,0,0,1,original['fps']))
    original_tail=bytes.fromhex(original.get('trailing_bytes_hex',''))
    w.data.extend(original_tail)
    if len(w.data)>MAX_PAYLOAD_BYTES:raise PivError('Serialized tables exceed project size limit')
    scaffold=bytes(w.data)
    normalized,_,_=_decode(scaffold)
    frames=copy.deepcopy(doc['keyframes'])
    for frame in frames:
        for key in ('background_id','background_id_b'):
            if frame.get(key) is not None:
                if frame[key] not in bg_map:raise PivError('Frame references a deleted background')
                frame[key]=bg_map[frame[key]]
        uid_types={obj['unique_id']:obj['figure_type_id'] for obj in frame['objects']}
        for obj in frame['objects']:
            pose_order=pose_orders.get(obj['figure_type_id'])
            if pose_order is not None:
                for key in ('angles','lengths','bends'):
                    values=obj.get(key,[])
                    if values:
                        if len(values)!=len(pose_order):raise PivError(f'Pose {key} does not match edited segment count')
                        obj[key]=[values[i] for i in pose_order]
            join=obj.get('join')
            if join:
                if 'target_unique_id' in join:
                    if join['target_unique_id'] not in uid_types:raise PivError('Join references a deleted object')
                    target_type=uid_types[join['target_unique_id']]
                else:
                    slot=join['target_object_slot']
                    if not isinstance(slot,int) or not 0<=slot<len(frame['objects']):raise PivError('Join references an invalid object slot')
                    target_type=uid_types[frame['objects'][slot]['unique_id']]
                joint_map=joint_maps.get(target_type,{})
                if join['target_handle_id'] not in joint_map:raise PivError('Join references a deleted target joint')
                join['target_handle_id']=joint_map[join['target_handle_id']]
            if obj['figure_type_id'] not in mapping:raise PivError('Frame references a deleted figure type')
            obj['figure_type_id']=mapping[obj['figure_type_id']]
    normalized.update(keyframes=frames,fps=doc['fps'],
        auto_easing=doc.get('auto_easing',original['auto_easing']),
        auto_easing_source=doc.get('auto_easing_source',original.get('auto_easing_source','file')))
    result=encode_piv_document(scaffold,normalized)
    if result==r.data:return bytes(source)
    return zlib.compress(result) if compressed else result


def encode_piv_project(source:bytes,document:dict[str,Any],*,workspace_root:str|Path|None=None,
                       force_rebuild:bool=False)->bytes:
    """Rebuild a V5 project, remapping table IDs and relocating embedded media.

    New figures/backgrounds may use arbitrary unique positive logical IDs;
    serialization assigns dense native slots in list order and updates frame
    references. An edited implicit default figure is materialized automatically.
    Disk media are allowed only when ``workspace_root`` is explicitly supplied.
    """
    if not isinstance(document,dict):raise PivError('Project document must be an object')
    try:return _encode_project(source,document,Path(workspace_root).resolve() if workspace_root else None,force_rebuild)
    except (KeyError,TypeError,AttributeError,IndexError,ValueError,struct.error,OverflowError) as exc:
        if isinstance(exc,PivError):raise
        raise PivError(f'Invalid full project document: {exc}') from exc
