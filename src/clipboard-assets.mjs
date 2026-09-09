const clone = value => structuredClone(value);
const SOURCE_LOCATORS = new Set(['record_offset', 'record_end', 'records_start', 'records_end', 'source_start', 'source_end', 'source_offset', 'source_size', 'image_start']);

export function portableAsset(asset, {image = false} = {}) {
  const next = clone(asset);
  for (const key of SOURCE_LOCATORS) delete next[key];
  if (image) {
    next.kind = 'image'; next.asset_index ??= next.table_index ?? next.image_index ?? next.sprite_index ?? 0; next.table_index = next.asset_index;
    next.anchor_start ??= next.pivot; next.anchor_end ??= next.endpoint;
    next.data_url ??= next.data_uri;
    // Legacy keyed BMPs retain the original opaque bitmap in data_uri and the
    // visible transparent PNG in data_url. The portable native record uses PNG.
    if (next.data_url) { delete next.data_uri; delete next.data_base64; }
    const mime = /^data:([^;]+);base64,/.exec(next.data_url ?? '')?.[1];
    if (mime) next.mime_type = mime;
  }
  return next;
}

export function portableFigure(figure, legacy) {
  const next = clone(figure);
  if (next.segment_decode) for (const key of SOURCE_LOCATORS) delete next.segment_decode[key];
  next.image_assets = (next.image_assets ?? []).map(asset => portableAsset(asset, {image: true}));
  next.text_assets = (next.text_assets ?? []).map(asset => portableAsset(asset));
  if (next.side_tables) delete next.side_tables; // canonical asset tables contain the same complete records
  for (const segment of next.segments) {
    for (const key of SOURCE_LOCATORS) delete segment[key];
    if (legacy) {
      segment.aux_code = ((segment.aux_code ?? 0) & 254) | Number(Boolean(segment.is_static ?? segment.static_raw));
      if ([2, 5].includes(segment.primitive_code)) {
        segment.extra_u16 ??= segment.image_asset_index ?? segment.sprite_index ?? 0;
        segment.extra_u8_a ??= segment.image_flip ?? segment.sprite_flip ?? 0; segment.extra_u8_b ??= 0;
      }
      segment.flags = segment.primitive_code | (segment.aux_code << 8);
    }
  }
  if (legacy) next.implicit = false;
  return next;
}

export function portableBackground(background) {
  const next = portableAsset(background);
  if (!next.data_url && next.data_uri) next.data_url = next.data_uri;
  if (next.data_url) { delete next.data_uri; delete next.data_base64; }
  if (typeof next.kind === 'string') next.kind = /jpe?g/.test(next.kind) ? 1 : 0;
  return next;
}

