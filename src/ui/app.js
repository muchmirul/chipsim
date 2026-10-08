import { analyzeDocument } from "../model/from-document.js";
import {
  builtinModels,
  registerModel,
  defaultParameters,
} from "../models/index.js";
import packagedModels from "../../.generated/models.js";
import { parsePayload, formatPayload } from "../core/values.js";
import { normalizeParameters, validateInputs } from "../model/engine.js";
import { extractPDF } from "../documents/pdf.js";
import {
  recognizeDocument,
  modelsForDocument,
  searchDocument,
  sourceBundle,
} from "../documents/recognize.js";
import { saveRecord, records } from "../documents/store.js";
import { exportCSV, exportJSON, exportVCD, download } from "../trace/export.js";
import { createModelBuilder } from "./creator.js";
import {
  escape,
  inspect,
  waveform,
  logRows,
  tableReference,
} from "./render.js";

async function main() {
  const $ = (id) => document.getElementById(id);
  let models = [...builtinModels],
    documents = await records("documents"),
    modelId = "pio",
    compareId = "pru",
    tick = 0,
    format = "hex",
    view = "inspect",
    runs = [],
    timer = null,
    currentDocument = null,
    importController = null;
  const settings = new Map(),
    urls = new Map();
  function notice(message, error = false) {
    $("notice").textContent = message;
    $("notice").hidden = false;
    $("notice").classList.toggle("error", error);
  }
  function guarded(fn) {
    return async (event) => {
      try {
        await fn(event);
      } catch (error) {
        notice(error.message, true);
      }
    };
  }
  function model() {
    return models.find((m) => m.id === modelId);
  }
  function config(m = model()) {
    if (!settings.has(m.id))
      settings.set(m.id, {
        parameters: defaultParameters(m),
        inputs: structuredClone(m.exampleInputs || []),
        duration: m.duration || 100,
      });
    return settings.get(m.id);
  }
  function pause() {
    clearInterval(timer);
    timer = null;
    $("run").textContent = "▶ Run";
  }
  function seek(value) {
    tick = Math.max(0, Math.min(Number(value), runs[0].trace.at(-1).tick));
    renderTick();
  }
  function rebuild() {
    pause();
    const m = model(),
      c = config(m);
    const next = [
      {
        model: m,
        trace: m.simulate(c.parameters, {
          inputs: c.inputs,
          ticks: c.duration,
        }),
      },
    ];
    if ($("compare-toggle").checked) {
      const other = models.find((m) => m.id === compareId);
      const otherConfig = config(other);
      const params =
        m.kind === "builtin" && other.kind === "builtin"
          ? c.parameters
          : otherConfig.parameters;
      const inputs =
        m.kind === "builtin" && other.kind === "builtin"
          ? c.inputs
          : otherConfig.inputs;
      next.push({
        model: other,
        trace: other.simulate(params, { inputs, ticks: otherConfig.duration }),
      });
    }
    runs = next;
    tick = 0;
    renderTick();
  }
  function library() {
    $("model-count").textContent = models.length;
    $("model-library").innerHTML = models
      .map(
        (m) =>
          `<button class="library-model" data-model="${escape(m.id)}" aria-current="${m.id === modelId}">${escape(m.name)}<span>${m.kind === "builtin" ? escape(m.metadata.tag) : "Document model · " + m.checks.length + " checks passed"}</span></button>`,
      )
      .join("");
    $("compare-model").innerHTML = models
      .filter((m) => m.id !== modelId)
      .map((m) => `<option value="${escape(m.id)}">${escape(m.name)}</option>`)
      .join("");
    if (compareId === modelId || !models.some((m) => m.id === compareId))
      compareId = models.find((m) => m.id !== modelId).id;
    $("compare-model").value = compareId;
    $("document-count").textContent = documents.length;
    $("document-library").innerHTML = documents
      .map(
        (d) =>
          `<button class="document-item" data-document="${escape(d.id)}">${escape(d.filename)}<span>${d.pages.length} pages · ${modelsForDocument(d, models).length ? "Model available" : "Model needed"}</span></button>`,
      )
      .join("");
  }
  function parameterMarkup(p) {
    const value = config().parameters[p.id],
      id = "parameter-" + p.id,
      label = escape(p.label || p.id);
    let input;
    if (p.type === "enum")
      input = `<select id="${id}" data-parameter="${p.id}">${p.options.map((o) => `<option ${o === value ? "selected" : ""} value="${escape(o)}">${escape(o)}</option>`).join("")}</select>`;
    else if (p.type === "boolean")
      input = `<input id="${id}" data-parameter="${p.id}" type="checkbox" ${value ? "checked" : ""}>`;
    else
      input = `<input id="${id}" data-parameter="${p.id}" type="text" spellcheck="false" value="${escape(p.id === "payload" ? formatPayload(value, format, Number(config().parameters.bits) || 8) : value)}"><span class="hint">${p.min}–${p.max}${p.id === "payload" ? " · decimal, 0x, 0b, 0o" : ""}</span>`;
    return `<div class="parameter"><label for="${id}">${label}${p.id === "half" ? " · ticks" : ""}</label>${input}</div>`;
  }
  function controls() {
    const m = model(),
      c = config();
    $("model-title").textContent = m.name;
    $("model-summary").textContent = m.summary;
    $("parameters").innerHTML = m.parameters
      .filter((p) => !p.advanced)
      .map(parameterMarkup)
      .join("");
    $("advanced-parameters").innerHTML = m.parameters
      .filter((p) => p.advanced)
      .map(parameterMarkup)
      .join("");
    $("input-events").value = JSON.stringify(c.inputs, null, 2);
    $("duration").value = c.duration;
    $("duration").disabled = m.kind === "builtin";
    if (m.kind === "builtin") {
      $("payload-equivalents").textContent = [
        "decimal",
        "hex",
        "binary",
        "octal",
      ]
        .map((f) =>
          formatPayload(c.parameters.payload, f, Number(c.parameters.bits)),
        )
        .join(" = ");
    } else
      $("payload-equivalents").textContent =
        "Integer inputs accept decimal, 0x, 0b, or 0o prefixes.";
  }
  function selectModel(id) {
    modelId = id;
    location.hash = "chip=" + encodeURIComponent(id);
    library();
    controls();
    rebuild();
  }
  function sourceURL(source, page) {
    const doc = documents.find((d) => d.sha256 === source.sha256);
    if (doc) {
      if (!urls.has(doc.id))
        urls.set(
          doc.id,
          URL.createObjectURL(
            new Blob([doc.bytes], { type: "application/pdf" }),
          ),
        );
      return urls.get(doc.id) + "#page=" + (page || 1);
    }
    const local = source.path || source.filename;
    if (local && /^docs\/references\/[a-zA-Z0-9_.-]+\.pdf$/.test(local))
      return local + "#page=" + (page || source.pdf_start_page || 1);
    const url = source.url || source.source_url;
    if (url && /^https?:\/\//.test(url)) return url + "#page=" + (page || 1);
    return null;
  }
  function sources() {
    $("source-panel").innerHTML = runs
      .map(
        ({ model: m }) =>
          `<article class="source-card"><h2>${escape(m.name)}</h2><p>${escape(m.scope)}</p><div class="source-meta"><span>Fidelity: ${escape(m.fidelity)}</span><span>Timing: normalized semantic ticks</span>${m.checks ? `<span>${m.checks.length} acceptance checks passed</span>` : ""}</div><h3 style="margin-top:18px">Assumptions</h3><ul>${m.assumptions.map((a) => `<li>${escape(a)}</li>`).join("")}</ul>${m.warnings?.length ? `<p class="warning-list">${m.warnings.map(escape).join("<br>")}</p>` : ""}<h3>Reference documents</h3><ul>${m.sources
            .map((s) => {
              const href = sourceURL(s);
              return `<li>${href ? `<a href="${escape(href)}" target="_blank" rel="noopener">${escape(s.title || s.filename || s.id)} ↗</a>` : escape(s.title || s.filename || s.id) + " · attach PDF to open"}${s.section ? ` · ${escape(s.section)}` : ""}</li>`;
            })
            .join("")}</ul>${
            m.evidence
              ? `<h3>Behavior evidence · PDF page numbers</h3>${m.evidence
                  .map((e) => {
                    const href = sourceURL(
                      m.sources.find((s) => s.id === e.sourceId),
                      e.page,
                    );
                    return `<p><strong>${escape(e.id)}</strong> · ${href ? `<a href="${escape(href)}" target="_blank" rel="noopener">page ${e.page}</a>` : `page ${e.page}`} · ${escape(e.claim)}<br><q>${escape(e.quote)}</q></p>`;
                  })
                  .join("")}`
              : ""
          }${tableReference(m)}${m.kind === "document" ? `<button data-export-model="${escape(m.id)}">Export model JSON</button>` : ""}</article>`,
      )
      .join("");
  }
  function logs() {
    const result = logRows(
      runs,
      tick,
      $("changes-only").checked,
      $("log-filter").value,
      format,
    );
    $("log-count").textContent = result.count;
    $("execution-log").innerHTML = result.html;
  }
  function renderTick() {
    const max = runs[0].trace.at(-1).tick;
    $("seek").max = max;
    $("seek").value = tick;
    $("tick-label").textContent = tick + " / " + max;
    $("back").disabled = tick === 0;
    $("step").disabled = tick === max;
    $("next-event").disabled = tick === max;
    $("waveforms").classList.toggle("wave-compare", runs.length > 1);
    $("waveforms").innerHTML = runs
      .map((r) =>
        waveform(r.model, r.trace, Math.min(tick, r.trace.at(-1).tick)),
      )
      .join("");
    $("inspect-panels").classList.toggle("compare", runs.length > 1);
    $("inspect-panels").innerHTML = runs
      .map((r) =>
        inspect(
          r.model,
          r.trace[Math.min(tick, r.trace.length - 1)],
          r.model.id === modelId
            ? config().parameters
            : r.model.kind === "builtin" && model().kind === "builtin"
              ? config().parameters
              : config(r.model).parameters,
          format,
        ),
      )
      .join("");
    if (view === "trace") logs();
    if (view === "sources") sources();
  }
  function setView(next) {
    view = next;
    for (const name of ["inspect", "trace", "sources"]) {
      $("view-" + name).hidden = name !== view;
      $("tab-" + name).setAttribute("aria-selected", String(name === view));
    }
    if (view === "trace") logs();
    if (view === "sources") sources();
  }
  function openDocument(id) {
    currentDocument = documents.find((d) => d.id === id);
    const d = currentDocument,
      available = modelsForDocument(d, models);
    $("document-title").textContent = d.filename;
    $("document-info").innerHTML =
      `${d.pages.length} pages · ${(d.size / 1048576).toFixed(1)} MiB · ${available.length ? "Existing models: " + available.map((m) => `<button data-document-model="${escape(m.id)}">${escape(m.name)} →</button>`).join(" ") : "No matching simulation yet. Export this source bundle to create a model with a developer or coding agent."}<br><code>SHA-256: ${d.sha256}</code>`;
    if (d.analysis?.diagnostics.length)
      $("document-info").innerHTML +=
        "<p>" +
        d.analysis.diagnostics
          .map((issue) =>
            escape("PDF page " + (issue.page || "?") + ": " + issue.reason),
          )
          .join("<br>") +
        "</p>";
    $("document-search").value = "";
    documentResults();
    if (!$("document-dialog").open) $("document-dialog").showModal();
  }
  function documentResults() {
    if (!currentDocument) return;
    const query = $("document-search").value;
    const hits = query.trim()
      ? searchDocument(currentDocument, query)
      : currentDocument.pages
          .slice(0, 3)
          .map((p) => ({ page: p.number, excerpt: p.text.slice(0, 500) }));
    $("document-results").innerHTML = hits.length
      ? hits
          .map(
            (h) =>
              `<div class="search-result"><button data-page="${h.page}">PDF page ${h.page} ↗</button><pre>${escape(h.excerpt)}</pre></div>`,
          )
          .join("")
      : '<p class="empty">No matching text found.</p>';
  }
  async function importDocuments(files) {
    if (importController)
      throw new Error("A document import is already running.");
    importController = new AbortController();
    $("import-progress").hidden = false;
    try {
      for (const file of files) {
        let document = await extractPDF(file, {
          signal: importController.signal,
          onProgress: ({ completed: page, total }) => {
            $("progress-label").textContent =
              file.name + " · page " + page + " / " + total;
            $("progress-bar").value = page / total;
          },
          onFirstPages: (document) => {
            const match = recognizeDocument(document);
            if (
              match &&
              models.some(
                (model) =>
                  model.kind === "builtin" && model.id === match.modelId,
              )
            ) {
              selectModel(match.modelId);
              notice(
                "Recognized " +
                  file.name +
                  ". Showing the existing " +
                  model().name +
                  " example while the manual finishes importing.",
              );
            }
          },
        });
        const existing = documents.find((d) => d.sha256 === document.sha256);
        if (existing) {
          document = { ...existing, pages: document.pages };
          documents[documents.indexOf(existing)] = document;
        } else documents.push(document);
        const persisted = await saveRecord("documents", document);
        const sourceErrors = [];
        for (let i = 0; i < models.length; i++)
          if (models[i].kind === "document")
            try {
              models[i] = registerModel(models[i].spec, documents);
            } catch (error) {
              const rejected = models.splice(i--, 1)[0];
              settings.delete(rejected.id);
              sourceErrors.push(rejected.name + ": " + error.message);
            }
        if (!models.some((m) => m.id === modelId)) modelId = "pio";
        if (!models.some((m) => m.id === compareId) || compareId === modelId)
          compareId = models.find((m) => m.id !== modelId).id;
        library();
        controls();
        rebuild();
        let compiled = null;
        if (
          !models.some(
            (model) =>
              model.kind === "document" &&
              model.sources.some((source) => source.sha256 === document.sha256),
          )
        ) {
          try {
            const analysis = analyzeDocument(document, {
              reservedIds: models.map((model) => model.id),
            });
            document.analysis = {
              models: analysis.models.map((model) => ({
                id: model.spec.id,
                name: model.spec.name,
                method: model.method,
                checks: model.checks.length,
              })),
              diagnostics: analysis.diagnostics,
            };
            for (const result of analysis.models)
              await installModel(result.spec);
            compiled = analysis.models[0] || null;
            await saveRecord("documents", document);
          } catch (error) {
            sourceErrors.push(error.message);
          }
        }
        const available = modelsForDocument(document, models);
        const linked =
          available.find((m) => m.kind === "document") || available[0];
        if (linked) {
          selectModel(linked.id);
          notice(
            "Imported " +
              file.name +
              ". Opened " +
              linked.name +
              (compiled
                ? "; created from " +
                  compiled.method +
                  ". Inspect scope and assumptions before using the result."
                : "; the upload does not generate new chip behavior.") +
              (persisted
                ? ""
                : " Browser storage is unavailable; export sources to keep this document."),
          );
        } else {
          notice(
            "PDF imported. Export its source bundle, create a model using AGENTS.md, then import the model JSON." +
              (persisted ? "" : " Browser storage is unavailable."),
          );
          openDocument(document.id);
        }
        if (sourceErrors.length)
          notice(
            "Source verification failed; these models were removed from the active library:\n" +
              sourceErrors.join("\n"),
            true,
          );
      }
    } finally {
      importController = null;
      $("import-progress").hidden = true;
      $("document-file").value = "";
    }
  }
  async function importModel(file) {
    if (file.size > 2 * 1048576)
      throw new Error("Model JSON must be under 2 MiB.");
    await installModel(JSON.parse(await file.text()));
    $("model-file").value = "";
  }
  async function installModel(spec) {
    const registered = registerModel(spec, documents);
    const index = models.findIndex((m) => m.id === registered.id);
    if (index >= 0) models[index] = registered;
    else models.push(registered);
    settings.delete(registered.id);
    const persisted = await saveRecord("models", spec);
    if ($("document-dialog").open) $("document-dialog").close();
    selectModel(registered.id);
    notice(
      "Imported " +
        registered.name +
        " · " +
        registered.checks.length +
        " checks passed." +
        (registered.warnings.length
          ? " Attach its source PDF to verify evidence."
          : " Source evidence verified.") +
        (persisted ? "" : " Browser storage unavailable; keep the model JSON."),
    );
    $("model-file").value = "";
  }
  function exportTrace() {
    const { model: m, trace } = runs[0],
      c = config(),
      type = $("trace-format").value;
    const content =
      type === "json"
        ? exportJSON(m, trace, c.parameters, c.inputs)
        : type === "vcd"
          ? exportVCD(m, trace)
          : exportCSV(m, trace);
    download(
      content,
      m.id + "-trace." + type,
      type === "csv"
        ? "text/csv"
        : type === "vcd"
          ? "text/plain"
          : "application/json",
    );
  }
  for (const spec of [...packagedModels, ...(await records("models"))])
    try {
      const registered = registerModel(spec, documents);
      const index = models.findIndex((m) => m.id === registered.id);
      if (index < 0) models.push(registered);
      else models[index] = registered;
    } catch (error) {
      notice("Could not load a model: " + error.message, true);
    }
  const initial = new URLSearchParams(location.hash.slice(1)).get("chip");
  if (models.some((m) => m.id === initial)) modelId = initial;
  $("model-library").addEventListener(
    "click",
    guarded((e) => {
      const b = e.target.closest("[data-model]");
      if (b) selectModel(b.dataset.model);
    }),
  );
  $("document-library").addEventListener("click", (e) => {
    const b = e.target.closest("[data-document]");
    if (b) openDocument(b.dataset.document);
  });
  function parameterChanged(event) {
    const id = event.target.dataset.parameter;
    if (!id) return;
    const p = model().parameters.find((p) => p.id === id);
    let value =
      p.type === "boolean" ? event.target.checked : event.target.value;
    if (p.type === "integer") {
      const parsed = parsePayload(value);
      if (!parsed)
        throw new Error("Use a whole number: 179, 0xB3, 0b10110011, or 0o263.");
      value = parsed.value;
    }
    const next = normalizeParameters(model().parameters, {
      ...config().parameters,
      [id]: value,
    });
    config().parameters = next;
    event.target.setAttribute("aria-invalid", "false");
    controls();
    rebuild();
  }
  for (const id of ["parameters", "advanced-parameters"])
    $(id).addEventListener("change", guarded(parameterChanged));
  $("parameters").addEventListener("submit", (e) => e.preventDefault());
  $("value-format").addEventListener("change", () => {
    format = $("value-format").value;
    controls();
    renderTick();
  });
  $("apply-events").addEventListener(
    "click",
    guarded(() => {
      config().inputs = validateInputs(
        model().signals,
        JSON.parse($("input-events").value),
      );
      config().duration = Number($("duration").value);
      rebuild();
      notice("Input stimulus applied.");
    }),
  );
  $("duration").addEventListener(
    "change",
    guarded(() => {
      const value = Number($("duration").value);
      if (!Number.isInteger(value) || value < 1 || value > 10000)
        throw new Error("Duration must be 1–10000 ticks.");
      config().duration = value;
      rebuild();
    }),
  );
  $("compare-toggle").addEventListener(
    "change",
    guarded(() => {
      $("compare-model").hidden = !$("compare-toggle").checked;
      rebuild();
    }),
  );
  $("compare-model").addEventListener(
    "change",
    guarded(() => {
      compareId = $("compare-model").value;
      rebuild();
    }),
  );
  $("reset").onclick = () => {
    pause();
    seek(0);
  };
  $("back").onclick = () => {
    pause();
    seek(tick - 1);
  };
  $("step").onclick = () => {
    pause();
    seek(tick + 1);
  };
  $("seek").oninput = () => {
    pause();
    seek($("seek").value);
  };
  $("next-event").onclick = () => {
    pause();
    const next = runs[0].trace.find((s) => s.tick > tick && s.changes.length);
    seek(next?.tick ?? runs[0].trace.at(-1).tick);
  };
  function play() {
    if (timer) {
      pause();
      return;
    }
    if (tick >= runs[0].trace.at(-1).tick) seek(0);
    $("run").textContent = "Ⅱ Pause";
    timer = setInterval(
      () => {
        seek(tick + 1);
        if (tick >= runs[0].trace.at(-1).tick) pause();
      },
      Number($("speed").value),
    );
  }
  $("run").onclick = play;
  $("speed").onchange = () => {
    if (timer) {
      pause();
      play();
    }
  };
  for (const button of document.querySelectorAll("[data-view]"))
    button.onclick = () => setView(button.dataset.view);
  $("changes-only").onchange = logs;
  $("log-filter").oninput = logs;
  $("execution-log").onclick = (e) => {
    const row = e.target.closest("[data-tick]");
    if (row) {
      pause();
      seek(row.dataset.tick);
    }
  };
  $("execution-log").onkeydown = (e) => {
    if (e.key === "Enter") {
      const row = e.target.closest("[data-tick]");
      if (row) {
        pause();
        seek(row.dataset.tick);
      }
    }
  };
  $("export-trace").onclick = exportTrace;
  $("source-panel").onclick = (e) => {
    const b = e.target.closest("[data-export-model]");
    if (b)
      download(
        JSON.stringify(
          models.find((m) => m.id === b.dataset.exportModel).spec,
          null,
          2,
        ),
        b.dataset.exportModel + ".model.json",
      );
  };
  $("add-document").onclick = $("drop-zone").onclick = () =>
    $("document-file").click();
  $("document-file").onchange = guarded(() =>
    importDocuments([...$("document-file").files]),
  );
  $("cancel-import").onclick = () => importController?.abort();
  $("import-model").onclick = $("document-import-model").onclick = () =>
    $("model-file").click();
  $("model-file").onchange = guarded(
    () => $("model-file").files[0] && importModel($("model-file").files[0]),
  );
  const builder = createModelBuilder({
    getDocuments: () => documents,
    getModels: () => models,
    onCreate: installModel,
  });
  $("document-create-model").onclick = guarded(() => {
    $("document-dialog").close();
    builder.open(currentDocument);
  });
  $("close-document").onclick = () => $("document-dialog").close();
  $("document-info").onclick = (e) => {
    const button = e.target.closest("[data-document-model]");
    if (button) {
      selectModel(button.dataset.documentModel);
      $("document-dialog").close();
    }
  };
  $("document-search").oninput = documentResults;
  $("open-pdf").onclick = () =>
    window.open(sourceURL(currentDocument, 1), "_blank", "noopener");
  $("document-results").onclick = (e) => {
    const b = e.target.closest("[data-page]");
    if (b)
      window.open(
        sourceURL(currentDocument, Number(b.dataset.page)),
        "_blank",
        "noopener",
      );
  };
  $("export-sources").onclick = () =>
    download(
      JSON.stringify(sourceBundle([currentDocument]), null, 2),
      currentDocument.filename.replace(/\.pdf$/i, "") + ".sources.json",
    );
  $("session-menu").onclick = () =>
    download(
      JSON.stringify(
        {
          format: "chipsim-session",
          version: 1,
          modelId,
          model: model().spec || null,
          parameters: config().parameters,
          inputs: config().inputs,
          duration: config().duration,
          tick,
          display: format,
          compare: $("compare-toggle").checked ? compareId : null,
        },
        null,
        2,
      ),
      "chipsim-session.json",
    );
  $("load-session").onclick = () => $("session-file").click();
  $("session-file").onchange = guarded(async () => {
    const file = $("session-file").files[0];
    if (!file) return;
    if (file.size > 3 * 1048576) throw new Error("Session is too large.");
    const session = JSON.parse(await file.text());
    if (session.format !== "chipsim-session" || session.version !== 1)
      throw new Error("Unsupported session format.");
    if (session.model) {
      const registered = registerModel(session.model, documents);
      const index = models.findIndex((m) => m.id === registered.id);
      if (index < 0) models.push(registered);
      else models[index] = registered;
    }
    const target = models.find((m) => m.id === session.modelId);
    if (!target) throw new Error("Session model is not installed.");
    const parameters = normalizeParameters(
        target.parameters,
        session.parameters,
      ),
      inputs = validateInputs(target.signals, session.inputs || []);
    if (
      !Number.isInteger(session.duration) ||
      session.duration < 1 ||
      session.duration > 10000
    )
      throw new Error("Invalid session duration.");
    settings.set(target.id, { parameters, inputs, duration: session.duration });
    format = ["hex", "decimal", "binary", "octal"].includes(session.display)
      ? session.display
      : "hex";
    $("value-format").value = format;
    compareId = session.compare || compareId;
    $("compare-toggle").checked = Boolean(
      session.compare && models.some((m) => m.id === session.compare),
    );
    $("compare-model").hidden = !$("compare-toggle").checked;
    selectModel(target.id);
    seek(Number.isInteger(session.tick) ? session.tick : 0);
    notice("Session restored.");
    $("session-file").value = "";
  });
  let depth = 0;
  document.addEventListener("dragenter", (e) => {
    e.preventDefault();
    depth++;
    document.body.classList.add("dragging");
  });
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("dragleave", () => {
    if (!--depth) document.body.classList.remove("dragging");
  });
  document.addEventListener(
    "drop",
    guarded((e) => {
      e.preventDefault();
      depth = 0;
      document.body.classList.remove("dragging");
      const files = [...e.dataTransfer.files];
      if (files.length) return importDocuments(files);
    }),
  );
  window.addEventListener(
    "hashchange",
    guarded(() => {
      const id = new URLSearchParams(location.hash.slice(1)).get("chip");
      if (id !== modelId && models.some((m) => m.id === id)) selectModel(id);
    }),
  );
  document.addEventListener("keydown", (e) => {
    if (
      $("document-dialog").open ||
      /INPUT|TEXTAREA|SELECT|BUTTON/.test(e.target.tagName)
    )
      return;
    if (e.code === "Space") {
      e.preventDefault();
      play();
    }
    if (e.key === "ArrowRight") {
      e.preventDefault();
      pause();
      seek(tick + 1);
    }
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      pause();
      seek(tick - 1);
    }
  });
  library();
  controls();
  rebuild();
}
if (document.readyState === "loading")
  document.addEventListener("DOMContentLoaded", () =>
    main().catch((error) => {
      document.getElementById("model-title").textContent =
        "Could not start ChipSim";
      document.getElementById("notice").hidden = false;
      document.getElementById("notice").textContent = error.message;
    }),
  );
else main().catch(console.error);
