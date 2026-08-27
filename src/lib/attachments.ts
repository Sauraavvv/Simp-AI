import type { Attachment } from "@/lib/types";

/** Plain-text-ish files read as-is, no parsing needed. */
const TEXT_EXTENSIONS = [
  ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".yaml", ".yml",
  ".xml", ".html", ".css", ".log", ".ini", ".toml", ".sql",
  ".py", ".js", ".jsx", ".ts", ".tsx", ".java", ".c", ".h", ".cpp",
  ".cs", ".go", ".rs", ".rb", ".php", ".sh", ".swift", ".kt",
];

/**
 * Binary document formats with their own extractor below (readPdf, readDocx)
 * -- pulled in as dynamic imports so pdfjs-dist and mammoth are not part of
 * the bundle for everyone who never attaches one.
 */
const DOCUMENT_EXTENSIONS = [".pdf", ".docx"];

/**
 * Legacy .doc is a proprietary binary format with no practical browser-side
 * parser (unlike .docx, which is just zipped XML) -- called out explicitly
 * so the error names the fix (re-save as .docx or PDF) instead of a generic
 * "not a text file" that leaves someone re-attaching the same file.
 */
const UNSUPPORTED_EXTENSIONS = [".doc"];

export const ACCEPTED_EXTENSIONS = [...TEXT_EXTENSIONS, ...DOCUMENT_EXTENSIONS];

export const ACCEPT_ATTR = [...ACCEPTED_EXTENSIONS, ...UNSUPPORTED_EXTENSIONS].join(",") + ",text/*";

/**
 * Past this size, the backend indexes the file for retrieval (RAG) rather than
 * pasting the whole thing into context -- see the attachment-routing step in
 * server/main.py. Below it, the full text still goes straight into the
 * message the way it always has, since chunking a short note buys nothing.
 */
export const MAX_CHARS = 20_000;

/**
 * Caps the original file, not what it yields. Mostly a PDF/DOCX concern: a
 * page of scanned-quality formatting, fonts and layout XML can be many times
 * the size of the words it actually contains, so this can be generous
 * without risking a huge request -- MAX_EXTRACTED_CHARS below is what
 * actually bounds that.
 */
const MAX_BYTES = 10 * 1024 * 1024;

/**
 * Caps the text actually sent over the wire, after extraction -- this is
 * what attachment.ts's caller folds into the /api/chat request body. Vercel
 * hard-caps a Function's request body at 4.5MB with no way to raise it (see
 * DEPLOY.md), so this stays safely under that with room for the rest of the
 * message and the JSON wrapper around it. For a plain text file, where the
 * extracted text is the file, this is the real limit -- MAX_BYTES above
 * would let one through that Vercel then rejects with a 413 in production
 * (while working fine locally, where nothing sits in front of the agent).
 */
export const MAX_EXTRACTED_CHARS = 4_000_000;

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

function hasTextExtension(name: string): boolean {
  return TEXT_EXTENSIONS.includes(extensionOf(name));
}

/**
 * Control characters that never appear in real text give away a binary file
 * whose extension says otherwise. Tab, newline and carriage return are fine.
 */
function looksBinary(sample: string): boolean {
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    if (code < 9 || (code > 13 && code < 32)) return true;
  }
  return false;
}

// Set once, the first time a PDF is actually opened -- see readPdf.
let pdfWorkerConfigured = false;

/** Extract the text of every page of a PDF, in order, via pdfjs-dist. */
async function readPdf(file: File): Promise<string> {
  const pdfjs = await import("pdfjs-dist");

  if (!pdfWorkerConfigured) {
    // A static asset (see the "postinstall" script in package.json, which
    // copies it out of node_modules) rather than letting the bundler resolve
    // the worker itself -- pdfjs' worker loading does not play well with
    // Turbopack's own module resolution.
    pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
    pdfWorkerConfigured = true;
  }

  const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    pages.push(
      content.items.map((item) => ("str" in item ? item.str : "")).join(" "),
    );
  }
  return pages.join("\n\n");
}

/** Extract the raw text of a .docx (zipped XML) via mammoth. */
async function readDocx(file: File): Promise<string> {
  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  return result.value;
}

/** Read one file as text, or throw a message worth showing the user. */
export async function readAttachment(file: File): Promise<Attachment> {
  if (file.size > MAX_BYTES) {
    throw new Error(`${file.name} is larger than ${MAX_BYTES / (1024 * 1024)} MB.`);
  }

  const ext = extensionOf(file.name);
  if (UNSUPPORTED_EXTENSIONS.includes(ext)) {
    throw new Error(
      `${file.name} is a legacy .doc file, which cannot be read in the browser. Save it as .docx or PDF and try again.`,
    );
  }

  let raw: string;
  if (ext === ".pdf") {
    raw = await readPdf(file);
  } else if (ext === ".docx") {
    raw = await readDocx(file);
  } else {
    if (!file.type.startsWith("text/") && !hasTextExtension(file.name)) {
      throw new Error(`${file.name} is not a text file.`);
    }
    raw = await file.text();
    if (looksBinary(raw.slice(0, 4000))) {
      throw new Error(`${file.name} looks binary, not text.`);
    }
  }

  if (!raw.trim()) {
    throw new Error(`${file.name} has no text ${ext === ".pdf" ? "-- it may be a scanned image without a text layer" : "in it"}.`);
  }
  if (raw.length > MAX_EXTRACTED_CHARS) {
    throw new Error(
      `${file.name}'s text is too long to send (${Math.round(raw.length / 1_000_000)}M characters). Split it into smaller parts and attach those instead.`,
    );
  }

  // The full text always travels -- up to MAX_EXTRACTED_CHARS on the wire --
  // so the backend can index a large file properly instead of losing
  // everything past a hard cutoff.
  return {
    name: file.name,
    text: raw,
    large: raw.length > MAX_CHARS,
  };
}

/**
 * Fold attachments into the message text. The model reads the file straight
 * from here -- there is no separate parsing step.
 */
export function buildMessage(text: string, attachments: Attachment[]): string {
  if (attachments.length === 0) return text;

  const blocks = attachments.map(
    (a) =>
      // The "(large)" suffix is what server/main.py's attachment-routing step
      // keys off of to send this one through RAG ingestion instead of leaving
      // it inline -- see MAX_CHARS above.
      `===ATTACHMENT_START:${a.name}${a.large ? " (large)" : ""}===\n` +
      a.text +
      `\n===ATTACHMENT_END===`,
  );

  return [text.trim(), ...blocks].filter(Boolean).join("\n\n");
}

const NEW_FILE_BLOCK = /(?:\n\n)?===ATTACHMENT_START:(.+?)===\n[\s\S]*?\n===ATTACHMENT_END===/g;
const LEGACY_FILE_HEADER = /(?:\n\n)?--- file: (.+?) ---\n```/g;

/**
 * Split a stored user message back into what they typed and which files they
 * attached. The file bodies stay in the stored message for the model; the UI
 * shows a chip instead of pasting the whole thing back at the user.
 */
export function splitMessage(content: string): { text: string; files: string[] } {
  const files: string[] = [];

  // Match new robust boundary tags
  let text = content.replace(NEW_FILE_BLOCK, (_match, header: string) => {
    const fileName = header.replace(/\s*\((?:truncated|large|indexed)\)$/, "").trim();
    files.push(fileName);
    return "";
  });

  // Handle legacy messages or files attached with legacy headers
  if (text.includes("--- file: ")) {
    const headerMatch = LEGACY_FILE_HEADER.exec(text);
    if (headerMatch) {
      const fileName = headerMatch[1].replace(/\s*\((?:truncated|large|indexed)\)$/, "").trim();
      files.push(fileName);
      text = text.slice(0, headerMatch.index);
    }
  }

  return { text: text.trim(), files };
}
