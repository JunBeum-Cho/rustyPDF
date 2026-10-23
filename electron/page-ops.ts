import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { PDFDocument, PDFPage, degrees } from "pdf-lib";
import type { PageMeta } from "./pdf-types.js";

export type PageEdit = {
  kind: "delete" | "duplicate" | "rotate" | "move" | "insert";
  indices?: number[];
  direction?: 1 | -1;
  toIndex?: number;
  afterIndex?: number;
  sourceBytes?: Uint8Array;
};
export type PageEditResult = {
  bytes: Uint8Array;
  pages: PageMeta[];
  mapping: (number | null)[];
  rotated: number[];
};

export function pageMeta(pdf: PDFDocument): PageMeta[] {
  return pdf.getPages().map((page, index) => {
    const box = page.getCropBox();
    const rotation = ((page.getRotation().angle % 360) + 360) % 360;
    if (![0, 90, 180, 270].includes(rotation))
      throw new Error("Invalid page rotation");
    return {
      index,
      width: rotation % 180 ? box.height : box.width,
      height: rotation % 180 ? box.width : box.height,
      rotation,
    };
  });
}

function reindex(pages: PageMeta[]): PageMeta[] {
  return pages.map((p, index) => ({ ...p, index }));
}

function checkIndices(raw: unknown, count: number): number[] {
  if (!Array.isArray(raw) || raw.length === 0)
    throw new Error("페이지를 선택하세요");
  const set = new Set<number>();
  for (const i of raw) {
    if (!Number.isInteger(i) || i < 0 || i >= count)
      throw new Error("Invalid page index");
    set.add(i);
  }
  return [...set].sort((a, b) => a - b);
}

export async function applyPageEdit(
  bytes: Uint8Array,
  op: PageEdit,
): Promise<PageEditResult> {
  const pdf = await PDFDocument.load(bytes);
  const count = pdf.getPageCount();
  let pages = pageMeta(pdf);
  let mapping: (number | null)[] = pages.map((_, i) => i);
  let rotated: number[] = [];
  if (op.kind === "insert") {
    if (!op.sourceBytes) throw new Error("삽입할 PDF가 없습니다");
    const after = op.afterIndex;
    if (!Number.isInteger(after) || after! < -1 || after! >= count)
      throw new Error("Invalid insertion index");
    const at = after! + 1;
    const source = await PDFDocument.load(op.sourceBytes);
    const copied = await pdf.copyPages(source, source.getPageIndices());
    copied.forEach((p, i) => pdf.insertPage(at + i, p));
    const added = pageMeta(source);
    mapping = mapping.map((i) => (i! >= at ? i! + copied.length : i));
    pages = reindex([...pages.slice(0, at), ...added, ...pages.slice(at)]);
  } else {
    const indices = checkIndices(op.indices, count);
    if (op.kind === "delete") {
      if (indices.length === count) throw new Error("Cannot delete every page");
      const del = new Set(indices);
      for (const i of [...indices].reverse()) pdf.removePage(i);
      let next = 0;
      mapping = mapping.map((i) => (del.has(i!) ? null : next++));
      pages = reindex(pages.filter((_, i) => !del.has(i)));
    } else if (op.kind === "rotate") {
      if (op.direction !== 1 && op.direction !== -1)
        throw new Error("Invalid rotation direction");
      const all = pdf.getPages();
      for (const i of indices) {
        const p = all[i];
        p.setRotation(
          degrees((p.getRotation().angle + op.direction * 90 + 360) % 360),
        );
      }
      pages = pageMeta(pdf);
      rotated = indices;
    } else if (op.kind === "duplicate") {
      const at = indices[indices.length - 1] + 1;
      const copied = await pdf.copyPages(pdf, indices);
      copied.forEach((p, i) => pdf.insertPage(at + i, p));
      mapping = mapping.map((i) => (i! >= at ? i! + copied.length : i));
      pages = reindex([
        ...pages.slice(0, at),
        ...indices.map((i) => pages[i]),
        ...pages.slice(at),
      ]);
    } else if (op.kind === "move") {
      const to = op.toIndex;
      const rest = count - indices.length;
      if (!Number.isInteger(to) || to! < 0 || to! > rest)
        throw new Error("Invalid move target");
      const moving = new Set(indices);
      const all = pdf.getPages();
      const order: number[] = [];
      const remaining = all.map((_, i) => i).filter((i) => !moving.has(i));
      order.push(...remaining.slice(0, to), ...indices, ...remaining.slice(to));
      const refs: PDFPage[] = order.map((i) => all[i]);
      for (let i = count - 1; i >= 0; i--) pdf.removePage(i);
      refs.forEach((p, i) => pdf.insertPage(i, p));
      mapping = new Array(count);
      order.forEach((old, n) => (mapping[old] = n));
      pages = reindex(order.map((i) => pages[i]));
    } else {
      throw new Error("Unknown page edit");
    }
  }
  return { bytes: await pdf.save(), pages, mapping, rotated };
}

export async function extractPages(
  bytes: Uint8Array,
  indices: number[],
): Promise<Uint8Array> {
  const source = await PDFDocument.load(bytes);
  if (!Array.isArray(indices) || indices.length === 0)
    throw new Error("페이지를 선택하세요");
  for (const i of indices)
    if (!Number.isInteger(i) || i < 0 || i >= source.getPageCount())
      throw new Error("Invalid page index");
  const out = await PDFDocument.create();
  const copied = await out.copyPages(source, indices);
  copied.forEach((p) => out.addPage(p));
  return out.save();
}

export async function mergePdfFiles(paths: string[]): Promise<Uint8Array> {
  if (!Array.isArray(paths) || paths.length < 1)
    throw new Error("합칠 PDF를 선택하세요");
  const out = await PDFDocument.create();
  for (const path of paths) {
    const source = await PDFDocument.load(await readFile(path), {
      ignoreEncryption: true,
    });
    if (source.isEncrypted)
      throw new Error(`암호화된 PDF는 합칠 수 없습니다: ${basename(path)}`);
    const copied = await out.copyPages(source, source.getPageIndices());
    copied.forEach((p) => out.addPage(p));
  }
  return out.save();
}
