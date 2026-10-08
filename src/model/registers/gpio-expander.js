import { op, assign, and, signal, register } from "../builders/shared.js";

// Shared reviewed digital behavior, not a datasheet/name recognizer. Callers
// supply and cite every address/default and review this behavior for their device.
export function gpioRegisterCore({ addresses, names, defaults: resetValues }) {
  const roles = ["input", "output", "polarity", "configuration"];
  const ports = addresses?.input?.length;
  if (
    ![1, 2].includes(ports) ||
    roles.some(
      (role) =>
        !Array.isArray(addresses[role]) ||
        addresses[role].length !== ports ||
        addresses[role].some(
          (address) =>
            !Number.isInteger(address) || address < 0 || address > 255,
        ) ||
        !Array.isArray(names?.[role]) ||
        names[role].length !== ports ||
        names[role].some(
          (name) =>
            typeof name !== "string" || !name.trim() || name.length > 160,
        ),
    )
  )
    throw new Error(
      "GPIO core requires explicit unique byte addresses and names for one or two complete eight-bit ports.",
    );
  if (new Set(roles.flatMap((role) => addresses[role])).size !== ports * 4)
    throw new Error("GPIO register addresses must be distinct.");
  for (const role of roles.slice(1))
    if (
      !Array.isArray(resetValues?.[role]) ||
      resetValues[role].length !== ports ||
      resetValues[role].some(
        (value) => !Number.isInteger(value) || value < 0 || value > 255,
      )
    )
      throw new Error(
        "GPIO core requires explicit byte reset values for every writable register.",
      );

  const indexes = Array.from({ length: ports }, (_, index) => index),
    eq = (a, b) => op("eq", a, b),
    select = (condition, yes, no) => op("select", condition, yes, no),
    reset = "signal.power_reset",
    read = and("signal.valid", op("not", "signal.write")),
    writable = roles
      .slice(1)
      .flatMap((role) => indexes.map((port) => role + port)),
    defaults = roles.slice(1).flatMap((role) => resetValues[role]),
    map = roles
      .flatMap((role) =>
        indexes.map((port) => ({
          name: names[role][port],
          address: addresses[role][port],
          value: (role === "input" ? "signal." : "reg.") + role + port,
          access: role === "input" ? "ro" : "rw",
          evidence: ["addresses", role],
        })),
      )
      .sort((a, b) => a.address - b.address);
  const pins = indexes.flatMap((port) => {
    const config = "reg.configuration" + port;
    return [
      assign(
        "reg.pins" + port,
        op(
          "bitOr",
          op("bitAnd", "signal.external" + port, config),
          op("bitAnd", "reg.output" + port, op("bitXor", config, 255)),
        ),
      ),
      assign(
        "signal.input" + port,
        op(
          "bitXor",
          "reg.pins" + port,
          op("bitAnd", "reg.polarity" + port, config),
        ),
      ),
      ...Array.from({ length: 8 }, (_, bit) =>
        assign(
          `signal.p${port}${bit}_driver`,
          select(
            op("bitAnd", config, 2 ** bit),
            "Z",
            op("bitAnd", op("shiftRight", "reg.output" + port, bit), 1),
          ),
        ),
      ),
    ];
  });
  const mismatch = indexes.map((port) =>
    op(
      "ne",
      op(
        "bitAnd",
        op("bitXor", "reg.pins" + port, "reg.sampled" + port),
        "reg.configuration" + port,
      ),
      0,
    ),
  );
  const irq = [
    assign(
      "signal.interrupt_pending",
      mismatch.reduce((left, right) => op("or", left, right)),
    ),
    assign("signal.int_driver", select("signal.interrupt_pending", 0, "Z")),
  ];
  const readValue = map.reduceRight(
    (rest, item) =>
      select(eq("signal.address", item.address), item.value, rest),
    0,
  );
  const mapped = map
    .map((item) => eq("signal.address", item.address))
    .reduce((left, right) => op("or", left, right));
  const step = [
    assign(
      "signal.valid",
      and(op("not", reset), op("ne", "signal.request", "reg.previous_request")),
    ),
    assign("signal.error", and("signal.valid", op("not", mapped))),
    ...roles
      .slice(1)
      .flatMap((role) =>
        indexes.map((port) =>
          assign(
            "reg." + role + port,
            select(
              reset,
              resetValues[role][port],
              select(
                and(
                  "signal.valid",
                  "signal.write",
                  eq("signal.address", addresses[role][port]),
                ),
                "signal.write_data",
                "reg." + role + port,
              ),
            ),
          ),
        ),
      ),
    ...pins,
    assign(
      "signal.read_data",
      select(
        reset,
        0,
        select(
          and(read, op("not", "signal.error")),
          readValue,
          "signal.read_data",
        ),
      ),
    ),
    ...indexes.map((port) =>
      assign(
        "reg.sampled" + port,
        select(
          op(
            "or",
            reset,
            and(read, eq("signal.address", addresses.input[port])),
          ),
          "reg.pins" + port,
          "reg.sampled" + port,
        ),
      ),
    ),
    ...irq,
    assign("reg.previous_request", "signal.request"),
  ];
  return {
    writable,
    defaults,
    pins,
    irq,
    map,
    step,
    read,
    initialize: [
      ...pins,
      ...indexes.map((port) => assign("reg.sampled" + port, "reg.pins" + port)),
      ...irq,
      assign("reg.previous_request", "signal.request"),
    ],
    registers: [
      ...writable.map((id, at) => register(id, 8, defaults[at])),
      ...indexes.flatMap((port) => [
        register("pins" + port, 8, 255),
        register("sampled" + port, 8, 255),
      ]),
      register("previous_request", 1),
    ],
    portSignals: indexes.flatMap((port) => [
      {
        ...signal("external" + port, 8, "input", 255),
        label: "Port " + port + " explicit external levels",
      },
      signal("input" + port, 8, "output", 255),
      ...Array.from({ length: 8 }, (_, bit) => ({
        ...signal(`p${port}${bit}_driver`, 1, "output", "Z"),
        triState: true,
      })),
    ]),
    registerInterface: {
      kind: "toggle-word-v1",
      address: "address",
      writeData: "write_data",
      write: "write",
      request: "request",
      readData: "read_data",
      valid: "valid",
      error: "error",
    },
  };
}
