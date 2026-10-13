// Small bounded xUnit reader. It validates nesting and test counts rather than
// trusting a summary attribute or a process exit code. No external entities.
export function parseXunit(xml) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new Error("XML entities are unsupported");
  xml = xml
    .replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, "")
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
            /\bname\s*=\s*(?:"([^"]*)"|'([^']*)')/
              .exec(text)
              ?.slice(1)
              .find(Boolean) || "test " + tests.length,
          verdict: "pass",
        };
      }
      if (!active && ["failure", "error", "skipped"].includes(tag))
        throw new Error("xUnit result has no recorded test case");
      if (active && ["failure", "error"].includes(tag)) active.verdict = "fail";
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
