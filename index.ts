#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { encode, decode, LeanParseError, estimateTokens } from "./lean.js";
import type { LeanValue } from "./lean.js";
import { encode as toonEncode } from "./toon.js";

const VERSION = "2.0.0";

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

type TextResult = {
  content: [{ type: "text"; text: string }];
};

type ErrorResult = TextResult & {
  isError: true;
};

const LeanValueSchema: z.ZodType<LeanValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(LeanValueSchema),
    z.record(z.string(), LeanValueSchema),
  ])
);

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

function jsonText(value: LeanValue, pretty: boolean): string {
  return pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
}

function selectBestFormat(data: LeanValue): { format: "lean" | "json"; text: string; jsonTokens: number; leanTokens: number } {
  const jsonCompact = JSON.stringify(data);
  const leanText = encode(data);
  const jsonTokens = estimateTokens(jsonCompact);
  const leanTokens = estimateTokens(leanText);
  if (leanTokens < jsonTokens) {
    return { format: "lean", text: leanText, jsonTokens, leanTokens };
  }
  return { format: "json", text: jsonCompact, jsonTokens, leanTokens };
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

  if (selection.jsonTokens === 0 || selection.leanTokens === 0) {
    const selectedTokens =
      selection.format === "lean" ? selection.leanTokens : selection.jsonTokens;
    parts.push(`[${selection.format.toUpperCase()}: ~${selectedTokens} tokens]`);
    return parts.join("\n");
  }

  if (selection.format === "lean") {
    const savedPct = Math.round(
      ((selection.jsonTokens - selection.leanTokens) / selection.jsonTokens) * 100
    );
    parts.push(
      `[LEAN selected: ~${selection.leanTokens} tokens, ${savedPct}% saved vs JSON compact (~${selection.jsonTokens} tokens)]`
    );
    return parts.join("\n");
  }

  parts.push(
    `[JSON selected: ~${selection.jsonTokens} tokens, LEAN would be ~${selection.leanTokens} tokens]`
  );
  return parts.join("\n");
}

const EncodeInputSchema = z
  .object({
    data: LeanValueSchema.describe(
      "Any JSON value to encode: object, array, string, number, boolean, or null."
    ),
  })
  .strict();

server.registerTool(
  "lean_encode",
  {
    title: "Encode Data to LEAN",
    description: `Convert any JSON value to LEAN format for token-efficient LLM context.

Accepts objects, arrays, strings, numbers, booleans, and null at root.
LEAN typically saves ~49% tokens vs JSON on average, with best results on tabular data.
Uses tab-delimited tables, dot-flattened keys, and single-char literals (T/F/_).
Object keys must be word characters or hyphens (no dots, spaces, slashes, or colons).
NaN and Infinity are rejected (not representable in LEAN).

Args:
  - data (any JSON value): Value to convert — object, array, string, number, boolean, or null

Returns:
  LEAN-encoded text representation of the data.

Examples:
  - {"data": {"users": [{"id":1,"name":"Alice"}]}} → tabular LEAN
  - {"data": [1, 2, 3]} → flat array LEAN
  - {"data": "hello"} → quoted root string`,
    inputSchema: EncodeInputSchema,
    annotations: TOOL_ANNOTATIONS,
  },
  async (params: z.infer<typeof EncodeInputSchema>) => {
    try {
      return textResult(encode(params.data));
    } catch (error) {
      return errorResult("Encoding error", error);
    }
  }
);

const DecodeInputSchema = z
  .object({
    lean: z.string().describe("LEAN-formatted text to decode back to JSON."),
    pretty: z
      .boolean()
      .default(true)
      .describe("Pretty-print the JSON output with 2-space indentation."),
  })
  .strict();

server.registerTool(
  "lean_decode",
  {
    title: "Decode LEAN to JSON",
    description: `Convert LEAN-formatted text back to any JSON value.

Lossless round-trip: decode(encode(data)) === data for any supported value
(objects, arrays, strings, numbers, booleans, null).
Root strings are disambiguated from scalars by quoting.
Duplicate object keys and tabular field names are rejected.

Args:
  - lean (string): LEAN text to decode
  - pretty (boolean): Pretty-print output (default: true)

Returns:
  JSON string of the decoded value (may be object, array, or primitive).`,
    inputSchema: DecodeInputSchema,
    annotations: TOOL_ANNOTATIONS,
  },
  async (params: z.infer<typeof DecodeInputSchema>) => {
    try {
      const result = decode(params.lean);
      return textResult(jsonText(result, params.pretty));
    } catch (error) {
      return errorResult("Decode error", error);
    }
  }
);

const StatsInputSchema = z
  .object({
    data: LeanValueSchema.describe(
      "Any JSON value to analyze for token efficiency comparison."
    ),
  })
  .strict();

server.registerTool(
  "lean_stats",
  {
    title: "LEAN Token Statistics",
    description: `Compare token usage across formats for any JSON value.

Shows estimated token counts for: JSON compact, JSON pretty, LEAN.
Baseline is JSON compact (minified) — the realistic production format.
Dynamically recommends the most token-efficient format for this specific data.
LEAN averages ~49% token savings vs JSON.

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
      const leanText = encode(data);

      let toonText: string | null = null;
      try {
        toonText = toonEncode(data as any, { delimiter: "|" });
      } catch {}

      const formats: { name: string; text: string }[] = [
        { name: "JSON (compact)", text: jsonCompact },
        { name: "JSON (pretty)", text: jsonPretty },
        { name: "LEAN", text: leanText },
      ];
      if (toonText !== null) formats.push({ name: "TOON (pipe)", text: toonText });

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
          "Recommended: JSON (compact) — already the most token-efficient for this data. LEAN works best on tabular data (arrays of uniform objects)."
        );
      } else {
        const savedPct = Math.round(
          ((baselineTokens - best.tokens) / baselineTokens) * 100
        );
        lines.push(
          `Recommended: ${best.name} — saves ${savedPct}% tokens vs JSON compact`
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
    data: LeanValueSchema.describe(
      "Any JSON value to format as LEAN. Typically the result of an API call or database query."
    ),
    label: z
      .string()
      .optional()
      .describe(
        "Optional label/header to prepend to the LEAN output (e.g., 'API Response', 'Query Results')."
      ),
  })
  .strict();

server.registerTool(
  "lean_format_response",
  {
    title: "Format Data for LLM Context",
    description: `Format any JSON value for injection into LLM context windows.

This tool compares compact JSON vs LEAN and returns whichever is more token-efficient
for the specific payload. LEAN averages ~49% token savings vs JSON, with best results
on tabular data; compact JSON can be smaller for small or irregular payloads.

Args:
  - data (any JSON value): Value to format
  - label (string, optional): Header label for the output

Returns:
  Either LEAN or compact JSON, optionally with a label header and token comparison note.

Examples:
  - Format a 100-row API response before adding to conversation
  - Convert database query results for compact storage
  - Prepare structured data for efficient multi-turn conversations`,
    inputSchema: FormatResponseInputSchema,
    annotations: TOOL_ANNOTATIONS,
  },
  async (params: z.infer<typeof FormatResponseInputSchema>) => {
    try {
      const selection = selectBestFormat(params.data);
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
