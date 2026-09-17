export const SUPPORTED_CONTEXT_UPLOAD_EXTENSIONS = [".md", ".markdown", ".pdf"];

/** Accept-attribute value for the Project Context "Upload MD/PDF" file inputs (ProjectContextPanel). */
export const CONTEXT_UPLOAD_ACCEPT = SUPPORTED_CONTEXT_UPLOAD_EXTENSIONS.join(",");

/** 10 MiB — generous for a plain-text guidance document, well short of anything that would make
 *  client-side PDF parsing noticeably slow in the browser. */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export class UnsupportedFileTypeError extends Error {
  constructor(fileName: string) {
    super(`"${fileName}" isn't a supported file type — only .md, .markdown, and .pdf are supported.`);
    this.name = "UnsupportedFileTypeError";
  }
}

export class FileTooLargeError extends Error {
  constructor(fileName: string) {
    super(`"${fileName}" is too large to upload here (max 10 MB).`);
    this.name = "FileTooLargeError";
  }
}

/**
 * Extracts plain text from a Project Context upload — entirely client-side, on purpose: no backend
 * upload endpoint exists (or is needed) for this, matching the same "prefer a frontend
 * representation over adding a new backend endpoint" call already made for the AI Context Preview
 * (see lib/projectContextPreview.ts). A .md/.markdown file is just read as text; a .pdf is parsed
 * with pdf.js entirely in the browser — the file's bytes never leave the device, and nothing is
 * saved anywhere until the user reviews the resulting list items and explicitly clicks "Save
 * Changes" (see ProjectContextPanel — this never bypasses the existing PUT/revision contract).
 */
export async function extractTextFromFile(file: File): Promise<string> {
  if (file.size > MAX_UPLOAD_BYTES) throw new FileTooLargeError(file.name);

  const lowerName = file.name.toLowerCase();
  if (lowerName.endsWith(".md") || lowerName.endsWith(".markdown")) {
    return readFileAsText(file);
  }
  if (lowerName.endsWith(".pdf")) {
    return extractPdfText(file);
  }
  throw new UnsupportedFileTypeError(file.name);
}

/** FileReader, not `file.text()` — broader compatibility (including this project's jsdom-based
 *  test environment, which doesn't implement Blob.text()). */
function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error ?? new Error(`Could not read "${file.name}".`));
    reader.readAsText(file);
  });
}

let pdfjsReady: Promise<typeof import("pdfjs-dist")> | undefined;

/** pdf.js (and its ~1.2 MB worker) is only ever needed by the tiny fraction of visits that upload a
 *  PDF into Project Context — dynamically imported so the other 99% of the app never pays for it in
 *  the main bundle. Cached on first use so re-uploading a second PDF doesn't re-fetch it. */
function loadPdfjs(): Promise<typeof import("pdfjs-dist")> {
  if (!pdfjsReady) {
    pdfjsReady = Promise.all([
      import("pdfjs-dist"),
      // Vite's `?url` import gives the worker script's built, hashed URL — pdf.js needs an actual
      // worker script (it does its parsing off the main thread), not a bundled module.
      import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
    ]).then(([pdfjsLib, worker]) => {
      pdfjsLib.GlobalWorkerOptions.workerSrc = worker.default;
      return pdfjsLib;
    });
  }
  return pdfjsReady;
}

async function extractPdfText(file: File): Promise<string> {
  const pdfjsLib = await loadPdfjs();
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  const pageTexts: string[] = [];
  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const pageText = content.items.map((item) => ("str" in item ? item.str : "")).join(" ");
      pageTexts.push(pageText);
    }
  } finally {
    await pdf.cleanup();
  }
  return pageTexts.join("\n");
}
