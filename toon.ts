// TOON encoder/decoder
// Keys must match [\w][\w.-]* — no spaces, slashes, colons, etc.
// Root empty object is special-cased as "{}"

export type ToonValue =
  | string
  | number
  | boolean
  | null
  | ToonValue[]
  | { [key: string]: ToonValue };

export interface EncodeOptions {
  strict?: boolean;
  delimiter?: string;
  indent?: number;
}

export interface FormatSelection {
  format: "toon" | "json";
  text: string;
  jsonTokens: number;
  toonTokens: number;
}

const KEY_PATTERN = "[\\w][\\w.-]*";
const KEY_REGEX = /^[\w][\w.-]*$/;

function validateKey(key: string): void {
  if (!KEY_REGEX.test(key)) {
    throw new Error(
      `Unsupported object key "${key}". Keys must match /^[\\w][\\w.-]*$/ (word chars, hyphens, dots). ` +
      `Keys with spaces, slashes, colons, or other special characters are not representable in TOON.`
    );
  }
}

// whitelist approach — easier to reason about than trying to blacklist
// every character that could collide with TOON syntax
const SAFE_DELIMITERS = new Set([",", "|", "\t", ";", "~", ";;", "|~|"]);

function validateDelimiter(delimiter: string): void {
  if (!SAFE_DELIMITERS.has(delimiter)) {
    const safe = [...SAFE_DELIMITERS].map(d => d === "\t" ? '"\\t"' : `"${d}"`).join(", ");
    throw new Error(
      `Delimiter "${delimiter}" is not in the safe delimiter set. ` +
      `Allowed delimiters: ${safe}`
    );
  }
}

function isScalarValue(value: ToonValue): value is string | number | boolean | null {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function isTabularArray(arr: ToonValue[]): boolean {
  if (arr.length === 0) return false;
  if (arr.some(item => typeof item !== "object" || item === null || Array.isArray(item))) return false;
  const firstKeys = Object.keys(arr[0] as Record<string, ToonValue>).sort();
  return arr.every(item => {
    const obj = item as Record<string, ToonValue>;
    const keys = Object.keys(obj).sort();
    return (
      keys.length === firstKeys.length &&
      keys.every((key, i) => key === firstKeys[i]) &&
      keys.every(key => isScalarValue(obj[key]))
    );
  });
}

// needs quoting if it'd be ambiguous as a bare cell value
function cellNeedsQuoting(value: string, delimiter: string): boolean {
  if (value === "") return true;
  if (value === "null" || value === "true" || value === "false") return true;
  if (value.trim() !== value) return true;
  if (!isNaN(Number(value))) return true;
  if (value.includes(delimiter) || value.includes('"') || value.includes("\n") || value.includes("\\")) return true;
  return false;
}

// scalar context (key: value lines) — backslash escaping
function escapeScalarString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/"/g, '\\"');
}

function unescapeScalarString(value: string): string {
  let result = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch !== "\\") {
      result += ch;
      continue;
    }
    const next = value[i + 1];
    if (next === "n") { result += "\n"; i++; }
    else if (next === "\\") { result += "\\"; i++; }
    else if (next === '"') { result += '"'; i++; }
    else { result += "\\"; }
  }
  return result;
}

// cell context (tabular rows) — RFC 4180 double-quoting + \n for newlines
function escapeCellString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/"/g, '""');
}

function unescapeCellString(value: string): string {
  let result = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '"' && value[i + 1] === '"') {
      result += '"';
      i++;
      continue;
    }
    if (ch === "\\") {
      const next = value[i + 1];
      if (next === "n") { result += "\n"; i++; continue; }
      if (next === "\\") { result += "\\"; i++; continue; }
    }
    result += ch;
  }
  return result;
}

function cellEscape(value: ToonValue, delimiter: string, strict: boolean): string {
  if (value === null) return "null";
  if (typeof value !== "string") return String(value);

  if (strict || cellNeedsQuoting(value, delimiter)) {
    return `"${escapeCellString(value)}"`;
  }
  return value;
}

function encodeString(value: string, forceQuote: boolean): string {
  if (forceQuote || value === "") {
    return `"${escapeScalarString(value)}"`;
  }
  const needsQ =
    value === "null" || value === "true" || value === "false" ||
    value.includes("\n") || value.includes(":") || value.trim() !== value ||
    value.includes("\\") || value.includes('"') || !isNaN(Number(value));
  if (needsQ) {
    return `"${escapeScalarString(value)}"`;
  }
  return value;
}

// --- encoder ---

export function encode(data: ToonValue, options: EncodeOptions = {}): string {
  const { strict = false, delimiter = ",", indent = 0 } = options;

  validateDelimiter(delimiter);

  if (data === null || data === undefined) return "null";
  if (typeof data === "boolean") return String(data);
  if (typeof data === "number") {
    if (!isFinite(data)) {
      throw new Error(
        `Unsupported number value: ${data}. NaN and Infinity are not representable in TOON.`
      );
    }
    return String(data);
  }
  if (typeof data === "string") return encodeString(data, true);

  if (Array.isArray(data)) {
    const lines: string[] = [];
    encodeArray(data, "", lines, indent, strict, delimiter);
    return lines.join("\n");
  }

  const entries = Object.entries(data as Record<string, ToonValue>);
  if (entries.length === 0) return "{}";

  const lines: string[] = [];
  for (const [k, v] of entries) {
    validateKey(k);
    encodeValue(v, `${k}: `, lines, indent, strict, delimiter);
  }
  return lines.join("\n");
}

function encodeArray(
  value: ToonValue[], prefix: string, lines: string[],
  indent: number, strict: boolean, delimiter: string
): void {
  const pad = "  ".repeat(indent);
  const keyPart = prefix.replace(/:\s*$/, "");

  if (value.length === 0) {
    lines.push(`${pad}${keyPart}[0]:`);
    return;
  }

  const allScalar = value.every(v => v === null || typeof v !== "object");
  if (allScalar) {
    const formatted = value.map(v => cellEscape(v, delimiter, strict)).join(delimiter);
    lines.push(`${pad}${keyPart}[${value.length}]: ${formatted}`);
    return;
  }

  if (isTabularArray(value)) {
    const fields = Object.keys(value[0] as Record<string, ToonValue>);
    fields.forEach(validateKey);
    lines.push(`${pad}${keyPart}[${value.length}]{${fields.join(delimiter)}}:`);
    for (const row of value) {
      const obj = row as Record<string, ToonValue>;
      const cells = fields.map(f => cellEscape(obj[f], delimiter, strict));
      lines.push(`${pad}  ${cells.join(delimiter)}`);
    }
    return;
  }

  lines.push(`${pad}${keyPart}[${value.length}]:`);
  for (const item of value) {
    encodeListItem(item, lines, indent + 1, strict, delimiter);
  }
}

function encodeListItem(
  item: ToonValue, lines: string[], indent: number,
  strict: boolean, delimiter: string
): void {
  const pad = "  ".repeat(indent);

  if (item === null || typeof item !== "object") {
    if (typeof item === "string") {
      lines.push(`${pad}- ${encodeString(item, false)}`);
    } else {
      lines.push(`${pad}- ${item === null ? "null" : String(item)}`);
    }
    return;
  }

  if (Array.isArray(item)) {
    const subLines: string[] = [];
    encodeArray(item, "", subLines, 0, strict, delimiter);
    lines.push(`${pad}- ${subLines[0]}`);
    for (let si = 1; si < subLines.length; si++) {
      lines.push(`${pad}  ${subLines[si]}`);
    }
    return;
  }

  const entries = Object.entries(item as Record<string, ToonValue>);
  if (entries.length === 0) {
    lines.push(`${pad}- {}`);
    return;
  }

  const [firstKey, firstVal] = entries[0];
  validateKey(firstKey);
  if (isScalarValue(firstVal)) {
    const sv = firstVal === null ? "null"
      : typeof firstVal === "string" ? encodeString(firstVal, false)
      : String(firstVal);
    lines.push(`${pad}- ${firstKey}: ${sv}`);
  } else {
    const subLines: string[] = [];
    encodeValue(firstVal, `${firstKey}: `, subLines, 0, strict, delimiter);
    lines.push(`${pad}- ${subLines[0]}`);
    for (let fi = 1; fi < subLines.length; fi++) {
      lines.push(`${pad}  ${subLines[fi]}`);
    }
  }

  for (let ei = 1; ei < entries.length; ei++) {
    const [k, v] = entries[ei];
    validateKey(k);
    encodeValue(v, `${k}: `, lines, indent + 1, strict, delimiter);
  }
}

function encodeValue(
  value: ToonValue, prefix: string, lines: string[],
  indent: number, strict: boolean, delimiter: string
): void {
  const pad = "  ".repeat(indent);

  if (value === null || value === undefined) { lines.push(`${pad}${prefix}null`); return; }
  if (typeof value === "boolean") { lines.push(`${pad}${prefix}${value}`); return; }
  if (typeof value === "number") {
    if (!isFinite(value)) throw new Error(`Unsupported number value: ${value}. NaN and Infinity are not representable in TOON.`);
    lines.push(`${pad}${prefix}${value}`); return;
  }
  if (typeof value === "string") { lines.push(`${pad}${prefix}${encodeString(value, false)}`); return; }

  if (Array.isArray(value)) {
    encodeArray(value, prefix, lines, indent, strict, delimiter);
    return;
  }

  if (typeof value === "object") {
    if (prefix) {
      lines.push(`${pad}${prefix.replace(/:\s*$/, "")}:`);
      indent += 1;
    }
    for (const [k, v] of Object.entries(value as Record<string, ToonValue>)) {
      validateKey(k);
      encodeValue(v, `${k}: `, lines, prefix ? indent : indent, strict, delimiter);
    }
  }
}

// --- decoder ---

export class ToonParseError extends Error {
  public readonly line: number;
  public readonly content: string;
  constructor(lineIndex: number, content: string, message: string) {
    super(`Line ${lineIndex + 1}: ${message} → "${content}"`);
    this.name = "ToonParseError";
    this.line = lineIndex + 1;
    this.content = content;
  }
}

// parses a value in scalar context (key: value)
// note: doubled quotes are cell-context only, not handled here
function parseScalar(s: string): ToonValue {
  s = s.trim();
  if (s === "null") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "") return "";
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    return unescapeScalarString(s.slice(1, -1));
  }
  const n = Number(s);
  if (Number.isFinite(n)) return n;
  return s;
}

function parseCellScalar(s: string): ToonValue {
  s = s.trim();
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    return unescapeCellString(s.slice(1, -1));
  }
  if (s === "null") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "") return "";
  const n = Number(s);
  if (Number.isFinite(n)) return n;
  return s;
}

function parseCSVRow(line: string, delimiter: string = ","): ToonValue[] {
  if (delimiter.length > 1 && !line.includes('"')) {
    return line.split(delimiter).map(parseCellScalar);
  }

  // split respecting quoted fields — parseCellScalar handles unescaping
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
      if (ch === '"') {
        inQuotes = true;
        current += '"';
        pos++;
      } else if (line.startsWith(delimiter, pos)) {
        cells.push(current);
        current = "";
        pos += delimiter.length;
      } else {
        current += ch;
        pos++;
      }
    }
  }
  cells.push(current);
  if (inQuotes) {
    throw new Error(`Unterminated quoted field in CSV row: "${line}"`);
  }
  return cells.map(parseCellScalar);
}

interface ParseState {
  i: number;
  lines: string[];
}

function getIndent(line: string): number {
  const m = line.match(/^(\s*)/);
  return m ? m[1].length : 0;
}

function assertExpectedCount(
  actual: number, expected: number, lineIndex: number, content: string, label: string
): void {
  if (actual !== expected) {
    throw new ToonParseError(lineIndex, content, `${label} count mismatch (declared ${expected}, parsed ${actual})`);
  }
}

function assertConsumedAll(state: ParseState): void {
  while (state.i < state.lines.length && state.lines[state.i].trim() === "") state.i++;
  if (state.i < state.lines.length) {
    throw new ToonParseError(state.i, state.lines[state.i].trim(), "Unexpected trailing content");
  }
}

function setKeyOrThrow(
  target: Record<string, ToonValue>, key: string, value: ToonValue,
  lineIndex: number, content: string
): void {
  if (Object.prototype.hasOwnProperty.call(target, key)) {
    throw new ToonParseError(lineIndex, content, `Duplicate key "${key}"`);
  }
  target[key] = value;
}

function assertUniqueFields(fields: string[], lineIndex: number, content: string): void {
  const seen = new Set<string>();
  for (const f of fields) {
    if (seen.has(f)) {
      throw new ToonParseError(lineIndex, content, `Duplicate field name "${f}" in tabular header`);
    }
    seen.add(f);
  }
}

function parseFlatArrayValues(
  raw: string, expected: number, lineIndex: number, content: string, delimiter: string
): ToonValue[] {
  const values = parseCSVRow(raw, delimiter);
  assertExpectedCount(values.length, expected, lineIndex, content, "Array item");
  return values;
}

function parseTabularRows(
  state: ParseState, expectedRows: number, fields: string[],
  delimiter: string, minIndent: number, headerContent: string
): ToonValue[] {
  assertUniqueFields(fields, state.i > 0 ? state.i - 1 : 0, headerContent);
  for (const field of fields) {
    if (!KEY_REGEX.test(field)) {
      throw new ToonParseError(
        state.i > 0 ? state.i - 1 : 0,
        headerContent,
        `Invalid tabular field name "${field}". Field names must match ${KEY_PATTERN} (word chars, hyphens, dots)`
      );
    }
  }
  const rows: ToonValue[] = [];
  while (rows.length < expectedRows && state.i < state.lines.length) {
    const rowLine = state.lines[state.i];
    if (rowLine.trim() === "") { state.i++; continue; }
    if (getIndent(rowLine) < minIndent) break;
    const values = parseCSVRow(rowLine.trim(), delimiter);
    assertExpectedCount(values.length, fields.length, state.i, rowLine.trim(), "Tabular row field");
    const obj: Record<string, ToonValue> = {};
    fields.forEach((field, index) => { obj[field] = values[index]; });
    rows.push(obj);
    state.i++;
  }
  assertExpectedCount(
    rows.length, expectedRows,
    state.i < state.lines.length ? state.i : state.lines.length - 1,
    headerContent, "Tabular row"
  );
  return rows;
}

// pre-compiled regexes for line matching
const tabRegex = new RegExp(`^(${KEY_PATTERN})\\[(\\d+)\\]\\{([^}]+)\\}:\\s*$`);
const flatRegex = new RegExp(`^(${KEY_PATTERN})\\[(\\d+)\\]:\\s*(.+)$`);
const emptyArrRegex = new RegExp(`^(${KEY_PATTERN})\\[0\\]:\\s*$`);
const nonUniformArrRegex = new RegExp(`^(${KEY_PATTERN})\\[([1-9]\\d*)\\]:\\s*$`);
const objRegex = new RegExp(`^(${KEY_PATTERN}):\\s*$`);
const kvRegex = new RegExp(`^(${KEY_PATTERN}):\\s+(.+)$`);

const listItemKvRegex = new RegExp(`^-\\s+(${KEY_PATTERN}):\\s+(.+)$`);
const listItemObjRegex = new RegExp(`^-\\s+(${KEY_PATTERN}):\\s*$`);
const listItemScalarRegex = /^-\s+(.+)$/;
const listItemEmptyObjRegex = /^-\s+\{\}\s*$/;

const listItemRootTabRegex = /^-\s+\[(\d+)\]\{([^}]+)\}:\s*$/;
const listItemRootFlatRegex = /^-\s+\[(\d+)\]:\s*(.+)$/;
const listItemRootEmptyArrRegex = /^-\s+\[0\]:\s*$/;
const listItemRootNonUniformArrRegex = /^-\s+\[([1-9]\d*)\]:\s*$/;

const listItemTabRegex = new RegExp(`^-\\s+(${KEY_PATTERN})\\[(\\d+)\\]\\{([^}]+)\\}:\\s*$`);
const listItemFlatKeyRegex = new RegExp(`^-\\s+(${KEY_PATTERN})\\[(\\d+)\\]:\\s*(.+)$`);
const listItemEmptyArrKeyRegex = new RegExp(`^-\\s+(${KEY_PATTERN})\\[0\\]:\\s*$`);
const listItemNonUniformKeyRegex = new RegExp(`^-\\s+(${KEY_PATTERN})\\[([1-9]\\d*)\\]:\\s*$`);

const rootTabRegex = /^\[(\d+)\]\{([^}]+)\}:\s*$/;
const rootFlatRegex = /^\[(\d+)\]:\s*(.+)$/;
const rootEmptyArrRegex = /^\[0\]:\s*$/;
const rootNonUniformArrRegex = /^\[([1-9]\d*)\]:\s*$/;

export function decode(toon: string, delimiter: string = ","): ToonValue {
  validateDelimiter(delimiter);
  const lines = toon.split("\n");
  let firstIdx = 0;
  while (firstIdx < lines.length && lines[firstIdx].trim() === "") firstIdx++;
  if (firstIdx >= lines.length) {
    throw new ToonParseError(0, "", "Empty TOON document");
  }

  const first = lines[firstIdx].trim();
  const state: ParseState = { i: firstIdx, lines };

  if (first === "{}") {
    state.i++;
    assertConsumedAll(state);
    return {};
  }

  // root array
  if (
    rootTabRegex.test(first) || rootEmptyArrRegex.test(first) ||
    rootNonUniformArrRegex.test(first) || rootFlatRegex.test(first)
  ) {
    const result = parseRootArray(state, delimiter);
    assertConsumedAll(state);
    return result;
  }

  // root object
  if (
    tabRegex.test(first) || emptyArrRegex.test(first) ||
    nonUniformArrRegex.test(first) || flatRegex.test(first) ||
    objRegex.test(first) || kvRegex.test(first)
  ) {
    const result: Record<string, ToonValue> = {};
    parseBlock(state, 0, result, delimiter);
    assertConsumedAll(state);
    return result;
  }

  // scalar fallback
  const scalar = parseScalar(first);
  for (let j = firstIdx + 1; j < lines.length; j++) {
    if (lines[j].trim() !== "") {
      throw new ToonParseError(j, lines[j].trim(), "Unexpected trailing content after root scalar");
    }
  }
  return scalar;
}

function parseRootArray(state: ParseState, delimiter: string): ToonValue[] {
  const line = state.lines[state.i].trim();

  const tabM = line.match(rootTabRegex);
  if (tabM) {
    const count = Number.parseInt(tabM[1], 10);
    const fields = tabM[2].split(delimiter).map(f => f.trim());
    state.i++;
    return parseTabularRows(state, count, fields, delimiter, 2, line);
  }

  if (rootEmptyArrRegex.test(line)) { state.i++; return []; }

  const nuM = line.match(rootNonUniformArrRegex);
  if (nuM) {
    const count = Number.parseInt(nuM[1], 10);
    state.i++;
    return parseListItems(state, 0, count, delimiter);
  }

  const flatM = line.match(rootFlatRegex);
  if (flatM) {
    const count = Number.parseInt(flatM[1], 10);
    const values = parseFlatArrayValues(flatM[2], count, state.i, line, delimiter);
    state.i++;
    return values;
  }

  throw new ToonParseError(state.i, line, "Unrecognized root array syntax");
}

function parseDashedArrayItem(state: ParseState, lineInd: number, delimiter: string): ToonValue[] {
  const content = state.lines[state.i].slice(lineInd);
  const header = content.replace(/^-\s+/, "");

  const tabM = header.match(rootTabRegex);
  if (tabM) {
    const count = Number.parseInt(tabM[1], 10);
    const fields = tabM[2].split(delimiter).map(f => f.trim());
    state.i++;
    return parseTabularRows(state, count, fields, delimiter, lineInd + 2, content);
  }
  if (rootEmptyArrRegex.test(header)) { state.i++; return []; }
  const nuM = header.match(rootNonUniformArrRegex);
  if (nuM) {
    const count = Number.parseInt(nuM[1], 10);
    state.i++;
    return parseListItems(state, lineInd, count, delimiter);
  }
  const flatM = header.match(rootFlatRegex);
  if (flatM) {
    const count = Number.parseInt(flatM[1], 10);
    const values = parseFlatArrayValues(flatM[2], count, state.i, content, delimiter);
    state.i++;
    return values;
  }
  throw new ToonParseError(state.i, content, "Unrecognized dashed array syntax");
}

function parseListItems(
  state: ParseState, baseIndent: number, count: number, delimiter: string
): ToonValue[] {
  const arr: ToonValue[] = [];
  const itemIndent = baseIndent + 2;

  while (arr.length < count && state.i < state.lines.length) {
    const line = state.lines[state.i];
    if (line.trim() === "") { state.i++; continue; }
    const lineInd = getIndent(line);
    if (lineInd < itemIndent) break;
    const content = line.slice(lineInd);

    if (content.match(listItemEmptyObjRegex)) { arr.push({}); state.i++; continue; }

    if (
      content.match(listItemRootTabRegex) || content.match(listItemRootEmptyArrRegex) ||
      content.match(listItemRootNonUniformArrRegex) || content.match(listItemRootFlatRegex)
    ) { arr.push(parseDashedArrayItem(state, lineInd, delimiter)); continue; }

    if (
      content.match(listItemTabRegex) || content.match(listItemEmptyArrKeyRegex) ||
      content.match(listItemNonUniformKeyRegex) || content.match(listItemFlatKeyRegex) ||
      content.match(listItemKvRegex) || content.match(listItemObjRegex)
    ) { arr.push(parseListItemObject(state, lineInd, itemIndent, delimiter)); continue; }

    const scalarM = content.match(listItemScalarRegex);
    if (scalarM) { arr.push(parseScalar(scalarM[1])); state.i++; continue; }

    throw new ToonParseError(state.i, content, "Expected list item starting with '- '");
  }

  assertExpectedCount(
    arr.length, count,
    state.i < state.lines.length ? state.i : state.lines.length - 1,
    state.i < state.lines.length ? state.lines[state.i].trim() : "",
    "Array item"
  );
  return arr;
}

function parseListItemObject(
  state: ParseState, lineInd: number, parentItemIndent: number, delimiter: string
): Record<string, ToonValue> {
  const obj: Record<string, ToonValue> = {};
  const content = state.lines[state.i].slice(lineInd);
  const firstLineIdx = state.i;

  if (content.match(listItemEmptyObjRegex)) { state.i++; return {}; }

  const firstTab = content.match(listItemTabRegex);
  if (firstTab) {
    const [, key, countStr, fieldsStr] = firstTab;
    const count = Number.parseInt(countStr, 10);
    const fields = fieldsStr.split(delimiter).map(f => f.trim());
    state.i++;
    setKeyOrThrow(obj, key, parseTabularRows(state, count, fields, delimiter, lineInd + 2, content), firstLineIdx, content);
  } else {
    const firstEmptyArr = content.match(listItemEmptyArrKeyRegex);
    const firstNonUniform = content.match(listItemNonUniformKeyRegex);
    const firstFlat = content.match(listItemFlatKeyRegex);
    const kvFirst = content.match(listItemKvRegex);
    const objFirst = content.match(listItemObjRegex);

    if (firstEmptyArr) { setKeyOrThrow(obj, firstEmptyArr[1], [], firstLineIdx, content); state.i++; }
    else if (firstNonUniform) {
      const [, key, countStr] = firstNonUniform;
      state.i++;
      setKeyOrThrow(obj, key, parseListItems(state, lineInd, Number.parseInt(countStr, 10), delimiter), firstLineIdx, content);
    }
    else if (firstFlat) {
      const [, key, countStr, raw] = firstFlat;
      setKeyOrThrow(obj, key, parseFlatArrayValues(raw, Number.parseInt(countStr, 10), state.i, content, delimiter), firstLineIdx, content);
      state.i++;
    }
    else if (kvFirst) { setKeyOrThrow(obj, kvFirst[1], parseScalar(kvFirst[2]), firstLineIdx, content); state.i++; }
    else if (objFirst) {
      const nested: Record<string, ToonValue> = {};
      state.i++;
      parseBlock(state, lineInd + 4, nested, delimiter);
      setKeyOrThrow(obj, objFirst[1], nested, firstLineIdx, content);
    }
    else { throw new ToonParseError(state.i, content, "Invalid object list item"); }
  }

  // remaining keys after the first "- key: val" line
  const bodyIndent = lineInd + 2;
  while (state.i < state.lines.length) {
    const line = state.lines[state.i];
    if (line.trim() === "") { state.i++; continue; }
    const ind = getIndent(line);
    if (ind < bodyIndent) break;
    const lc = line.slice(ind);
    if (ind === parentItemIndent && lc.startsWith("- ")) break;
    const bodyLineIdx = state.i;

    const tabM = lc.match(tabRegex);
    if (tabM) {
      const [, key, cs, fs] = tabM;
      state.i++;
      setKeyOrThrow(obj, key, parseTabularRows(state, Number.parseInt(cs, 10), fs.split(delimiter).map(f => f.trim()), delimiter, ind + 2, lc), bodyLineIdx, lc);
      continue;
    }
    const eaM = lc.match(emptyArrRegex);
    if (eaM) { setKeyOrThrow(obj, eaM[1], [], bodyLineIdx, lc); state.i++; continue; }
    const nuM = lc.match(nonUniformArrRegex);
    if (nuM) {
      state.i++;
      setKeyOrThrow(obj, nuM[1], parseListItems(state, ind, Number.parseInt(nuM[2], 10), delimiter), bodyLineIdx, lc);
      continue;
    }
    const flatM = lc.match(flatRegex);
    if (flatM) {
      setKeyOrThrow(obj, flatM[1], parseFlatArrayValues(flatM[3], Number.parseInt(flatM[2], 10), state.i, lc, delimiter), bodyLineIdx, lc);
      state.i++;
      continue;
    }
    const kvM = lc.match(kvRegex);
    if (kvM) { setKeyOrThrow(obj, kvM[1], parseScalar(kvM[2]), bodyLineIdx, lc); state.i++; continue; }
    const objM = lc.match(objRegex);
    if (objM) {
      const nested: Record<string, ToonValue> = {};
      state.i++;
      parseBlock(state, ind + 2, nested, delimiter);
      setKeyOrThrow(obj, objM[1], nested, bodyLineIdx, lc);
      continue;
    }
    break;
  }
  return obj;
}

function parseBlock(
  state: ParseState, baseIndent: number,
  target: Record<string, ToonValue>, delimiter: string
): void {
  while (state.i < state.lines.length) {
    const line = state.lines[state.i];
    if (line.trim() === "") { state.i++; continue; }
    const ind = getIndent(line);
    if (ind < baseIndent) break;
    const content = line.slice(ind);
    const lineIdx = state.i;

    const tabMatch = content.match(tabRegex);
    if (tabMatch) {
      const [, key, cs, fs] = tabMatch;
      state.i++;
      const val = parseTabularRows(state, Number.parseInt(cs, 10), fs.split(delimiter).map(f => f.trim()), delimiter, ind + 2, content);
      setKeyOrThrow(target, key, val, lineIdx, content);
      continue;
    }
    const eaMatch = content.match(emptyArrRegex);
    if (eaMatch) { setKeyOrThrow(target, eaMatch[1], [], lineIdx, content); state.i++; continue; }
    const nuMatch = content.match(nonUniformArrRegex);
    if (nuMatch) {
      state.i++;
      const val = parseListItems(state, ind, Number.parseInt(nuMatch[2], 10), delimiter);
      setKeyOrThrow(target, nuMatch[1], val, lineIdx, content);
      continue;
    }
    const flatMatch = content.match(flatRegex);
    if (flatMatch) {
      const val = parseFlatArrayValues(flatMatch[3], Number.parseInt(flatMatch[2], 10), state.i, content, delimiter);
      setKeyOrThrow(target, flatMatch[1], val, lineIdx, content);
      state.i++;
      continue;
    }
    const objMatch = content.match(objRegex);
    if (objMatch) {
      const nested: Record<string, ToonValue> = {};
      state.i++;
      parseBlock(state, ind + 2, nested, delimiter);
      setKeyOrThrow(target, objMatch[1], nested, lineIdx, content);
      continue;
    }
    const kvMatch = content.match(kvRegex);
    if (kvMatch) { setKeyOrThrow(target, kvMatch[1], parseScalar(kvMatch[2]), lineIdx, content); state.i++; continue; }

    throw new ToonParseError(state.i, content, "Unrecognized TOON syntax");
  }
}

// rough token estimate — good enough for comparing formats against each other
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let count = 0;
  const words = text.split(/\s+/).filter(w => w.length > 0);
  for (const word of words) {
    if (word.length <= 4) count += 1;
    else if (word.length <= 10) count += 2;
    else count += Math.ceil(word.length / 4);
    const puncts = word.match(/[{}\[\](),":;|~<>]/g);
    if (puncts) count += Math.ceil(puncts.length / 2);
  }
  count += (text.match(/\n/g) || []).length;
  return Math.max(count, 1);
}

export function selectBestFormat(
  data: ToonValue,
  options: EncodeOptions = {}
): FormatSelection {
  const jsonText = JSON.stringify(data);
  const toonText = encode(data, options);
  const jsonTokens = estimateTokens(jsonText);
  const toonTokens = estimateTokens(toonText);

  if (toonTokens < jsonTokens) {
    return {
      format: "toon",
      text: toonText,
      jsonTokens,
      toonTokens,
    };
  }

  return {
    format: "json",
    text: jsonText,
    jsonTokens,
    toonTokens,
  };
}
