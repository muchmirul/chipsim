// Reduced ordered binary decision diagrams for exact finite-domain rule checks.
// Resource exhaustion is inconclusive, never a successful proof.
export class SymbolicLimit extends Error {}
export class BDD {
  constructor(names, { nodes = 100000, operations = 2000000 } = {}) {
    this.names = names;
    this.limit = { nodes, operations };
    this.nodes = [null, null];
    this.unique = new Map();
    this.cache = new Map();
    this.operations = 0;
  }
  node(variable, low, high) {
    if (low === high) return low;
    const key = `${variable},${low},${high}`;
    if (this.unique.has(key)) return this.unique.get(key);
    if (this.nodes.length >= this.limit.nodes)
      throw new SymbolicLimit("Symbolic node budget exhausted");
    const id = this.nodes.length;
    this.nodes.push({ variable, low, high });
    this.unique.set(key, id);
    return id;
  }
  variable(index) {
    return this.node(index, 0, 1);
  }
  apply(op, a, b) {
    if (++this.operations > this.limit.operations)
      throw new SymbolicLimit("Symbolic operation budget exhausted");
    if (a > b) [a, b] = [b, a];
    if (op === "and" && (!a || a === b || b === 1)) return !a ? 0 : a;
    if (op === "or" && (b === 1 || a === b || !a)) return b;
    if (op === "xor" && (!a || a === b)) return a === b ? 0 : b;
    if (a < 2 && b < 2)
      return Number(op === "and" ? a && b : op === "or" ? a || b : a !== b);
    const key = `${op},${a},${b}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const variable = Math.min(
      this.nodes[a]?.variable ?? Infinity,
      this.nodes[b]?.variable ?? Infinity,
    );
    const cofactor = (id, branch) =>
      this.nodes[id]?.variable === variable ? this.nodes[id][branch] : id;
    const result = this.node(
      variable,
      this.apply(op, cofactor(a, "low"), cofactor(b, "low")),
      this.apply(op, cofactor(a, "high"), cofactor(b, "high")),
    );
    this.cache.set(key, result);
    return result;
  }
  not(a) {
    return this.apply("xor", a, 1);
  }
  and(a, b) {
    return this.apply("and", a, b);
  }
  or(a, b) {
    return this.apply("or", a, b);
  }
  xor(a, b) {
    return this.apply("xor", a, b);
  }
  mux(c, yes, no) {
    return this.or(this.and(c, yes), this.and(this.not(c), no));
  }
  witness(root) {
    if (!root) return null;
    const result = Object.fromEntries(this.names.map((name) => [name, 0]));
    while (root > 1) {
      const node = this.nodes[root],
        take = node.low ? 0 : 1;
      result[this.names[node.variable]] = take;
      root = take ? node.high : node.low;
    }
    return result;
  }
}

export function bitblast(expr, ref, bdd) {
  if (expr.kind === "ref") return ref(expr.ref);
  if (expr.kind === "constant")
    return Array.from({ length: expr.width }, (_, bit) =>
      Number((expr.bits >> BigInt(bit)) & 1n),
    );
  const args = expr.args.map((arg) => bitblast(arg, ref, bdd)),
    [a, b, c] = args;
  if (expr.kind === "not") return a.map((bit) => bdd.not(bit));
  if (["and", "or", "xor"].includes(expr.kind))
    return a.map((bit, i) => bdd[expr.kind](bit, b[i]));
  if (expr.kind === "slice") return a.slice(expr.low, expr.high + 1);
  if (expr.kind === "concat") return args.reverse().flat();
  if (expr.kind === "mux") return b.map((bit, i) => bdd.mux(a[0], bit, c[i]));
  if (expr.kind === "eq")
    return [
      a.reduce((same, bit, i) => bdd.and(same, bdd.not(bdd.xor(bit, b[i]))), 1),
    ];
  if (expr.kind === "ult") {
    let less = 0;
    for (let bit = 0; bit < a.length; bit++)
      less = bdd.mux(bdd.xor(a[bit], b[bit]), b[bit], less);
    return [less];
  }
  let carry = expr.kind === "sub" ? 1 : 0;
  return a.map((bit, i) => {
    const other = expr.kind === "sub" ? bdd.not(b[i]) : b[i],
      pair = bdd.xor(bit, other);
    const result = bdd.xor(pair, carry);
    carry = bdd.or(bdd.and(bit, other), bdd.and(pair, carry));
    return result;
  });
}
