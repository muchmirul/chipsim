import test from "node:test";
import assert from "node:assert/strict";
import { signalCells, signalRows } from "../src/tui/waveform.js";
const trace = (values) =>
  values.map((value, tick) => ({ tick, signals: { bus: value } }));
const rows = (values, options = {}, bits = 32) =>
  signalRows(
    trace(values),
    { id: "bus", width: bits },
    {
      width: values.length,
      offset: 0,
      zoom: 1,
      cursor: -1,
      format: "hex",
      ...options,
    },
  );

test("short bus intervals never show partial values and zoom reveals complete words", () => {
  const values = [
    0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff, 0xdeadbeef, 0xdeadbeef,
    0xdeadbeef, 0xdeadbeef, 0, 0,
  ];
  const small = rows(values)[1];
  assert.equal(small, "…   │…  │…");
  const large = rows(values, { zoom: 4, width: 40 })[1];
  assert.ok(large.indexOf("0xFFFFFFFF") < 16);
  assert.ok(large.indexOf("0xDEADBEEF") > 16);
  assert.equal(large.slice(16, 17), "│");
  assert.ok(large.slice(32).includes("0x0"));
  for (const cursor of [0, 1, 8, 16, 22, 39]) {
    const middle = rows(values, { zoom: 4, width: 40, cursor })[1];
    // Every visible numeric token must be the complete value for its run.
    const tokens = [...middle.matchAll(/0x[0-9A-F]+/g)];
    for (const token of tokens) {
      assert.equal(Number(token[0]), values[Math.floor(token.index / 4)]);
      assert.ok(!token[0].includes("┃"));
    }
    assert.equal(middle[cursor], "┃");
  }
});

test("labels preserve every base, maximum unsigned word, release and unavailable values", () => {
  for (const [format, expected] of [
    ["hex", "0xFFFFFFFF"],
    ["decimal", "4294967295"],
    ["binary", "0b" + "1".repeat(32)],
    ["octal", "0o37777777777"],
  ]) {
    const middle = rows(Array(80).fill(0xffffffff), { format, cursor: 40 })[1];
    assert.ok(middle.includes(expected));
    assert.equal(middle[40], "┃");
    assert.equal(middle.length, 80);
  }
  for (const bits of [1, 32]) {
    const middle = rows([undefined, undefined, "Z", "Z", 0, 0], {}, bits)[1];
    assert.equal(middle[0], "x");
    assert.equal(middle[2], "Z");
    assert.notEqual(middle[4], "x");
    assert.notEqual(middle[4], "Z");
    assert.equal(rows([undefined], { cursor: 0 }, bits)[1], "x");
    assert.equal(rows(["Z"], { cursor: 0 }, bits)[1], "Z");
  }
  assert.deepEqual(rows([1], { width: 4, offset: 1 }), [
    "    ",
    "    ",
    "    ",
  ]);
});

test("zoomed-out columns retain short pulses, bus activity and release changes even under the cursor", () => {
  for (const values of [
    [0, 1, 0, 0],
    [0, "Z", 0, 0],
    [0, undefined, 0, 0],
    [179, 181, 179, 179],
  ]) {
    const rendered = rows(values, { zoom: 0.25, width: 2, cursor: 0 });
    assert.equal(rendered[1], "≋ ");
    assert.equal(rendered[0], "┃ ");
  }
  assert.equal(
    rows([0, 0, 0, 0], { zoom: 0.25, width: 1, cursor: -1 }, 1)[2],
    "─",
  );
  const activity = signalCells(trace([0, 1, 0, 0]), "bus", {
    width: 4,
    offset: 0,
    zoom: 1,
  });
  assert.deepEqual(
    activity.map((cell) => cell.value),
    [0, 1, 0, 0],
  );
});

test("column coverage agrees with an independent time-interval overlap oracle at fractional zoom and pan", () => {
  const values = Array.from({ length: 91 }, (_, i) =>
    i % 17 === 0 ? "Z" : i % 7 === 0 ? undefined : i % 3,
  );
  for (const zoom of [0.02, 0.125, 0.3, 0.5, 1, 1.7, 2, 4, 16])
    for (const offset of [0, 3, 5.25, 71]) {
      const cells = signalCells(trace(values), "bus", {
        width: 80,
        zoom,
        offset,
      });
      for (let col = 0; col < 80; col++) {
        const left = offset + col / zoom,
          right = offset + (col + 1) / zoom;
        const covered = values.filter(
          (_, tick) => tick < right && tick + 1 > left,
        );
        if (!covered.length) assert.equal(cells[col].kind, "empty");
        else if (covered.some((value) => value !== covered[0]))
          assert.equal(cells[col].kind, "mixed");
        else assert.deepEqual(cells[col], { kind: "value", value: covered[0] });
      }
    }
});

test("the zoomed-out cursor marks the column containing its tick, never a later interval", async () => {
  const { TuiState } = await import("../src/tui/state.js");
  const { render } = await import("../src/tui/render.js");
  const s = new TuiState();
  s.rebuild();
  s.columns = 80;
  s.rows = 24;
  s.selected = 0;
  for (const zoom of [0.3, 0.5, 1.7])
    for (const tick of [1, 2, 3, 5, 11]) {
      s.zoom = zoom;
      s.tick = tick;
      s.offset = 0;
      const top = render(s)[4].text.slice(23),
        column = top.indexOf("┃");
      assert.ok(column / zoom <= tick);
      assert.ok((column + 1) / zoom > tick);
    }
});
