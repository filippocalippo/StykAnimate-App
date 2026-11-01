/**
 * What the interface asks of the figure types of a document. The table of the read view (`report.figure_types`, src/lazy-table.mjs)
 * fetches a type when it is read, so no reader walks it to answer a question about one type or about all: these answer from
 * the table's rows, which hold each type's id, name, kind, segment count, drawing cel and whether it draws pictures, and fetch
 * only the type asked for. They take a plain array as well (a document the interface built itself, a movieclip's).
 */
import {figureRow, tableOf} from './lazy-table.mjs';

/** The first figure type with id `id`, or undefined (`figures.find(f => f.figure_type_id === id)`). */
export function findFigureType(figures, id) {
  const table = tableOf(figures);
  if (!table) return figures?.find(figure => figure.figure_type_id === id);
  const at = table.positionOf(id);
  return at < 0 ? undefined : figures[at];
}

/** The rows of the figure types, in order: `{id, name, cel, kind, segments, pictures}` (see `figureRow`), with no type fetched. */
export function figureRows(figures) {
  const table = tableOf(figures);
  return table ? table.rows() : (figures ?? []).map(figureRow);
}

/** The id the next figure type takes: one above the greatest (at least 1). */
export const nextFigureTypeId = figures => figureRows(figures).reduce((next, row) => Math.max(next, row.id + 1), 1);

/** The figure types that carry a drawing cel, fetching those alone (`figures.filter(drawingMetadata)`). */
export function drawingFigures(figures) {
  const rows = figureRows(figures);
  return rows.flatMap((row, index) => row.cel === null ? [] : [figures[index]]);
}

/** The figure type that carries drawing cel `celId`, or undefined. */
export function figureForCel(figures, celId) {
  if (celId === undefined || celId === null) return undefined;
  const at = figureRows(figures).findIndex(row => row.cel === celId);
  return at < 0 ? undefined : figures[at];
}

/** Whether any figure type carries a drawing cel. */
export const hasDrawingFigures = figures => figureRows(figures).some(row => row.cel !== null);

/** The movieclip figure types (fetched), which hold documents of their own. */
export function movieclipFigures(figures) {
  return figureRows(figures).flatMap((row, index) => row.kind === 'Movieclip' ? [figures[index]] : []);
}
