import { encode, decode, ToonParseError, selectBestFormat } from './dist/toon.js';

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}
function assertEqual(a, b, l='') {
  const as=JSON.stringify(a), bs=JSON.stringify(b);
  if(as!==bs) throw new Error(`${l}\n       expected: ${bs}\n       actual:   ${as}`);
}
function assertRoundTrip(data, d='|') {
  const enc = encode(data, { delimiter: d });
  const dec = decode(enc, d);
  assertEqual(dec, data, `round-trip\n       encoded:\n${enc.split('\n').map(l=>'         '+l).join('\n')}`);
}
function assertThrows(fn, check) {
  let threw = false;
  try { fn(); } catch (e) { threw = true; if (check && !check(e)) throw new Error(`Wrong error: ${e.message}`); }
  if (!threw) throw new Error('Expected to throw');
}

console.log('\n-- empty string round-trips --');

test('nested: { name: "" }', () => assertRoundTrip({ name: "" }));
test('flat array: [""]', () => assertRoundTrip({ x: [""] }));
test('flat array: ["", "a", ""]', () => assertRoundTrip({ x: ["", "a", ""] }));
test('tabular: [{ v: "" }]', () => assertRoundTrip({ rows: [{ k: "a", v: "" }, { k: "b", v: "" }] }));
test('non-uniform list: [{ name: "" }]', () => assertRoundTrip({ items: [{ name: "" }, { name: "x", extra: true }] }));
test('root empty string', () => assertRoundTrip(""));

console.log('\n-- scalar-looking strings in cells --');

test('["null"] stays string', () => assertRoundTrip({ x: ["null"] }));
test('["true"] stays string', () => assertRoundTrip({ x: ["true"] }));
test('["false"] stays string', () => assertRoundTrip({ x: ["false"] }));
test('["42"] stays string', () => assertRoundTrip({ x: ["42"] }));
test('["0012"] stays string', () => assertRoundTrip({ x: ["0012"] }));
test('[" x "] preserves whitespace', () => assertRoundTrip({ x: [" x "] }));
test('tabular: [{ code: "0012" }]', () => assertRoundTrip({ rows: [{ code: "0012", ok: true }, { code: "0034", ok: false }] }));
test('tabular: [{ v: "null" }]', () => assertRoundTrip({ rows: [{ v: "null" }, { v: "true" }] }));
test('mixed scalar-looking array', () => assertRoundTrip({ vals: ["null", "true", "42", 42, true, null] }));

console.log('\n-- newline-containing strings --');

test('nested: { bio: "line1\\nline2" }', () => assertRoundTrip({ bio: "line1\nline2" }));
test('nested: multiline with quotes', () => assertRoundTrip({ text: 'she said:\n"hello"\nend' }));
test('flat array with newlines', () => assertRoundTrip({ notes: ["a\nb", "c"] }));
test('tabular with newlines', () => assertRoundTrip({ rows: [{ msg: "hi\nthere", id: 1 }, { msg: "ok", id: 2 }] }));
test('root string with newline', () => assertRoundTrip("hello\nworld"));

console.log('\n-- root empty object --');

test('root {} round-trips', () => assertRoundTrip({}));
test('encode({}) === "{}"', () => assertEqual(encode({}), "{}"));
test('decode("{}") === {}', () => assertEqual(decode("{}", "|"), {}));

console.log('\n-- key restrictions --');

test('unsupported key throws on encode', () => {
  assertThrows(() => encode({ "first name": "Alice" }), e => e.message.includes('Unsupported'));
});
test('key with slash throws', () => {
  assertThrows(() => encode({ "x/y": 1 }), e => e.message.includes('Unsupported'));
});
test('key with colon throws', () => {
  assertThrows(() => encode({ "a:b": 1 }), e => e.message.includes('Unsupported'));
});
test('valid keys pass', () => {
  assertRoundTrip({ foo: 1, bar_baz: 2, x1: 3, "a.b": 4, "c-d": 5 });
});

// regression stuff

console.log('\n-- root scalar round-trips --');
test('"true" vs true', () => { assertEqual(decode(encode("true")), "true"); assertEqual(decode(encode(true)), true); });
test('"42" vs 42', () => { assertEqual(decode(encode("42")), "42"); assertEqual(decode(encode(42)), 42); });
test('"null" vs null', () => { assertEqual(decode(encode("null")), "null"); assertEqual(decode(encode(null)), null); });
test('root string with spaces', () => assertRoundTrip("hello world"));
test('root string with colon', () => assertRoundTrip("a: b"));
test('root string with quotes', () => assertRoundTrip('she said "hi"'));
test('root number 0', () => assertRoundTrip(0));
test('root -3.14', () => assertRoundTrip(-3.14));
test('root true/false', () => { assertRoundTrip(true); assertRoundTrip(false); });
test('root null', () => assertRoundTrip(null));

console.log('\n-- root array round-trips --');
test('flat scalar', () => assertRoundTrip([1, 2, 3]));
test('tabular', () => assertRoundTrip([{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }]));
test('empty', () => assertRoundTrip([]));
test('non-uniform', () => assertRoundTrip([{ type: 'a', val: 1 }, { type: 'b', val: 2, extra: true }]));

console.log('\n-- root object round-trips --');
test('simple', () => assertRoundTrip({ a: 1, b: 'hello', c: true }));
test('nested', () => assertRoundTrip({ config: { db: { host: 'localhost', port: 5432 }, debug: false } }));
test('with tabular', () => assertRoundTrip({ users: [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }] }));
test('with empty array', () => assertRoundTrip({ items: [] }));

console.log('\n-- null in flat arrays --');
test('[1, null, 3]', () => assertRoundTrip({ v: [1, null, 3] }, ','));
test('[null, null]', () => assertRoundTrip({ x: [null, null] }));

console.log('\n-- non-uniform arrays --');
test('different keys', () => assertRoundTrip({ t: [{ k: 'a', v: 1 }, { k: 'b', v: 2, x: true }] }));

console.log('\n-- delimiter collision --');
test('comma in value', () => assertRoundTrip({ p: [{ n: 'A, B', v: 1 }, { n: 'C', v: 2 }] }, ','));
test('pipe in value', () => assertRoundTrip({ p: [{ n: 'a | b', v: 1 }, { n: 'c', v: 2 }] }, '|'));
test('quotes in value', () => assertRoundTrip({ p: [{ n: '"hi"', v: true }, { n: 'ok', v: false }] }, ','));

console.log('\n-- parse errors --');
test('garbage throws', () => assertThrows(() => decode('a: 1\n!@#$', ','), e => e instanceof ToonParseError));
test('trailing garbage', () => assertThrows(() => decode('42\ngarbage', '|'), e => e.message.includes('trailing')));

console.log('\n-- count enforcement --');
test('non-uniform mismatch', () => assertThrows(() => decode('x[3]:\n  - a: 1\n  - b: 2', '|'), e => e.message.includes('count')));
test('tabular mismatch', () => assertThrows(() => decode('x[3]{a|b}:\n  1|2\n  3|4', '|'), e => e.message.includes('count')));
test('flat mismatch', () => assertThrows(() => decode('x[3]: 1|2', '|'), e => e.message.includes('count')));

console.log('\n-- nested structures --');
test('nested array value', () => assertRoundTrip({ g: [{ n: 'A', m: [{ id: 1 }, { id: 2 }] }] }));
test('nested object value', () => assertRoundTrip({ i: [{ id: 1, m: { c: 'r' } }, { id: 2, m: { c: 'b' } }] }));
test('tabular rejects nested', () => {
  const enc = encode({ r: [{ id: 1, t: ['a'] }, { id: 2, t: ['b'] }] }, { delimiter: '|' });
  if (enc.includes('{id|t}:')) throw new Error('Should not tabularize nested');
  assertRoundTrip({ r: [{ id: 1, t: ['a'] }, { id: 2, t: ['b'] }] });
});
test('deeply nested', () => assertRoundTrip({
  teams: [{ name: 'A', projects: [{ title: 'P1', tasks: [{ done: true }] }] }]
}));

// escape/unescape edge cases

console.log('\n-- escape/unescape edge cases --');

test('root: "plain"', () => assertRoundTrip("plain"));
test('root: ""', () => assertRoundTrip(""));
test('root: "null"', () => assertRoundTrip("null"));
test('root: "42"', () => assertRoundTrip("42"));
test('root: "  padded  "', () => assertRoundTrip("  padded  "));
test('root: "line1\\nline2"', () => assertRoundTrip("line1\nline2"));
test('root: "C:\\\\new" (literal backslash-n)', () => assertRoundTrip("C:\\new"));
test('root: "a\\\\\\"b" (backslash + quote)', () => assertRoundTrip('a\\"b'));

test('flat array of tricky strings', () => {
  assertRoundTrip({ x: ["", "42", "null", "\\n", "line1\nline2"] });
});

test('tabular with tricky strings', () => {
  assertRoundTrip({ rows: [{ code: "0012", note: "C:\\new" }] });
});

test('nested empty containers', () => {
  assertRoundTrip({ empty: {}, arr: [[], {}, [""]] });
});

test('literal backslash in nested value', () => {
  assertRoundTrip({ path: "C:\\Users\\test" });
});

test('literal backslash-n vs real newline', () => {
  const data = { a: "real\nnewline", b: "literal\\nnot" };
  const enc = encode(data, { delimiter: '|' });
  const dec = decode(enc, '|');
  assertEqual(dec.a, "real\nnewline");
  assertEqual(dec.b, "literal\\nnot");
});

test('double backslash round-trips', () => {
  assertRoundTrip({ p: "\\\\" });
});

test('tabular cell: backslash + delimiter combo', () => {
  assertRoundTrip({ rows: [{ val: "a\\|b", id: 1 }, { val: "c", id: 2 }] });
});

test('flat array: single backslash', () => {
  assertRoundTrip({ x: ["\\"] });
});

test('cell with quote inside', () => {
  assertRoundTrip({ rows: [{ msg: 'say "hello"', id: 1 }, { msg: "ok", id: 2 }] });
});

console.log('\n-- delimiter validation --');

test('delimiter "." throws (not in safe set)', () => {
  assertThrows(
    () => encode({ x: 1 }, { delimiter: '.' }),
    e => e.message.includes('not in the safe delimiter set')
  );
});

test('delimiter "-" throws (not in safe set)', () => {
  assertThrows(
    () => encode({ x: 1 }, { delimiter: '-' }),
    e => e.message.includes('not in the safe delimiter set')
  );
});

test('delimiter "a" throws (not in safe set)', () => {
  assertThrows(
    () => encode({ x: 1 }, { delimiter: 'a' }),
    e => e.message.includes('not in the safe delimiter set')
  );
});

test('delimiter "" throws (not in safe set)', () => {
  assertThrows(
    () => encode({ x: 1 }, { delimiter: '' }),
    e => e.message.includes('not in the safe delimiter set')
  );
});

test('delimiter "}" throws (structural collision)', () => {
  assertThrows(
    () => encode({ x: 1 }, { delimiter: '}' }),
    e => e.message.includes('not in the safe delimiter set')
  );
});

test('delimiter "\\n" throws', () => {
  assertThrows(
    () => encode({ x: 1 }, { delimiter: '\n' }),
    e => e.message.includes('not in the safe delimiter set')
  );
});

test('safe delimiters: , | \\t ; ~ ;; |~|', () => {
  const data = { users: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }] };
  for (const d of [',', '|', '\t', ';', '~', ';;', '|~|']) {
    assertRoundTrip(data, d);
  }
});

test('key user.id with pipe delimiter round-trips', () => {
  assertRoundTrip({ rows: [{ "user.id": 1, name: 'A' }, { "user.id": 2, name: 'B' }] });
});

console.log('\n-- duplicate key rejection --');

test('duplicate object key throws', () => {
  assertThrows(
    () => decode('a: 1\na: 2', ','),
    e => e instanceof ToonParseError && e.message.includes('Duplicate key "a"')
  );
});

test('duplicate tabular field header throws', () => {
  assertThrows(
    () => decode('items[1]{a|a}:\n  1|2', '|'),
    e => e instanceof ToonParseError && e.message.includes('Duplicate field')
  );
});

test('duplicate key in list-item object throws', () => {
  assertThrows(
    () => decode('items[1]:\n  - x: 1\n    x: 2', '|'),
    e => e instanceof ToonParseError && e.message.includes('Duplicate key "x"')
  );
});

test('non-duplicate keys decode fine', () => {
  const back = decode('a: 1\nb: 2\nc: 3', ',');
  assertEqual(back, { a: 1, b: 2, c: 3 });
});

console.log('\n-- NaN / Infinity rejection --');

test('encode(NaN) throws', () => {
  assertThrows(
    () => encode(NaN),
    e => e.message.includes('NaN')
  );
});

test('encode(Infinity) throws', () => {
  assertThrows(
    () => encode(Infinity),
    e => e.message.includes('Infinity')
  );
});

test('encode(-Infinity) throws', () => {
  assertThrows(
    () => encode(-Infinity),
    e => e.message.includes('Infinity')
  );
});

test('nested NaN throws', () => {
  assertThrows(
    () => encode({ x: NaN }),
    e => e.message.includes('NaN')
  );
});

test('nested Infinity throws', () => {
  assertThrows(
    () => encode({ x: Infinity }),
    e => e.message.includes('Infinity')
  );
});

test('valid numbers still work', () => {
  assertRoundTrip({ a: 0, b: -1, c: 3.14, d: 1e10 });
});

console.log('\n-- tabular field name validation --');

test('decode rejects invalid field name "first name"', () => {
  assertThrows(
    () => decode('[1]{first name}:\nBob', ','),
    e => e.message.includes('Invalid tabular field name')
  );
});

test('decode rejects field name with slash', () => {
  assertThrows(
    () => decode('items[1]{x/y}:\n1', ','),
    e => e.message.includes('Invalid tabular field name')
  );
});

test('decode accepts valid field names', () => {
  const back = decode('items[1]{foo|bar_baz|x.y}:\n  1|2|3', '|');
  assertEqual(back.items[0], { foo: 1, bar_baz: 2, "x.y": 3 });
});

console.log('\n-- unterminated quote detection --');

test('unterminated quote in CSV row throws', () => {
  assertThrows(
    () => decode('items[1]{a|b}:\n  "hello|world', '|'),
    e => e.message.includes('Unterminated') || e.message.includes('unterminated')
  );
});

test('properly closed quotes still work', () => {
  const back = decode('items[1]{a|b}:\n  "hello"|"world"', '|');
  assertEqual(back.items[0], { a: 'hello', b: 'world' });
});

console.log('\n-- quoted-looking string round-trips --');

test('value \'\"abc\"\' round-trips in object', () => {
  assertRoundTrip({ x: '"abc"' });
});
test('value \'\"\" \' (just quotes) round-trips', () => {
  assertRoundTrip({ x: '""' });
});
test('value starting with quote round-trips', () => {
  assertRoundTrip({ x: '"start' });
});
test('quoted-looking string in flat array', () => {
  assertRoundTrip({ x: ['"abc"', 'normal'] });
});
test('quoted-looking string in tabular', () => {
  assertRoundTrip({ rows: [{ v: '"abc"', id: 1 }, { v: '"xyz"', id: 2 }] });
});
test('quoted-looking string in non-uniform list', () => {
  assertRoundTrip({ items: [{ v: '"abc"' }, { v: '"xyz"', extra: true }] });
});
test('root quoted-looking string', () => {
  assertRoundTrip('"abc"');
});

console.log('\n-- non-finite numbers in decoder --');

test('Infinity in scalar context stays string', () => {
  assertEqual(decode('x: Infinity', ','), { x: 'Infinity' });
});
test('-Infinity in scalar context stays string', () => {
  assertEqual(decode('x: -Infinity', ','), { x: '-Infinity' });
});
test('1e309 (overflow) in scalar context stays string', () => {
  assertEqual(decode('x: 1e309', ','), { x: '1e309' });
});
test('Infinity in flat array stays string', () => {
  assertEqual(decode('x[1]: Infinity', ','), { x: ['Infinity'] });
});
test('normal numbers still parse as numbers', () => {
  assertEqual(decode('x: 42', ','), { x: 42 });
  assertEqual(decode('x: -3.14', ','), { x: -3.14 });
  assertEqual(decode('x: 0', ','), { x: 0 });
});

console.log('\n-- decoder rejects bad delimiters --');

test('decode with "}" throws', () => {
  assertThrows(() => decode('x: 1', '}'), e => e.message.includes('not in the safe delimiter set'));
});
test('decode with ":" throws', () => {
  assertThrows(() => decode('x: 1', ':'), e => e.message.includes('not in the safe delimiter set'));
});
test('decode with "-" throws', () => {
  assertThrows(() => decode('x: 1', '-'), e => e.message.includes('not in the safe delimiter set'));
});
test('decode with valid delimiters works', () => {
  for (const d of [',', '|', '\t', ';', '~']) {
    decode(`x: hello`, d); // should not throw
  }
});

console.log('\n-- empty document throws --');

test('decode("") throws', () => {
  assertThrows(() => decode('', ','), e => e instanceof ToonParseError && e.message.includes('Empty'));
});
test('decode("   \\n\\n") throws', () => {
  assertThrows(() => decode('   \n\n', ','), e => e instanceof ToonParseError && e.message.includes('Empty'));
});
test('decode("\\n") throws', () => {
  assertThrows(() => decode('\n', '|'), e => e instanceof ToonParseError && e.message.includes('Empty'));
});
test('root null still works (encodes as "null", not empty)', () => {
  assertEqual(encode(null), 'null');
  assertEqual(decode('null', ','), null);
});

console.log('\n-- format selection --');

test('selectBestFormat chooses TOON for tabular data', () => {
  const data = {
    users: [
      { id: 1, name: 'Alice', active: true },
      { id: 2, name: 'Bob', active: false }
    ]
  };
  const result = selectBestFormat(data, { delimiter: '|' });
  assertEqual(result.format, 'toon');
  if (result.toonTokens >= result.jsonTokens) {
    throw new Error(`Expected TOON to be cheaper than JSON, got toon=${result.toonTokens}, json=${result.jsonTokens}`);
  }
  assertEqual(result.text, encode(data, { delimiter: '|' }));
});

test('selectBestFormat prefers JSON when TOON is tied or larger', () => {
  const data = 'hello';
  const result = selectBestFormat(data, { delimiter: '|' });
  assertEqual(result.format, 'json');
  if (result.toonTokens < result.jsonTokens) {
    throw new Error(`Expected JSON to be selected only when TOON is not cheaper, got toon=${result.toonTokens}, json=${result.jsonTokens}`);
  }
  assertEqual(result.text, JSON.stringify(data));
});

console.log(`\n${'─'.repeat(40)}`);
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
