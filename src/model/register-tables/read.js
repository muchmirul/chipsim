// Structural extraction only. Access rights/default patterns do not establish
// writable masks, side effects, pin behavior, reset domains or bus semantics.
import { hasRegisterTable } from "../../documents/layout.js";
export { hasRegisterTable } from "../../documents/layout.js";
const textOf = (line) =>
  line.cells
    .map((cell) => cell.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
const headerGroups = (line) => {
  const groups = [];
  for (const cell of line.cells) {
    const last = groups.at(-1);
    if (last && cell.x - last.right <= 8) {
      last.text += " " + cell.text;
      last.right = cell.x + cell.width;
    } else
      groups.push({
        text: cell.text,
        x: cell.x,
        right: cell.x + cell.width,
        y: line.y,
      });
  }
  return groups.map((group) => ({
    ...group,
    text: group.text.replace(/\s+/g, " ").trim(),
    center: (group.x + group.right) / 2,
  }));
};
const literalByte = /^0[x×][\da-f]{1,2}$/i;
const stop =
  /^(?:Table\s+[\w.-]+\.|\d+(?:\.\d+)+\s+\S|Copyright\b|Product Folder Links:|Submit (?:Document|Documentation) Feedback|www\.|©)/i;
function readTable(document, page, start) {
  const lines = page.layoutLines,
    caption = textOf(lines[start]);
  if (
    !/^Table\s+[\w.-]+\.\s*(?:Command Byte(?: Table)?|Register Map)$/i.test(
      caption,
    )
  )
    throw new Error(
      "Register table caption has unsupported qualifications or continuation.",
    );
  let end = start + 1;
  while (end < lines.length && !stop.test(textOf(lines[end]))) end++;
  const dataStart = lines.findIndex(
    (line, index) =>
      index > start &&
      index < end &&
      line.cells.some((cell) => literalByte.test(cell.text.trim())),
  );
  if (dataStart < 0 || dataStart - start > 5)
    throw new Error(
      "Register table needs literal byte addresses directly below positioned headers.",
    );
  const header = lines.slice(start + 1, dataStart).flatMap(headerGroups);
  const one = (pattern, label) => {
    const matches = header.filter((item) => pattern.test(item.text));
    if (matches.length !== 1)
      throw new Error(
        "Register table requires one positioned " + label + " heading.",
      );
    return matches[0];
  };
  const name = one(/^REGISTER$/i, "REGISTER"),
    protocol = one(/^PROTOCOL$/i, "PROTOCOL");
  const addressBase = one(
    /^(?:COMMAND(?: BYTE(?: \(HEX\))?)?|ADDRESS(?: \(HEX\))?)$/i,
    "hex address",
  );
  const addressParts = header.filter(
    (item) =>
      Math.abs(item.center - addressBase.center) <= 2.5 &&
      Math.abs(item.y - addressBase.y) <= 20 &&
      /^(?:COMMAND(?: BYTE(?: \(HEX\))?)?|ADDRESS(?: \(HEX\))?|BYTE \(HEX\)|\(HEX\))$/i.test(
        item.text,
      ),
  );
  const addressLabel = addressParts
    .sort((a, b) => a.y - b.y)
    .map((item) => item.text)
    .join(" ");
  if (!/^(?:COMMAND BYTE|ADDRESS) \(HEX\)$/i.test(addressLabel))
    throw new Error(
      "Register addresses require a complete explicit HEX heading.",
    );
  const defaultBase = one(/^POWER-UP(?: DEFAULT)?$/i, "POWER-UP DEFAULT");
  const defaultParts = header.filter(
    (item) =>
      Math.abs(item.center - defaultBase.center) <= 2.5 &&
      Math.abs(item.y - defaultBase.y) <= 20 &&
      /^(?:POWER-UP(?: DEFAULT)?|DEFAULT)$/i.test(item.text),
  );
  if (
    defaultParts
      .sort((a, b) => a.y - b.y)
      .map((item) => item.text)
      .join(" ")
      .toUpperCase() !== "POWER-UP DEFAULT"
  )
    throw new Error(
      "Register table requires the complete POWER-UP DEFAULT heading.",
    );
  const controls = header
    .filter((item) => /^B\d$/.test(item.text))
    .sort((a, b) => a.center - b.center);
  const controlGroups = header.filter((item) =>
    /^CONTROL REGISTER BITS$/i.test(item.text),
  );
  if (
    Boolean(controls.length) !== Boolean(controlGroups.length) ||
    controlGroups.length > 1 ||
    controls.length > 4 ||
    controls.some(
      (item, index) => item.text !== "B" + (controls.length - 1 - index),
    )
  )
    throw new Error(
      "Control bit columns must be a complete descending Bn…B0 group of at most four bits.",
    );
  if (
    controls.length &&
    controls.some(
      (item) =>
        item.center < controlGroups[0].x - 2.5 ||
        item.center > controlGroups[0].right + 2.5,
    )
  )
    throw new Error("Control bit headings fall outside their declared group.");
  const consumed = new Set([
    name,
    protocol,
    ...addressParts,
    ...defaultParts,
    ...controls,
    ...controlGroups,
  ]);
  if (header.some((item) => !consumed.has(item)))
    throw new Error(
      "Register table has unsupported or ambiguous header columns.",
    );
  const roles = [addressBase, name, protocol, defaultBase];
  if (
    roles.some(
      (role, index) => index && role.center - roles[index - 1].center < 20,
    ) ||
    controls.some((item) => item.center >= addressBase.center)
  )
    throw new Error(
      "Register columns must be distinct and ordered address/register/protocol/default.",
    );
  const boundaries = [
    controls.length
      ? (controls.at(-1).center + addressBase.center) / 2
      : -Infinity,
    ...roles
      .slice(1)
      .map((role, index) => (role.center + roles[index].center) / 2),
    Infinity,
  ];
  const rows = [],
    addresses = new Set(),
    names = new Set(),
    combinations = new Set();
  for (const line of lines.slice(dataStart, end)) {
    const fields = [[], [], [], []],
      bits = [];
    for (const cell of line.cells) {
      const center = cell.x + cell.width / 2;
      if (center < boundaries[0]) {
        const control = controls.findIndex(
          (item) => Math.abs(item.center - center) <= 2.5,
        );
        if (
          control < 0 ||
          bits[control] !== undefined ||
          !/^[01]$/.test(cell.text)
        )
          throw new Error(
            "Register row has missing or unsupported control-bit cells.",
          );
        bits[control] = Number(cell.text);
        continue;
      }
      const column =
        boundaries.findIndex((right, index) => index > 0 && center < right) - 1;
      if (
        column < 0 ||
        cell.x < boundaries[column] - 2 ||
        cell.x + cell.width > boundaries[column + 1] + 2
      )
        throw new Error("Register cell crosses a column boundary.");
      fields[column].push(cell.text);
    }
    if (
      controls.length &&
      (bits.length !== controls.length ||
        controls.some((_, index) => bits[index] === undefined))
    )
      throw new Error("Register row lacks a declared control bit.");
    const [rawAddress, rawName, rawProtocol, rawDefault] = fields.map((field) =>
      field.join(" ").replace(/\s+/g, " ").trim(),
    );
    if (
      !literalByte.test(rawAddress) ||
      !rawName ||
      rawName.length > 160 ||
      /[\x00-\x1f\x7f]/.test(rawName)
    )
      throw new Error(
        "Register rows require one literal byte address and a nonempty name.",
      );
    const address = parseInt(rawAddress.slice(2), 16),
      key = rawName.toLowerCase();
    if (addresses.has(address) || names.has(key))
      throw new Error("Register table has duplicate names or addresses.");
    const resetBits = rawDefault.replace(/\s/g, "").toUpperCase();
    if (
      !/^[01X]{8}$/.test(resetBits) ||
      !/^(?:Read|Read\/write) byte$/i.test(rawProtocol)
    )
      throw new Error(
        "Register rows require explicit byte access and complete eight-bit 0/1/X defaults.",
      );
    if (controls.length) {
      const combination = bits.reduce((value, bit) => value * 2 + bit, 0);
      if (
        combination !== address % 2 ** controls.length ||
        combinations.has(combination)
      )
        throw new Error(
          "Control bits disagree with the byte address or repeat a combination.",
        );
      combinations.add(combination);
    }
    addresses.add(address);
    names.add(key);
    rows.push({
      name: rawName,
      address,
      access: /^Read byte$/i.test(rawProtocol) ? "ro" : "rw",
      reset: resetBits.includes("X") ? null : parseInt(resetBits, 2),
      resetBits,
      protocol: rawProtocol,
    });
  }
  if (
    !rows.length ||
    rows.length > 16 ||
    (controls.length && rows.length !== 2 ** controls.length)
  )
    throw new Error(
      "Register table requires 1–16 complete rows and every declared control-bit combination.",
    );
  return {
    id:
      "register-table-" +
      document.sha256.slice(0, 12) +
      "-p" +
      page.number +
      "-t" +
      caption.match(/^Table\s+([\w.-]+)/i)[1].replace(/\.$/, ""),
    page: page.number,
    caption,
    quote: caption,
    width: 8,
    rows,
    reviewRequired: true,
  };
}
export function readRegisterTables(document) {
  const tables = [],
    diagnostics = [];
  if (
    !document ||
    !/^[a-f0-9]{64}$/.test(document.sha256 || "") ||
    !Array.isArray(document.pages)
  )
    return {
      tables,
      diagnostics: [{ reason: "Register-table source metadata is invalid." }],
    };
  for (const page of document.pages) {
    if (
      !page ||
      !Number.isInteger(page.number) ||
      page.number < 1 ||
      page.number > 20000 ||
      typeof page.text !== "string"
    ) {
      diagnostics.push({ reason: "Register-table page metadata is invalid." });
      continue;
    }
    if (!hasRegisterTable(page.text || "")) continue;
    const lines = page.layoutLines;
    if (
      !Array.isArray(lines) ||
      !lines.length ||
      lines.length > 5000 ||
      lines.some(
        (line, index) =>
          !line ||
          typeof line !== "object" ||
          !Number.isFinite(line.y) ||
          !Array.isArray(line.cells) ||
          line.cells.length > 512 ||
          (index && line.y < lines[index - 1].y) ||
          line.cells.some(
            (cell, i) =>
              !cell ||
              typeof cell !== "object" ||
              typeof cell.text !== "string" ||
              cell.text.length > 2000 ||
              !Number.isFinite(cell.x) ||
              !Number.isFinite(cell.width) ||
              cell.width <= 0 ||
              (i && cell.x < line.cells[i - 1].x),
          ),
      )
    ) {
      diagnostics.push({
        page: page.number,
        reason:
          "Register-table geometry is unavailable or invalid; no register draft was extracted.",
      });
      continue;
    }
    for (let index = 0; index < lines.length; index++)
      if (hasRegisterTable(textOf(lines[index]))) {
        try {
          tables.push(readTable(document, page, index));
        } catch (error) {
          diagnostics.push({
            page: page.number,
            caption: textOf(lines[index]),
            reason: error.message,
          });
        }
      }
  }
  if (document.registerScanLimit)
    diagnostics.push({
      reason:
        "Register-table geometry scan was limited to " +
        document.registerScanLimit +
        " pages.",
    });
  return { tables, diagnostics };
}

export function registerDraftRows(table) {
  const names = new Set();
  return table.rows
    .map((row) => {
      const name = row.name
        .replace(/[^A-Za-z0-9_]+/g, "_")
        .replace(/^_+|_+$/g, "");
      if (
        !/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(name) ||
        names.has(name.toLowerCase())
      )
        throw new Error(
          "Register names need explicit unique aliases before creating a bank.",
        );
      names.add(name.toLowerCase());
      return `${name} 0x${row.address.toString(16).toUpperCase().padStart(2, "0")} ${row.access} ${row.reset === null ? "?" : "0x" + row.reset.toString(16).toUpperCase().padStart(2, "0")} ?`;
    })
    .join("; ");
}
