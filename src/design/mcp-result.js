// OpenROAD-MCP puts failures in JSON content.error and does not reliably set
// MCP isError. Keep transport, command, and completeness failures distinct.
export function mcpResult(response) {
  if (response.error || response.result?.isError)
    return {
      verdict: "fail",
      error: response.error?.message || "MCP tool returned isError",
    };
  const result = response.result,
    payloads = [];
  if (result?.structuredContent && typeof result.structuredContent === "object")
    payloads.push(result.structuredContent);
  for (const content of result?.content || [])
    if (content.type === "text") {
      try {
        const data = JSON.parse(content.text);
        if (data && typeof data === "object" && !Array.isArray(data))
          payloads.push(data);
      } catch {
        /* Other content remains available in the exact transcript. */
      }
    }
  const error = payloads.find(
    (p) => Object.hasOwn(p, "error") && p.error !== null,
  );
  if (error)
    return { verdict: "fail", error: String(error.error), payload: error };
  const payload = payloads.find((p) => Object.hasOwn(p, "error"));
  if (!payload)
    return {
      verdict: "inconclusive",
      error: "Missing OpenROAD-MCP JSON error contract",
    };
  if (payloads.some((p) => p.truncated === true || p.bytes_discarded > 0))
    return {
      verdict: "inconclusive",
      error: "MCP response is truncated",
      payload,
    };
  return { verdict: "pass", payload };
}
