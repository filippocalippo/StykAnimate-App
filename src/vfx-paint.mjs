import {normalizePaint} from './paint.mjs';
export function vfxPaint(value){return typeof value==='number'?{type:'solid',angle:0,stops:[{offset:0,color:[value>>>16&255,value>>>8&255,value&255],opacity:1}]}:normalizePaint(value);}
