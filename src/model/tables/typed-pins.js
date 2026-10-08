// Positioned NAME / NO. / TYPE / DESCRIPTION tables with a local I = Input
// legend. A name or descriptive word alone never establishes pin direction.
export function typedInputs(page, label) {
  const lines = page.layoutLines || [],
    declarations = [];
  const inputRole = lines.some((line) =>
    /^\(\d+\)\s+Signal Types:\s*I\s*=\s*Input,\s*O\s*=\s*Output(?:,\s*G\s*=\s*Ground)?(?:,\s*P\s*=\s*Power)\.$/.test(
      line.cells.map((cell) => cell.text).join(" "),
    ),
  );
  for (let index = 0; index < lines.length; index++) {
    const cells = lines[index].cells;
    const name = cells.find((cell) => cell.text === "NAME"),
      pin = cells.find((cell) => cell.text === "NO.");
    if (!name || !pin) continue;
    const headings = lines
      .slice(Math.max(0, index - 2), index + 1)
      .flatMap((line) => line.cells);
    const type = headings.find((cell) => /^TYPE(?:\(\d+\))?$/.test(cell.text)),
      description = headings.find((cell) => cell.text === "DESCRIPTION");
    if (
      !type ||
      !description ||
      !(name.x < pin.x && pin.x < type.x && type.x < description.x)
    )
      continue;
    const centers = [name, pin, type, description].map(
      (cell) => cell.x + cell.width / 2,
    );
    const boundaries = centers
      .slice(1)
      .map((value, at) => (value + centers[at]) / 2);
    for (const line of lines.slice(index + 1)) {
      const text = line.cells.map((cell) => cell.text).join(" ");
      if (
        /^\(\d+\)|Copyright|Product Folder Links:|^\d+(?:\.\d+)*\s+[A-Za-z]/.test(
          text,
        )
      )
        break;
      const group = [[], [], [], []];
      for (const cell of line.cells) {
        const center = cell.x + cell.width / 2;
        const column = boundaries.findIndex((boundary) => center < boundary);
        group[column < 0 ? 3 : column].push(cell.text);
      }
      if (group[0].join(" ") !== label) continue;
      declarations.push({
        page: page.number,
        pin: group[1].join(" "),
        description: group[3].join(" "),
        valid:
          /^\d+$/.test(group[1].join(" ")) &&
          group[2].join(" ") === "I" &&
          inputRole &&
          !/\b(?:output|bidirectional)\b/i.test(group[3].join(" ")),
      });
    }
  }
  return declarations;
}
