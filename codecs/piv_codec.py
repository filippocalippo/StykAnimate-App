#!/usr/bin/env python3
"""Trace-independent Pivot project reader and conservative binary field editor.

Offsets refer to the uncompressed payload.  Editing is deliberately restricted to
fields whose representation is established; unknown bytes survive every edit.
"""
from __future__ import annotations

import argparse
import base64
import copy
import hashlib
import json
import math
import struct
import zlib
from pathlib import Path
from typing import Any

MAX_PAYLOAD_BYTES = 256 * 1024 * 1024
# Pivot 5's published figure limit; the count and joint IDs are uint16 fields.
# Keep this independent from polygon and overall decompression safety limits.
MAX_SEGMENTS = 30000


class PivError(ValueError):
    pass


class Reader:
    def __init__(self, data: bytes):
        self.data = data
        self.pos = 0
        self.bindings: dict[str, dict[str, Any]] = {}

    def take(self, count: int) -> bytes:
        if count < 0 or self.pos + count > len(self.data):
            raise PivError(f"Unexpected EOF at payload offset {self.pos:#x}, need {count} bytes")
        start = self.pos
        self.pos += count
        return self.data[start:self.pos]

    def read(self, fmt: str, path: str | None = None):
        offset = self.pos
        value = struct.unpack('<' + fmt, self.take(struct.calcsize('<' + fmt)))[0]
        if isinstance(value, float) and not math.isfinite(value):
            raise PivError(f"Non-finite {path or fmt} at {offset:#x}")
        if path:
            self.bindings[path] = {'offset': offset, 'format': fmt}
        return value

    def array(self, fmt: str, count: int, path: str | None = None) -> list:
        return [self.read(fmt, f'{path}/{i}' if path else None) for i in range(count)]

    def string8(self) -> str:
        return self.take(self.read('B')).decode('cp1252', errors='replace')


def _unpack_source(source: bytes) -> tuple[bytes, bool]:
    if not source:
        raise PivError('Empty project')
    if len(source) > MAX_PAYLOAD_BYTES:
        raise PivError('Project exceeds size limit')
    # Legacy raw files begin directly with a version byte.
    if source[0] in (1, 2, 3, 4, 5):
        return source, False
    inflater = zlib.decompressobj()
    try:
        payload = inflater.decompress(source, MAX_PAYLOAD_BYTES + 1)
    except zlib.error as exc:
        raise PivError(f'Invalid zlib project: {exc}') from exc
    if len(payload) > MAX_PAYLOAD_BYTES or inflater.unconsumed_tail:
        raise PivError('Decompressed project exceeds size limit')
    if not inflater.eof:
        raise PivError('Truncated compressed project')
    if inflater.unused_data:
        raise PivError('Unexpected bytes after compressed project')
    return payload, True


def _builtin_man() -> dict:
    # Implicit native slot 1, independently dumped from Pivot 5 descriptor RAM.
    # It is NOT the distinct twelve-segment figure shipped as Legacy/man.stk.
    values = [
        (0,32.,-1.5707963267948968,14.,0,0),(1,32.,-1.5707963267948968,14.,0,0),
        (2,33.,-1.5707963267948968,14.,0,0),(3,20.,1.5707963267948966,20.,1,1),
        (2,38.,2.356194490192345,14.,0,0),(2,38.,0.7853981633974483,14.,0,0),
        (5,40.,2.0943951023931957,14.,0,0),(6,40.,1.0471975511965979,14.,0,0),
        (0,50.,1.9634954084936207,14.,0,0),(0,50.,1.1780972450961724,14.,0,0),
        (9,50.,1.9634954084936207,14.,0,0),(10,50.,1.1780972450961724,14.,0,0),
    ]
    segments = []
    for i, (parent, length, angle, thickness, prim,aux) in enumerate(values):
        segments.append(dict(segment_id=i+1, parent_id=parent, length=length, angle_rad=angle,
            thickness=thickness, primitive_code=prim, aux_code=aux, flags=prim|(aux<<8), is_static=bool(aux&1),
            flag_bits={'is_static':bool(aux&1)}, color_rgb=[0,0,0], color_alpha=1., transparency=0,
            bend_rad=0., segment_kind='circle' if prim else 'line', segment_type='circle' if prim else 'line',
            segment_order_index=i, z_order_runtime_raw=i, z_order=i+1, visible=True, valid=True))
    return dict(figure_type_id=1, name='Default', segment_count=len(segments), segments=segments,
        polyfills=[], bends=[], text_assets=[], image_assets=[], has_side_table=False,
        segment_decode={'layout':'builtin_native_v5'}, z_order_mode='record_order', implicit=True)


def _asset(blob: bytes, assets_dir: Path | None, name: str) -> dict:
    if blob.startswith(b'\x89PNG\r\n\x1a\n'):
        suffix, mime = '.png', 'image/png'
    elif blob.startswith(b'\xff\xd8'):
        suffix, mime = '.jpg', 'image/jpeg'
    elif blob.startswith(b'BM'):
        suffix, mime = '.bmp', 'image/bmp'
    else:
        suffix, mime = '.bin', 'application/octet-stream'
    result = {'mime_type':mime, 'byte_length':len(blob), 'sha256':hashlib.sha256(blob).hexdigest()}
    if assets_dir:
        assets_dir.mkdir(parents=True, exist_ok=True)
        target = assets_dir / (name + suffix)
        target.write_bytes(blob)
        result.update(asset_path=str(target.resolve()), asset_path_relative=target.name)
    elif mime != 'application/octet-stream':
        result['data_url'] = f'data:{mime};base64,' + base64.b64encode(blob).decode('ascii')
    return result


def _backgrounds(r: Reader, assets_dir: Path | None) -> tuple[list, int]:
    slots = r.read('H')
    if slots < 1:
        raise PivError('Background slot count must include implicit white background')
    out = []
    for i in range(1, slots):
        path = f'/backgrounds/{i-1}'
        kind = r.read('B')
        item = {'background_id': i, 'kind': kind, 'record_offset':r.pos-1}
        if kind in (0, 1):
            end = r.read('Q')
            blob = r.take(end-r.pos)
            item.update(_asset(blob, assets_dir, f'background_{i}'))
        elif kind == 2:
            item['color'] = r.read('I', path+'/color')
        elif kind in (3,4):
            item['color_a'] = r.read('I', path+'/color_a')
            item['color_b'] = r.read('I', path+'/color_b')
            for field in ('x1','y1','x2','y2'):
                item[field] = r.read('f', path+'/'+field)
        else:
            raise PivError(f'Unsupported background kind {kind} at {r.pos-1:#x}')
        item['name'] = r.string8()
        item['record_end'] = r.pos
        out.append(item)
    return out, slots


def _figure(r: Reader, figure_id: int, assets_dir: Path | None) -> dict:
    start = r.pos
    prefix = f'/figure_types/{figure_id-1}'
    flags = r.read('B')
    count = r.read('H')
    if not 0 < count <= MAX_SEGMENTS:
        raise PivError(f'Invalid segment count {count} for figure {figure_id} at {start:#x}')
    segments = []
    for i in range(count):
        p = f'{prefix}/segments/{i}'
        offset = r.pos
        parent = r.read('H', p+'/parent_id')
        seg_id = i+1 if flags & 32 else r.read('H')
        length = r.read('f', p+'/length')
        angle = r.read('d', p+'/angle_rad')
        thickness = r.read('f', p+'/thickness')
        prim = 0 if flags & 1 else r.read('B', p+'/primitive_code')
        aux = 0 if flags & 2 else r.read('B', p+'/aux_code')
        rgb = [0,0,0] if flags & 4 else r.array('B',3,p+'/color_rgb')
        trans = 0 if flags & 8 else r.read('B',p+'/transparency')
        secondary = None
        if not flags & 128:
            if r.read('B'):
                secondary = {'rgb':r.array('B',3,p+'/secondary/rgb'), 'a':r.read('B',p+'/secondary/a')}
        extra = [r.read('H'),r.read('B'),r.read('B')] if prim in (2,5) else None
        if prim > 6:
            raise PivError(f'Unknown primitive {prim} in figure {figure_id}, segment {i}')
        seg = dict(segment_id=seg_id,parent_id=parent,length=length,angle_rad=angle,
            thickness=thickness,primitive_code=prim,aux_code=aux,flags=(aux<<8)|prim,
            color_rgb=rgb,transparency=trans,color_alpha=1.-trans/255.,secondary=secondary,
            segment_kind={0:'line',1:'circle',2:'image',3:'circleFill',4:'circleClear',5:'text',6:'squareLine'}[prim],
            segment_type='circle' if prim in (1,3,4) else ('image' if prim==2 else 'text' if prim==5 else 'line'),
            is_static=bool(aux&1),flag_bits={'is_static':bool(aux&1)},extra=extra,
            segment_order_index=i, visible=thickness>0.01 or prim in (1,2,3,4,5,6), valid=True,
            bend_rad=0.,record_offset=offset,record_end=r.pos)
        if extra:
            seg.update(extra_u16=extra[0],extra_u8_a=extra[1],extra_u8_b=extra[2])
        segments.append(seg)
    ids = {s['segment_id'] for s in segments}
    if len(ids) != count or 0 in ids:
        raise PivError(f'Invalid duplicate/zero segment IDs in figure {figure_id}')
    # Build the allowable handle set once: rebuilding its union per segment
    # made validation quadratic on large, valid 30,000-segment figures.
    valid_handles = ids | {0}
    if any(s['parent_id'] not in valid_handles for s in segments):
        raise PivError(f'Unknown parent ID in figure {figure_id}')
    parents={s['segment_id']:s['parent_id'] for s in segments}
    checked={0}
    for sid in parents:
        pending=set()
        cursor=sid
        while cursor not in checked:
            if cursor in pending:
                raise PivError(f'Cyclic segment parents in figure {figure_id}')
            pending.add(cursor)
            cursor=parents[cursor]
        checked.update(pending)
    bend_count = r.read('H')
    if bend_count > count:
        raise PivError(f'Invalid bend count in figure {figure_id}')
    bends = []
    for bi in range(bend_count):
        index = r.read('H')
        if index >= count:
            raise PivError(f'Invalid bend index {index} in figure {figure_id}')
        value = r.read('d',f'{prefix}/segments/{index}/bend_rad')
        bends.append({'segment_index':index,'bend_rad':value})
        segments[index]['bend_rad'] = value
    side = []
    if any(s['primitive_code'] in (2,5) for s in segments):
        try:
            if __package__:
                from .piv_side_tables import parse_side_tables
            else:
                from piv_side_tables import parse_side_tables
        except ImportError as exc:
            raise PivError(f'Figure {figure_id} contains unsupported image/text tables at {r.pos:#x}') from exc
        try:
            side, r.pos = parse_side_tables(r.data,r.pos,segments)
        except ValueError as exc:
            raise PivError(f'Invalid side table in figure {figure_id}: {exc}') from exc
        if assets_dir:
            for asset in side:
                if asset.get('kind')=='image':
                    asset.update(_asset(base64.b64decode(asset['data_base64']),assets_dir,
                        f'figure_{figure_id}_image_{asset["asset_index"]}'))
                    asset.pop('data_base64',None)
                    asset.pop('data_url',None)
    poly_count = r.read('H')
    if poly_count > 20000:
        raise PivError(f'Invalid polyfill count {poly_count} in figure {figure_id}')
    polys = []
    for pi in range(poly_count):
        p=f'{prefix}/polyfills/{pi}'
        sc = r.read('H')
        rgb = r.array('B',3,p+'/color_rgb')
        alpha = r.read('B',p+'/alpha_raw')
        vertices = r.array('H',sc,p+'/segment_ids')
        if any(v not in valid_handles for v in vertices):
            raise PivError(f'Unknown polyfill joint in figure {figure_id}, polygon {pi}')
        polys.append(dict(polyfill_id=pi+1,segment_ids=vertices,segment_ids_raw=vertices[:],
            vertex_id_space='joint_tip_ids',color_rgb=rgb,alpha_raw=alpha,color_alpha=1.-alpha/255.))
    seg_z = r.array('H',count,prefix+'/segment_z_raw') if not flags & 16 else list(range(count))
    poly_z = r.array('H',poly_count,prefix+'/poly_z_raw') if not flags & 16 else list(range(count,count+poly_count))
    if sorted(seg_z+poly_z) != list(range(count+poly_count)):
        raise PivError(f'Invalid z-order permutation for figure {figure_id}')
    for seg,z in zip(segments,seg_z): seg.update(z_order_runtime_raw=z,z_order=z+1)
    for poly,z in zip(polys,poly_z): poly.update(z_order_runtime_raw=z,z_order=z+1)
    style = None
    if flags & 64:
        style_offset=r.pos
        style={'u28':r.read('I',prefix+'/segment_decode/global_style/u28'),
            'rgb':r.array('B',3,prefix+'/segment_decode/global_style/rgb'),
            'u30':r.read('B',prefix+'/segment_decode/global_style/u30')}
        thickness=struct.unpack('<f',struct.pack('<I',style['u28']))[0]
        if not math.isfinite(thickness):raise PivError(f'Non-finite outline thickness in figure {figure_id}')
        style.update(outline_thickness=thickness,outline_transparency=style['u30'],
            outline_opacity=1.-style['u30']/255.)
        r.bindings[prefix+'/segment_decode/global_style/outline_thickness']={'offset':style_offset,'format':'f'}
    name = r.string8()
    return dict(figure_type_id=figure_id,name=name,segment_count=count,segments=segments,
        polyfills=polys,bends=bends,segment_z_raw=seg_z,poly_z_raw=poly_z,
        segment_decode={'layout':'piv_v5_sequential','flags_byte':flags,'records_start':start,
            'records_end':r.pos,'global_style':style},
        has_side_table=bool(side),side_tables=side,text_assets=[x for x in side if x.get('kind')=='text'],
        image_assets=[x for x in side if x.get('kind')=='image'],z_order_mode='runtime_z_map')


def _keyframes(r: Reader, figures: list, bg_slots: int) -> list:
    count = r.read('I')
    if count > 1000000:
        raise PivError(f'Implausible keyframe count {count} at {r.pos-4:#x}')
    types = {f['figure_type_id']:f for f in figures}
    frames=[]
    for fi in range(count):
        p=f'/keyframes/{fi}'
        start=r.pos
        duration=r.read('H',p+'/duration_raw')
        mix=r.read('B',p+'/background_mix')
        bg=r.read('H',p+'/background_id')
        bg_b=r.read('H',p+'/background_id_b') if mix else None
        if bg>=bg_slots or (bg_b is not None and bg_b>=bg_slots):
            raise PivError(f'Unknown background in frame {fi} at {start:#x}')
        objects=[]
        obj_count=r.read('H')
        for oi in range(obj_count):
            op=f'{p}/objects/{oi}'
            obj_start=r.pos
            uid=r.read('I')
            tid=r.read('H')
            if tid not in types:
                raise PivError(f'Unknown figure type {tid} in frame {fi}, object {oi} at {obj_start:#x}')
            sc=types[tid]['segment_count']
            obj={'object_slot':oi,'unique_id':uid,'figure_type_id':tid,
                'scale':r.read('f',op+'/scale'),'color_override_raw':r.read('I',op+'/color_override_raw'),
                'field28':r.read('B',op+'/field28')}
            if types[tid].get('image_assets') or types[tid].get('text_assets'):
                obj['image_text_flags']=r.read('B',op+'/image_text_flags')
            obj.update(angles=r.array('d',sc,op+'/angles'),root_x=r.read('f',op+'/root_x'),
                root_y=r.read('f',op+'/root_y'))
            color=obj['color_override_raw']
            obj.update(color_override_rgb=[color&255,(color>>8)&255,(color>>16)&255],
                color_override_mix=color>>24,transparency=obj['field28'],opacity=1.-obj['field28']/255.)
            lf=r.read('H')
            obj['len_flag']=lf
            obj['lengths']=r.array('f',sc,op+'/lengths') if lf else []
            bf=r.read('H')
            obj['bend_flag']=bf
            obj['bends']=r.array('d',sc,op+'/bends') if bf else []
            join_flag=r.read('B')
            obj['join']=None
            if join_flag:
                slot=r.read('H',op+'/join/target_object_slot')
                handle=r.read('H',op+'/join/target_handle_id')
                if slot>=obj_count: raise PivError(f'Invalid joined object slot {slot} in frame {fi}')
                obj['join']={'target_object_slot':slot,'target_handle_id':handle}
            obj.update(record_offset=obj_start,record_end=r.pos)
            objects.append(obj)
        for obj in objects:
            if obj['join']:
                target=objects[obj['join']['target_object_slot']]
                handles={0,*(s['segment_id'] for s in types[target['figure_type_id']]['segments'])}
                if obj['join']['target_handle_id'] not in handles:
                    raise PivError(f'Unknown joined target handle in frame {fi}')
                obj['join']['target_unique_id']=target['unique_id']
        for oi in range(obj_count):
            visited=set()
            cursor=oi
            while objects[cursor]['join']:
                if cursor in visited:
                    raise PivError(f'Cyclic object joins in frame {fi}')
                visited.add(cursor)
                cursor=objects[cursor]['join']['target_object_slot']
        unique_ids=[obj['unique_id'] for obj in objects]
        signed=lambda uid:uid if uid<0x80000000 else uid-0x100000000
        if len(set(unique_ids))!=len(unique_ids) or unique_ids!=sorted(unique_ids,key=signed):
            raise PivError(f'Object IDs must be unique and sorted as signed integers in frame {fi}')
        order=r.array('H',obj_count,p+'/object_draw_order')
        if sorted(order)!=list(range(obj_count)):
            raise PivError(f'Invalid object draw-order permutation in frame {fi} at {r.pos:#x}')
        default=r.read('B')
        camera={'is_default':bool(default),'x':0.,'y':0.,'angle_rad':0.,'scale':1.}
        if not default:
            camera.update(x=r.read('f',p+'/camera/x'),y=r.read('f',p+'/camera/y'),
                angle_rad=r.read('d',p+'/camera/angle_rad'),scale=r.read('f',p+'/camera/scale'))
        frames.append(dict(keyframe_index=fi,duration_raw=duration,inbetweens=duration-1,hidden=duration==0,
            background_mix=mix,background_id=bg,background_id_b=bg_b,objects=objects,
            object_draw_order=order,object_draw_order_unique_ids=[objects[i]['unique_id'] for i in order],
            camera=camera,record_offset=start,record_end=r.pos))
    return frames


def _decode(source: bytes, source_path: str = '', assets_dir: Path | None = None) -> tuple[dict,Reader,bool]:
    payload, compressed = _unpack_source(source)
    r=Reader(payload)
    version=r.read('B')
    if version != 5:
        try:
            if __package__:
                from .piv_legacy import decode_legacy_payload
            else:
                from piv_legacy import decode_legacy_payload
        except ImportError as exc:
            raise PivError(f'Unsupported PIV version {version}; current decoder requires version 5') from exc
        report=decode_legacy_payload(payload,source_path=source_path,assets_root=assets_dir)
        r.bindings=report.pop('_bindings',{})
        delay_binding=r.bindings.get('/frame_delay_ms')
        if delay_binding:
            r.bindings['/fps']={**delay_binding,'transform':'fps_to_delay_ms'}
        r.pos=len(payload)
        return report,r,compressed
    width=r.read('I','/canvas_width');height=r.read('I','/canvas_height')
    if not (0<width<=100000 and 0<height<=100000): raise PivError('Invalid canvas dimensions')
    backgrounds,bg_slots=_backgrounds(r,assets_dir)
    figure_slots=r.read('H')
    if figure_slots<2: raise PivError('Figure table must include reserved and implicit slots')
    table_start=r.pos
    figures=[_builtin_man()]
    for tid in range(2,figure_slots): figures.append(_figure(r,tid,assets_dir))
    frame_start=r.pos
    frames=_keyframes(r,figures,bg_slots)
    for fi,(outgoing,incoming) in enumerate(zip(frames,frames[1:])):
        if outgoing['duration_raw']<=1:continue
        types_out={obj['unique_id']:obj['figure_type_id'] for obj in outgoing['objects']}
        for obj in incoming['objects']:
            if obj['unique_id'] in types_out and types_out[obj['unique_id']]!=obj['figure_type_id']:
                raise PivError(f'Cannot interpolate a changed figure type for object {obj["unique_id"]} in frame {fi}')
    fps=r.read('I','/fps')
    if not 1<=fps<=1000: raise PivError(f'Invalid fps {fps} at {r.pos-4:#x}')
    trailer_start=r.pos
    # Native Options/Auto-Easing checkbox stores the complement of this byte.
    # Older saves may omit it; native then retains its application preference.
    ease_raw=r.read('B','/auto_easing_disabled_raw') if r.pos<len(payload) else None
    if ease_raw is not None and ease_raw not in (0,1):
        raise PivError(f'Invalid auto-easing mode {ease_raw} at {trailer_start:#x}')
    if ease_raw is not None:
        r.bindings['/auto_easing']={'offset':trailer_start,'format':'B','transform':'invert_bool'}
    r.pos=trailer_start
    tail=r.take(len(payload)-r.pos)
    total_frames=sum(f['duration_raw'] for f in frames[:-1])+(int(frames[-1]['duration_raw']>0) if frames else 0)
    report=dict(source_path=source_path,source_size=len(source),payload_size=len(payload),file_type='piv',
        format='piv_v5_standalone',decode_status='decoded',trace_assisted=False,version=version,
        canvas_width=width,canvas_height=height,backgrounds=backgrounds,background_slots=bg_slots,
        figure_slots=figure_slots,figure_types=figures,keyframes=frames,fps=fps,
        total_output_frames=total_frames,duration_seconds=total_frames/fps,
        auto_easing=ease_raw in (None,0),auto_easing_disabled_raw=ease_raw,
        auto_easing_source='application_default' if ease_raw is None else 'file',
        trailing_bytes_hex=tail.hex(),supports_viewer=True,
        validation={'figure_table_start':table_start,'frame_start':frame_start,'trailer_start':trailer_start,
            'payload_consumed':len(payload),'custom_figure_count':len(figures)-1,'keyframe_count':len(frames),
            'editable_field_count':len(r.bindings)},
        notes=['Sequential binary grammar; no trace, marker scan, or external figure files needed.',
            'The first trailer byte is the inverted Auto-Easing option; further bytes are preserved.',
            *(['Auto-Easing omitted: standalone uses the fresh application default ON; native may inherit a different saved preference.'] if ease_raw is None else [])])
    return report,r,compressed


def decode_piv_bytes(source: bytes, *, source_path: str = '', assets_dir: Path | None = None,
                     include_lossless: bool = False) -> dict:
    report,r,compressed=_decode(source,source_path,Path(assets_dir) if assets_dir else None)
    report.setdefault('source_size',len(source))
    report.setdefault('payload_size',len(r.data))
    report['source_sha256']=hashlib.sha256(source).hexdigest()
    report['editable_paths']=list(r.bindings)
    if include_lossless:
        report['_codec']={'source_base64':base64.b64encode(source).decode('ascii'),'bindings':r.bindings,
            'compressed':compressed}
    return report


def decode_piv_file(path: str | Path, assets_dir: str | Path | None = None,
                    include_lossless: bool = False) -> dict:
    path=Path(path)
    return decode_piv_bytes(path.read_bytes(),source_path=str(path.resolve()),
        assets_dir=Path(assets_dir) if assets_dir else None,include_lossless=include_lossless)


def encode_piv_bytes(source: bytes, edits: list[dict] | None = None) -> bytes:
    """Apply JSON-pointer scalar edits while retaining all other payload bytes.

    Arrays may be supplied as one edit when every element already exists. Lists
    cannot grow/shrink and optional fields cannot be introduced by this API.
    """
    if not edits:
        _unpack_source(source)
        return bytes(source)
    report,r,compressed=_decode(source)
    payload=bytearray(r.data)
    flat=[]
    def get_pointer(path):
        current=report
        try:
            for token in path.split('/')[1:]:
                token=token.replace('~1','/').replace('~0','~')
                current=current[int(token)] if isinstance(current,list) else current[token]
        except (KeyError,IndexError,ValueError,TypeError) as exc:
            raise PivError(f'Unknown edit path: {path}') from exc
        return current
    def flatten(path,value):
        if isinstance(value,list):
            original=get_pointer(path)
            if not isinstance(original,list) or len(value)!=len(original):
                raise PivError(f'Cannot change array length: {path}')
            for i,v in enumerate(value): flatten(f'{path}/{i}',v)
        else: flat.append((path,value))
    for edit in edits:
        if set(edit)!={'path','value'} or not isinstance(edit['path'],str):
            raise PivError('Each edit must contain exactly path and value')
        flatten(edit['path'],edit['value'])
    for path,value in flat:
        binding=r.bindings.get(path)
        if not binding: raise PivError(f'Field is not safely editable: {path}')
        fmt=binding['format']
        if binding.get('transform')=='invert_bool':
            if not isinstance(value,bool): raise PivError(f'Edit must be a boolean: {path}')
            value=int(not value)
        elif binding.get('transform')=='fps_to_delay_ms':
            if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value) or not 1<=value<=1000 or int(value)!=value:
                raise PivError('Legacy FPS must be an integer from 1 to 1000')
            if value==report['fps']:
                continue  # Keep the original exact interval for unchanged UI FPS.
            delay=round(1000/value)
            if not delay or round(1000/delay)!=value:
                raise PivError(f'FPS {value} is not exactly representable as native integer milliseconds; edit /frame_delay_ms explicitly')
            value=delay
        if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value):
            raise PivError(f'Edit must be a finite number: {path}')
        if fmt not in ('f','d'):
            if int(value)!=value: raise PivError(f'Edit must be an integer: {path}')
            value=int(value)
        try: struct.pack_into('<'+fmt,payload,binding['offset'],value)
        except (struct.error,OverflowError) as exc: raise PivError(f'Out-of-range edit: {path}') from exc
    if payload==r.data: return bytes(source)
    result=zlib.compress(payload) if compressed else bytes(payload)
    # Reject edits that break references, permutations, flags, or boundaries.
    _decode(result)
    return result


def encode_piv_document(source: bytes, document: dict) -> bytes:
    """Rebuild a V5 frame stream; see :mod:`piv_document` for its contract."""
    if __package__:
        from .piv_document import encode_piv_document as encode
    else:
        from piv_document import encode_piv_document as encode
    return encode(source,document)


def encode_piv_project(source: bytes, document: dict, *, workspace_root: str | Path | None = None,
                       force_rebuild: bool = False) -> bytes:
    """Serialize edited V5 figure/background tables and their frame references."""
    if __package__:
        from .piv_full_writer import encode_piv_project as encode
    else:
        from piv_full_writer import encode_piv_project as encode
    return encode(source,document,workspace_root=workspace_root,force_rebuild=force_rebuild)


def main() -> int:
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('source',type=Path)
    ap.add_argument('--out',type=Path)
    ap.add_argument('--assets-dir',type=Path)
    writes=ap.add_mutually_exclusive_group()
    writes.add_argument('--edits',type=Path,metavar='JSON',help='Apply fixed-field JSON edits to a separate output file')
    writes.add_argument('--document',type=Path,metavar='JSON',help='Serialize a complete edited V5 scene document')
    writes.add_argument('--convert-v5',nargs='?',const=True,default=None,type=Path,metavar='JSON',
        help='Migrate legacy source to V5, optionally applying an edited legacy JSON document')
    ap.add_argument('--media-root',type=Path,help='Explicit workspace boundary for --document disk image assets')
    args=ap.parse_args()
    writing=args.edits is not None or args.document is not None or args.convert_v5 is not None
    if writing and not args.out:ap.error('--edits, --document and --convert-v5 require --out')
    if args.media_root is not None and args.document is None:ap.error('--media-root requires --document')
    try:
        if args.out:
            same_path=args.source.resolve()==args.out.resolve()
            same_inode=args.out.exists() and args.source.exists() and args.out.samefile(args.source)
            if same_path or same_inode:ap.error('Output must be a different file; the original source is never overwritten')
        def read_json(path):return json.loads(path.read_text(encoding='utf-8-sig'))
        if args.edits is not None:
            output=encode_piv_bytes(args.source.read_bytes(),read_json(args.edits))
        elif args.document is not None:
            output=encode_piv_project(args.source.read_bytes(),read_json(args.document),workspace_root=args.media_root)
        elif args.convert_v5 is not None:
            if __package__:
                from .piv_migrate import migrate_legacy_bytes
            else:
                from piv_migrate import migrate_legacy_bytes
            document=None if args.convert_v5 is True else read_json(args.convert_v5)
            output=migrate_legacy_bytes(args.source.read_bytes(),document)
        else:
            report=decode_piv_file(args.source,args.assets_dir)
            output=json.dumps(report,indent=2,ensure_ascii=False).encode('utf-8')
        if args.out:
            args.out.parent.mkdir(parents=True,exist_ok=True)
            args.out.write_bytes(output)
        else:print(output.decode('utf-8'))
    except (PivError,OSError,json.JSONDecodeError) as exc:
        ap.error(str(exc))
    return 0


if __name__=='__main__':
    raise SystemExit(main())
