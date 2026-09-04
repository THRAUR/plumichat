// Path containment: every file/project path must resolve INSIDE a user's home.
// This is the one pattern worth borrowing from CloudCLI — clean-room reimplemented.
//
// Multi-user model: there is one WORKSPACES_ROOT (see docs/INSTALL.md).
//   - owner/admin home = the root itself (sees every project, as before).
//   - each member home = <root>/.users/<id> (a private folder they're locked into).
// `.users` is a dotfolder so it never shows up in the owner's project picker.
// Per-user helpers resolve & contain paths against the *caller's* home, so a
// member can never read or write outside their own folder via the app.
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

export const WORKSPACES_ROOT = path.resolve(
  process.env.WORKSPACES_ROOT || path.join(process.env.HOME || '/home', 'projects')
);

// Resolve the real root once (so a symlinked ~/projects resolves to its target).
let ROOT_REAL;
try {
  ROOT_REAL = fs.realpathSync(WORKSPACES_ROOT);
} catch {
  ROOT_REAL = WORKSPACES_ROOT; // may not exist yet; resolvePath still guards by prefix
}

// Container for member homes (hidden from the owner's picker by the dot prefix).
export const MEMBERS_DIRNAME = '.users';

export function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); return p; }

// Absolute home directory for a user record. owner/admin (homeRel falsy) -> root.
export function userHome(user) {
  const rel = user && user.homeRel ? String(user.homeRel) : '';
  if (!rel) return ROOT_REAL;
  // Guard: a stored homeRel must itself stay inside the root.
  const abs = path.resolve(ROOT_REAL, rel);
  const r = path.relative(ROOT_REAL, abs);
  if (r.startsWith('..') || path.isAbsolute(r)) return ROOT_REAL;
  return abs;
}

// Realpath of a home if it exists (so containment compares resolved paths),
// else the literal home (guarded by prefix until the dir is created).
function realHome(user) {
  const home = userHome(user);
  try { return fs.realpathSync(home); } catch { return home; }
}

// Resolve a caller-supplied relative path against the USER'S home and assert
// containment. Throws on traversal (../) or absolute escapes. Returns abs path.
export function resolveInUserRoot(user, ...segments) {
  const base = realHome(user);
  const candidate = path.resolve(base, ...segments);
  const rel = path.relative(base, candidate);
  if (rel === '') return candidate;
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Path escapes your workspace');
  }
  return candidate;
}

// Reduce ONE path segment (a folder name or a filename) to something safe to put
// on disk AND safe to hand back to a browser.
//   - control characters: they corrupt paths and log lines.
//   - < > " ' & : names come back out through the file picker and the chat's
//     attachment chips, which render into HTML. A member uploading a folder named
//     `<img src=x onerror=...>` is exactly how script reaches an admin's session
//     (audit H5). The client escapes too — this is the layer that still holds when
//     the next innerHTML gets written carelessly.
// Separators are deliberately NOT stripped here: containment is asserted by
// path.basename / contains() below, and mangling them would only hide bugs.
const MAX_SEGMENT = 120; // well under NAME_MAX (255) once a -NN suffix is added
function safeSegment(s) {
  return String(s == null ? '' : s)
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[<>"'&]/g, '')
    .trim()
    .slice(0, MAX_SEGMENT)
    .trim(); // slicing can leave a trailing space
}

// Persist a device upload (phone/computer file or picture) inside the CALLER'S
// own home, under a hidden `.uploads/` folder, and return its absolute path.
// The client-supplied name is reduced to a bare basename (no separators) and run
// through safeSegment, so a crafted name can neither escape the folder nor carry
// markup back into a page; on a clash we suffix -1, -2, … The file
// then rides the SAME path-reference pipeline as a disk-picked one — Claude opens
// it with its Read tool, and /api/chat re-checks containment before the run.
export function saveUpload(user, filename, buffer) {
  const dir = ensureDir(path.join(userHome(user), '.uploads'));
  let base = safeSegment(path.basename(String(filename || '')));
  if (!base || base === '.' || base === '..') base = 'file';
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length) || 'file';
  let name = base;
  let dest = path.join(dir, name);
  for (let i = 1; fs.existsSync(dest); i++) { name = stem + '-' + i + ext; dest = path.join(dir, name); }
  fs.writeFileSync(dest, buffer);
  return dest;
}

// Save one uploaded device file INTO a folder the caller is allowed to write to
// (the folder the picker is showing) — as opposed to saveUpload's fixed `.uploads`
// drop. `destDir` is re-checked with resolveBrowse, so an owner/admin may write
// anywhere the OS permits but a member only ever inside their own home, even with a
// hand-crafted request. `relPath` is a bare filename OR a folder-upload relative
// path ("proj/src/a.js"); it's sanitised segment-by-segment (safeSegment, then
// drops "", "." and "..") and every intermediate folder is created. We
// NEVER overwrite — a clashing FILE is suffixed -1, -2, … so an upload can't destroy
// existing work — and the resolved leaf is re-asserted to sit inside destDir.
export function saveUploadInto(user, destDir, relPath, buffer) {
  const base = resolveBrowse(user, destDir);
  if (!fs.statSync(base).isDirectory()) throw new Error('Destination is not a folder');

  const parts = String(relPath == null ? '' : relPath)
    .split(/[\\/]+/)
    .map(safeSegment) // sanitise BEFORE the filter, so `<..>` can't survive as `..`
    .filter((s) => s && s !== '.' && s !== '..');
  const fileName = parts.pop() || 'file';
  const subDir = parts.length ? path.join(base, ...parts) : base;
  if (!contains(base, path.resolve(subDir))) throw new Error('Upload path escapes the folder');
  ensureDir(subDir);

  const ext = path.extname(fileName);
  const stem = fileName.slice(0, fileName.length - ext.length) || 'file';
  let name = fileName;
  let dest = path.join(subDir, name);
  for (let i = 1; fs.existsSync(dest); i++) { name = stem + '-' + i + ext; dest = path.join(subDir, name); }
  fs.writeFileSync(dest, buffer);
  return dest;
}

// Create ONE empty folder inside a folder the caller may write to (the folder the
// file picker is showing). `destDir` is re-checked with resolveBrowse, so an
// owner/admin may create anywhere the OS permits but a member only inside their own
// home, even with a hand-crafted request. The name is reduced to a bare folder name
// — no separators, no traversal — and an existing name is REFUSED rather than reused,
// so this can never touch existing work.
export function createFolderIn(user, destDir, rawName) {
  const base = resolveBrowse(user, destDir);
  if (!fs.statSync(base).isDirectory()) throw new Error('Destination is not a folder');

  const name = String(rawName == null ? '' : rawName).replace(/[\x00-\x1f]/g, '').trim();
  if (!name) throw new Error('Folder name is required');
  if (name !== path.basename(name) || name === '.' || name === '..') {
    throw new Error('Use a simple folder name (no slashes)');
  }
  if (/[<>:"\\|?*]/.test(name)) throw new Error('Name contains invalid characters');
  if (name.length > 80) throw new Error('Name is too long (max 80 characters)');

  const dir = path.join(base, name);
  if (!contains(base, path.resolve(dir))) throw new Error('Path escapes the folder');
  if (fs.existsSync(dir)) throw new Error('Something with that name already exists here');
  fs.mkdirSync(dir);
  return { name, path: dir };
}

// Back-compat: resolve against the global root (used by the autonomous Operations
// runner, which already confines edits to a throwaway worktree).
export function resolveInRoot(...segments) {
  const candidate = path.resolve(ROOT_REAL, ...segments);
  const rel = path.relative(ROOT_REAL, candidate);
  if (rel === '') return candidate;
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes workspace root: ${segments.join('/')}`);
  }
  return candidate;
}

// List immediate subdirectories of a user's home — the project picker's source.
// Dotfolders are skipped, which also hides the `.users` members container from
// the owner/admin picker.
export function listProjectsFor(user) {
  const base = userHome(user);
  let entries;
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ name, path: path.join(base, name) }));
}


// Create a new project: a single folder directly under the CALLER'S home, then
// `git init` + an initial (empty) commit so the Operations runner — which checks
// out the project's HEAD into a worktree — has a commit to build on. Git is
// best-effort: if it's missing the folder is still created and usable for chat
// (the result flags git:false). The name is validated to a bare folder name so it
// can never traverse out of the workspace.
export function createProjectFor(user, rawName) {
  const name = String(rawName == null ? '' : rawName).trim();
  if (!name) throw new Error('Project name is required');
  if (name !== path.basename(name) || name === '.' || name === '..') {
    throw new Error('Use a simple folder name (no slashes)');
  }
  if (name.startsWith('.')) throw new Error("Name can't start with a dot");
  if (/[\x00-\x1f<>:"\\|?*]/.test(name)) throw new Error('Name contains invalid characters');
  if (name.length > 80) throw new Error('Name is too long (max 80 characters)');

  const dir = resolveInUserRoot(user, name); // asserts the path stays in the home
  if (fs.existsSync(dir)) throw new Error('A project with that name already exists');
  fs.mkdirSync(dir);

  let git = false;
  try {
    execFileSync('git', ['init', '-q', dir], { stdio: 'ignore' });
    // Name the default branch `main` while HEAD is still unborn — works across
    // git versions without relying on `init -b` (git ≥ 2.28 only).
    try { execFileSync('git', ['-C', dir, 'symbolic-ref', 'HEAD', 'refs/heads/main'], { stdio: 'ignore' }); } catch { /* keep git's default branch name */ }
    // Commit identity is set inline so this succeeds even when the box has no
    // global git config; the user can change it later in the repo.
    const id = ['-c', 'user.name=PlumiChat', '-c', 'user.email=plumi@localhost'];
    execFileSync('git', ['-C', dir, ...id, 'commit', '--allow-empty', '-q', '-m', 'Initial commit'], { stdio: 'ignore' });
    git = true;
  } catch { /* git unavailable → folder still created, just not a repo */ }

  return { name, path: dir, git };
}

/* --------------------- filesystem browsing (file picker) ------------------ */
// "Pick a file from disk" support. Scope rule mirrors the project model:
//   - owner/admin  → may browse the WHOLE machine (ceiling = filesystem root).
//   - member       → confined to their own home folder, nothing else.
// The client path is NEVER trusted — every browse/attach is re-checked here.
const FS_ROOT = path.parse(ROOT_REAL).root || path.sep;
function isAdminLike(user) { return !!user && (user.role === 'owner' || user.role === 'admin'); }

// The highest directory a user may navigate to.
export function userBrowseRoot(user) {
  return isAdminLike(user) ? FS_ROOT : realHome(user);
}

// True if `candidate` is `base` itself or sits underneath it (both absolute).
function contains(base, candidate) {
  const rel = path.relative(base, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Resolve a browse/attach path for a user and assert it stays inside their
// allowed root. `p` may be absolute or relative to that root. Throws on escape.
// For confined users we also defeat symlink escapes by re-checking real paths.
export function resolveBrowse(user, p) {
  const root = userBrowseRoot(user);
  const target = !p ? root : (path.isAbsolute(p) ? path.resolve(p) : path.resolve(root, p));
  if (!contains(root, target)) throw new Error('Path is outside your allowed area');
  if (root !== FS_ROOT) { // owner ceiling is '/', so nothing to escape
    try {
      if (!contains(fs.realpathSync(root), fs.realpathSync(target))) {
        throw new Error('Path is outside your allowed area');
      }
    } catch (e) {
      if (e && e.message === 'Path is outside your allowed area') throw e;
      // ENOENT/EACCES: the prefix check above already held — fall through.
    }
  }
  return target;
}

// List a directory for the file picker, scoped to the user's allowed root.
// Returns folders first then files (name/type/size), plus navigation context.
export function listDir(user, p) {
  const dir = resolveBrowse(user, p);
  if (!fs.statSync(dir).isDirectory()) throw new Error('Not a directory');
  const root = userBrowseRoot(user);
  const home = realHome(user);

  let raw;
  try { raw = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { throw new Error('Cannot read this folder (' + (e.code || 'error') + ')'); }

  const entries = [];
  for (const de of raw) {
    // Never expose the members container in the owner's root listing.
    if (de.name === MEMBERS_DIRNAME && dir === ROOT_REAL) continue;
    const abs = path.join(dir, de.name);
    let type = de.isDirectory() ? 'dir' : de.isFile() ? 'file' : 'other';
    let size = null;
    if (type !== 'dir') {
      try { const s = fs.statSync(abs); type = s.isDirectory() ? 'dir' : 'file'; if (type === 'file') size = s.size; }
      catch { /* dangling symlink / race — keep best guess */ }
    }
    entries.push({ name: de.name, type, size });
  }
  entries.sort((a, b) =>
    (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) ||
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

  return {
    path: dir,
    parent: dir === root ? null : path.dirname(dir), // null at the ceiling
    root,
    home,
    atRoot: dir === root,
    // The projects workspace (WORKSPACES_ROOT). Exposed
    // only when it sits inside the caller's allowed area (owner/admin) so the picker
    // can offer a one-tap jump to it; null for members, whose ceiling is their home.
    workspace: contains(root, WORKSPACES_ROOT) ? WORKSPACES_ROOT : null,
    entries,
  };
}

// Directory names we never descend into while searching: they're almost always
// huge, machine-generated, and not what someone hunts for by name. Skipping them
// keeps a recursive search fast (especially on a slow spinning disk).
const SEARCH_SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '.cache', '__pycache__',
  '.venv', 'venv', '.next', '.nuxt', '.gradle', '.terraform', '.pnpm-store',
]);

// Recursive "find a file/folder by name" for the picker, rooted at `p` (defaults
// to the caller's home via resolveBrowse). Scope is enforced exactly like browsing
// — a member can only search inside their own home. The walk is BOUNDED on every
// axis (result count, entries scanned, depth, wall-clock) and skips heavy dirs, so
// even an owner searching a big tree returns quickly with `truncated` set rather
// than hanging. Symlinked directories are matched but never followed (no loops, no
// escapes). Matching is a case-insensitive substring on the entry name.
export function searchFiles(user, p, query, opts = {}) {
  const root = resolveBrowse(user, p);
  if (!fs.statSync(root).isDirectory()) throw new Error('Not a directory');
  const q = String(query || '').toLowerCase().trim();
  if (!q) return { path: root, root, query: '', results: [], truncated: false, scanned: 0 };

  const maxResults = opts.maxResults || 300;
  const maxScanned = opts.maxScanned || 20000;
  const maxDepth = opts.maxDepth || 10;
  const deadline = Date.now() + (opts.budgetMs || 2500);

  const results = [];
  let scanned = 0;
  let truncated = false;
  const queue = [{ dir: root, depth: 0 }];

  while (queue.length) {
    if (results.length >= maxResults || scanned >= maxScanned || Date.now() > deadline) {
      truncated = true;
      break;
    }
    const { dir, depth } = queue.shift();
    let raw;
    try { raw = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; } // unreadable folder (EACCES etc.) — skip, keep going

    for (const de of raw) {
      if (results.length >= maxResults) { truncated = true; break; }
      scanned++;
      // Never expose the members container in the owner's root.
      if (de.name === MEMBERS_DIRNAME && dir === ROOT_REAL) continue;
      const abs = path.join(dir, de.name);
      const isLink = de.isSymbolicLink();
      let type = de.isDirectory() ? 'dir' : de.isFile() ? 'file' : 'other';
      let size = null;
      if (type !== 'dir') {
        try { const s = fs.statSync(abs); type = s.isDirectory() ? 'dir' : 'file'; if (type === 'file') size = s.size; }
        catch { /* dangling link / race — keep best guess */ }
      }
      if (de.name.toLowerCase().includes(q)) {
        results.push({ name: de.name, type, size, path: abs, rel: path.relative(root, abs) });
      }
      // Descend into real subdirectories only (never follow symlinks).
      if (type === 'dir' && !isLink && depth < maxDepth && !SEARCH_SKIP_DIRS.has(de.name)) {
        queue.push({ dir: abs, depth: depth + 1 });
      }
    }
  }

  // Shallower matches first (closer to where you're searching), folders before
  // files, then natural-name order — the most useful hits float to the top.
  results.sort((a, b) =>
    a.rel.split(path.sep).length - b.rel.split(path.sep).length ||
    (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) ||
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

  return { path: root, root, query: String(query).trim(), results, truncated, scanned };
}

// Build the entry plan for a .zip of `items` (each already scope-validated by
// resolveBrowse in the caller: {abs, isDir, name}). Folders are walked WITHOUT
// following symlinks — so the archive can't loop and a confined member can't escape
// their home through a symlink inside it. Top-level names are de-duplicated so two
// identically named picks don't collide; empty folders are kept as explicit entries.
// Returns { files: [{abs, name}], dirs: [name] } — names are forward-slash zip paths.
export function planZip(items) {
  const files = [];
  const dirs = [];
  const used = new Set();
  for (const it of items || []) {
    const baseName = it.name || (it.isDir ? 'folder' : 'file');
    const ext = it.isDir ? '' : path.extname(baseName);
    const stem = it.isDir ? baseName : baseName.slice(0, baseName.length - ext.length);
    let entry = baseName;
    for (let i = 1; used.has(entry); i++) entry = stem + '-' + i + ext;
    used.add(entry);
    if (!it.isDir) { files.push({ abs: it.abs, name: entry }); continue; }
    const stack = [{ d: it.abs, rel: entry }];
    while (stack.length) {
      const { d, rel } = stack.pop();
      let raw;
      try { raw = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
      if (!raw.length) { dirs.push(rel); continue; }
      for (const de of raw) {
        if (de.isSymbolicLink()) continue; // never follow links (no loops, no escapes)
        const child = path.join(d, de.name);
        const childRel = rel + '/' + de.name;
        if (de.isDirectory()) stack.push({ d: child, rel: childRel });
        else if (de.isFile()) files.push({ abs: child, name: childRel });
      }
    }
  }
  return { files, dirs };
}

export { ROOT_REAL };
