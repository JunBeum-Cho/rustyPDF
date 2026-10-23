import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ALWAYS_KEEP = " 0123456789";

export async function subsetFontBytes(
  bytes: Uint8Array,
  text: string,
): Promise<Uint8Array> {
  try {
    // @ts-ignore subset-font ships no type declarations
    const { default: subsetFont } = await import("subset-font");
    const result = await subsetFont(Buffer.from(bytes), ALWAYS_KEEP + text, {
      targetFormat: "truetype",
    });
    const out = new Uint8Array(result.buffer, result.byteOffset, result.byteLength);
    return out.byteLength > 0 ? out : bytes;
  } catch {
    return bytes;
  }
}

export async function loadFontBytes(
  fileName: string,
  fontsDir?: string,
): Promise<Uint8Array> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    ...(fontsDir ? [path.join(fontsDir, fileName)] : []),
    path.resolve(here, "..", "resources", "fonts", fileName),
    path.resolve(here, "..", "..", "resources", "fonts", fileName),
  ];
  let last: unknown;
  for (const file of candidates) {
    try {
      return new Uint8Array(await readFile(file));
    } catch (error) {
      last = error;
    }
  }
  throw last;
}
