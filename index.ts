#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { decode, encode, estimateTokens, selectBestFormat } from "./toon.js";
import type { EncodeOptions, ToonValue } from "./toon.js";

const VERSION = "1.2.0";

const server = new McpServer({
  name: "toon-mcp-server",
  version: VERSION,
});

const TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const DELIMITER_OPTIONS = ["comma", "pipe", "tab"] as const;
type DelimiterOption = (typeof DELIMITER_OPTIONS)[number];

type TextResult = {
  content: [{ type: "text"; text: string }];
};

type ErrorResult = TextResult & {
  isError: true;
};

// Recursive zod type so we don't need `as ToonValue` casts.
const ToonValueSchema: z.ZodType<ToonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(ToonValueSchema),
    z.record(z.string(), ToonValueSchema),
  ])
);

function resolveDelimiter(option: DelimiterOption): string {
  switch (option) {
    case "pipe":
      return "|";
    case "tab":
      return "\t";
    default:
      return ",";
  }
}

function delimiterField(description: string) {
  return z.enum(DELIMITER_OPTIONS).default("pipe").describe(description);
}

function textResult(text: string): TextResult {
  return {
    content: [{ type: "text", text }],
  };
}

function errorResult(prefix: string, error: unknown, hint?: string): ErrorResult {
  const message = `${prefix}: ${error instanceof Error ? error.message : String(error)}`;
  return {
    isError: true,
    content: [{ type: "text", text: hint ? `${message}. ${hint}` : message }],
  };
}

function jsonText(value: ToonValue, pretty: boolean): string {
  return pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
}

function formatContextResponse(
  selection: ReturnType<typeof selectBestFormat>,
  label?: string
): string {
  const parts: string[] = [];

  if (label) {
    parts.push(`# ${label}`);
    parts.push("");
  }

  parts.push(selection.text);
  parts.push("");

  if (selection.jsonTokens === 0 || selection.toonTokens === 0) {
    const selectedTokens =
      selection.format === "toon" ? selection.toonTokens : selection.jsonTokens;
    parts.push(`[${selection.format.toUpperCase()}: ~${selectedTokens} tokens]`);
    return parts.join("\n");
  }

  if (selection.format === "toon") {
    const savedPct = Math.round(
      ((selection.jsonTokens - selection.toonTokens) / selection.jsonTokens) * 100
    );
    parts.push(
      `[TOON selected: ~${selection.toonTokens} tokens, ${savedPct}% saved vs JSON compact (~${selection.jsonTokens} tokens)]`
    );
    return parts.join("\n");
  }

  parts.push(
    `[JSON selected: ~${selection.jsonTokens} tokens, TOON would be ~${selection.toonTokens} tokens]`
  );
  return parts.join("\n");
}

const EncodeInputSchema = z
  .object({
    data: ToonValueSchema.describe(
      "Any JSON value to encode: object, array, string, number, boolean, or null."
    ),
    delimiter: delimiterField(
      "Delimiter between tabular values. 'pipe' (|) recommended — usually minimal quoting needed. 'comma' for standard TOON. 'tab' for maximum token efficiency. Delimiter must not contain characters valid in keys (word chars, hyphens, dots)."
    ),
    strict: z
      .boolean()
      .default(false)
      .describe(
        "Always quote string values in tabular rows regardless of delimiter. Eliminates all delimiter ambiguity at ~11% token cost."
      ),
  })
  .strict();

server.registerTool(
  "toon_encode",
  {
    title: "Encode Data to TOON",
    description: `Convert any JSON value to TOON format for token-efficient LLM context.

Accepts objects, arrays, strings, numbers, booleans, and null at root.
TOON typically saves 30-60% tokens vs JSON for tabular data (arrays of uniform objects).
Savings vary by structure — deeply nested configs with no arrays may see little benefit.
String values containing the delimiter are automatically quoted (RFC 4180 style).
Object keys must be word characters, hyphens, or dots (no spaces, slashes, or colons).
NaN and Infinity are rejected (not representable in TOON).

Args:
  - data (any JSON value): Value to convert — object, array, string, number, boolean, or null
  - delimiter ('comma' | 'pipe' | 'tab'): Separator for tabular values (default: 'pipe')
  - strict (boolean): Always quote strings in tabular rows regardless of delimiter (default: false)

Returns:
  TOON-encoded text representation of the data.

Examples:
  - {"data": {"users": [{"id":1,"name":"Alice"}]}} → tabular TOON
  - {"data": [1, 2, 3]} → flat array TOON
  - {"data": "hello"} → quoted root string`,
    inputSchema: EncodeInputSchema,
    annotations: TOOL_ANNOTATIONS,
  },
  async (params: z.infer<typeof EncodeInputSchema>) => {
    try {
      const options: EncodeOptions = {
        strict: params.strict,
        delimiter: resolveDelimiter(params.delimiter),
      };
      return textResult(encode(params.data, options));
    } catch (error) {
      return errorResult("Encoding error", error);
    }
  }
);

const DecodeInputSchema = z
  .object({
    toon: z.string().describe("TOON-formatted text to decode back to JSON."),
    delimiter: delimiterField(
      "Delimiter used in the TOON input. Must match the delimiter used during encoding."
    ),
    pretty: z
      .boolean()
      .default(true)
      .describe("Pretty-print the JSON output with 2-space indentation."),
  })
  .strict();

server.registerTool(
  "toon_decode",
  {
    title: "Decode TOON to JSON",
    description: `Convert TOON-formatted text back to any JSON value.

Lossless round-trip: decode(encode(data)) === data for any supported value
(objects, arrays, strings, numbers, booleans, null).
Root strings are disambiguated from scalars by quoting.
Duplicate object keys and tabular field names are rejected.

Args:
  - toon (string): TOON text to decode
  - delimiter ('comma' | 'pipe' | 'tab'): Delimiter used in the TOON (default: 'pipe')
  - pretty (boolean): Pretty-print output (default: true)

Returns:
  JSON string of the decoded value (may be object, array, or primitive).`,
    inputSchema: DecodeInputSchema,
    annotations: TOOL_ANNOTATIONS,
  },
  async (params: z.infer<typeof DecodeInputSchema>) => {
    try {
      const result = decode(params.toon, resolveDelimiter(params.delimiter));
      return textResult(jsonText(result, params.pretty));
    } catch (error) {
      return errorResult(
        "Decode error",
        error,
        "Check that the delimiter matches the one used during encoding."
      );
    }
  }
);

const StatsInputSchema = z
  .object({
    data: ToonValueSchema.describe(
      "Any JSON value to analyze for token efficiency comparison."
    ),
  })
  .strict();

server.registerTool(
  "toon_stats",
  {
    title: "TOON Token Statistics",
    description: `Compare token usage across formats for any JSON value.

Shows estimated token counts for: JSON compact, JSON pretty, TOON (comma), TOON (pipe), TOON (tab).
Baseline is JSON compact (minified) — the realistic production format.
Dynamically recommends the most token-efficient format for this specific data.

Args:
  - data (any JSON value): Value to analyze

Returns:
  Token count comparison table with savings percentages and a best-format recommendation.`,
    inputSchema: StatsInputSchema,
    annotations: TOOL_ANNOTATIONS,
  },
  async (params: z.infer<typeof StatsInputSchema>) => {
    try {
      const data = params.data;

      const jsonPretty = JSON.stringify(data, null, 2);
      const jsonCompact = JSON.stringify(data);
      const toonComma = encode(data, { delimiter: "," });
      const toonPipe = encode(data, { delimiter: "|" });
      const toonTab = encode(data, { delimiter: "\t" });
      const toonStrict = encode(data, { delimiter: ",", strict: true });

      const formats = [
        { name: "JSON (compact)", text: jsonCompact },
        { name: "JSON (pretty)", text: jsonPretty },
        { name: "TOON (comma)", text: toonComma },
        { name: "TOON (comma, strict)", text: toonStrict },
        { name: "TOON (pipe)", text: toonPipe },
        { name: "TOON (tab)", text: toonTab },
      ];

      const stats = formats.map((format) => ({
        name: format.name,
        tokens: estimateTokens(format.text),
        chars: format.text.length,
      }));

      const baselineTokens = stats[0].tokens;
      const lines = [
        "Token Efficiency Comparison (baseline: JSON compact)",
        "═".repeat(64),
        "",
      ];

      for (const stat of stats) {
        let savings = "(baseline)";
        if (stat.name !== "JSON (compact)") {
          if (baselineTokens === 0) {
            savings = "n/a";
          } else {
            const percent = ((stat.tokens - baselineTokens) / baselineTokens) * 100;
            savings = `${percent > 0 ? "+" : ""}${percent.toFixed(1)}%`;
          }
        }

        lines.push(
          `  ${stat.name.padEnd(24)} ${String(stat.tokens).padStart(6)} tokens  ${String(stat.chars).padStart(7)} chars  ${savings}`
        );
      }

      const best = stats.reduce((left, right) =>
        left.tokens <= right.tokens ? left : right
      );

      lines.push("");

      if (baselineTokens === 0 || best.tokens === 0) {
        lines.push("Payload too small to meaningfully compare formats.");
      } else if (best.name === "JSON (compact)") {
        lines.push(
          "Recommended: JSON (compact) — already the most token-efficient for this data. TOON works best on tabular data (arrays of uniform objects)."
        );
      } else {
        const savedPct = Math.round(
          ((baselineTokens - best.tokens) / baselineTokens) * 100
        );
        const note =
          best.name === "TOON (pipe)"
            ? ", usually minimal quoting overhead"
            : best.name === "TOON (tab)"
              ? ", most compact but invisible in some editors"
              : "";
        lines.push(
          `Recommended: ${best.name} — saves ${savedPct}% tokens vs JSON compact${note}`
        );
      }

      return textResult(lines.join("\n"));
    } catch (error) {
      return errorResult("Stats error", error);
    }
  }
);

const FormatResponseInputSchema = z
  .object({
    data: ToonValueSchema.describe(
      "Any JSON value to format as TOON. Typically the result of an API call or database query."
    ),
    label: z
      .string()
      .optional()
      .describe(
        "Optional label/header to prepend to the TOON output (e.g., 'API Response', 'Query Results')."
      ),
    delimiter: delimiterField("Delimiter for tabular values."),
  })
  .strict();

server.registerTool(
  "toon_format_response",
  {
    title: "Format Data for LLM Context",
    description: `Format any JSON value for injection into LLM context windows.

This tool compares compact JSON vs TOON and returns whichever is more token-efficient
for the specific payload. TOON often wins on tabular data; compact JSON can be smaller
for small or irregular payloads.

Args:
  - data (any JSON value): Value to format
  - label (string, optional): Header label for the output
  - delimiter ('comma' | 'pipe' | 'tab'): Tabular delimiter (default: 'pipe')

Returns:
  Either TOON or compact JSON, optionally with a label header and token comparison note.

Examples:
  - Format a 100-row API response before adding to conversation
  - Convert database query results for compact storage
  - Prepare structured data for efficient multi-turn conversations`,
    inputSchema: FormatResponseInputSchema,
    annotations: TOOL_ANNOTATIONS,
  },
  async (params: z.infer<typeof FormatResponseInputSchema>) => {
    try {
      const selection = selectBestFormat(params.data, {
        delimiter: resolveDelimiter(params.delimiter),
      });
      return textResult(formatContextResponse(selection, params.label));
    } catch (error) {
      return errorResult("Format error", error);
    }
  }
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`toon-mcp-server v${VERSION} running on stdio`);
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
