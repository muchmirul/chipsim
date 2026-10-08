import {
  buildScenario,
  modelId,
  suggestScenarios,
  templates,
} from "../model/templates.js";
import { searchDocument } from "../documents/recognize.js";
import { parsePayload } from "../core/values.js";
import { escape } from "./render.js";
export function createModelBuilder({ getDocuments, getModels, onCreate }) {
  const $ = (id) => document.getElementById(id);
  let source = null,
    suggestions = [],
    latest = null;
  const fields = ["width", "direction", "match", "depth", "value"];
  function inputOptions() {
    const parsed = parsePayload($("builder-value").value);
    if ($("builder-kind").value !== "fifo" && !parsed)
      throw new Error("Enter a whole default value: decimal, 0x, 0b, or 0o.");
    return {
      kind: $("builder-kind").value,
      name: $("builder-name").value,
      width: Number($("builder-width").value),
      direction: $("builder-direction").value,
      match: $("builder-match").value,
      depth: Number($("builder-depth").value),
      value: parsed?.value,
      page: Number($("builder-page").value),
      quote: $("builder-quote").value,
      claim: $("builder-claim").value,
      assumptions: $("builder-assumptions").value,
    };
  }
  function uniqueId(name) {
    const base = modelId(name);
    let id = base,
      index = 2;
    while (getModels().some((m) => m.id === id)) id = base + "-" + index++;
    return id;
  }
  function preview() {
    try {
      const result = buildScenario(source, inputOptions());
      latest = result;
      const { spec, checks } = result;
      $("builder-status").textContent =
        `${spec.registers.length} registers · ${spec.signals.length} signals · ${checks.length} acceptance checks passed · source quote verified`;
      $("builder-status").classList.remove("error");
      $("builder-json").textContent = JSON.stringify(spec, null, 2);
      $("builder-rules").innerHTML = spec.assumptions
        .map((a) => `<li>${escape(a)}</li>`)
        .join("");
      $("builder-run").disabled = false;
    } catch (error) {
      latest = null;
      $("builder-status").textContent = error.message;
      $("builder-status").classList.add("error");
      $("builder-run").disabled = true;
      $("builder-json").textContent = "";
      $("builder-rules").innerHTML = "";
    }
  }
  function renderKind(reset = true) {
    const kind = $("builder-kind").value;
    const visible =
      kind === "counter"
        ? ["width", "direction", "match", "value"]
        : kind === "fifo"
          ? ["width", "depth"]
          : ["width", "direction", "value"];
    for (const field of fields)
      $("builder-field-" + field).hidden = !visible.includes(field);
    $("builder-width-label").textContent =
      kind === "fifo"
        ? "Word width · bits"
        : kind === "shifter"
          ? "Transfer width · bits"
          : "Counter width · bits";
    $("builder-value-label").textContent =
      kind === "counter" ? "Default period · enabled ticks" : "Default payload";
    $("builder-direction").innerHTML = (
      kind === "shifter"
        ? [
            ["lsb", "LSB first"],
            ["msb", "MSB first"],
          ]
        : [
            ["up", "Count up"],
            ["down", "Count down"],
          ]
    )
      .map(([id, label]) => `<option value="${id}">${label}</option>`)
      .join("");
    $("builder-kind-description").textContent = templates.find(
      (t) => t.id === kind,
    ).description;
    if (reset) {
      $("builder-width").value = kind === "counter" ? "16" : "8";
      $("builder-value").value = kind === "counter" ? "8" : "0xB3";
      $("builder-name").value =
        source.title + " · " + templates.find((t) => t.id === kind).label;
      $("builder-width-hint").textContent =
        "Scenario setting · verify the width in the manual.";
    }
  }
  function choose(candidate) {
    if (candidate.kind !== $("builder-kind").value) {
      $("builder-kind").value = candidate.kind;
      renderKind();
    }
    $("builder-page").value = candidate.page;
    $("builder-quote").value = candidate.quote;
    $("builder-claim").value =
      "This excerpt is retained for the developer’s review of the selected scenario. The generated rules are explicit assumptions.";
    if (candidate.width) {
      $("builder-width").value = candidate.width;
      $("builder-width-hint").textContent =
        `Found ${candidate.width}-bit wording on PDF page ${candidate.page} · review its context.`;
      if (
        $("builder-kind").value === "shifter" &&
        parsePayload($("builder-value").value)?.value >= 2 ** candidate.width
      )
        $("builder-value").value = Math.min(179, 2 ** candidate.width - 1);
    }
    preview();
  }
  function results() {
    const query = $("builder-search").value.trim();
    const candidates = query
      ? searchDocument(source, query, 12).map((result) => ({
          page: result.page,
          quote: result.excerpt,
          kind: $("builder-kind").value,
        }))
      : suggestions.filter((s) => s.kind === $("builder-kind").value);
    $("builder-candidates").innerHTML = candidates.length
      ? candidates
          .map(
            (c, index) =>
              `<button type="button" class="source-choice" data-choice="${index}"><strong>PDF page ${c.page}${c.width ? " · " + c.width + "-bit wording" : ""}</strong><span>${escape(c.quote.slice(0, 240))}${c.quote.length > 240 ? "…" : ""}</span></button>`,
          )
          .join("")
      : '<p class="hint">No matching excerpt found. Search for the peripheral or paste an exact quote from its PDF page.</p>';
    $("builder-candidates").onclick = (e) => {
      const button = e.target.closest("[data-choice]");
      if (button) choose(candidates[Number(button.dataset.choice)]);
    };
  }
  function useDocument(document) {
    source = document;
    latest = null;
    suggestions = suggestScenarios(source);
    $("builder-document").value = source.id;
    $("builder-kind").value = suggestions[0]?.kind || "counter";
    $("builder-depth").value = 4;
    $("builder-match").value = "repeat";
    $("builder-search").value = "";
    $("builder-assumptions").value = "";
    $("builder-quote").value = "";
    $("builder-claim").value = "";
    $("builder-page").value = 1;
    renderKind();
    results();
    if (suggestions.length) choose(suggestions[0]);
    else preview();
  }
  $("builder-kind").onchange = () => {
    renderKind();
    results();
    const first = suggestions.find((s) => s.kind === $("builder-kind").value);
    if (first) choose(first);
    else preview();
  };
  $("builder-document").onchange = () =>
    useDocument(
      getDocuments().find((d) => d.id === $("builder-document").value),
    );
  $("builder-search").oninput = results;
  $("builder-form").addEventListener("input", (e) => {
    if (
      !["builder-search", "builder-document", "builder-kind"].includes(
        e.target.id,
      )
    )
      preview();
  });
  $("close-builder").onclick = () => $("builder-dialog").close();
  $("builder-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!latest) return;
    $("builder-run").disabled = true;
    try {
      const result = buildScenario(source, {
        ...inputOptions(),
        id: uniqueId($("builder-name").value),
      });
      await onCreate(result.spec);
      $("builder-dialog").close();
    } catch (error) {
      $("builder-status").textContent = error.message;
      $("builder-status").classList.add("error");
      $("builder-run").disabled = false;
    }
  });
  return {
    open(document) {
      const documents = getDocuments();
      if (!documents.length)
        throw new Error(
          "Import a PDF before creating a document-backed simulation.",
        );
      $("builder-document").innerHTML = documents
        .map(
          (d) =>
            `<option value="${escape(d.id)}">${escape(d.filename)}</option>`,
        )
        .join("");
      useDocument(document || documents.at(-1));
      $("builder-dialog").showModal();
    },
  };
}
