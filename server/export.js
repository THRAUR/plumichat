// server/export.js — turn an answer's markdown into a downloadable file.
//
// Word (.docx) and PowerPoint (.pptx) go through pandoc, which is already on the
// box (no install). Excel (.xlsx) is hand-built as a minimal OOXML package — an
// .xlsx is just a zip of XML — using yazl, the zip lib we already depend on, so it
// adds no dependency either. PDF is pandoc → HTML → headless Chromium.
//
// The browser's own print-to-PDF is still the better renderer (it uses the device's
// fonts, which shows in Traditional Chinese), so that remains the default path and
// this one exists for the client that CAN'T print: an iOS home-screen web app has
// no print UI at all, so its PDF button was dead until this landed.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findChrome as platformFindChrome, findPandoc, tmpRoot } from './platform.js';
import { fileURLToPath } from 'node:url';
import yazl from 'yazl';

const NO_RAW_HTML = path.join(path.dirname(fileURLToPath(import.meta.url)), 'no-raw-html.lua');

// What each format is, how pandoc should write it (null = we build it ourselves),
// and the MIME type the browser saves under. `print` takes the Chromium route.
const FORMATS = {
  docx: { ext: 'docx', pandoc: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  pptx: { ext: 'pptx', pandoc: 'pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
  xlsx: { ext: 'xlsx', pandoc: null,  mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  pdf:  { ext: 'pdf',  pandoc: null,  mime: 'application/pdf', print: true },
};

export function formatInfo(format) {
  return FORMATS[String(format == null ? '' : format).toLowerCase()] || null;
}

const MAX_INPUT = 1_000_000; // 1 MB of markdown — matches the JSON body cap.

// --- Word / PowerPoint via pandoc ------------------------------------------------

// Run pandoc with a fixed argv (no shell, so nothing in the markdown can be parsed
// as a command), feeding the markdown on stdin and collecting the binary file on
// stdout. Hard timeout + output cap so a runaway conversion can't wedge the box.
function runPandoc(markdown, to, extra) {
  return new Promise((resolve, reject) => {
    const pandoc = findPandoc();
    if (!pandoc) return reject(new Error('Conversion needs pandoc, which is not installed (see docs/INSTALL.md)'));
    const child = execFile(
      pandoc,
      ['-f', 'gfm', '-t', to, '-o', '-'].concat(extra || []),
      { encoding: 'buffer', timeout: 20_000, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(new Error('Conversion failed (pandoc): ' + (err.message || 'unknown')));
        if (!stdout || !stdout.length) return reject(new Error('Conversion produced no output'));
        resolve(stdout);
      },
    );
    child.stdin.on('error', () => { /* ignore EPIPE if pandoc exits early */ });
    child.stdin.end(markdown, 'utf8');
  });
}

// --- Excel: parse the answer's tables, emit a minimal .xlsx ----------------------

// Pull every GitHub-flavoured markdown table out of the text. A table is a run of
// pipe-bearing lines whose SECOND line is a separator (---, :--:, etc.).
function parseTables(md) {
  const lines = String(md).replace(/\r\n?/g, '\n').split('\n');
  const sepRe = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
  const tables = [];
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i];
    const sep = lines[i + 1];
    if (!head || head.indexOf('|') === -1) continue;
    if (!sep || !sepRe.test(sep)) continue;
    const rows = [];
    let j = i;
    for (; j < lines.length; j++) {
      if (!lines[j] || lines[j].indexOf('|') === -1) break;
      rows.push(splitRow(lines[j]));
    }
    rows.splice(1, 1); // drop the separator row
    if (rows.length) tables.push(rows);
    i = j; // resume past this table
  }
  return tables;
}

// Split one table row into trimmed cells, honouring escaped pipes (\|).
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  const out = [];
  let cur = '';
  for (let k = 0; k < s.length; k++) {
    if (s[k] === '\\' && s[k + 1] === '|') { cur += '|'; k++; continue; }
    if (s[k] === '|') { out.push(cur.trim()); cur = ''; continue; }
    cur += s[k];
  }
  out.push(cur.trim());
  return out;
}

// Strip the light markdown that survives inside a cell so the spreadsheet shows
// clean text rather than **stars** and `backticks`.
function cleanCell(s) {
  return String(s)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/\[(.+?)\]\((?:.+?)\)/g, '$1')
    .trim();
}

function xmlEsc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// 0-based column index → spreadsheet column name (0→A, 25→Z, 26→AA).
function colName(n) {
  let s = '';
  n += 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// A plain integer/decimal with no leading zero and a safe length becomes a real
// number cell; everything else (IDs, currency, CJK, dates) stays as text so nothing
// is silently mangled.
function isNumber(v) { return /^-?(0|[1-9]\d*)(\.\d+)?$/.test(v) && v.replace('-', '').length <= 15; }

function buildSheetXml(tables) {
  let rows = '';
  let r = 0;
  tables.forEach((table, ti) => {
    if (ti > 0) r++; // blank row between stacked tables
    for (const row of table) {
      r++;
      let cells = '';
      for (let c = 0; c < row.length; c++) {
        const val = cleanCell(row[c]);
        if (val === '') continue;
        const ref = colName(c) + r;
        if (isNumber(val)) cells += `<c r="${ref}"><v>${val}</v></c>`;
        else cells += `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(val)}</t></is></c>`;
      }
      rows += `<row r="${r}">${cells}</row>`;
    }
  });
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + `<sheetData>${rows}</sheetData></worksheet>`;
}

// The four fixed OOXML parts that wrap the one worksheet we generate.
const CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
  + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
  + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
  + '<Default Extension="xml" ContentType="application/xml"/>'
  + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
  + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
  + '</Types>';
const ROOT_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
  + '</Relationships>';
const WORKBOOK = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
  + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
  + '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>';
const WB_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
  + '</Relationships>';

function tablesToXlsx(tables) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const chunks = [];
    zip.outputStream.on('data', (d) => chunks.push(d));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
    zip.addBuffer(Buffer.from(CONTENT_TYPES, 'utf8'), '[Content_Types].xml');
    zip.addBuffer(Buffer.from(ROOT_RELS, 'utf8'), '_rels/.rels');
    zip.addBuffer(Buffer.from(WORKBOOK, 'utf8'), 'xl/workbook.xml');
    zip.addBuffer(Buffer.from(WB_RELS, 'utf8'), 'xl/_rels/workbook.xml.rels');
    zip.addBuffer(Buffer.from(buildSheetXml(tables), 'utf8'), 'xl/worksheets/sheet1.xml');
    zip.end();
  });
}

// --- PDF: pandoc → HTML → headless Chromium --------------------------------------

// Chromium isn't a package dependency, so use whatever this machine already has —
// platform.js knows where each OS puts it. Resolved once, then remembered.
let chromePath;
function findChrome() {
  if (chromePath === undefined) chromePath = platformFindChrome();
  return chromePath;
}

function htmlEsc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// tmpRoot() lives in platform.js — same guard, one copy.

// Naming Noto CJK first means the Chinese gets better automatically if that font
// package is ever installed; Droid Sans Fallback is what the box has today.
const PDF_CSS = `
  @page { size: A4; margin: 20mm 18mm; }
  * { box-sizing: border-box; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; color: #14161a; font: 10.5pt/1.65 "Helvetica Neue", Helvetica, Arial,
         "Liberation Sans", "DejaVu Sans", "Noto Sans CJK TC", "Droid Sans Fallback", sans-serif;
         orphans: 2; widows: 2; }
  .doc-title { margin: 0 0 2pt; font-size: 21pt; font-weight: 700; letter-spacing: -0.2pt; line-height: 1.25; }
  .doc-meta { margin: 0 0 22pt; font-size: 8.5pt; color: #6b7280; }
  h1, h2, h3, h4 { margin: 18pt 0 6pt; font-weight: 700; line-height: 1.3; break-after: avoid; }
  h1 { font-size: 16pt; } h2 { font-size: 13pt; } h3 { font-size: 11.5pt; } h4 { font-size: 10.5pt; }
  p, ul, ol, blockquote, pre, table { margin: 0 0 9pt; }
  ul, ol { padding-left: 18pt; } li { margin: 0 0 3pt; }
  a { color: #1d4ed8; text-decoration: none; }
  strong { font-weight: 700; }
  code { font-family: "DejaVu Sans Mono", Menlo, Consolas, monospace; font-size: 9pt;
         background: #f1f3f5; padding: 1pt 3pt; border-radius: 3pt; }
  pre { background: #f6f8fa; padding: 9pt 11pt; border-radius: 5pt; break-inside: avoid;
        white-space: pre-wrap; word-wrap: break-word; }
  pre code { background: none; padding: 0; font-size: 8.5pt; line-height: 1.5; }
  blockquote { padding-left: 11pt; border-left: 2.5pt solid #d1d5db; color: #4b5563; }
  table { width: 100%; border-collapse: collapse; font-size: 9.5pt; break-inside: auto; }
  th, td { border: 0.5pt solid #d1d5db; padding: 5pt 7pt; text-align: left; vertical-align: top; }
  th { background: #f3f4f6; font-weight: 700; }
  tr { break-inside: avoid; }
  thead { display: table-header-group; }
  img { max-width: 100%; }
  hr { border: 0; border-top: 0.5pt solid #e5e7eb; margin: 14pt 0; }
`;

// Render an answer to a real PDF.
//
// Two things keep the answer's own text from acting as markup in the browser doing
// the rendering. The Lua filter drops every raw-HTML tag, so the only structure
// Chromium sees is what pandoc emitted; the CSP then refuses to fetch anything at
// all, so even a tag that somehow survived could not pull in a local file. Either
// alone is enough — an <iframe src="file:///etc/passwd"> would otherwise print the
// file into the PDF, handing a confined member whatever the server can read.
async function markdownToPdf(markdown, title) {
  const chrome = findChrome();
  if (!chrome) throw new Error('No Chromium on this box to render a PDF');
  const body = await runPandoc(markdown, 'html5', ['--lua-filter=' + NO_RAW_HTML]);
  const name = String(title || '').trim() || 'PlumiChat answer';
  const html = '<!doctype html><html><head><meta charset="utf-8">'
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; '
    + 'img-src data: https:; style-src \'unsafe-inline\'">'
    + '<title>' + htmlEsc(name)
    + '</title><style>' + PDF_CSS + '</style></head><body>'
    + '<div class="doc-title">' + htmlEsc(name) + '</div>'
    + '<div class="doc-meta">' + htmlEsc(new Date().toLocaleString()) + '</div>'
    + body.toString('utf8') + '</body></html>';

  const dir = await fs.promises.mkdtemp(path.join(tmpRoot(), 'plumi-pdf-'));
  const src = path.join(dir, 'answer.html');
  const out = path.join(dir, 'answer.pdf');
  try {
    await fs.promises.writeFile(src, html, 'utf8');
    await new Promise((resolve, reject) => {
      // Deliberately NO --user-data-dir: pointing Chromium at a fresh profile makes
      // it start sign-in/GCM background work and it then never gets round to
      // printing (verified — it just times out). Left alone, headless uses a
      // throwaway profile of its own, which is also safe for concurrent exports.
      execFile(chrome, [
        '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
        '--no-pdf-header-footer', '--print-to-pdf=' + out, 'file://' + src,
      ], { timeout: 45_000, maxBuffer: 4 * 1024 * 1024 }, (err) => {
        // Chromium reports layout/dbus noise on stderr and still exits 0; only a
        // missing output file actually means failure.
        if (err && !fs.existsSync(out)) return reject(new Error('PDF rendering failed: ' + (err.message || 'unknown')));
        resolve();
      });
    });
    const buffer = await fs.promises.readFile(out);
    if (!buffer.length) throw new Error('PDF rendering produced no output');
    return buffer;
  } finally {
    fs.promises.rm(dir, { recursive: true, force: true }).catch(() => { /* temp dir, leave it */ });
  }
}

// --- public API ------------------------------------------------------------------

// Convert one answer's markdown to the requested format. Returns { buffer, mime, ext }.
// `title` heads the PDF; the other formats ignore it.
export async function exportAnswer(format, markdown, title) {
  const info = formatInfo(format);
  if (!info) throw new Error('Unsupported export format');
  const md = String(markdown == null ? '' : markdown);
  if (!md.trim()) throw new Error('Nothing to export');
  if (md.length > MAX_INPUT) throw new Error('Answer is too large to export');

  if (info.print) {
    const buffer = await markdownToPdf(md, title);
    return { buffer, mime: info.mime, ext: info.ext };
  }
  if (info.pandoc) {
    const buffer = await runPandoc(md, info.pandoc);
    return { buffer, mime: info.mime, ext: info.ext };
  }
  // xlsx
  const tables = parseTables(md);
  if (!tables.length) throw new Error('No table found in this answer to put in a spreadsheet');
  const buffer = await tablesToXlsx(tables);
  return { buffer, mime: info.mime, ext: info.ext };
}
