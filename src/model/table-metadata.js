export function validateTableMetadata(model, { fail, number, signals }) {
  if (model.sourceTable !== undefined) {
    const table = model.sourceTable,
      sequential = table?.compiler === "sequential-function-table-v1",
      retained = table?.compiler === "retained-function-table-v1",
      triState = table?.compiler === "tri-state-function-table-v1",
      labels = (values) =>
        Array.isArray(values) &&
        values.length &&
        values.every(
          (value) =>
            typeof value === "string" && /^[A-Za-z\d][A-Za-z\d_]*$/.test(value),
        );
    if (
      !table ||
      typeof table !== "object" ||
      (!sequential &&
        !retained &&
        !triState &&
        table.compiler !== "binary-function-table-v1") ||
      !labels(table.inputs) ||
      !labels(table.outputs) ||
      table.inputs.length > 6 ||
      table.outputs.length > 24 ||
      typeof table.caption !== "string" ||
      table.caption.length > 1000
    )
      fail("sourceTable", "expected bounded function-table metadata");
    else {
      number(table.page, "sourceTable.page", 1, 100000);
      const bits = (
        values,
        length,
        wildcard = false,
        state = false,
        released = false,
      ) =>
        Array.isArray(values) &&
        values.length === length &&
        values.every(
          (value) =>
            value === 0 ||
            value === 1 ||
            (released && !wildcard && value === "Z") ||
            (wildcard && value === null) ||
            (state &&
              (wildcard ? ["rise", "fall"].includes(value) : value === "hold")),
        );
      if (
        !Array.isArray(table.rows) ||
        !table.rows.length ||
        table.rows.length > 32 ||
        table.rows.some(
          (row) =>
            !row ||
            !bits(row.inputs, table.inputs.length, true, sequential) ||
            !bits(
              row.outputs,
              table.outputs.length,
              false,
              sequential || retained,
              triState,
            ),
        )
      )
        fail("sourceTable.rows", "invalid table rows");
      if (
        !Array.isArray(table.matrix) ||
        table.matrix.length !==
          2 **
            (table.inputs.length +
              (sequential
                ? 1 + table.outputs.length
                : retained
                  ? table.outputs.length
                  : 0)) ||
        table.matrix.length > 64 ||
        table.matrix.some(
          (row) => !bits(row, table.outputs.length, false, false, triState),
        )
      )
        fail("sourceTable.matrix", "expected exhaustive binary output matrix");
      if (
        retained &&
        (table.outputs.length > 2 ||
          !Array.isArray(table.rows) ||
          table.rows.length > 8 ||
          !table.rows.some(
            (row) =>
              Array.isArray(row?.outputs) && row.outputs.includes("hold"),
          ) ||
          table.clock !== undefined)
      )
        fail(
          "sourceTable",
          "invalid level-sensitive state/row bounds or clock metadata",
        );
      if (sequential || retained) {
        const clock = table.clock,
          rows = Array.isArray(table.rows) ? table.rows : [];
        if (
          sequential &&
          (!clock ||
            !Number.isInteger(clock.index) ||
            clock.index < 0 ||
            clock.index >= table.inputs.length ||
            clock.input !== table.inputs[clock.index] ||
            !Array.isArray(clock.edges) ||
            !clock.edges.length ||
            clock.edges.length > 2 ||
            clock.edges.some((edge) => !["rise", "fall"].includes(edge)) ||
            table.outputs.length > 2 ||
            rows.length > 8 ||
            rows.some(
              (row) =>
                !row ||
                !Array.isArray(row.inputs) ||
                row.inputs.some(
                  (value, index) =>
                    typeof value === "string" &&
                    (index !== clock.index || !clock.edges.includes(value)),
                ),
            ))
        )
          fail("sourceTable.clock", "invalid sequential clock/row bounds");
        if (
          !Array.isArray(table.symbolRows) ||
          table.symbolRows.length !== rows.length ||
          table.symbolRows.some(
            (row) =>
              !row ||
              !Array.isArray(row.inputs) ||
              row.inputs.length !== table.inputs.length ||
              row.inputs.some(
                (value) =>
                  typeof value !== "string" ||
                  !(retained ? /^[HLX01]$/ : /^[HLhlX01↑↓]$/).test(value),
              ) ||
              !Array.isArray(row.outputs) ||
              row.outputs.length !== table.outputs.length ||
              row.outputs.some(
                (value) =>
                  typeof value !== "string" ||
                  !/^(?:[HL01]|no change)$/i.test(value),
              ),
          )
        )
          fail("sourceTable.symbolRows", "expected bounded source symbols");
      }
      if (
        !Array.isArray(table.instances) ||
        !table.instances.length ||
        table.instances.length > 8 ||
        table.instances.some(
          (instance) =>
            !labels(instance) ||
            instance.length !== table.inputs.length + table.outputs.length ||
            instance.some((label, index) => {
              const signal = signals?.get("pin_" + label.toLowerCase());
              return (
                !signal ||
                signal.width !== 1 ||
                (triState &&
                  index >= table.inputs.length &&
                  [table.rows, table.matrix].some(
                    (rows) =>
                      Array.isArray(rows) &&
                      rows.some(
                        (row) =>
                          (Array.isArray(row) ? row : row?.outputs)?.[
                            index - table.inputs.length
                          ] === "Z",
                      ),
                  ) &&
                  signal.triState !== true) ||
                signal.direction !==
                  (index < table.inputs.length ? "input" : "output")
              );
            }),
        )
      )
        fail(
          "sourceTable.instances",
          "must map to declared binary input/output signals",
        );
    }
  }
}
