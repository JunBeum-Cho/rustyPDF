import { cp, mkdir, writeFile, rm } from "node:fs/promises";
import { build } from "esbuild";
const assets = "resources/assets";
await mkdir(assets, { recursive: true });
for (const name of ["cmaps", "standard_fonts", "wasm"])
  await cp(`node_modules/pdfjs-dist/${name}`, `public/pdfjs/${name}`, {
    recursive: true,
  });
await cp(
  "node_modules/pdfjs-dist/build/pdf.worker.min.mjs",
  "public/pdfjs/pdf.worker.min.mjs",
);
for (const lang of ["eng", "kor"])
  await cp(
    `node_modules/@tesseract.js-data/${lang}/4.0.0/${lang}.traineddata.gz`,
    `${assets}/tessdata/${lang}.traineddata.gz`,
    { recursive: false },
  ).catch(async () => {
    await mkdir(`${assets}/tessdata`, { recursive: true });
    await cp(
      `node_modules/@tesseract.js-data/${lang}/4.0.0/${lang}.traineddata.gz`,
      `${assets}/tessdata/${lang}.traineddata.gz`,
    );
  });
await build({
  entryPoints: ["node_modules/tesseract.js/src/worker-script/node/index.js"],
  outfile: `${assets}/tesseract/worker-script/node/index.js`,
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["tesseract.js-core/*"],
});
await cp(
  "node_modules/tesseract.js-core",
  `${assets}/tesseract/worker-script/node/node_modules/tesseract.js-core`,
  { recursive: true },
);
await rm(`${assets}/tesseract-core`, { recursive: true, force: true });
await rm(`${assets}/fonts`, { recursive: true, force: true });
await cp("resources/fonts", `${assets}/fonts`, { recursive: true }).catch(
  (error) => {
    if (error.code !== "ENOENT") throw error;
  },
);
await writeFile(
  `${assets}/tesseract/package.json`,
  JSON.stringify({ type: "commonjs" }),
);
console.log("Offline PDF.js and OCR assets prepared.");

// Serve the exact embedded TrueType faces to the annotation renderer offline.
await rm("public/fonts", { recursive: true, force: true });
await cp("resources/fonts", "public/fonts", { recursive: true });
