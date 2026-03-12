# LEAN Format Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the LEAN encoder/decoder and integrate it into the benchmark and MCP server stats tool.

**Architecture:** `lean.ts` contains the encoder and decoder following the same export pattern as `toon.ts` (types, encode, decode, estimateTokens reused from toon.ts). `lean-test.mjs` validates round-trip correctness. Integration touches `benchmark.mjs` (add LEAN as 5th format) and `index.ts` (add to toon_stats comparison).

**Tech Stack:** TypeScript, Node.js ESM

**Spec:** `docs/superpowers/specs/2026-03-12-lean-format-design.md`

---

## File Structure

```
lean.ts              — LEAN encoder/decoder (new)
lean-test.mjs        — LEAN round-trip tests (new)
benchmark.mjs        — add LEAN as 5th format (modify)
index.ts             — add LEAN to toon_stats (modify)
tsconfig.json        — no changes needed (lean.ts auto-included)
```

---

## Chunk 1: LEAN Encoder

### Task 1: Create lean.ts with types and primitive encoding

**Files:**
- Create: `lean.ts`

- [ ] **Step 1: Create lean.ts with types, key validation, and primitive encoding**

```ts
// LEAN encoder/decoder
// LLM-Efficient Adaptive Notation
// Keys must match [\w][\w-]* — no dots, spaces, slashes, colons

export type LeanValue =
  | string
  | number
  | boolean
  | null
  | LeanValue[]
  | { [key: string]: LeanValue };

const KEY_REGEX = /^[\w][\w-]*$/;

function validateKey(key: string): void {
  if (!KEY_REGEX.test(key)) {
    throw new Error(
      `Unsupported key "${key}". Keys must match /^[\\w][\\w-]*$/ (word chars and hyphens). ` +
      `No dots (reserved for path flattening), spaces, slashes, or colons.`
    );
  }
}

function isScalar(value: LeanValue): value is string | number | boolean | null {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function isTabularArray(arr: LeanValue[]): boolean {
  if (arr.length === 0) return false;
  if (arr.some(item => typeof item !== "object" || item === null || Array.isArray(item))) return false;
  const firstKeys = Object.keys(arr[0] as Record<string, LeanValue>).sort();
  return arr.every(item => {
    const obj = item as Record<string, LeanValue>;
    const keys = Object.keys(obj).sort();
    return (
      keys.length === firstKeys.length &&
      keys.every((key, i) => key === firstKeys[i]) &&
      keys.every(key => isScalar(obj[key]))
    );
  });
}

// --- Scalar encoding ---

function scalarNeedsQuoting(value: string): boolean {
  if (value === "") return true;
  if (value === "T" || value === "F" || value === "_") return true;
  if (value.trim() !== value) return true;
  if (!isNaN(Number(value)) && value !== "") return true;
  if (value.includes("\t") || value.includes("\n") || value.includes("\\") || value.includes('"')) return true;
  return false;
}

function escapeScalar(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/"/g, '\\"');
}

function encodeScalar(value: string, forceQuote: boolean): string {
  if (forceQuote || scalarNeedsQuoting(value)) {
    return `"${escapeScalar(value)}"`;
  }
  return value;
}

function encodePrimitive(value: LeanValue): string {
  if (value === null) return "_";
  if (value === true) return "T";
  if (value === false) return "F";
  if (typeof value === "number") {
    if (!isFinite(value)) throw new Error(`Unsupported number: ${value}. NaN and Infinity not representable.`);
    return String(value);
  }
  if (typeof value === "string") return encodeScalar(value, false);
  throw new Error("Not a primitive");
}

// --- Cell encoding (tabular context) ---

function cellNeedsQuoting(value: string): boolean {
  if (value === "") return true;
  if (value === "T" || value === "F" || value === "_") return true;
  if (value.trim() !== value) return true;
  if (!isNaN(Number(value)) && value !== "") return true;
  if (value.includes("\t") || value.includes("\n") || value.includes("\\") || value.includes('"')) return true;
  return false;
}

function escapeCell(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/"/g, '""');
}

function cellEncode(value: LeanValue): string {
  if (value === null) return "_";
  if (value === true) return "T";
  if (value === false) return "F";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    if (cellNeedsQuoting(value)) return `"${escapeCell(value)}"`;
    return value;
  }
  throw new Error("Not a scalar cell value");
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd /Users/denysfiialko/Downloads/files && npx tsc --noEmit lean.ts
```
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add lean.ts
git commit -m "feat(lean): types, key validation, primitive and cell encoding"
```

### Task 2: Add the main encode function with dot-flattening and tabular encoding

**Files:**
- Modify: `lean.ts`

- [ ] **Step 1: Add the encode function and helpers**

Append to `lean.ts`:

```ts
// --- Encoder ---

export function encode(data: LeanValue): string {
  if (data === null || data === undefined) return "_";
  if (typeof data === "boolean") return data ? "T" : "F";
  if (typeof data === "number") {
    if (!isFinite(data)) throw new Error(`Unsupported number: ${data}.`);
    return String(data);
  }
  if (typeof data === "string") return encodeScalar(data, true); // root strings always quoted

  if (Array.isArray(data)) {
    return encodeRootArray(data);
  }

  const entries = Object.entries(data as Record<string, LeanValue>);
  if (entries.length === 0) return "{}";

  const lines: string[] = [];
  for (const [key, value] of entries) {
    validateKey(key);
    encodeProperty(key, value, lines, 0);
  }
  return lines.join("\n");
}

function encodeRootArray(arr: LeanValue[]): string {
  const lines: string[] = [];
  encodeArrayValue("", arr, lines, 0);
  return lines.join("\n");
}

function encodeProperty(path: string, value: LeanValue, lines: string[], indent: number): void {
  // Scalar → dot-flatten
  if (isScalar(value)) {
    const pad = "  ".repeat(indent);
    const encoded = value === null ? "_"
      : typeof value === "boolean" ? (value ? "T" : "F")
      : typeof value === "number" ? (isFinite(value) ? String(value) : (() => { throw new Error(`Unsupported: ${value}`); })())
      : encodeScalar(value, false);
    lines.push(`${pad}${path}:${encoded}`);
    return;
  }

  // Array
  if (Array.isArray(value)) {
    encodeArrayValue(path, value, lines, indent);
    return;
  }

  // Object — try dot-flattening, fall back to indented block
  const obj = value as Record<string, LeanValue>;
  const entries = Object.entries(obj);

  if (entries.length === 0) {
    const pad = "  ".repeat(indent);
    lines.push(`${pad}${path}:{}`);
    return;
  }

  // Check if all values can be dot-flattened (scalar or further nesting)
  // Always dot-flatten when at indent 0, use indented blocks otherwise
  if (indent === 0) {
    for (const [key, val] of entries) {
      validateKey(key);
      encodeProperty(`${path}.${key}`, val, lines, 0);
    }
  } else {
    const pad = "  ".repeat(indent);
    lines.push(`${pad}${path}:`);
    for (const [key, val] of entries) {
      validateKey(key);
      encodeProperty(key, val, lines, indent + 1);
    }
  }
}

function encodeArrayValue(path: string, arr: LeanValue[], lines: string[], indent: number): void {
  const pad = "  ".repeat(indent);
  const prefix = path ? `${path}` : "";

  if (arr.length === 0) {
    lines.push(`${pad}${prefix}[0]:`);
    return;
  }

  // Flat scalar array
  const allScalar = arr.every(v => isScalar(v));
  if (allScalar) {
    const cells = arr.map(v => cellEncode(v)).join("\t");
    lines.push(`${pad}${prefix}[${arr.length}]:${cells}`);
    return;
  }

  // Tabular array
  if (isTabularArray(arr)) {
    const fields = Object.keys(arr[0] as Record<string, LeanValue>);
    fields.forEach(validateKey);
    lines.push(`${pad}${prefix}[${arr.length}]:${fields.join("\t")}`);
    for (const row of arr) {
      const obj = row as Record<string, LeanValue>;
      const cells = fields.map(f => cellEncode(obj[f]));
      lines.push(`${pad}  ${cells.join("\t")}`);
    }
    return;
  }

  // Non-uniform / mixed array
  lines.push(`${pad}${prefix}[${arr.length}]:`);
  for (const item of arr) {
    encodeListItem(item, lines, indent + 1);
  }
}

function encodeListItem(item: LeanValue, lines: string[], indent: number): void {
  const pad = "  ".repeat(indent);

  // Scalar
  if (isScalar(item)) {
    if (typeof item === "string") {
      lines.push(`${pad}- ${encodeScalar(item, false)}`);
    } else {
      lines.push(`${pad}- ${encodePrimitive(item)}`);
    }
    return;
  }

  // Sub-array
  if (Array.isArray(item)) {
    const subLines: string[] = [];
    encodeArrayValue("", item, subLines, 0);
    lines.push(`${pad}- ${subLines[0]}`);
    for (let i = 1; i < subLines.length; i++) {
      lines.push(`${pad}  ${subLines[i]}`);
    }
    return;
  }

  // Object
  const obj = item as Record<string, LeanValue>;
  const entries = Object.entries(obj);

  if (entries.length === 0) {
    lines.push(`${pad}- {}`);
    return;
  }

  const [firstKey, firstVal] = entries[0];
  validateKey(firstKey);

  if (isScalar(firstVal)) {
    const sv = firstVal === null ? "_"
      : typeof firstVal === "boolean" ? (firstVal ? "T" : "F")
      : typeof firstVal === "number" ? String(firstVal)
      : encodeScalar(firstVal, false);
    lines.push(`${pad}- ${firstKey}:${sv}`);
  } else if (Array.isArray(firstVal)) {
    const subLines: string[] = [];
    encodeArrayValue(firstKey, firstVal, subLines, 0);
    lines.push(`${pad}- ${subLines[0]}`);
    for (let i = 1; i < subLines.length; i++) {
      lines.push(`${pad}  ${subLines[i]}`);
    }
  } else {
    // Non-scalar object value as first key
    const subObj = firstVal as Record<string, LeanValue>;
    if (Object.keys(subObj).length === 0) {
      lines.push(`${pad}- ${firstKey}:{}`);
    } else {
      lines.push(`${pad}- ${firstKey}:`);
      for (const [k, v] of Object.entries(subObj)) {
        validateKey(k);
        encodeProperty(k, v, lines, indent + 2);
      }
    }
  }

  // Remaining keys
  for (let i = 1; i < entries.length; i++) {
    const [key, val] = entries[i];
    validateKey(key);
    encodeProperty(key, val, lines, indent + 1);
  }
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd /Users/denysfiialko/Downloads/files && npx tsc --noEmit lean.ts
```

- [ ] **Step 3: Commit**

```bash
git add lean.ts
git commit -m "feat(lean): encode function with dot-flattening, tabular, and mixed arrays"
```

---

## Chunk 2: LEAN Decoder

### Task 3: Add the decoder to lean.ts

**Files:**
- Modify: `lean.ts`

- [ ] **Step 1: Add decoder helper functions**

Append to `lean.ts`:

```ts
// --- Decoder ---

export class LeanParseError extends Error {
  public readonly line: number;
  public readonly content: string;
  constructor(lineIndex: number, content: string, message: string) {
    super(`Line ${lineIndex + 1}: ${message} → "${content}"`);
    this.name = "LeanParseError";
    this.line = lineIndex + 1;
    this.content = content;
  }
}

function unescapeScalar(s: string): string {
  let result = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && i + 1 < s.length) {
      const next = s[i + 1];
      if (next === "n") { result += "\n"; i++; }
      else if (next === "\\") { result += "\\"; i++; }
      else if (next === '"') { result += '"'; i++; }
      else { result += "\\"; }
    } else {
      result += s[i];
    }
  }
  return result;
}

function unescapeCell(s: string): string {
  let result = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '"' && s[i + 1] === '"') { result += '"'; i++; continue; }
    if (s[i] === "\\" && i + 1 < s.length) {
      if (s[i + 1] === "n") { result += "\n"; i++; continue; }
      if (s[i + 1] === "\\") { result += "\\"; i++; continue; }
    }
    result += s[i];
  }
  return result;
}

function parseScalarValue(s: string): LeanValue {
  s = s.trim();
  if (s === "T") return true;
  if (s === "F") return false;
  if (s === "_") return null;
  if (s === "") return "";
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    return unescapeScalar(s.slice(1, -1));
  }
  const n = Number(s);
  if (Number.isFinite(n) && s !== "") return n;
  return s; // bare string
}

function parseCellValue(s: string): LeanValue {
  s = s.trim();
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    return unescapeCell(s.slice(1, -1));
  }
  if (s === "T") return true;
  if (s === "F") return false;
  if (s === "_") return null;
  if (s === "") return "";
  const n = Number(s);
  if (Number.isFinite(n)) return n;
  return s;
}

function parseTabRow(line: string): LeanValue[] {
  // Split by tab, respecting quoted fields
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;
  let pos = 0;
  while (pos < line.length) {
    const ch = line[pos];
    if (inQuotes) {
      if (ch === '"') {
        if (pos + 1 < line.length && line[pos + 1] === '"') {
          current += '""';
          pos += 2;
        } else {
          inQuotes = false;
          current += '"';
          pos++;
        }
      } else {
        current += ch;
        pos++;
      }
    } else {
      if (ch === '"') { inQuotes = true; current += '"'; pos++; }
      else if (ch === "\t") { cells.push(current); current = ""; pos++; }
      else { current += ch; pos++; }
    }
  }
  cells.push(current);
  if (inQuotes) throw new Error(`Unterminated quote in row: "${line}"`);
  return cells.map(parseCellValue);
}

function getIndent(line: string): number {
  const m = line.match(/^(\s*)/);
  return m ? m[1].length : 0;
}

interface ParseState {
  i: number;
  lines: string[];
}

function setKeyOrThrow(
  target: Record<string, LeanValue>, key: string, value: LeanValue,
  lineIndex: number, content: string
): void {
  if (Object.prototype.hasOwnProperty.call(target, key)) {
    throw new LeanParseError(lineIndex, content, `Duplicate key "${key}"`);
  }
  target[key] = value;
}

function setNestedValue(
  target: Record<string, LeanValue>, path: string, value: LeanValue,
  lineIndex: number, content: string
): void {
  const parts = path.split(".");
  let current = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!Object.prototype.hasOwnProperty.call(current, part)) {
      current[part] = {};
    }
    const next = current[part];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      throw new LeanParseError(lineIndex, content, `Cannot nest into non-object at "${part}"`);
    }
    current = next as Record<string, LeanValue>;
  }
  const lastKey = parts[parts.length - 1];
  setKeyOrThrow(current, lastKey, value, lineIndex, content);
}
```

- [ ] **Step 2: Add the main decode function**

Append to `lean.ts`:

```ts
// Regex patterns
const kvRegex = /^([\w][\w.-]*):(.*)/; // key:value — dots allowed in KEY for dot-flattened paths
const emptyObjRegex = /^([\w][\w.-]*):\{\}\s*$/;
const blockRegex = /^([\w][\w.-]*):\s*$/;
const tabularRegex = /^([\w][\w.-]*)\[(\d+)\]:([\w][\w-]*(?:\t[\w][\w-]*)*)\s*$/;
const flatArrayRegex = /^([\w][\w.-]*)\[(\d+)\]:(.+)$/;
const emptyArrayRegex = /^([\w][\w.-]*)\[0\]:\s*$/;
const nonUniformRegex = /^([\w][\w.-]*)\[([1-9]\d*)\]:\s*$/;

// Root array patterns (no key prefix)
const rootTabularRegex = /^\[(\d+)\]:([\w][\w-]*(?:\t[\w][\w-]*)*)\s*$/;
const rootFlatRegex = /^\[(\d+)\]:(.+)$/;
const rootEmptyRegex = /^\[0\]:\s*$/;
const rootNonUniformRegex = /^\[([1-9]\d*)\]:\s*$/;

// List item patterns
const listItemScalarRegex = /^-\s+(.+)$/;
const listItemEmptyObjRegex = /^-\s+\{\}\s*$/;
const listItemKvRegex = /^-\s+([\w][\w-]*):(.*)/;
const listItemBlockRegex = /^-\s+([\w][\w-]*):\s*$/;
const listItemArrayRegex = /^-\s+([\w][\w-]*)\[(\d+)\]:(.*)/;
const listItemEmptyArrayRegex = /^-\s+([\w][\w-]*)\[0\]:\s*$/;
const listItemNonUniformRegex = /^-\s+([\w][\w-]*)\[([1-9]\d*)\]:\s*$/;
const listItemTabularRegex = /^-\s+([\w][\w-]*)\[(\d+)\]:([\w][\w-]*(?:\t[\w][\w-]*)*)\s*$/;
const listItemRootArrayRegex = /^-\s+\[(\d+)\]:(.*)/;
const listItemRootEmptyRegex = /^-\s+\[0\]:\s*$/;
const listItemRootNonUniformRegex = /^-\s+\[([1-9]\d*)\]:\s*$/;
const listItemRootTabularRegex = /^-\s+\[(\d+)\]:([\w][\w-]*(?:\t[\w][\w-]*)*)\s*$/;
const listItemEmptyObjKeyRegex = /^-\s+([\w][\w-]*):\{\}\s*$/;

export function decode(lean: string): LeanValue {
  const lines = lean.split("\n");
  let firstIdx = 0;
  while (firstIdx < lines.length && lines[firstIdx].trim() === "") firstIdx++;
  if (firstIdx >= lines.length) {
    throw new LeanParseError(0, "", "Empty LEAN document");
  }

  const first = lines[firstIdx].trim();
  const state: ParseState = { i: firstIdx, lines };

  // Root empty object
  if (first === "{}") {
    state.i++;
    skipTrailing(state);
    return {};
  }

  // Root scalar
  if (first === "T") { state.i++; skipTrailing(state); return true; }
  if (first === "F") { state.i++; skipTrailing(state); return false; }
  if (first === "_") { state.i++; skipTrailing(state); return null; }

  // Root quoted string
  if (first.startsWith('"') && first.endsWith('"') && first.length >= 2) {
    state.i++;
    skipTrailing(state);
    return unescapeScalar(first.slice(1, -1));
  }

  // Root number
  const num = Number(first);
  if (Number.isFinite(num) && first !== "" && !first.includes(":") && !first.includes("[")) {
    state.i++;
    skipTrailing(state);
    return num;
  }

  // Root array
  if (first.startsWith("[")) {
    const result = parseRootArray(state);
    skipTrailing(state);
    return result;
  }

  // Root object (key:value or key[N]:... lines)
  const result: Record<string, LeanValue> = {};
  parseBlock(state, 0, result);
  skipTrailing(state);
  return result;
}

function skipTrailing(state: ParseState): void {
  while (state.i < state.lines.length) {
    if (state.lines[state.i].trim() !== "") {
      throw new LeanParseError(state.i, state.lines[state.i].trim(), "Unexpected trailing content");
    }
    state.i++;
  }
}

function parseRootArray(state: ParseState): LeanValue[] {
  const line = state.lines[state.i].trim();

  if (rootEmptyRegex.test(line)) { state.i++; return []; }

  const tabM = line.match(rootTabularRegex);
  if (tabM) {
    const count = parseInt(tabM[1], 10);
    const fields = tabM[2].split("\t");

    // Peek: tabular arrays have indented data rows; flat arrays do not
    let peekIdx = state.i + 1;
    while (peekIdx < state.lines.length && state.lines[peekIdx].trim() === "") peekIdx++;
    const nextIsDataRow = count > 0 && peekIdx < state.lines.length && getIndent(state.lines[peekIdx]) >= 2;

    if (nextIsDataRow) {
      state.i++;
      return parseTabularRows(state, count, fields, 2, line);
    }
    // Fall through to flat array parsing below
  }

  const nuM = line.match(rootNonUniformRegex);
  if (nuM) {
    const count = parseInt(nuM[1], 10);
    state.i++;
    return parseListItems(state, 0, count);
  }

  const flatM = line.match(rootFlatRegex);
  if (flatM) {
    const count = parseInt(flatM[1], 10);
    const values = parseTabRow(flatM[2]);
    if (values.length !== count) {
      throw new LeanParseError(state.i, line, `Array count mismatch (declared ${count}, got ${values.length})`);
    }
    state.i++;
    return values;
  }

  throw new LeanParseError(state.i, line, "Unrecognized root array syntax");
}

function parseTabularRows(
  state: ParseState, count: number, fields: string[],
  minIndent: number, headerContent: string
): LeanValue[] {
  // Check for duplicate fields
  const seen = new Set<string>();
  for (const f of fields) {
    if (seen.has(f)) throw new LeanParseError(state.i - 1, headerContent, `Duplicate field "${f}"`);
    seen.add(f);
  }

  const rows: LeanValue[] = [];
  while (rows.length < count && state.i < state.lines.length) {
    const rowLine = state.lines[state.i];
    if (rowLine.trim() === "") { state.i++; continue; }
    if (getIndent(rowLine) < minIndent) break;
    const values = parseTabRow(rowLine.trim());
    if (values.length !== fields.length) {
      throw new LeanParseError(state.i, rowLine.trim(), `Row field count mismatch (expected ${fields.length}, got ${values.length})`);
    }
    const obj: Record<string, LeanValue> = {};
    fields.forEach((f, idx) => { obj[f] = values[idx]; });
    rows.push(obj);
    state.i++;
  }

  if (rows.length !== count) {
    throw new LeanParseError(state.i - 1, headerContent, `Row count mismatch (declared ${count}, got ${rows.length})`);
  }
  return rows;
}

function parseListItems(state: ParseState, baseIndent: number, count: number): LeanValue[] {
  const arr: LeanValue[] = [];
  const itemIndent = baseIndent + 2;

  while (arr.length < count && state.i < state.lines.length) {
    const line = state.lines[state.i];
    if (line.trim() === "") { state.i++; continue; }
    const ind = getIndent(line);
    if (ind < itemIndent) break;
    const content = line.slice(ind);

    // Empty object item
    if (listItemEmptyObjRegex.test(content)) { arr.push({}); state.i++; continue; }

    // Sub-array items (- [N]:...)
    if (content.match(listItemRootEmptyRegex)) { arr.push([]); state.i++; continue; }

    const liRootTabM = content.match(listItemRootTabularRegex);
    if (liRootTabM) {
      const cnt = parseInt(liRootTabM[1], 10);
      const fields = liRootTabM[2].split("\t");
      // Peek-ahead: tabular has indented data rows, flat does not
      let peekIdx = state.i + 1;
      while (peekIdx < state.lines.length && state.lines[peekIdx].trim() === "") peekIdx++;
      const nextIsData = cnt > 0 && peekIdx < state.lines.length && getIndent(state.lines[peekIdx]) >= ind + 2;
      if (nextIsData) {
        state.i++;
        arr.push(parseTabularRows(state, cnt, fields, ind + 2, content));
        continue;
      }
      // Fall through to flat array below
    }

    const liRootNuM = content.match(listItemRootNonUniformRegex);
    if (liRootNuM) {
      const cnt = parseInt(liRootNuM[1], 10);
      state.i++;
      arr.push(parseListItems(state, ind, cnt));
      continue;
    }

    const liRootArrM = content.match(listItemRootArrayRegex);
    if (liRootArrM) {
      const cnt = parseInt(liRootArrM[1], 10);
      const values = parseTabRow(liRootArrM[2]);
      if (values.length !== cnt) {
        throw new LeanParseError(state.i, content, `Array count mismatch`);
      }
      arr.push(values);
      state.i++;
      continue;
    }

    // Object items (- key:value)
    if (
      content.match(listItemEmptyObjKeyRegex) ||
      content.match(listItemTabularRegex) ||
      content.match(listItemEmptyArrayRegex) ||
      content.match(listItemNonUniformRegex) ||
      content.match(listItemKvRegex) ||
      content.match(listItemBlockRegex)
    ) {
      arr.push(parseListItemObject(state, ind, itemIndent));
      continue;
    }

    // Scalar item
    const scalarM = content.match(listItemScalarRegex);
    if (scalarM) {
      arr.push(parseScalarValue(scalarM[1]));
      state.i++;
      continue;
    }

    throw new LeanParseError(state.i, content, "Unrecognized list item");
  }

  if (arr.length !== count) {
    throw new LeanParseError(state.i - 1, "", `List count mismatch (declared ${count}, got ${arr.length})`);
  }
  return arr;
}

function parseListItemObject(
  state: ParseState, lineInd: number, parentItemIndent: number
): Record<string, LeanValue> {
  const obj: Record<string, LeanValue> = {};
  const content = state.lines[state.i].slice(lineInd);
  const firstLineIdx = state.i;

  // - key:{}
  const emptyObjKeyM = content.match(listItemEmptyObjKeyRegex);
  if (emptyObjKeyM) { setKeyOrThrow(obj, emptyObjKeyM[1], {}, firstLineIdx, content); state.i++; }
  // - key[N]:fields (tabular) — peek-ahead to disambiguate from flat arrays
  else {
    const tabM = content.match(listItemTabularRegex);
    let isTabularItem = false;
    if (tabM) {
      const count = parseInt(tabM[2], 10);
      let peekIdx = state.i + 1;
      while (peekIdx < state.lines.length && state.lines[peekIdx].trim() === "") peekIdx++;
      isTabularItem = count > 0 && peekIdx < state.lines.length && getIndent(state.lines[peekIdx]) >= lineInd + 2;
    }
    if (tabM && isTabularItem) {
      const [, key, countStr, fieldsStr] = tabM;
      const fields = fieldsStr.split("\t");
      state.i++;
      setKeyOrThrow(obj, key, parseTabularRows(state, parseInt(countStr, 10), fields, lineInd + 2, content), firstLineIdx, content);
    }
    // - key[0]:
    else {
      const emptyArrM = content.match(listItemEmptyArrayRegex);
      if (emptyArrM) { setKeyOrThrow(obj, emptyArrM[1], [], firstLineIdx, content); state.i++; }
      // - key[N]:
      else {
        const nuM = content.match(listItemNonUniformRegex);
        if (nuM) {
          state.i++;
          setKeyOrThrow(obj, nuM[1], parseListItems(state, lineInd, parseInt(nuM[2], 10)), firstLineIdx, content);
        }
        // - key:value or - key: (block)
        else {
          const blockM = content.match(listItemBlockRegex);
          if (blockM) {
            const nested: Record<string, LeanValue> = {};
            state.i++;
            parseBlock(state, lineInd + 4, nested);
            setKeyOrThrow(obj, blockM[1], nested, firstLineIdx, content);
          } else {
            const kvM = content.match(listItemKvRegex);
            if (kvM) {
              setKeyOrThrow(obj, kvM[1], parseScalarValue(kvM[2]), firstLineIdx, content);
              state.i++;
            } else {
              throw new LeanParseError(state.i, content, "Invalid list item object");
            }
          }
        }
      }
    }
  }

  // Remaining keys
  const bodyIndent = lineInd + 2;
  while (state.i < state.lines.length) {
    const line = state.lines[state.i];
    if (line.trim() === "") { state.i++; continue; }
    const ind = getIndent(line);
    if (ind < bodyIndent) break;
    const lc = line.slice(ind);
    if (ind === parentItemIndent && lc.startsWith("- ")) break;
    parseLine(state, ind, obj, lc);
  }

  return obj;
}

function parseLine(
  state: ParseState, ind: number, target: Record<string, LeanValue>, content: string
): void {
  const lineIdx = state.i;

  // key:{}
  const emptyObjM = content.match(emptyObjRegex);
  if (emptyObjM) {
    setNestedValue(target, emptyObjM[1], {}, lineIdx, content);
    state.i++;
    return;
  }

  // key[N]:fields (tabular) — disambiguate from flat arrays by peeking ahead
  const tabM = content.match(tabularRegex);
  if (tabM) {
    const [, path, countStr, fieldsStr] = tabM;
    const count = parseInt(countStr, 10);
    const fields = fieldsStr.split("\t");

    // Peek: tabular arrays have indented data rows; flat arrays do not
    let peekIdx = state.i + 1;
    while (peekIdx < state.lines.length && state.lines[peekIdx].trim() === "") peekIdx++;
    const nextIsDataRow = count > 0 && peekIdx < state.lines.length && getIndent(state.lines[peekIdx]) >= ind + 2;

    if (nextIsDataRow) {
      state.i++;
      setNestedValue(target, path, parseTabularRows(state, count, fields, ind + 2, content), lineIdx, content);
      return;
    }
    // Fall through to flat array parsing below
  }

  // key[0]:
  const emptyArrM = content.match(emptyArrayRegex);
  if (emptyArrM) {
    setNestedValue(target, emptyArrM[1], [], lineIdx, content);
    state.i++;
    return;
  }

  // key[N]: (non-uniform)
  const nuM = content.match(nonUniformRegex);
  if (nuM) {
    state.i++;
    setNestedValue(target, nuM[1], parseListItems(state, ind, parseInt(nuM[2], 10)), lineIdx, content);
    return;
  }

  // key[N]:values (flat)
  const flatM = content.match(flatArrayRegex);
  if (flatM) {
    const count = parseInt(flatM[2], 10);
    const values = parseTabRow(flatM[3]);
    if (values.length !== count) {
      throw new LeanParseError(lineIdx, content, `Array count mismatch (declared ${count}, got ${values.length})`);
    }
    setNestedValue(target, flatM[1], values, lineIdx, content);
    state.i++;
    return;
  }

  // key: (block header)
  const blockM = content.match(blockRegex);
  if (blockM) {
    const nested: Record<string, LeanValue> = {};
    state.i++;
    parseBlock(state, ind + 2, nested);
    setNestedValue(target, blockM[1], nested, lineIdx, content);
    return;
  }

  // key:value
  const kvM = content.match(kvRegex);
  if (kvM) {
    setNestedValue(target, kvM[1], parseScalarValue(kvM[2]), lineIdx, content);
    state.i++;
    return;
  }

  throw new LeanParseError(state.i, content, "Unrecognized LEAN syntax");
}

function parseBlock(
  state: ParseState, baseIndent: number, target: Record<string, LeanValue>
): void {
  while (state.i < state.lines.length) {
    const line = state.lines[state.i];
    if (line.trim() === "") { state.i++; continue; }
    const ind = getIndent(line);
    if (ind < baseIndent) break;
    const content = line.slice(ind);
    parseLine(state, ind, target, content);
  }
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd /Users/denysfiialko/Downloads/files && npx tsc --noEmit lean.ts
```

- [ ] **Step 3: Commit**

```bash
git add lean.ts
git commit -m "feat(lean): decoder with dot-flattening, tabular, mixed array support"
```

---

## Chunk 3: Tests

### Task 4: Write comprehensive round-trip tests

**Files:**
- Create: `lean-test.mjs`

- [ ] **Step 1: Create lean-test.mjs with round-trip tests**

Follow the same pattern as `test.mjs`. Test all data shapes from the spec:

```js
import { encode, decode, LeanParseError } from './dist/lean.js';

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}
function assertEqual(a, b, l = '') {
  const as = JSON.stringify(a), bs = JSON.stringify(b);
  if (as !== bs) throw new Error(`${l}\n       expected: ${bs}\n       actual:   ${as}`);
}
function assertRoundTrip(data) {
  const enc = encode(data);
  const dec = decode(enc);
  assertEqual(dec, data, `round-trip\n       encoded:\n${enc.split('\n').map(l => '         ' + l).join('\n')}`);
}
function assertThrows(fn, check) {
  let threw = false;
  try { fn(); } catch (e) { threw = true; if (check && !check(e)) throw new Error(`Wrong error: ${e.message}`); }
  if (!threw) throw new Error('Expected to throw');
}

console.log('\n-- primitives --');
test('T/F/_ keywords', () => {
  assertRoundTrip(true);
  assertRoundTrip(false);
  assertRoundTrip(null);
});
test('numbers', () => {
  assertRoundTrip(0);
  assertRoundTrip(-3.14);
  assertRoundTrip(1e10);
});
test('root strings (always quoted)', () => {
  assertRoundTrip("hello");
  assertRoundTrip("");
  assertRoundTrip("42");
  assertRoundTrip("T");
  assertRoundTrip("F");
  assertRoundTrip("_");
  assertRoundTrip("hello world");
  assertRoundTrip("line1\nline2");
});

console.log('\n-- root empty object --');
test('root {} round-trips', () => assertRoundTrip({}));
test('encode({}) === "{}"', () => assertEqual(encode({}), "{}"));

console.log('\n-- root object --');
test('simple kv', () => assertRoundTrip({ a: 1, b: "hello", c: true }));
test('nested', () => assertRoundTrip({ config: { db: { host: "localhost", port: 5432 }, debug: false } }));
test('with tabular', () => assertRoundTrip({ users: [{ id: 1, name: "Alice" }, { id: 2, name: "Bob" }] }));
test('with empty array', () => assertRoundTrip({ items: [] }));
test('nested empty object', () => assertRoundTrip({ meta: {} }));

console.log('\n-- dot-flattening --');
test('scalars flatten', () => {
  const data = { config: { database: { host: "localhost", port: 5432 }, cache: { ttl: 300 } } };
  const enc = encode(data);
  if (!enc.includes('config.database.host:')) throw new Error('Expected dot-flattened key');
  assertRoundTrip(data);
});

console.log('\n-- tabular arrays --');
test('basic tabular', () => assertRoundTrip({ users: [{ id: 1, name: "Alice" }, { id: 2, name: "Bob" }] }));
test('T/F/_ in cells', () => assertRoundTrip({ rows: [{ ok: true, v: null }, { ok: false, v: null }] }));
test('quoted cells', () => assertRoundTrip({ rows: [{ code: "0012", ok: true }, { code: "0034", ok: false }] }));
test('cell with tab', () => assertRoundTrip({ rows: [{ msg: "a\tb", id: 1 }, { msg: "c", id: 2 }] }));
test('cell with newline', () => assertRoundTrip({ rows: [{ msg: "hi\nthere", id: 1 }, { msg: "ok", id: 2 }] }));
test('cell with double-quote', () => assertRoundTrip({ rows: [{ msg: 'she said "hi"', id: 1 }, { msg: "ok", id: 2 }] }));

console.log('\n-- flat scalar arrays --');
test('[1,2,3]', () => assertRoundTrip([1, 2, 3]));
test('["a","b"]', () => assertRoundTrip({ x: ["a", "b"] }));
test('with nulls', () => assertRoundTrip({ x: [1, null, 3] }));
test('keyword-looking strings', () => assertRoundTrip({ x: ["T", "F", "_", "42"] }));
test('empty strings', () => assertRoundTrip({ x: ["", "a", ""] }));

console.log('\n-- root arrays --');
test('flat scalar', () => assertRoundTrip([1, 2, 3]));
test('tabular', () => assertRoundTrip([{ id: 1, name: "Alice" }, { id: 2, name: "Bob" }]));
test('empty', () => assertRoundTrip([]));
test('non-uniform', () => assertRoundTrip([{ type: "a", val: 1 }, { type: "b", val: 2, extra: true }]));

console.log('\n-- non-uniform arrays --');
test('different keys', () => assertRoundTrip({ t: [{ k: "a", v: 1 }, { k: "b", v: 2, x: true }] }));
test('mixed types', () => assertRoundTrip({ m: [1, "hello", { key: "val" }] }));
test('mixed with sub-array', () => assertRoundTrip({ m: [42, "hi", { a: 1 }, ["x", "y"]] }));
test('non-scalar first value', () => assertRoundTrip({
  items: [{ config: { host: "localhost", port: 8080 } }, { config: { host: "remote", port: 9090 } }]
}));

console.log('\n-- deep nesting --');
test('nested array value', () => assertRoundTrip({ g: [{ n: "A", m: [{ id: 1 }, { id: 2 }] }] }));
test('deeply nested', () => assertRoundTrip({
  teams: [{ name: "A", projects: [{ title: "P1", tasks: [{ done: true }] }] }]
}));

console.log('\n-- empty containers --');
test('nested empty containers', () => assertRoundTrip({ empty: {}, arr: [[], {}, [""]] }));

console.log('\n-- string edge cases --');
test('backslash', () => assertRoundTrip({ path: "C:\\Users\\test" }));
test('quotes in string', () => assertRoundTrip({ x: 'she said "hi"' }));
test('double backslash', () => assertRoundTrip({ p: "\\\\" }));
test('backslash-n vs newline', () => {
  const data = { a: "real\nnewline", b: "literal\\nnot" };
  assertRoundTrip(data);
});

console.log('\n-- key validation --');
test('key with dot throws', () => assertThrows(() => encode({ "a.b": 1 })));
test('key with space throws', () => assertThrows(() => encode({ "first name": 1 })));
test('key with colon throws', () => assertThrows(() => encode({ "a:b": 1 })));
test('valid keys', () => assertRoundTrip({ foo: 1, bar_baz: 2, x1: 3, "c-d": 4 }));

console.log('\n-- empty string vs block header --');
test('empty string value round-trips', () => assertRoundTrip({ name: "" }));
test('empty string encoded as key:""', () => {
  const enc = encode({ name: "" });
  if (!enc.includes('name:""')) throw new Error('Expected name:""');
});

console.log('\n-- "true"/"false"/"null" are not reserved --');
test('bare "true" string', () => assertRoundTrip({ x: "true" }));
test('bare "false" string', () => assertRoundTrip({ x: "false" }));
test('bare "null" string', () => assertRoundTrip({ x: "null" }));
test('"true" in tabular cell', () => assertRoundTrip({ r: [{ v: "true" }, { v: "false" }] }));

console.log('\n-- flat array vs tabular disambiguation --');
test('flat numeric array not parsed as tabular', () => assertRoundTrip({ scores: [95, 87, 42] }));
test('flat string array with word values', () => assertRoundTrip({ tags: ["alpha", "beta", "gamma"] }));
test('root flat numeric array', () => assertRoundTrip([1, 2, 3]));

console.log('\n-- error handling --');
test('NaN throws', () => assertThrows(() => encode(NaN)));
test('Infinity throws', () => assertThrows(() => encode(Infinity)));
test('empty doc throws', () => assertThrows(() => decode(""), e => e instanceof LeanParseError));
test('trailing garbage', () => assertThrows(() => decode("42\ngarbage")));
test('root bare string rejected', () => assertThrows(() => decode("hello")));
test('duplicate keys rejected', () => assertThrows(() => decode("a:1\na:2"), e => e instanceof LeanParseError));

console.log('\n-- LEAN-specific optimizations --');
test('T/F encoded as single chars', () => {
  const enc = encode({ active: true, deleted: false });
  if (enc.includes('true') || enc.includes('false')) throw new Error('Should use T/F');
});
test('_ encoded for null', () => {
  const enc = encode({ value: null });
  if (enc.includes('null')) throw new Error('Should use _');
});
test('no space after colon', () => {
  const enc = encode({ host: "localhost" });
  if (enc.includes(': ')) throw new Error('Should not have space after colon');
});

console.log('\n-- integration: spec complete example --');
test('spec example round-trips', () => {
  const data = {
    meta: { version: "2.1.0", debug: false },
    users: [
      { id: 1, name: "Alice", email: "alice@ex.com", active: true },
      { id: 2, name: "Bob", email: "bob@ex.com", active: false }
    ],
    tags: [],
    notes: [1, "hello", { key: "val" }]
  };
  assertRoundTrip(data);
});

console.log(`\n${'─'.repeat(40)}`);
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
```

- [ ] **Step 2: Build and run tests**

```bash
cd /Users/denysfiialko/Downloads/files && npm run build && node lean-test.mjs
```
Expected: all tests pass.

- [ ] **Step 3: Fix any failures, re-run until all pass**

- [ ] **Step 4: Commit**

```bash
git add lean-test.mjs
git commit -m "test(lean): comprehensive round-trip tests"
```

---

## Chunk 4: Integration

### Task 5: Add LEAN to benchmark.mjs

**Files:**
- Modify: `benchmark.mjs`

- [ ] **Step 1: Add LEAN import and format entry**

At the top of `benchmark.mjs`, add import:
```js
import { encode as leanEncode, decode as leanDecode } from './dist/lean.js';
```

Add to the `FORMATS` array (after ZON):
```js
  {
    name: 'LEAN',
    encode: (d) => leanEncode(d),
    decode: (t) => leanDecode(t),
  },
```

- [ ] **Step 2: Build and run benchmark Phase 1**

```bash
cd /Users/denysfiialko/Downloads/files && npm run build && node benchmark.mjs --skip-llm
```
Expected: LEAN appears in all 12 dataset tables and summary.

- [ ] **Step 3: Commit**

```bash
git add benchmark.mjs
git commit -m "feat(benchmark): add LEAN as 5th format"
```

### Task 6: Add LEAN to toon_stats in index.ts

**Files:**
- Modify: `index.ts`

- [ ] **Step 1: Add LEAN import**

Add to imports in `index.ts`:
```ts
import { encode as leanEncode } from "./lean.js";
```

- [ ] **Step 2: Add LEAN to the stats formats array**

In the `toon_stats` handler, after the ZON block, add:

```ts
      let leanText: string | null = null;
      try {
        leanText = leanEncode(data);
      } catch {}

      // ... and in the formats array:
      if (leanText !== null) formats.push({ name: "LEAN", text: leanText });
```

- [ ] **Step 3: Build and run existing tests**

```bash
cd /Users/denysfiialko/Downloads/files && npm run build && npm test
```
Expected: all 122 existing tests still pass.

- [ ] **Step 4: Commit**

```bash
git add index.ts
git commit -m "feat(stats): add LEAN to toon_stats comparison"
```
