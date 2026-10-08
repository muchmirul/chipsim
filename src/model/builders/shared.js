export const op = (name, ...args) => ({ op: name, args });
export const assign = (target, value) => ({ target, value });
export const signal = (id, width, direction, initial = 0) => ({
  id,
  label: id.toUpperCase(),
  width,
  direction,
  initial,
});
export const register = (id, width, initial = 0) => ({ id, width, initial });
export const parameter = (id, label, defaultValue, min, max) => ({
  id,
  label,
  type: "integer",
  default: defaultValue,
  min,
  max,
});
export const transition = (to, when, actions, message, active) => ({
  to,
  when,
  actions,
  message,
  active,
  evidence: ["manual-excerpt"],
});
export const and = (...args) => args.reduce((a, b) => op("and", a, b));
export const input = (tick, signal, value) => ({ tick, signal, value });
export const widthFor = (max) => Math.max(1, Math.ceil(Math.log2(max + 1)));
