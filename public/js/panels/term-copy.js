import { copyText } from '../cards.js';
import { toast } from '../dom.js';
import { relTime } from './notepad.js';
import { closeSheet, openSheet, sheetActions, sheetButton, sheetNote, sheetSection } from '../sheet.js';

/* ===================== Copying OUT of the terminal =======================
   xterm.js paints its own text, so a phone has nothing to long-press: pasting
   in always worked, copying out never did. Three ways out, all from here:

   - OSC 52. Claude Code already has a copy key — the `c` beside the MCP and
     login URLs — and inside tmux it runs `tmux load-buffer -w -`, which makes
     tmux hand the text to the OUTER terminal as \e]52;;<base64>\a. The outer
     terminal is us, and xterm.js ignores OSC 52 out of the box, so every one of
     those copies was landing nowhere. terminal.js registers the handler.
   - The copy sheet (the "copy" key): the links on screen, re-joined across the
     rows they were wrapped onto, each with Copy and Open; and the screen as
     ordinary text a thumb can select.
   - The keyboard: Ctrl+C copies while something is selected, Ctrl+Shift+C
     always does, ⌘C on a Mac. */

// Box drawing, block elements and Claude Code's ⎿ gutter: frame, never content.
const FRAME = /[\s─-▟⎿]/;
// What a URL can be broken in the middle of. ASCII only and without brackets or
// quotes, so a border, a Chinese word or "(c to copy)" is never glued onto one.
const URL_CHARS = "A-Za-z0-9\\-._~:/?#@!$&*+,;=%";
const URL_START = new RegExp("https?://[" + URL_CHARS + "]+", "g");
const URL_RUN = new RegExp("^[" + URL_CHARS + "]+");
const URL_WHOLE = new RegExp("^[" + URL_CHARS + "]+$");
const IS_MAC = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || "");

export function isLink(text) { return /^https?:\/\/\S+$/.test(String(text || "").trim()); }

function contentStart(text) { let i = 0; while (i < text.length && FRAME.test(text[i])) i++; return i; }
function contentEnd(text) { let i = text.length; while (i > 0 && FRAME.test(text[i - 1])) i--; return i; }

// One buffer row as a string plus, per character, the column just past it. A
// wide (CJK) character is one character but two columns, so string offsets and
// screen columns part ways on any row with Chinese in it — a folder, a prompt.
function readRow(line, cols, cell) {
  let text = "";
  const after = [];
  for (let x = 0; x < cols; x++) {
    if (!line.getCell(x, cell)) break;
    const w = cell.getWidth();
    if (!w) continue;                        // the right half of a wide character
    const ch = cell.getChars() || " ";
    for (let i = 0; i < ch.length; i++) { text += ch[i]; after.push(x + w); }
  }
  return { text, after, wrapped: !!line.isWrapped };
}

/* Every http(s) link in `rows`, and where each of its pieces sits.
   A long URL is almost never on one row. Either the terminal wrapped it — the
   next row says isWrapped, which is easy — or the PROGRAM did: Claude Code draws
   with Ink, which hard-breaks a long word at the width of its box and carries on
   at the start of a fresh row, so to xterm those are unrelated lines. A break is
   believed when the next row is itself a full piece ending at the same column, or
   this row ended where the URL's previous row did, or this row reached the right
   edge (Claude's auth box has padding 1, so its pieces end at cols-1) or the edge of
   a box padded the same on both sides AND the next row holds nothing but URL
   characters. That last AND is what keeps a URL which happens to end near the edge
   from swallowing the first word of the prose line under it.

   One walk, two readers. findLinks wants the joined URLs; screenText wants to know
   which rows the pieces came from, so it can put them back together. They used to
   disagree: the link card came out whole while the Screen text under it kept a line
   break and an indent at every wrap — and selecting the URL out of THAT, the obvious
   move on a phone, put a link on the clipboard no browser will open. */
function joinLinks(rows, cols) {
  const claimed = rows.map(() => 0);        // leading characters already used as a continuation
  const links = [];
  rows.forEach(function (row, r) {
    URL_START.lastIndex = 0;
    let m;
    while ((m = URL_START.exec(row.text))) {
      if (m.index < claimed[r]) continue;
      let url = m[0], at = r, end = m.index + url.length, breakCol = -1, lead = -1;
      const pieces = [];
      while (at + 1 < rows.length && end === contentEnd(rows[at].text)) {
        const next = rows[at + 1];
        const start = next.wrapped ? 0 : contentStart(next.text);
        const run = URL_RUN.exec(next.text.slice(start));
        if (!run) break;
        const stop = start + run[0].length;
        if (!next.wrapped) {
          const edge = rows[at].after[end - 1];   // column just past this piece
          const col = next.after[start] - 1;      // where the next piece starts (URL characters are one column)
          const whole = stop === contentEnd(next.text);           // the next row is nothing but this piece
          const atEdge = edge >= cols - 1 || Math.abs(edge - (cols - col)) <= 1;
          const fits = (whole && next.after[stop - 1] === edge)  // a full piece breaking at the same column
            || edge === breakCol                                  // this row broke where the last one did
            || (atEdge && whole);
          if (!fits || (lead >= 0 && col !== lead)) break;
          breakCol = edge; lead = col;
        }
        url += run[0];
        claimed[at + 1] = stop;
        pieces.push({ row: at + 1, from: start, to: stop, soft: next.wrapped });
        end = stop;
        at++;
      }
      links.push({ url: url, row: r, to: m.index + m[0].length, pieces: pieces });
    }
  });
  return links;
}

// The last `maxRows` rows of the buffer, read the way joinLinks needs them.
function bufferRows(term, maxRows) {
  const buf = term.buffer.active, cols = term.cols, cell = buf.getNullCell();
  const rows = [];
  for (let y = Math.max(0, buf.length - maxRows); y < buf.length; y++) {
    const line = buf.getLine(y);
    rows.push(line ? readRow(line, cols, cell) : { text: "", after: [], wrapped: false });
  }
  return rows;
}

// Every http(s) link in the last rows of the buffer, newest first.
export function findLinks(term, maxRows) {
  const found = joinLinks(bufferRows(term, maxRows || 400), term.cols).map(function (l) {
    return l.url.replace(/[.,;:!?]+$/, "");  // sentence punctuation is not part of it
  });
  const seen = new Set(), out = [];
  for (let i = found.length - 1; i >= 0; i--) {
    if (!seen.has(found[i])) { seen.add(found[i]); out.push(found[i]); }
  }
  return out;
}

// The whole buffer as plain text: the terminal's own soft wraps undone, every link a
// PROGRAM broke across rows put back together on the row it started on, and every
// run of empty rows squeezed to one — a full-screen program leaves most of the screen
// blank, and the sheet opened on a black box with tmux's status line at the foot.
// Under tmux this is the screen and nothing more — tmux runs on the alternate screen,
// and the alternate screen keeps no scrollback.
export function screenText(term) {
  const rows = bufferRows(term, Infinity);
  const text = rows.map(function (row) { return row.text; });
  const moved = rows.map(function () { return false; });   // gave its piece to the row above
  const shift = rows.map(function () { return 0; });       // characters taken off its front
  joinLinks(rows, term.cols).forEach(function (l) {
    // Where the link currently ends, in the CURRENT text of the row holding it. A row
    // only ever donates before it hosts (links are walked top-down), so `shift` is all
    // the bookkeeping a later link starting on a donor row needs.
    let tail = l.row, tailAt = l.to - shift[l.row];
    l.pieces.forEach(function (p) {
      if (p.soft) { tail = p.row; tailAt = p.to - shift[p.row]; return; }  // isWrapped joins these below
      const piece = rows[p.row].text.slice(p.from, p.to);
      text[tail] = text[tail].slice(0, tailAt) + piece + text[tail].slice(tailAt);
      tailAt += piece.length;
      text[p.row] = text[p.row].slice(0, p.from - shift[p.row]) + text[p.row].slice(p.to - shift[p.row]);
      shift[p.row] += p.to - p.from;
      moved[p.row] = true;
    });
  });
  const lines = [];
  for (let y = 0; y < rows.length; y++) {
    const s = text[y];
    if (moved[y] && contentStart(s) === s.length) continue;   // nothing left of it but its indent
    const keepEnd = y + 1 < rows.length && rows[y + 1].wrapped;
    const t = keepEnd ? s : s.replace(/\s+$/, "");            // keep a space that sits on the wrap
    if (rows[y].wrapped && lines.length) lines[lines.length - 1] += t;
    else if (t.trim() || (lines.length && lines[lines.length - 1].trim())) lines.push(t);
  }
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join("\n");
}

// A hard wrap only happens to a link longer than its box, and no box anyone reads is
// narrower than this. It is what stops "…/done" with a one-word line under it from
// being glued into one token. The geometric joins above do not need it.
const MIN_WRAPPED_LINK = 24;
const LINK_TAIL = new RegExp("https?://[" + URL_CHARS + "]+$");

// Text that went through a selection — a drag in the terminal, or a thumb in the
// sheet's screen text — comes out with a line break wherever the program wrapped a
// URL. Glue a line back on when it is nothing but URL characters and the text above
// it ends INSIDE a long link, whatever stood in front of that link on its own line:
// a label ("URL: https://…"), a CJK prefix, a drag that started a word early. The old
// rule wanted the very first line to start with https:// and every line to be URL,
// so a label in front — or a line of prose after — kept every break. Lines that were
// not glued come back untouched; a selection with nothing to glue comes back as it was.
export function tidyCopy(text) {
  const raw = String(text || "");
  const out = [];
  let glued = false;
  raw.split(/\r?\n/).forEach(function (line) {
    const body = line.slice(contentStart(line), contentEnd(line));
    if (out.length && body && URL_WHOLE.test(body)) {
      const prev = out[out.length - 1];
      const head = prev.slice(contentStart(prev), contentEnd(prev));
      const link = LINK_TAIL.exec(head);
      if (link && link[0].length >= MIN_WRAPPED_LINK) {
        out[out.length - 1] = head + body;
        glued = true;
        return;
      }
    }
    out.push(line);
  });
  if (!glued) return raw;
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.join("\n");
}

// \e]52;<targets>;<base64>\a → the text, or null. A payload of "?" asks to READ
// the clipboard, which a terminal must never answer; an empty one asks to clear
// it, which is not worth doing to someone's phone.
export function decodeOsc52(data) {
  const s = String(data || "");
  const semi = s.indexOf(";");
  const payload = (semi >= 0 ? s.slice(semi + 1) : s).trim();
  if (!payload || payload === "?") return null;
  try {
    const bin = atob(payload);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes) || null;
  } catch (e) { return null; }
}

// Put what a program copied onto THIS device's clipboard. Chrome lets a focused
// page write without a fresh tap; Safari — every iPhone — does not, because the
// text arrives over the socket rather than inside the key press that asked for
// it. So a refusal (or a promise that never settles) becomes a toast to tap, and
// that tap is the gesture Safari is waiting for.
export function deliverCopy(text) {
  const link = isLink(text);
  let settled = false;
  const offerTap = function () {
    if (settled) return;
    settled = true;
    toast(link ? "Tap to copy the link" : "Tap to copy what the terminal copied", false, function () {
      copyText(text).then(function () { toast("Copied"); }).catch(function () { toast("Copy failed", true); });
    });
  };
  copyText(text).then(function () {
    if (settled) return;
    settled = true;
    toast(link ? "Link copied from the terminal" : "Copied from the terminal");
  }, offerTap);
  setTimeout(offerTap, 1500);
}

// xterm's custom key handler: return false to keep the key away from the shell.
// Plain Ctrl+C still interrupts whenever nothing is selected, and copying clears
// the selection, so a second Ctrl+C is the interrupt again (Windows Terminal's rule).
export function copyKey(term, e) {
  if (e.type !== "keydown" || e.altKey || String(e.key).toLowerCase() !== "c") return true;
  const selected = term.hasSelection();
  const byMeta = IS_MAC && e.metaKey && !e.ctrlKey && selected;
  const byCtrl = !IS_MAC && e.ctrlKey && !e.metaKey && (e.shiftKey || selected);
  if (!byMeta && !byCtrl) return true;
  e.preventDefault();
  if (selected) {
    const text = tidyCopy(term.getSelection());
    term.clearSelection();
    copyText(text).then(function () { toast("Copied"); }).catch(function () { toast("Copy failed", true); });
  }
  return false;
}

function copyButton(row, value, cls, label) {
  label = label || "Copy";
  sheetButton(row, label, cls, function (b) {
    copyText(value).then(function () {
      b.textContent = "Copied";
      clearTimeout(b._revert);
      b._revert = setTimeout(function () { b.textContent = label; }, 1600);
    }).catch(function () { toast("Copy failed", true); });
  });
}

// The copy sheet. Everything is read BEFORE it opens: opening it drops the phone
// keyboard, the terminal gains rows, and Claude Code repaints underneath.
// The accent goes to the first Copy only — the likeliest thing you came for.
export function openCopySheet(term, lastCopy) {
  const selection = term.hasSelection() ? tidyCopy(term.getSelection()) : "";
  const links = findLinks(term);
  const text = screenText(term);
  let accent = "primary";
  function item(box, value) {
    const card = document.createElement("div");
    card.className = "term-copy-item";
    const v = document.createElement("div");
    v.className = "term-copy-value";
    v.textContent = value;
    card.appendChild(v);
    const row = sheetActions(card);
    copyButton(row, value, accent);
    accent = "";
    if (isLink(value)) {
      sheetButton(row, "Open", "", function () { window.open(value.trim(), "_blank", "noopener"); });
    }
    box.appendChild(card);
  }
  openSheet("term-copy", "Copy from the terminal", function (box) {
    if (lastCopy && lastCopy.text) { sheetSection(box, "Copied by the terminal · " + relTime(lastCopy.at)); item(box, lastCopy.text); }
    if (selection) { sheetSection(box, "Your selection"); item(box, selection); }
    if (links.length) {
      sheetSection(box, links.length === 1 ? "Link on screen" : "Links on screen");
      links.forEach(function (u) { item(box, u); });
    }
    sheetSection(box, "Screen text");
    const pre = document.createElement("pre");
    pre.className = "term-copy-text";
    pre.textContent = text || "Nothing on screen yet.";
    box.appendChild(pre);
    // The browser copies a DOM selection by itself, so tidy it on the way out.
    // screenText already joins every link the geometry can prove; this catches what
    // it cannot — a partial selection, a layout the walk did not recognise.
    pre.addEventListener("copy", function (e) {
      const sel = window.getSelection ? String(window.getSelection()) : "";
      const tidy = tidyCopy(sel);
      if (!sel || tidy === sel || !e.clipboardData) return;
      e.clipboardData.setData("text/plain", tidy);
      e.preventDefault();
    });
    if (text) sheetNote(box, "Select any part of it, or copy the lot.");
    const row = sheetActions(box);
    if (text) copyButton(row, text, accent, "Copy all");
    sheetButton(row, "Close", "", closeSheet);
    // The newest output is at the bottom, and so is anything you just ran.
    requestAnimationFrame(function () { pre.scrollTop = pre.scrollHeight; });
  });
}
