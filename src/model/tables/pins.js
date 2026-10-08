const indexed = (label) => /^n[A-Za-z][\w]*$/.test(label);
// A single explicitly declared input pin can be shared between indexed
// channels. Read its column role, rather than inferring it from its name.
function inputDeclarations(page, label) {
  const lines = page.layoutLines || [],
    declarations = [];
  for (let index = 0; index < lines.length; index++) {
    const cells = lines[index].cells;
    const symbol = cells.find((cell) => cell.text === "Symbol"),
      pin = cells.find((cell) => cell.text === "Pin"),
      description = cells.find((cell) => cell.text === "Description");
    if (
      !symbol ||
      !pin ||
      !description ||
      !(symbol.x < pin.x && pin.x < description.x)
    )
      continue;
    for (const line of lines.slice(index + 1)) {
      const text = line.cells
        .map((cell) => cell.text)
        .join(" ")
        .trim();
      if (/^(?:Table\s|\d+(?:\.\d+)*\.?\s+[A-Za-z])/.test(text)) break;
      const group = [[], [], []];
      for (const cell of line.cells)
        group[
          cell.x >= description.x - 2 ? 2 : cell.x >= pin.x - 2 ? 1 : 0
        ].push(cell.text);
      if (group[0].join(" ") === label)
        declarations.push({
          page: page.number,
          pin: group[1].join(" "),
          valid:
            /^\d+$/.test(group[1].join(" ")) &&
            /\binputs?\b/i.test(group[2].join(" ")) &&
            !/\b(?:outputs?|bidirectional)\b/i.test(group[2].join(" ")),
        });
    }
  }
  return declarations;
}
export function instancesFor(document, table) {
  const labels = [...table.inputs, ...table.outputs];
  const indexedLabels = labels.filter(indexed),
    shared = table.inputs.filter((label) => !indexed(label));
  if (!indexedLabels.length)
    return { instances: [{ key: "one", labels }], indexed: false };
  const pages = document.pages.filter((page) =>
      /pin description/i.test(page.text),
    ),
    sets = [],
    pinPages = new Set();
  for (const label of indexedLabels) {
    const suffix = label.slice(1),
      found = [];
    for (const page of pages) {
      const range = new RegExp(
        "\\b(\\d+)" + suffix + "\\s+to\\s+(\\d+)" + suffix + "\\b",
        "g",
      );
      for (const match of page.text.matchAll(range)) {
        pinPages.add(page.number);
        const low = Number(match[1]),
          high = Number(match[2]);
        if (high < low || high - low > 7)
          throw new Error("Indexed pin range exceeds supported bounds.");
        found.push(
          Array.from({ length: high - low + 1 }, (_, index) => low + index),
        );
      }
      const list = new RegExp(
        "\\b\\d+" + suffix + "(?:,\\s*\\d+" + suffix + ")+\\b",
        "g",
      );
      for (const match of page.text.matchAll(list)) {
        pinPages.add(page.number);
        found.push(
          match[0]
            .split(",")
            .map((pin) => Number(pin.trim().slice(0, -suffix.length))),
        );
      }
    }
    const unique = [...new Set(found.map((values) => JSON.stringify(values)))];
    if (unique.length > 1)
      throw new Error("Conflicting indexed pin sets require review.");
    sets.push(unique[0] ? JSON.parse(unique[0]) : null);
  }
  if (sets.every((set) => set === null))
    return { instances: [{ key: "generic", labels }], indexed: false };
  if (
    sets.some((set) => set === null) ||
    sets.some((set) => JSON.stringify(set) !== JSON.stringify(sets[0]))
  )
    throw new Error(
      "Not every indexed signal has the same documented instance set.",
    );
  if (table.outputs.some((label) => !indexed(label)))
    throw new Error(
      "A shared output between indexed instances requires review.",
    );
  for (const label of shared) {
    const declarations = pages.flatMap((page) =>
      inputDeclarations(page, label),
    );
    if (
      !declarations.length ||
      declarations.some((declaration) => !declaration.valid) ||
      new Set(declarations.map((declaration) => declaration.pin)).size !== 1
    )
      throw new Error(
        "Shared control " +
          label +
          " requires a positioned pin description declaring one input pin.",
      );
    declarations.forEach((declaration) => pinPages.add(declaration.page));
  }
  return {
    instances: sets[0].map((index) => ({
      key: "channel_" + index,
      labels: labels.map((label) =>
        indexed(label) ? index + label.slice(1) : label,
      ),
    })),
    indexed: true,
    pinPages: [...pinPages].sort((a, b) => a - b),
    shared,
  };
}
