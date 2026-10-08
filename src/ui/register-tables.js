import { readRegisterTables } from "../model/register-tables/read.js";
import { escape } from "./values.js";
import { formatPayload } from "../core/values.js";
export function registerInventory(document) {
  const { tables } = readRegisterTables(document);
  if (!tables.length) return "";
  return (
    "<h3>Register-table drafts · review required</h3><p>Addresses, access labels and default patterns only. Masks, unknown initial values and peripheral side effects remain unresolved. These drafts are not executable simulations.</p>" +
    tables
      .map(
        (table) =>
          `<details><summary>PDF page ${table.page} · ${escape(table.caption)} · ${table.rows.length} words</summary><table class="register-table"><thead><tr><th>Address</th><th>Register</th><th>Access</th><th>Power-up pattern</th></tr></thead><tbody>${table.rows.map((row) => `<tr><td>${formatPayload(row.address, "hex", 8)}</td><td>${escape(row.name)}</td><td>${escape(row.protocol)}</td><td>${escape(row.resetBits)}</td></tr>`).join("")}</tbody></table><button data-register-draft="${escape(table.id)}">Export row draft · ? fields require review</button></details>`,
      )
      .join("")
  );
}
