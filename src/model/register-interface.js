// This metadata describes a transaction adapter, not register side effects.
// Reads, writes, reset, and interrupts remain executable model actions.
export function validateRegisterInterface(
  model,
  { fail, number, definitions },
) {
  if (model.registerInterface === undefined && model.registerMap === undefined)
    return;
  const bus = model.registerInterface;
  if (!bus || bus.kind !== "toggle-word-v1") {
    fail("registerInterface", "expected a toggle-word-v1 interface");
    return;
  }
  const fields = {
    address: "input",
    writeData: "input",
    write: "input",
    request: "input",
    readData: "output",
    valid: "output",
    error: "output",
  };
  for (const [field, direction] of Object.entries(fields)) {
    const signal = definitions.signals.get(bus[field]);
    if (!signal || signal.direction !== direction || signal.triState)
      fail(
        "registerInterface." + field,
        "must name a numeric " + direction + " signal",
      );
    if (
      ["write", "request", "valid", "error"].includes(field) &&
      signal?.width !== 1
    )
      fail("registerInterface." + field, "must be one bit");
  }
  const dataWidth = definitions.signals.get(bus.writeData)?.width;
  if (definitions.signals.get(bus.readData)?.width !== dataWidth)
    fail("registerInterface", "read and write data widths must match");
  if (new Set(Object.keys(fields).map((field) => bus[field])).size !== 7)
    fail(
      "registerInterface",
      "each interface field must name a distinct signal",
    );
  if (
    !Array.isArray(model.registerMap) ||
    !model.registerMap.length ||
    model.registerMap.length > 128
  ) {
    fail("registerMap", "expected 1–128 addressed registers");
    return;
  }
  const addresses = new Set();
  for (const [index, item] of model.registerMap.entries()) {
    const path = `registerMap[${index}]`;
    if (!item || typeof item !== "object") {
      fail(path, "expected a register entry");
      continue;
    }
    number(
      item.address,
      path + ".address",
      0,
      2 ** (definitions.signals.get(bus.address)?.width || 1) - 1,
    );
    if (addresses.has(item.address))
      fail(path + ".address", "duplicate address");
    addresses.add(item.address);
    if (
      typeof item.name !== "string" ||
      !item.name.trim() ||
      item.name.length > 160
    )
      fail(path + ".name", "expected a name of 1–160 characters");
    if (!["ro", "rw", "wo"].includes(item.access))
      fail(path + ".access", "use ro, rw, or wo");
    const match = /^(reg|signal)\.([a-zA-Z][\w-]*)$/.exec(item.value || "");
    const target =
      match &&
      definitions[match[1] === "reg" ? "registers" : "signals"].get(match[2]);
    if (item.access === "wo") {
      if (item.value !== undefined)
        fail(
          path + ".value",
          "omit value for a write-only action; no readback is declared",
        );
    } else if (
      !target ||
      target.width !== dataWidth ||
      target.triState ||
      (match?.[1] === "signal" && target.direction !== "output")
    )
      fail(
        path + ".value",
        "must reference a numeric register or output of the interface data width",
      );
    if (
      !Array.isArray(item.evidence) ||
      !item.evidence.length ||
      item.evidence.length > 16 ||
      item.evidence.some((id) => !definitions.evidence.has(id))
    )
      fail(path + ".evidence", "cite 1–16 declared evidence IDs");
  }
}
