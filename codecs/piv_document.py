"""Rebuild modern PIV frame streams while preserving the original asset tables.

This supports structural frame/object editing, including optional pose arrays
and cameras. Custom figure/background changes remain a separate operation.
"""
from __future__ import annotations

import math
import base64
import binascii
import struct
import zlib
from typing import Any

if __package__:
    from .piv_codec import PivError, _decode, MAX_PAYLOAD_BYTES
else:
    from piv_codec import PivError, _decode, MAX_PAYLOAD_BYTES


class _Writer:
    def __init__(self): self.data=bytearray()

    def put(self,fmt,value,label):
        if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value):
            raise PivError(f'{label} must be a finite number')
        if fmt not in ('f','d'):
            if int(value)!=value: raise PivError(f'{label} must be an integer')
            value=int(value)
        try: self.data.extend(struct.pack('<'+fmt,value))
        except (OverflowError,struct.error) as exc: raise PivError(f'{label} is out of range') from exc

    def array(self,fmt,values,count,label):
        if not isinstance(values,list) or len(values)!=count:
            raise PivError(f'{label} must contain exactly {count} values')
        for value in values:self.put(fmt,value,label)


_ASSET_EXPORT_METADATA={'asset_path','asset_path_relative','asset_url','data_base64','data_url','data_uri',
    'sha256','byte_length'}


def _table_signature(value):
    """Ignore asset materialization paths; retain every decoded table field."""
    if isinstance(value,dict):
        return {k:_table_signature(v) for k,v in value.items() if k not in _ASSET_EXPORT_METADATA}
    if isinstance(value,list):return [_table_signature(v) for v in value]
    return value


def _check_assets_unchanged(original,document):
    # Side-table media may be omitted when a server materializes assets, but an
    # explicitly supplied replacement must never be silently discarded.
    if isinstance(original,dict) and isinstance(document,dict):
        def inline_bytes(value):
            decoded=[]
            for key in ('data_base64','data_url','data_uri'):
                if key not in value or value[key] is None:continue
                data=value[key]
                if not isinstance(data,str):raise PivError('Inline media must be encoded text')
                if key!='data_base64':
                    if not data.startswith('data:') or ',' not in data or not data.split(',',1)[0].endswith(';base64'):
                        raise PivError('Inline media URL must use base64 encoding')
                    data=data.split(',',1)[1]
                try:decoded.append(base64.b64decode(data,validate=True))
                except (binascii.Error,ValueError) as exc:raise PivError('Invalid inline media encoding') from exc
            if any(data!=decoded[0] for data in decoded[1:]):raise PivError('Conflicting inline media representations')
            return decoded[0] if decoded else None
        supplied=inline_bytes(document)
        if supplied is not None and supplied!=inline_bytes(original):
            raise PivError('Replacing image assets is not supported by the frame writer')
        for k,v in document.items():
            if k in original:_check_assets_unchanged(original[k],v)
    elif isinstance(original,list) and isinstance(document,list):
        for a,b in zip(original,document):_check_assets_unchanged(a,b)


def _encode_piv_document(source: bytes, document: dict[str,Any]) -> bytes:
    """Encode modified V5 keyframes against immutable original figure tables.

    ``document`` is a decoded scene report. Source byte preservation includes
    every figure, background and unknown trailer byte. Objects are serialized
    in native signed-ID order; joins use persistent IDs, and ``object_draw_order_unique_ids``
    preserves layer order across insertions/deletions (new IDs append on top).
    """
    original,r,compressed=_decode(source)
    if original['version']!=5 or document.get('version')!=5:
        raise PivError('Structural document export currently supports PIV version 5 only')
    for field in ('canvas_width','canvas_height','backgrounds','figure_types'):
        if field not in document or _table_signature(document[field])!=_table_signature(original[field]):
            raise PivError(f'{field} changes are outside the structural frame writer; use fixed-field edits separately')
        _check_assets_unchanged(original[field],document[field])
    frames=document.get('keyframes')
    if not isinstance(frames,list) or len(frames)>1000000:
        raise PivError('A project must contain between 0 and 1000000 keyframes')
    types={f['figure_type_id']:f for f in original['figure_types']}
    w=_Writer()
    w.put('I',len(frames),'keyframe count')
    for fi,frame in enumerate(frames):
        p=f'keyframe {fi}'
        w.put('H',frame['duration_raw'],p+' duration')
        mix=frame.get('background_mix',0)
        w.put('B',mix,p+' background mix')
        w.put('H',frame.get('background_id',0),p+' background ID')
        if mix:w.put('H',frame.get('background_id_b'),p+' secondary background ID')
        input_objects=frame.get('objects')
        if not isinstance(input_objects,list):raise PivError(p+' objects must be a list')
        w.put('H',len(input_objects),p+' object count')
        input_uids=[o.get('unique_id') for o in input_objects]
        if (any(not isinstance(uid,int) or isinstance(uid,bool) or not 0<=uid<=0xffffffff for uid in input_uids)
            or len(set(input_uids))!=len(input_uids)):
            raise PivError(p+' requires distinct integer object unique IDs')
        signed=lambda obj:obj['unique_id'] if obj['unique_id']<0x80000000 else obj['unique_id']-0x100000000
        objects=sorted(input_objects,key=signed)
        uids=[o['unique_id'] for o in objects]
        slots={uid:i for i,uid in enumerate(uids)}
        for oi,obj in enumerate(objects):
            op=f'{p}, object {oi}'
            tid=obj['figure_type_id']
            if tid not in types:raise PivError(op+' has unknown figure type')
            figure=types[tid];count=figure['segment_count']
            w.put('I',obj['unique_id'],op+' unique ID')
            w.put('H',tid,op+' figure type')
            w.put('f',obj['scale'],op+' scale')
            w.put('I',obj['color_override_raw'],op+' override color')
            w.put('B',obj['field28'],op+' transparency')
            if figure.get('image_assets') or figure.get('text_assets'):
                w.put('B',obj.get('image_text_flags',0),op+' image/text mirror')
            w.array('d',obj['angles'],count,op+' angles')
            w.put('f',obj['root_x'],op+' root x');w.put('f',obj['root_y'],op+' root y')
            for field,flag,fmt in (('lengths','len_flag','f'),('bends','bend_flag','d')):
                values=obj.get(field,[])
                enabled=bool(values)
                w.put('H',(obj.get(flag) or 1) if enabled else 0,op+' '+flag)
                if enabled:w.array(fmt,values,count,op+' '+field)
            join=obj.get('join')
            w.put('B',int(bool(join)),op+' join flag')
            if join:
                if 'target_unique_id' in join:
                    target=slots.get(join['target_unique_id'])
                    if target is None:raise PivError(op+' joins an object removed from this frame')
                else:
                    input_slot=join.get('target_object_slot')
                    if not isinstance(input_slot,int) or not 0<=input_slot<len(input_uids):
                        raise PivError(op+' has an invalid joined object slot')
                    target=slots[input_uids[input_slot]]
                w.put('H',target,op+' joined object slot')
                w.put('H',join.get('target_handle_id'),op+' joined handle')
        if 'object_draw_order_unique_ids' in frame:
            requested=frame['object_draw_order_unique_ids']
            if (not isinstance(requested,list) or
                any(not isinstance(uid,int) or isinstance(uid,bool) for uid in requested) or
                len(set(requested))!=len(requested)):
                raise PivError(p+' draw-order IDs must be a list without duplicates')
            # Surviving IDs keep relative layer order; new objects appear on top.
            ordered=[uid for uid in requested if uid in slots]
            existing=set(ordered)
            ordered.extend(uid for uid in uids if uid not in existing)
            order=[slots[uid] for uid in ordered]
        else:
            input_order=frame.get('object_draw_order',list(range(len(objects))))
            if sorted(input_order)!=list(range(len(input_uids))):raise PivError(p+' has invalid draw-order slots')
            order=[slots[input_uids[index]] for index in input_order]
        w.array('H',order,len(objects),p+' draw order')
        cam=frame.get('camera') or {}
        values=[cam.get('x',0.),cam.get('y',0.),cam.get('angle_rad',0.),cam.get('scale',1.)]
        default=bool(cam.get('is_default',False)) and values==[0.,0.,0.,1.]
        w.put('B',int(default),p+' camera default')
        if not default:
            for fmt,value in zip(('f','f','d','f'),values):w.put(fmt,value,p+' camera')
    w.put('I',document['fps'],'FPS')
    auto_easing=document.get('auto_easing',original['auto_easing'])
    if not isinstance(auto_easing,bool):raise PivError('auto_easing must be a boolean')
    trailer=bytes.fromhex(original['trailing_bytes_hex'])
    if trailer or auto_easing!=original['auto_easing'] or document.get('auto_easing_source')=='file':
        w.put('B',int(not auto_easing),'Auto-Easing option')
    w.data.extend(trailer[1:])
    payload=r.data[:original['validation']['frame_start']]+bytes(w.data)
    if len(payload)>MAX_PAYLOAD_BYTES:raise PivError('Encoded project exceeds size limit')
    if payload==r.data:return bytes(source)
    result=zlib.compress(payload) if compressed else payload
    _decode(result)  # Enforce references, topology, finite geometry, and timings.
    return result


def encode_piv_document(source: bytes, document: dict[str,Any]) -> bytes:
    """Public structural writer; malformed documents produce actionable errors."""
    if not isinstance(document,dict):raise PivError('Document must be a scene object')
    try:return _encode_piv_document(source,document)
    except (KeyError,TypeError,AttributeError,IndexError) as exc:
        raise PivError(f'Malformed scene document: {exc}') from exc
