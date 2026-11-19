// Small bounded xUnit reader. It validates nesting and test counts rather than
// trusting a summary attribute or a process exit code. No external entities.
function decode(value) {
  return value.replace(
    /&(?:amp;|lt;|gt;|quot;|apos;|#(?:x[0-9a-fA-F]+|[0-9]+);)?/g,
    (ref) => {
      const predefined = {
        "&amp;": "&",
        "&lt;": "<",
        "&gt;": ">",
        "&quot;": '"',
        "&apos;": "'",
      };
      if (Object.hasOwn(predefined, ref)) return predefined[ref];
      const n = ref.startsWith("&#x")
        ? parseInt(ref.slice(3, -1), 16)
        : Number(ref.slice(2, -1));
      if (!(
        n === 9 ||
        n === 10 ||
        n === 13 ||
        (n >= 32 && n <= 0xd7ff) ||
        (n >= 0xe000 && n <= 0xfffd) ||
        (n >= 0x10000 && n <= 0x10ffff)
      ))
        throw Error("Invalid XML reference");
      return String.fromCodePoint(n);
    },
  );
}
export function parseXunit(xml) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new Error("XML entities are unsupported");
  xml = xml
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, t) =>
      t
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;"),
    )
    .replace(/<\?xml\s[\s\S]*?\?>/, "");
  const stack = [],
    tests = [],
    suites = [];
  const finishSuite = () => {
    const suite = suites.pop();
    const cases = tests.slice(suite.start);
    const failed = cases.filter((t) => t.verdict === "fail").length;
    const skipped = cases.filter((t) => t.verdict === "inconclusive").length;
    for (const [key, value] of Object.entries(suite.counts))
      if (
        !Number.isSafeInteger(value) ||
        value < 0 ||
        (key === "tests"
          ? value !== cases.length
          : value > (key === "skipped" ? skipped : failed))
      )
        throw new Error("xUnit summary contradicts recorded test cases");
  };
  let root = false,
    closed = false,
    active,
    cursor = 0;
  const tokens = /<(?:[^>"']|"[^"]*"|'[^']*')*>/g;
  for (const match of xml.matchAll(tokens)) {
    if (stack.length === 0 && xml.slice(cursor, match.index).trim())
      throw new Error("Text outside xUnit root");
    if (active && ["failure", "error"].includes(stack.at(-1)))
      active.message = (
        (active.message || "") + decode(xml.slice(cursor, match.index))
      ).slice(0, 4096);
    cursor = match.index + match[0].length;
    const text = match[0],
      closing = /^<\//.test(text),
      empty = /\/>$/.test(text);
    const tag = /^<\/?([\w:.-]+)/.exec(text)?.[1];
    if (!tag || closed) throw new Error("Malformed xUnit XML");
    if (!root) {
      if (!["testsuite", "testsuites"].includes(tag) || closing)
        throw new Error("Expected xUnit testsuite root");
      root = true;
    }
    if (closing) {
      if (stack.pop() !== tag) throw new Error("Unbalanced xUnit XML");
      if (tag === "testcase") {
        tests.push(active);
        active = null;
      }
      if (["testsuite", "testsuites"].includes(tag)) finishSuite();
    } else {
      if (["testsuite", "testsuites"].includes(tag)) {
        const counts = {};
        for (const a of text.matchAll(
          /\s(tests|failures|errors|skipped)\s*=\s*(?:"([^"]*)"|'([^']*)')/g,
        ))
          counts[a[1]] = Number(a[2] ?? a[3]);
        suites.push({ start: tests.length, counts });
      }
      if (tag === "testcase") {
        if (active || !stack.includes("testsuite"))
          throw new Error("Malformed testcase");
        active = {
          name:
            decode(
              /\bname\s*=\s*(?:"([^"]*)"|'([^']*)')/
                .exec(text)
                ?.slice(1)
                .find(Boolean) || "",
            ) || null,
          verdict: "pass",
        };
      }
      if (!active && ["failure", "error", "skipped"].includes(tag))
        throw new Error("xUnit result has no recorded test case");
      if (active && ["failure", "error"].includes(tag)) {
        active.verdict = "fail";
        const message = /\bmessage\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(text);
        if (message)
          active.message = decode(message[1] ?? message[2]).slice(0, 4096);
      }
      if (active && tag === "skipped" && active.verdict !== "fail")
        active.verdict = "inconclusive";
      if (!empty) stack.push(tag);
      else if (tag === "testcase") {
        tests.push(active);
        active = null;
      }
      if (empty && ["testsuite", "testsuites"].includes(tag)) finishSuite();
    }
    if (root && !stack.length) closed = true;
  }
  if (!closed || stack.length || xml.slice(cursor).trim() || !tests.length)
    throw new Error("Empty or malformed test suite");
  return tests;
}
