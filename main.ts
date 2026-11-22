// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// Implements all of SPEC.md: the command line, output and exit codes, safe paths,
// format detection, line matching at three tiers, unified diffs, SEARCH/REPLACE
// blocks, V4A patches, JSON edits, and all-or-nothing writes.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then
// this file hands over to runner.ts (the last lines below): keep that hand-over
// and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  recordMove(oldP: string, newP: string): void {
    this.moves.push([oldP, newP]);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Shared helpers: file line model (section 3) and three-tier matching (section 5)
// ---------------------------------------------------------------------------

interface FileModel {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileModel {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(f: FileModel): string {
  return f.lines.length === 0 ? '' : f.lines.join(f.br) + (f.final ? f.br : '');
}

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const onlyWs = (s: string): boolean => /^[ \t]*$/.test(s);

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimWs(a) === trimWs(b);
}

function occurrencesAt(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = 0; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** First tier (0, then 1, then 2; strict: 0 only) at which `o` occurs at/after `from`. */
function findTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrencesAt(lines, o, t).filter((p) => p >= from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/**
 * Build the replacement lines for a matched block. `ctx` maps each index of N
 * that is a context line to its index in O. Context lines are written as the
 * file's own matched line; at tier 2 every other non-blank line of N that
 * starts with O's leading whitespace has that prefix swapped for the file's.
 */
function transformN(n: string[], ctx: Map<number, number>, o: string[], fileSlice: string[], tier: number): string[] {
  const p = o.length > 0 ? leadWs(o[0]!) : '';
  const f = fileSlice.length > 0 ? leadWs(fileSlice[0]!) : '';
  return n.map((line, ni) => {
    const oi = ctx.get(ni);
    if (oi !== undefined) return fileSlice[oi]!;
    if (tier === 2 && line !== '' && !onlyWs(line) && line.startsWith(p)) return f + line.slice(p.length);
    return line;
  });
}

/** One body line of a unified hunk or a V4A chunk. `noNl` is set by a `\` line after it. */
interface BodyLine {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  noNl: boolean;
  rawEmpty?: boolean;
}

/** Split a hunk/chunk body into its old lines O, new lines N and the context map. */
function splitBody(body: BodyLine[]): { o: string[]; n: string[]; ctx: Map<number, number> } {
  const o: string[] = [];
  const n: string[] = [];
  const ctx = new Map<number, number>();
  for (const b of body) {
    if (b.kind === 'ctx') {
      ctx.set(n.length, o.length);
      o.push(b.text);
      n.push(b.text);
    } else if (b.kind === 'old') {
      o.push(b.text);
    } else {
      n.push(b.text);
    }
  }
  return { o, n, ctx };
}

/** The last context or `+` line of a body, if any (for the no-newline-at-EOF rule). */
function lastCtxOrNew(body: BodyLine[]): BodyLine | undefined {
  for (let i = body.length - 1; i >= 0; i -= 1) {
    if (body[i]!.kind === 'ctx' || body[i]!.kind === 'new') return body[i]!;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Unified diffs (section 6)
// ---------------------------------------------------------------------------

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface UnifiedSection {
  startLine: number;
  oldPath: string | null | undefined;
  newPath: string | null | undefined;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: |$)/;
const DIFF_RE = /^diff --git a\/([^ ]+) b\/([^ ]+)[ \t]*$/;

function cleanPairPath(raw: string): string | null {
  let p = raw.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseUnified(lines: string[]): UnifiedSection[] {
  const sections: UnifiedSection[] = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    let section: UnifiedSection | null = null;
    if (line.startsWith('diff --git ')) {
      const m = DIFF_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      section = { startLine: i + 1, oldPath: m[1]!, newPath: m[2]!, isCreate: false, isDelete: false, hunks: [] };
      i += 1;
    } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      // A bare ---/+++ section: do not advance; the header loop below
      // consumes the pair and records the paths.
      section = { startLine: i + 1, oldPath: undefined, newPath: undefined, isCreate: false, isDelete: false, hunks: [] };
    } else if (line.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i += 1;
      continue;
    }
    // Header: before the first hunk.
    let pairOld: string | null | undefined;
    let pairNew: string | null | undefined;
    let pairSeen = false;
    let renameOld: string | undefined;
    let renameNew: string | undefined;
    const diffOld = section.oldPath;
    const diffNew = section.newPath;
    let inHeader = true;
    while (inHeader && i < n) {
      const h = lines[i]!;
      if (h.startsWith('@@')) {
        inHeader = false;
        break;
      }
      if (h.startsWith('diff --git ')) break;
      if (h.startsWith('--- ')) {
        const nxt = lines[i + 1] ?? '';
        if (!nxt.startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        const rawOld = h.slice(4).split('\t')[0]!;
        const rawNew = nxt.slice(4).split('\t')[0]!;
        pairOld = cleanPairPath(rawOld);
        pairNew = cleanPairPath(rawNew);
        pairSeen = true;
        i += 2;
        continue;
      }
      if (h.startsWith('rename from ')) renameOld = h.slice('rename from '.length).trim();
      else if (h.startsWith('rename to ')) renameNew = h.slice('rename to '.length).trim();
      else if (h.startsWith('new file mode')) section.isCreate = true;
      else if (h.startsWith('deleted file mode')) section.isDelete = true;
      i += 1;
    }
    if (pairSeen) {
      section.oldPath = pairOld ?? null;
      section.newPath = pairNew ?? null;
    } else if (renameOld !== undefined || renameNew !== undefined) {
      if (renameOld !== undefined) section.oldPath = renameOld === '/dev/null' ? null : renameOld;
      if (renameNew !== undefined) section.newPath = renameNew === '/dev/null' ? null : renameNew;
    } else {
      section.oldPath = diffOld;
      section.newPath = diffNew;
    }
    // Hunks.
    while (i < n) {
      const h = lines[i]!;
      if (h.startsWith('diff --git ')) break;
      if (h.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
      if (h.startsWith('@@')) {
        const m = HUNK_RE.exec(h);
        if (m === null) throw new Exit2(`error: parse ${i + 1}`);
        const a = Number(m[1]);
        i += 1;
        const body: BodyLine[] = [];
        while (i < n) {
          const b = lines[i]!;
          if (b.startsWith('diff --git ')) break;
          if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
          if (b.startsWith('@@')) break;
          if (b === '') {
            body.push({ kind: 'ctx', text: '', noNl: false, rawEmpty: true });
            i += 1;
            continue;
          }
          if (b.startsWith(' ')) {
            body.push({ kind: 'ctx', text: b.slice(1), noNl: false });
            i += 1;
            continue;
          }
          if (b.startsWith('-')) {
            body.push({ kind: 'old', text: b.slice(1), noNl: false });
            i += 1;
            continue;
          }
          if (b.startsWith('+')) {
            body.push({ kind: 'new', text: b.slice(1), noNl: false });
            i += 1;
            continue;
          }
          if (b.startsWith('\\')) {
            const prev = body[body.length - 1];
            if (prev !== undefined) prev.noNl = true;
            i += 1;
            continue;
          }
          break;
        }
        while (body.length > 0) {
          const lastB = body[body.length - 1]!;
          if (lastB.kind === 'ctx' && lastB.rawEmpty === true) body.pop();
          else break;
        }
        section.hunks.push({ a, body });
        continue;
      }
      // Prose outside bodies: ignored.
      i += 1;
    }
    sections.push(section);
  }
  return sections;
}

/** Apply a section's hunks to a file model; throws Fail('no-match', path) on failure. */
function applyHunks(f: FileModel, hunks: Hunk[], strict: boolean, failPath: string): FileModel {
  let lines = [...f.lines];
  let final = f.final;
  let d = 0;
  for (const hunk of hunks) {
    const { o, n, ctx } = splitBody(hunk.body);
    if (o.length > 0) {
      const found = findTier(lines, o, strict);
      if (found === null) throw new Fail('no-match', failPath);
      const target = hunk.a - 1 + d;
      let best = found.pos[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.pos) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const slice = lines.slice(best, best + o.length);
      const rep = transformN(n, ctx, o, slice, found.tier);
      const runsToEnd = best + o.length === lines.length;
      const lastCP = lastCtxOrNew(hunk.body);
      lines.splice(best, o.length, ...rep);
      if (runsToEnd) final = !(lastCP !== undefined && lastCP.noNl);
      d += n.length - o.length;
    } else {
      const pos = Math.min(Math.max(hunk.a + d, 0), lines.length);
      const atEnd = pos === lines.length;
      const lastCP = lastCtxOrNew(hunk.body);
      lines.splice(pos, 0, ...n);
      if (atEnd && n.length > 0) final = !(lastCP !== undefined && lastCP.noNl);
      d += n.length;
    }
  }
  return { br: f.br, lines, final };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseUnified(lines);
  const edits: Edit[] = [];
  for (const s of sections) {
    const oldP = s.oldPath;
    const newP = s.newPath;
    const isCreate = s.isCreate || oldP === null;
    const isDelete = s.isDelete || newP === null;
    if (isCreate && newP === null) throw new Exit2(`error: parse ${s.startLine}`);
    if (isDelete && !isCreate && oldP === null) throw new Exit2(`error: parse ${s.startLine}`);
    if (oldP === undefined || newP === undefined) throw new Exit2(`error: parse ${s.startLine}`);
    const hunks = s.hunks;
    if (isCreate) {
      const np = newP as string;
      edits.push((tree) => {
        if (!safe(np)) throw new Fail('unsafe', np);
        if (tree.get(np) !== null) throw new Fail('exists', np);
        const plus: string[] = [];
        let lastNoNl = false;
        let anyPlus = false;
        for (const h of hunks) {
          for (const b of h.body) {
            if (b.kind === 'new') {
              plus.push(b.text);
              lastNoNl = b.noNl;
              anyPlus = true;
            }
          }
        }
        tree.now.set(np, !anyPlus ? '' : plus.join('\n') + (lastNoNl ? '' : '\n'));
      });
    } else if (isDelete) {
      const op = oldP as string;
      edits.push((tree) => {
        if (!safe(op)) throw new Fail('unsafe', op);
        if (tree.get(op) === null) throw new Fail('missing', op);
        tree.now.set(op, null);
      });
    } else if (oldP !== newP) {
      const op = oldP as string;
      const np = newP as string;
      edits.push((tree) => {
        if (!safe(op)) throw new Fail('unsafe', op);
        if (!safe(np)) throw new Fail('unsafe', np);
        if (tree.get(op) === null) throw new Fail('missing', op);
        if (tree.get(np) !== null) throw new Fail('exists', np);
        const res = applyHunks(splitFile(tree.get(op)!), hunks, strict, op);
        tree.now.set(np, joinFile(res));
        tree.now.set(op, null);
        tree.recordMove(op, np);
      });
    } else {
      const op = oldP as string;
      edits.push((tree) => {
        if (!safe(op)) throw new Fail('unsafe', op);
        if (tree.get(op) === null) throw new Fail('missing', op);
        const res = applyHunks(splitFile(tree.get(op)!), hunks, strict, op);
        tree.now.set(op, joinFile(res));
      });
    }
  }
  return edits;
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (section 7)
// ---------------------------------------------------------------------------

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const s = i;
    let eq = -1;
    for (let j = s + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    let path: string | null = null;
    for (let j = s - 1; j >= prevEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${s + 1}`);
    prevPath = path;
    const oldLines = lines.slice(s + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const cur = tree.get(p);
      if (cur === null) throw new Fail('missing', p);
      const f = splitFile(cur);
      const found = findTier(f.lines, oldLines, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.pos.length > 1) throw new Fail('ambiguous', p);
      const at = found.pos[0]!;
      const slice = f.lines.slice(at, at + oldLines.length);
      const repLines = transformN(newLines, new Map(), oldLines, slice, found.tier);
      const outLines = [...f.lines];
      outLines.splice(at, oldLines.length, ...repLines);
      tree.now.set(p, joinFile({ br: f.br, lines: outLines, final: f.final }));
    });
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// V4A patches (section 8)
// ---------------------------------------------------------------------------

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

const V4A_ADD = '*** Add File: ';
const V4A_DELETE = '*** Delete File: ';
const V4A_UPDATE = '*** Update File: ';
const V4A_MOVE = '*** Move to: ';

function isV4aHeader(l: string): boolean {
  return l.startsWith(V4A_ADD) || l.startsWith(V4A_DELETE) || l.startsWith(V4A_UPDATE);
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (!isV4aHeader(line)) throw new Exit2(`error: parse ${i + 1}`);
    const headerLine = i + 1;
    // Collect the section's lines: until the next section header or End Patch.
    const content: Array<{ text: string; line: number }> = [];
    i += 1;
    while (i < last && !isV4aHeader(lines[i]!)) {
      content.push({ text: lines[i]!, line: i + 1 });
      i += 1;
    }
    while (content.length > 0 && blank(content[content.length - 1]!.text)) content.pop();
    if (line.startsWith(V4A_ADD)) {
      const path = line.slice(V4A_ADD.length).trim();
      const fileLines: string[] = [];
      for (const c of content) {
        if (c.text.startsWith('+')) fileLines.push(c.text.slice(1));
        else if (c.text === '') fileLines.push('');
        else throw new Exit2(`error: parse ${c.line}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
    } else if (line.startsWith(V4A_DELETE)) {
      const path = line.slice(V4A_DELETE.length).trim();
      for (const c of content) throw new Exit2(`error: parse ${c.line}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      const path = line.slice(V4A_UPDATE.length).trim();
      let moveTo: string | null = null;
      let j = 0;
      if (j < content.length && content[j]!.text.startsWith(V4A_MOVE)) {
        moveTo = content[j]!.text.slice(V4A_MOVE.length).trim();
        j += 1;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      const pushCur = (): void => {
        if (cur !== null) {
          chunks.push(cur);
          cur = null;
        }
      };
      while (j < content.length) {
        const c = content[j]!;
        const t = c.text;
        if (t.startsWith('@@')) {
          pushCur();
          cur = { anchor: t.slice(2).trim() === '' ? null : t.slice(2).trim(), eof: false, body: [] };
        } else if (t === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${c.line}`);
          cur.eof = true;
          pushCur();
        } else if (t.startsWith(' ') || t.startsWith('-') || t.startsWith('+') || t === '') {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${c.line}`);
            cur = { anchor: null, eof: false, body: [] };
          }
          if (t === '') cur.body.push({ kind: 'ctx', text: '', noNl: false });
          else if (t.startsWith(' ')) cur.body.push({ kind: 'ctx', text: t.slice(1), noNl: false });
          else if (t.startsWith('-')) cur.body.push({ kind: 'old', text: t.slice(1), noNl: false });
          else cur.body.push({ kind: 'new', text: t.slice(1), noNl: false });
        } else {
          throw new Exit2(`error: parse ${c.line}`);
        }
        j += 1;
      }
      pushCur();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
      const p = path;
      const mt = moveTo;
      const chs = chunks;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (mt !== null && !safe(mt)) throw new Fail('unsafe', mt);
        const curText = tree.get(p);
        if (curText === null) throw new Fail('missing', p);
        if (mt !== null && tree.get(mt) !== null) throw new Fail('exists', mt);
        const f = splitFile(curText);
        let fileLines = [...f.lines];
        let cursor = 0;
        for (const chunk of chs) {
          if (chunk.anchor !== null) {
            const foundA = findTier(fileLines, [chunk.anchor], strict, cursor);
            if (foundA === null) throw new Fail('no-match', p);
            cursor = foundA.pos[0]! + 1;
          }
          const { o, n, ctx } = splitBody(chunk.body);
          if (o.length > 0) {
            const found = findTier(fileLines, o, strict, cursor);
            if (found === null) throw new Fail('no-match', p);
            let at: number | undefined;
            if (chunk.eof) {
              at = found.pos.find((q) => q + o.length === fileLines.length);
              if (at === undefined) throw new Fail('no-match', p);
            } else {
              at = found.pos[0]!;
            }
            const slice = fileLines.slice(at, at + o.length);
            const repLines = transformN(n, ctx, o, slice, found.tier);
            fileLines.splice(at, o.length, ...repLines);
            cursor = at + repLines.length;
          } else {
            const pos = chunk.eof ? fileLines.length : cursor;
            fileLines.splice(pos, 0, ...n);
            cursor = pos + n.length;
          }
        }
        const out = joinFile({ br: f.br, lines: fileLines, final: f.final });
        if (mt !== null) {
          tree.now.set(mt, out);
          tree.now.set(p, null);
          tree.recordMove(p, mt);
        } else {
          tree.now.set(p, out);
        }
      });
    }
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Changed paths, with move edits reported as R lines (sorted by the new path).
  const changed = new Map<string, { was: string | null; now: string | null }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was !== now) changed.set(p, { was, now });
  }
  const rows: Array<{ key: string; text: string }> = [];
  const usedInMove = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    const o = changed.get(oldP);
    const nn = changed.get(newP);
    if (o !== undefined && nn !== undefined && o.was !== null && o.now === null && nn.was === null && nn.now !== null) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      usedInMove.add(oldP);
      usedInMove.add(newP);
    }
  }
  for (const [p, { was, now }] of changed) {
    if (usedInMove.has(p)) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...changed.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const now = changed.get(p)!.now;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const outLines = rows.map((r) => r.text);
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
