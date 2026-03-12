# toon-mcp-server

MCP server for token-efficient data encoding in LLM context windows.

**v2** uses [LEAN format](https://github.com/fiialkod/lean-format) (LLM-Efficient Adaptive Notation) as the primary encoding, with [TOON](https://github.com/nicholasgasior/toon) available for comparison in stats.

## Why?

JSON wastes tokens on syntax — braces, brackets, repeated key names, quotes. LEAN saves ~49% tokens on average by declaring field names once in tab-delimited tables, using dot-flattened keys, indentation instead of braces, and single-char literals (T/F/_).

## Tools

- **`lean_encode`** — JSON value -> LEAN
- **`lean_decode`** — LEAN -> JSON value
- **`lean_stats`** — compare token counts: JSON vs LEAN vs TOON
- **`lean_format_response`** — picks whichever format is smaller (LEAN or compact JSON), adds metadata

All tools accept any JSON value at root. Input validated with Zod.

## Setup

```bash
npm install && npm run build
```

Claude Desktop (`claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "toon": {
      "command": "node",
      "args": ["/absolute/path/to/toon-mcp-server/dist/index.js"]
    }
  }
}
```

Claude Code:
```bash
claude mcp add toon -- node /absolute/path/to/toon-mcp-server/dist/index.js
```

## Limitations

**Keys** must match `[\w][\w-]*`. No dots, spaces, slashes, colons. `encode()` throws on bad keys.

**Strings** round-trip correctly including empty strings, scalar-lookalikes (`"null"`, `"42"`), whitespace, backslashes, newlines. Two escape conventions:
- Scalar context (key:value): backslash escaping (`\\`, `\"`, `\n`)
- Cell context (tabular rows): RFC 4180 doubling (`""`) + `\n`

**Empty root object** encodes as `{}`.

## Files

```
index.ts      MCP server, 4 tools
lean.ts       LEAN encoder/decoder + token estimation
toon.ts       TOON encoder/decoder (used in stats comparison)
test.mjs      tests
dist/         compiled output
```

## License

MIT
