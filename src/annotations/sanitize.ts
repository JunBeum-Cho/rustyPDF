import { normalizeFontFamily } from "./fonts";
import DOMPurify from "dompurify";
import type { Annotation } from "./types";

// Rich text needs typography, not arbitrary layout, resource loading, or UI IDs.
const TEXT_STYLES = new Set([
  "color", "background-color", "font-family", "font-size", "font-weight",
  "font-style", "text-decoration", "text-decoration-line", "text-align",
  "line-height", "letter-spacing", "word-spacing", "white-space",
  "vertical-align", "text-indent",
]);

DOMPurify.addHook("uponSanitizeAttribute", (node, data) => {
  if (data.attrName === "face") { data.attrValue = normalizeFontFamily(data.attrValue); return; }
  if (data.attrName !== "style") return;
  const source = (node as HTMLElement).style;
  if (!source) {
    data.keepAttr = false;
    return;
  }
  const clean = document.createElement("span").style;
  for (const property of Array.from(source)) {
    const value = source.getPropertyValue(property);
    if (TEXT_STYLES.has(property) && !/url\s*\(|expression\s*\(|var\s*\(|[\\@]/i.test(value)) {
      clean.setProperty(property, property === "font-family" ? normalizeFontFamily(value) : property === "font-style" && /^(italic|oblique)/.test(value) ? "oblique 12deg" : value);
    }
  }
  data.attrValue = clean.cssText;
  data.keepAttr = clean.cssText.length > 0;
});

/** The same policy is used for sidecars, editing, measurement, and rendering. */
export const sanitizeAnnotationHtml = (html: string): string =>
  DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      "b", "strong", "i", "em", "u", "s", "strike", "span", "br",
      "div", "p", "font", "sub", "sup", "ul", "ol", "li",
    ],
    ALLOWED_ATTR: ["style", "color", "face", "size", "align"],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  });

export const escapeAnnotationText = (text: string): string => text
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/\r?\n/g, "<br>");

export const sanitizeAnnotation = (annotation: Annotation): Annotation => {
  if (annotation.type !== "text") return annotation;
  return {
    ...annotation,
    style: { ...annotation.style, fontFamily: normalizeFontFamily(annotation.style.fontFamily) },
    payload: {
      ...annotation.payload,
      ...(annotation.payload?.html == null ? {} : { html: typeof annotation.payload.html === "string"
        ? sanitizeAnnotationHtml(annotation.payload.html)
        : "" }),
    },
  };
};

/** Prevent browser paste/drop from inserting unsafe markup before onInput runs. */
export const insertSafeEditorTransfer = (transfer: DataTransfer): void => {
  const html = transfer.getData("text/html");
  const template = document.createElement("template");
  template.innerHTML = sanitizeAnnotationHtml(html);
  // Match the destination's typography. In particular, copied PDF/OCR
  // overlays carry invisible colors and page-sized font metrics.
  template.content.querySelectorAll<HTMLElement>("*").forEach((element) => {
    element.removeAttribute("color");
    element.removeAttribute("face");
    element.removeAttribute("size");
    for (const property of Array.from(element.style)) {
      if (!["font-weight", "font-style", "text-decoration", "text-decoration-line", "vertical-align"].includes(property)) {
        element.style.removeProperty(property);
      }
    }
    if (!element.style.cssText) element.removeAttribute("style");
  });
  const safe = template.content.textContent?.trim()
    ? template.innerHTML
    : escapeAnnotationText(transfer.getData("text/plain"));
  if (safe) document.execCommand("insertHTML", false, safe);
};
