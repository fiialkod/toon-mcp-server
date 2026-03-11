# toon-mcp-server

MCP server for encoding/decoding [TOON format](https://github.com/nicholasgasior/toon) — a token-efficient alternative to JSON for structured data in LLM context windows.

## Why?

JSON wastes a lot of tokens on syntax — braces, brackets, repeated key names, quotes. That adds up in context windows. TOON saves 30-60% on tabular data by declaring field names once, using indentation instead of braces, and quoting only when necessary.

## Tools

- **`toon_encode`** — JSON value -> TOON
- **`toon_decode`** — TOON -> JSON value
- **`toon_stats`** — compare token counts across formats
- **`toon_format_response`** — picks whichever format is smaller (TOON or compact JSON), adds metadata

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

## Delimiters

`pipe` (default, `|`) — usually needs no quoting, visible in editors.
`comma` (`,`) — standard TOON compat.
`tab` (`\t`) — most compact, invisible in some editors.

`strict` flag forces all strings to be quoted regardless.

## Limitations

**Keys** must match `[\w][\w.-]*`. No spaces, slashes, colons. `encode()` throws on bad keys.

**Strings** round-trip correctly including empty strings, scalar-lookalikes (`"null"`, `"42"`), whitespace, backslashes, newlines. Two escape conventions:
- Scalar context (key: value): backslash escaping (`\\`, `\"`, `\n`)
- Cell context (tabular rows): RFC 4180 doubling (`""`) + `\n`

**Empty root object** encodes as `{}`.

## Files

```
index.ts      MCP server, 4 tools
toon.ts       encoder/decoder + format selection
test.mjs      tests
dist/         compiled output
```

## License

MIT
