// mend: universal AI edit patch CLI implementing SPEC.md (unified, search-replace, v4a, json).
// Node 22 standard library only; hands trial execution over to runner.ts when MAKEFUN_ENV_URL is set.

import { mkdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
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

interface MoveRecord {
  oldPath: string;
  newPath: string;
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

function trimSpaces(s: string): string {
  return s.replace(/^ +| +$/g, '');
}

function leadingWs(s: string): string {
  let i = 0;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i += 1;
  return s.slice(0, i);
}

function normLine(s: string, tier: 0 | 1 | 2): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+|[ \t]+$/g, '');
}

interface SplitText {
  lines: string[];
  br: '\r\n' | '\n';
  endsWithBreak: boolean;
}

function splitFile(text: string): SplitText {
  if (text === '') return { lines: [], br: '\n', endsWithBreak: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const endsWithBreak = text.endsWith(br);
  const lines = text.split(br);
  if (endsWithBreak) lines.pop();
  return { lines, br, endsWithBreak };
}

function joinFile(lines: string[], br: '\r\n' | '\n', endsWithBreak: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (endsWithBreak ? br : '');
}

function findMatches(
  fileLines: string[],
  oldLines: string[],
  strict: boolean,
  startAt = 0,
  endOnly = false,
): { tier: 0 | 1 | 2; positions: number[] } | null {
  const k = oldLines.length;
  const tiers: (0 | 1 | 2)[] = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const normOld = oldLines.map((l) => normLine(l, tier));
    const positions: number[] = [];
    if (endOnly) {
      const i = fileLines.length - k;
      if (i >= startAt && i >= 0) {
        let ok = true;
        for (let j = 0; j < k; j += 1) {
          if (normLine(fileLines[i + j]!, tier) !== normOld[j]) {
            ok = false;
            break;
          }
        }
        if (ok) positions.push(i);
      }
    } else {
      const maxStart = fileLines.length - k;
      for (let i = startAt; i <= maxStart; i += 1) {
        let ok = true;
        for (let j = 0; j < k; j += 1) {
          if (normLine(fileLines[i + j]!, tier) !== normOld[j]) {
            ok = false;
            break;
          }
        }
        if (ok) positions.push(i);
      }
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

function reindentLine(line: string, filePrefix: string, patchPrefix: string): string {
  if (line.trim() !== '' && line.startsWith(patchPrefix)) {
    return filePrefix + line.slice(patchPrefix.length);
  }
  return line;
}

interface BodyOp {
  kind: 'ctx' | 'del' | 'add' | 'noeol';
  text: string;
  bareEmpty?: boolean;
}

function buildReplacement(
  ops: BodyOp[],
  fileLines: string[],
  matchPos: number,
  oldLines: string[],
  tier: 0 | 1 | 2,
): string[] {
  const filePrefix = oldLines.length > 0 ? leadingWs(fileLines[matchPos]!) : '';
  const patchPrefix = oldLines.length > 0 ? leadingWs(oldLines[0]!) : '';
  const out: string[] = [];
  let oldIdx = 0;
  for (const op of ops) {
    if (op.kind === 'ctx') {
      out.push(fileLines[matchPos + oldIdx]!);
      oldIdx += 1;
    } else if (op.kind === 'del') {
      oldIdx += 1;
    } else if (op.kind === 'add') {
      if (tier === 2 && oldLines.length > 0) out.push(reindentLine(op.text, filePrefix, patchPrefix));
      else out.push(op.text);
    }
  }
  return out;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: MoveRecord[] = [];

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

  deletePath(p: string): void {
    this.now.set(p, null);
    for (let i = this.moves.length - 1; i >= 0; i -= 1) {
      if (this.moves[i]!.newPath === p) this.moves.splice(i, 1);
    }
  }

  recordMove(oldPath: string, newPath: string): void {
    for (let i = this.moves.length - 1; i >= 0; i -= 1) {
      if (this.moves[i]!.newPath === newPath) this.moves.splice(i, 1);
    }
    this.moves.push({ oldPath, newPath });
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

// --- Section 6: Unified diffs ---

interface UnifiedHunk {
  oldStart: number;
  ops: BodyOp[];
}

interface UnifiedSection {
  gitOld: string | null;
  gitNew: string | null;
  minusPath: string | null;
  plusPath: string | null;
  minusIsDevNull: boolean;
  plusIsDevNull: boolean;
  hasMinusPlus: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  isNew: boolean;
  isDeleted: boolean;
  hunks: UnifiedHunk[];
}

const DIFF_GIT_PREFIX_RE = /^diff --git(?:\s|$)/;

function parseDiffGitLine(line: string): { oldPath: string; newPath: string } | null {
  if (!line.startsWith('diff --git ')) return null;
  const rest = line.slice(11);
  if (!rest.startsWith('a/')) return null;
  const splits: Array<{ oldPath: string; newPath: string }> = [];
  let from = 2;
  while (true) {
    const idx = rest.indexOf(' b/', from);
    if (idx < 0) break;
    const oldPath = rest.slice(2, idx);
    const newPath = rest.slice(idx + 3);
    if (oldPath !== '' && newPath !== '') splits.push({ oldPath, newPath });
    from = idx + 1;
  }
  if (splits.length === 0) return null;
  const same = splits.find((s) => s.oldPath === s.newPath);
  return same ?? splits[0]!;
}

function parseUnifiedPath(line: string): { path: string; isDevNull: boolean } {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = trimSpaces(p);
  if (p === '/dev/null') return { path: '/dev/null', isDevNull: true };
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return { path: p, isDevNull: false };
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function makeEmptyUnifiedSection(): UnifiedSection {
  return {
    gitOld: null,
    gitNew: null,
    minusPath: null,
    plusPath: null,
    minusIsDevNull: false,
    plusIsDevNull: false,
    hasMinusPlus: false,
    renameFrom: null,
    renameTo: null,
    isNew: false,
    isDeleted: false,
    hunks: [],
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let cur: UnifiedSection | null = null;
  let inHeader = false;
  let i = 0;

  while (i < lines.length) {
    const l = lines[i]!;
    if (DIFF_GIT_PREFIX_RE.test(l)) {
      const parsed = parseDiffGitLine(l);
      if (parsed === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = makeEmptyUnifiedSection();
      cur.gitOld = parsed.oldPath;
      cur.gitNew = parsed.newPath;
      sections.push(cur);
      inHeader = true;
      i += 1;
      continue;
    }

    if (l.startsWith('--- ')) {
      const next = lines[i + 1];
      if (next !== undefined && next.startsWith('+++ ')) {
        const mp = parseUnifiedPath(l);
        const pp = parseUnifiedPath(next);
        if (cur !== null && inHeader && !cur.hasMinusPlus) {
          cur.minusPath = mp.path;
          cur.minusIsDevNull = mp.isDevNull;
          cur.plusPath = pp.path;
          cur.plusIsDevNull = pp.isDevNull;
          cur.hasMinusPlus = true;
        } else {
          cur = makeEmptyUnifiedSection();
          cur.minusPath = mp.path;
          cur.minusIsDevNull = mp.isDevNull;
          cur.plusPath = pp.path;
          cur.plusIsDevNull = pp.isDevNull;
          cur.hasMinusPlus = true;
          sections.push(cur);
          inHeader = true;
        }
        i += 2;
        continue;
      }
      if (cur !== null && inHeader && !cur.hasMinusPlus) {
        throw new Exit2(`error: parse ${i + 2}`);
      }
      i += 1;
      continue;
    }

    if (l.startsWith('@@')) {
      const m = HUNK_HEADER_RE.exec(l);
      if (m === null || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const oldStart = Number(m[1]);
      const ops: BodyOp[] = [];
      i += 1;
      while (i < lines.length) {
        const bl = lines[i]!;
        if (DIFF_GIT_PREFIX_RE.test(bl)) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '') {
          ops.push({ kind: 'ctx', text: '', bareEmpty: true });
          i += 1;
        } else if (bl[0] === ' ') {
          ops.push({ kind: 'ctx', text: bl.slice(1), bareEmpty: false });
          i += 1;
        } else if (bl[0] === '-') {
          ops.push({ kind: 'del', text: bl.slice(1), bareEmpty: false });
          i += 1;
        } else if (bl[0] === '+') {
          ops.push({ kind: 'add', text: bl.slice(1), bareEmpty: false });
          i += 1;
        } else if (bl[0] === '\\') {
          ops.push({ kind: 'noeol', text: '', bareEmpty: false });
          i += 1;
        } else {
          break;
        }
      }
      while (ops.length > 0 && ops[ops.length - 1]!.bareEmpty) ops.pop();
      cur.hunks.push({ oldStart, ops });
      continue;
    }

    if (cur !== null && inHeader) {
      if (l.startsWith('rename from ')) cur.renameFrom = trimSpaces(l.slice(12));
      else if (l.startsWith('rename to ')) cur.renameTo = trimSpaces(l.slice(10));
      else if (l.startsWith('new file mode')) cur.isNew = true;
      else if (l.startsWith('deleted file mode')) cur.isDeleted = true;
    }
    i += 1;
  }

  return sections.map((sec): Edit => {
    const oldPath = sec.hasMinusPlus ? sec.minusPath! : (sec.renameFrom ?? sec.gitOld ?? '');
    const newPath = sec.hasMinusPlus ? sec.plusPath! : (sec.renameTo ?? sec.gitNew ?? '');
    const oldDevNull = sec.hasMinusPlus && sec.minusIsDevNull;
    const newDevNull = sec.hasMinusPlus && sec.plusIsDevNull;
    const isCreate = sec.isNew || oldDevNull;
    const isDelete = !isCreate && (sec.isDeleted || newDevNull);
    const isMove = !isCreate && !isDelete && oldPath !== newPath;

    if (isCreate) {
      return (tree) => {
        if (!oldDevNull && oldPath !== '' && !safe(oldPath)) throw new Fail('unsafe', oldPath);
        if (!safe(newPath)) throw new Fail('unsafe', newPath);
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const addLines: string[] = [];
        let lastAddNoEol = false;
        for (const h of sec.hunks) {
          let lastWasAdd = false;
          for (const op of h.ops) {
            if (op.kind === 'add') {
              addLines.push(op.text);
              lastWasAdd = true;
              lastAddNoEol = false;
            } else if (op.kind === 'noeol') {
              if (lastWasAdd) lastAddNoEol = true;
            } else {
              lastWasAdd = false;
            }
          }
        }
        tree.now.set(newPath, joinFile(addLines, '\n', !lastAddNoEol));
      };
    }

    if (isDelete) {
      return (tree) => {
        if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
        if (!newDevNull && newPath !== '' && !safe(newPath)) throw new Fail('unsafe', newPath);
        if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
        tree.deletePath(oldPath);
      };
    }

    return (tree) => {
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (isMove && !safe(newPath)) throw new Fail('unsafe', newPath);
      const before = tree.get(oldPath);
      if (before === null) throw new Fail('missing', oldPath);
      if (isMove && tree.get(newPath) !== null) throw new Fail('exists', newPath);

      const state = splitFile(before);
      let d = 0;
      for (const h of sec.hunks) {
        const oldLines: string[] = [];
        const newOnlyCount = h.ops.filter((op) => op.kind === 'ctx' || op.kind === 'add').length;
        let lastKind: 'ctx' | 'del' | 'add' | null = null;
        let lastNewNoEol = false;
        for (const op of h.ops) {
          if (op.kind === 'ctx') {
            oldLines.push(op.text);
            lastKind = 'ctx';
            lastNewNoEol = false;
          } else if (op.kind === 'del') {
            oldLines.push(op.text);
            lastKind = 'del';
          } else if (op.kind === 'add') {
            lastKind = 'add';
            lastNewNoEol = false;
          } else if (op.kind === 'noeol') {
            if (lastKind === 'ctx' || lastKind === 'add') lastNewNoEol = true;
          }
        }

        if (oldLines.length > 0) {
          const matched = findMatches(state.lines, oldLines, strict);
          if (matched === null) throw new Fail('no-match', oldPath);
          const target = h.oldStart - 1 + d;
          let bestPos = matched.positions[0]!;
          let bestDist = Math.abs(bestPos - target);
          for (let j = 1; j < matched.positions.length; j += 1) {
            const p = matched.positions[j]!;
            const dist = Math.abs(p - target);
            if (dist < bestDist) {
              bestDist = dist;
              bestPos = p;
            }
          }
          const runsToEnd = bestPos + oldLines.length === state.lines.length;
          const repl = buildReplacement(h.ops, state.lines, bestPos, oldLines, matched.tier);
          state.lines.splice(bestPos, oldLines.length, ...repl);
          if (runsToEnd) state.endsWithBreak = !lastNewNoEol;
          d += repl.length - oldLines.length;
        } else {
          const insertPos = Math.max(0, Math.min(state.lines.length, h.oldStart + d));
          const runsToEnd = insertPos === state.lines.length;
          const addLines = h.ops.filter((op) => op.kind === 'add').map((op) => op.text);
          state.lines.splice(insertPos, 0, ...addLines);
          if (runsToEnd) state.endsWithBreak = !lastNewNoEol;
          d += newOnlyCount;
        }
      }

      const outText = sec.hunks.length === 0 ? before : joinFile(state.lines, state.br, state.endsWithBreak);
      if (isMove) {
        tree.deletePath(oldPath);
        tree.now.set(newPath, outText);
        tree.recordMove(oldPath, newPath);
      } else {
        tree.now.set(oldPath, outText);
      }
    };
  });
}

// --- Section 7: SEARCH/REPLACE blocks ---

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;

  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let blockPath: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t !== '' && !t.startsWith('```')) {
        blockPath = t;
        break;
      }
    }
    if (blockPath === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      blockPath = prevPath;
    }

    let sepIdx = -1;
    for (let j = searchIdx + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        sepIdx = j;
        break;
      }
    }
    if (sepIdx < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);

    let repIdx = -1;
    for (let j = sepIdx + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        repIdx = j;
        break;
      }
    }
    if (repIdx < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);

    const oldLines = lines.slice(searchIdx + 1, sepIdx);
    const newLines = lines.slice(sepIdx + 1, repIdx);
    const path = blockPath;
    prevPath = path;
    prevEnd = repIdx;
    i = repIdx + 1;

    if (oldLines.length === 0) {
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, joinFile(newLines, '\n', true));
      });
    } else {
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        const before = tree.get(path);
        if (before === null) throw new Fail('missing', path);
        const state = splitFile(before);
        const matched = findMatches(state.lines, oldLines, strict);
        if (matched === null) throw new Fail('no-match', path);
        if (matched.positions.length > 1) throw new Fail('ambiguous', path);
        const pos = matched.positions[0]!;
        let repl: string[];
        if (matched.tier === 2) {
          const F = leadingWs(state.lines[pos]!);
          const P = leadingWs(oldLines[0]!);
          repl = newLines.map((l) => reindentLine(l, F, P));
        } else {
          repl = newLines;
        }
        state.lines.splice(pos, oldLines.length, ...repl);
        tree.now.set(path, joinFile(state.lines, state.br, state.endsWithBreak));
      });
    }
  }

  return edits;
}

// --- Section 8: V4A patches ---

interface V4AChunk {
  anchor: string | null;
  ops: BodyOp[];
  eof: boolean;
}

function isV4ASectionHeader(l: string): boolean {
  return l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);

  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last <= first || lines[last]!.trim() !== '*** End Patch') {
    throw new Exit2(`error: parse ${lines.length + 1}`);
  }

  const edits: Edit[] = [];
  let i = first + 1;

  while (i < last) {
    while (i < last && blank(lines[i]!)) i += 1;
    if (i >= last) break;

    const headerLine = lines[i]!;
    const headerNum = i + 1;
    if (!isV4ASectionHeader(headerLine)) throw new Exit2(`error: parse ${headerNum}`);

    if (headerLine.startsWith('*** Delete File: ')) {
      const path = trimSpaces(headerLine.slice(17));
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.deletePath(path);
      });
      i += 1;
      continue;
    }

    // Find raw end of this Add/Update section (next section header or *** End Patch)
    let secEnd = i + 1;
    while (secEnd < last && !isV4ASectionHeader(lines[secEnd]!)) secEnd += 1;
    // Strip trailing blank lines at the end of the section (SPEC.md section 8)
    let contentEnd = secEnd;
    while (contentEnd > i + 1 && blank(lines[contentEnd - 1]!)) contentEnd -= 1;

    if (headerLine.startsWith('*** Add File: ')) {
      const path = trimSpaces(headerLine.slice(14));
      const addLines: string[] = [];
      for (let j = i + 1; j < contentEnd; j += 1) {
        const l = lines[j]!;
        if (l.startsWith('+')) addLines.push(l.slice(1));
        else if (l === '') addLines.push('');
        else throw new Exit2(`error: parse ${j + 1}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, joinFile(addLines, '\n', true));
      });
    } else {
      const path = trimSpaces(headerLine.slice(17));
      let j = i + 1;
      let moveTo: string | null = null;
      if (j < contentEnd && lines[j]!.startsWith('*** Move to: ')) {
        moveTo = trimSpaces(lines[j]!.slice(13));
        j += 1;
      }

      const chunks: V4AChunk[] = [];
      let curChunk: V4AChunk | null = null;
      let chunkClosedByEof = false;

      while (j < contentEnd) {
        const l = lines[j]!;
        if (chunkClosedByEof && blank(l)) {
          j += 1;
          continue;
        }
        if (l.startsWith('@@')) {
          const anchorText = trimSpaces(l.slice(2));
          curChunk = { anchor: anchorText === '' ? null : anchorText, ops: [], eof: false };
          chunks.push(curChunk);
          chunkClosedByEof = false;
          j += 1;
          continue;
        }
        if (l === '*** End of File') {
          if (curChunk === null) throw new Exit2(`error: parse ${j + 1}`);
          curChunk.eof = true;
          curChunk = null;
          chunkClosedByEof = true;
          j += 1;
          continue;
        }
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (curChunk === null) {
            if (chunks.length > 0 || chunkClosedByEof) throw new Exit2(`error: parse ${j + 1}`);
            curChunk = { anchor: null, ops: [], eof: false };
            chunks.push(curChunk);
          }
          if (l === '') curChunk.ops.push({ kind: 'ctx', text: '' });
          else if (l[0] === ' ') curChunk.ops.push({ kind: 'ctx', text: l.slice(1) });
          else if (l[0] === '-') curChunk.ops.push({ kind: 'del', text: l.slice(1) });
          else curChunk.ops.push({ kind: 'add', text: l.slice(1) });
          j += 1;
          continue;
        }
        throw new Exit2(`error: parse ${j + 1}`);
      }

      if (chunks.length === 0 && moveTo === null) {
        throw new Exit2(`error: parse ${headerNum}`);
      }

      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
        const before = tree.get(path);
        if (before === null) throw new Fail('missing', path);
        if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);

        const state = splitFile(before);
        let cursor = 0;
        for (const ch of chunks) {
          if (ch.anchor !== null) {
            const am = findMatches(state.lines, [ch.anchor], strict, cursor, false);
            if (am === null) throw new Fail('no-match', path);
            cursor = am.positions[0]! + 1;
          }
          const oldLines: string[] = [];
          for (const op of ch.ops) {
            if (op.kind === 'ctx' || op.kind === 'del') oldLines.push(op.text);
          }
          if (oldLines.length > 0) {
            const matched = findMatches(state.lines, oldLines, strict, cursor, ch.eof);
            if (matched === null) throw new Fail('no-match', path);
            const pos = matched.positions[0]!;
            const repl = buildReplacement(ch.ops, state.lines, pos, oldLines, matched.tier);
            state.lines.splice(pos, oldLines.length, ...repl);
            cursor = pos + repl.length;
          } else {
            const pos = ch.eof ? state.lines.length : cursor;
            const addLines = ch.ops.filter((op) => op.kind === 'add').map((op) => op.text);
            state.lines.splice(pos, 0, ...addLines);
            cursor = pos + addLines.length;
          }
        }

        const outText = chunks.length === 0 ? before : joinFile(state.lines, state.br, state.endsWithBreak);
        if (moveTo !== null) {
          tree.deletePath(path);
          tree.now.set(moveTo, outText);
          tree.recordMove(path, moveTo);
        } else {
          tree.now.set(path, outText);
        }
      });
    }

    i = secEnd;
  }

  return edits;
}

// --- Section 9: JSON edits ---

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
      const state = splitFile(before);
      if (line < 0 || line > state.lines.length) throw new Fail('no-match', p);
      state.lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(state.lines, state.br, state.endsWithBreak));
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
  lines.forEach((l, idx) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${idx + 1}`);
    edits.push(e);
  });
  return edits;
}

// --- Section 1, 2, 10: CLI dispatch & atomic commit ---

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
    if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else if (kind === 'v4a') edits = v4aEdits(lines, strict);
    else edits = jsonEdits(text, lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }

  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const beforeNow = new Map(tree.now);
    const beforeMoves = tree.moves.slice();
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of beforeNow) tree.now.set(k, v);
      tree.moves.length = 0;
      for (const mv of beforeMoves) tree.moves.push(mv);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }

  const pairedOld = new Set<string>();
  const pairedNew = new Set<string>();
  const entries: Array<{ sortKey: string; line: string }> = [];
  for (const mv of tree.moves) {
    if (
      !pairedOld.has(mv.oldPath) &&
      !pairedNew.has(mv.newPath) &&
      tree.original(mv.oldPath) !== null &&
      tree.get(mv.oldPath) === null &&
      tree.original(mv.newPath) === null &&
      tree.get(mv.newPath) !== null
    ) {
      pairedOld.add(mv.oldPath);
      pairedNew.add(mv.newPath);
      entries.push({ sortKey: mv.newPath, line: `R ${mv.oldPath} -> ${mv.newPath}` });
    }
  }

  const toDelete: string[] = [];
  const toWrite: Array<{ p: string; content: string }> = [];
  for (const [p, now] of tree.now) {
    const was = tree.original(p);
    if (was === now) continue;
    if (now === null) {
      toDelete.push(p);
      if (!pairedOld.has(p)) entries.push({ sortKey: p, line: `D ${p}` });
    } else {
      toWrite.push({ p, content: now });
      if (was === null) {
        if (!pairedNew.has(p)) entries.push({ sortKey: p, line: `A ${p}` });
      } else {
        entries.push({ sortKey: p, line: `M ${p}` });
      }
    }
  }

  if (!check) {
    for (const p of toDelete) {
      rmSync(p, { force: true });
      let dir = dirname(p);
      while (dir !== '.' && dir !== '' && dir !== '/') {
        try {
          rmdirSync(dir);
        } catch {
          break;
        }
        dir = dirname(dir);
      }
    }
    for (const { p, content } of toWrite) {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content);
    }
  }

  entries.sort((a, b) => Buffer.compare(Buffer.from(a.sortKey, 'utf8'), Buffer.from(b.sortKey, 'utf8')));
  const rows = entries.map((e) => e.line);
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

function writeAllStdout(text: string): void {
  const buf = Buffer.from(text, 'utf8');
  let off = 0;
  while (off < buf.length) {
    off += writeSync(1, buf, off, buf.length - off);
  }
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeAllStdout(r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
