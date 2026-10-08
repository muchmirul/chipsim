const center = (word) => word.x + word.width / 2;
// A typographic suffix belongs to one header only when physically adjacent.
// This is not applied to data rows, where separate binary cells must stay separate.
export function signalSubscripts(words) {
  const result = [];
  for (let at = 0; at < words.length; at++) {
    const word = words[at],
      next = words[at + 1];
    if (
      /^[A-Za-z]+$/.test(word.text) &&
      /^\d{1,2}[A-Za-z]?$/.test(next?.text || "") &&
      Math.abs(next.x - word.x - word.width) <= 0.75
    ) {
      result.push({
        ...word,
        text: word.text + next.text,
        width: next.x + next.width - word.x,
      });
      at++;
    } else result.push(word);
  }
  return result;
}

// Exhaust all contiguous, nonempty partitions. Every role heading must center
// over its own columns within two PDF points; no nearest-heading assignment.
function partitions(names, roles) {
  const matches = [];
  function visit(at, role, ends) {
    if (role === roles.length) {
      if (at === names.length) matches.push(ends);
      return;
    }
    for (
      let end = at + 1;
      end <= names.length - (roles.length - role - 1);
      end++
    ) {
      const midpoint = (center(names[at]) + center(names[end - 1])) / 2;
      if (Math.abs(midpoint - center(roles[role])) <= 2)
        visit(end, role + 1, [...ends, end]);
    }
  }
  visit(0, 0, []);
  return matches;
}
function qualifiedRoles(words) {
  const roles = [];
  for (let at = 0; at < words.length; at++) {
    const word = words[at],
      next = words[at + 1];
    if (
      /^(?:Enable|Select)$/i.test(word.text) &&
      /^Inputs?$/i.test(next?.text || "")
    ) {
      roles.push({
        ...word,
        width: next.x + next.width - word.x,
        direction: "input",
      });
      at++;
    } else if (/^Inputs?$/i.test(word.text))
      roles.push({ ...word, direction: "input" });
    else if (/^Outputs?$/i.test(word.text))
      roles.push({ ...word, direction: "output" });
    else return null;
  }
  if (
    roles.length < 2 ||
    roles.length > 3 ||
    roles.at(-1).direction !== "output" ||
    roles.slice(0, -1).some((role) => role.direction !== "input")
  )
    return null;
  return roles;
}
export function centeredHeaders(lines, start, header, stop) {
  for (let at = start + 1; at < Math.min(lines.length, start + 12); at++) {
    if (stop(lines[at])) break;
    const words = header(lines[at]);
    let roles = qualifiedRoles(words),
      nameLine = at + 1,
      subgroups = null;
    let strict = words.some((word) => /^(?:Enable|Select)$/i.test(word.text));
    if (words.length === 1 && /^Inputs?$/i.test(words[0].text)) {
      const children = header(lines[at + 1] || { cells: [] });
      if (
        children.length !== 3 ||
        !/^Enable$/i.test(children[0].text) ||
        !/^Select$/i.test(children[1].text) ||
        !/^Outputs?$/i.test(children[2].text) ||
        lines[at + 1].y - lines[at].y > 16
      )
        continue;
      roles = [
        { ...words[0], direction: "input" },
        { ...children[2], direction: "output" },
      ];
      subgroups = children.slice(0, 2);
      nameLine = at + 2;
      strict = true;
    }
    if (!roles) continue;
    const names = header(lines[nameLine] || { cells: [] });
    if (
      !names.length ||
      names.length > 30 ||
      names.some((name) => !/^[A-Za-z][A-Za-z\d_]*$/.test(name.text))
    ) {
      if (strict)
        throw new Error(
          "Centered group headers require a complete signal-name row.",
        );
      continue;
    }
    const candidates = partitions(names, roles).flatMap((ends) =>
      subgroups
        ? partitions(names.slice(0, ends[0]), subgroups).map(() => ends)
        : [ends],
    );
    if (candidates.length !== 1) {
      if (strict || candidates.length > 1)
        throw new Error(
          "Centered group headers have no unique, aligned column partition; review required.",
        );
      continue;
    }
    return {
      names,
      split: candidates[0].at(-2),
      rowStart: nameLine + 1,
      group: at,
    };
  }
  return null;
}
