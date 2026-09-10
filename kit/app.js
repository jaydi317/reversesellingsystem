(() => {
  "use strict";

  const offline = window.TOOLKIT_OFFLINE || {};
  const merge = window.OWNER_TOOLKIT_MERGE || { vault: { categories: [], entries: [], sources: [] }, featured: {} };
  const isStageMode = new URLSearchParams(window.location.search).get("stage") === "1";
  const localRuntime = !window.TOOLKIT_FORCE_OFFLINE && !window.OFFLINE_TOOLKIT && ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
  const toolkitSession = (() => { const value = `owner-toolkit-${Date.now()}-${Math.random().toString(36).slice(2)}`; try { const prior = sessionStorage.getItem("ownerToolkitSession"); if (prior) return prior; sessionStorage.setItem("ownerToolkitSession", value); } catch {} return value; })();
  const fallbackBuckets = offline.catalog?.buckets || [
    { id: "phone", title: "Phone" }, { id: "follow-up", title: "Follow-up" },
    { id: "reviews", title: "Reviews" }, { id: "writing", title: "Writing" },
    { id: "inbox", title: "Inbox" }, { id: "money", title: "Money" },
    { id: "customers", title: "Finding customers" }, { id: "assistant", title: "Your own assistant" },
    { id: "shop", title: "Running the shop" }
  ];
  const fallbackTool = {
    id: "text-back", bucket: "phone", title: "The 30-Second Text Back",
    summary: "Give a missed caller a useful next step in your words.", layer: "wire", mode: "ai",
    fields: [
      { key: "business", label: "Business name and what you do", type: "text", required: true, placeholder: "Maple Plumbing, repairs and replacements" },
      { key: "callback", label: "When can you honestly call back?", type: "text", required: true, placeholder: "Within one business hour; Monday to Friday, 8 to 5" },
      { key: "question", label: "What one question helps you call back prepared?", type: "text", required: true, placeholder: "Is this a repair or a new installation?" }
    ],
    prompt: "Create a missed-call text for this business. Use only the supplied facts. Never send anything.",
    deliveryNote: "Creates ready-to-review text and setup values. Automatic texting requires your phone provider connection.",
    playbook: { when: "You miss a call while serving another customer.", how: "Enter your real callback window and one useful question, then test one call.", fixes: "If it sounds stiff, paste a text you actually sent and ask for that tone.", fallback: "Save the reviewed message in your phone's text replacements and send it yourself." },
    sources: [], status: "offline fallback"
  };

  const state = {
    catalog: null,
    library: null,
    status: null,
    selectedId: "text-back",
    bucket: "",
    toolSearch: "",
    librarySearch: "",
    libraryKind: "",
    libraryCategory: "",
    libraryViewMode: "resources",
    sourceFocusId: "",
    image: null,
    result: null,
    running: false,
    offline: false,
    runSequence: 0,
    imageSequence: 0,
    fieldValues: {},
    lastRun: null,
    volunteerFacts: "",
    homeSearch: "",
    stageSelected: null,
    stageResult: null,
    stageRunning: false,
    stageImage: null,
    stageImageSequence: 0,
    stageSequence: 0,
    stageEvidence: {},
    featureSequence: 0
  };

  const $ = (id) => document.getElementById(id);
  const localAiConfigured = () => localRuntime && Boolean(state.status?.ok && state.status?.providerConfigured);
  const localAiLabel = () => localAiConfigured() ? "Local AI is configured on this Mac." : state.status?.ok ? "Local runtime is open, but AI is not configured." : "Public reader: copy prompts into your own AI.";
  const canonicalText = (value) => String(value ?? "").replace(/\u2014/g, "-");
  const api = async (path, options = {}) => {
    if (!localRuntime) throw new Error("This public reader does not call an AI service. Copy the visible prompt into your own AI.");
    const response = await fetch(path, { headers: { "Content-Type": "application/json", "X-Toolkit-Session": toolkitSession }, ...options });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Local runtime returned ${response.status}`);
    return body;
  };

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>\"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
  }

  function inlineMarkdown(value) {
    let text = escapeHtml(value);
    text = text.replace(/`([^`]+)`/g, "<code>$1</code>");
    text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    text = text.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    return text;
  }

  function renderMarkdown(value) {
    const lines = String(value ?? "").replace(/\r/g, "").split("\n");
    const out = [];
    let inCode = false;
    let code = [];
    let listOpen = false;
    const closeList = () => { if (listOpen) { out.push("</ul>"); listOpen = false; } };
    const tableCells = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
    const tableDivider = (line) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.trim().startsWith("```") && !inCode) { closeList(); inCode = true; code = []; continue; }
      if (line.trim().startsWith("```") && inCode) { out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`); inCode = false; continue; }
      if (inCode) { code.push(line); continue; }
      if (!line.trim()) { closeList(); continue; }
      const heading = line.match(/^(#{1,3})\s+(.+)$/);
      if (heading) { closeList(); const level = heading[1].length; out.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`); continue; }
      const bullet = line.match(/^\s*[-*]\s+(.+)$/);
      if (bullet) { if (!listOpen) { out.push("<ul>"); listOpen = true; } out.push(`<li>${inlineMarkdown(bullet[1])}</li>`); continue; }
      if (line.match(/^\s*>\s?/)) { closeList(); out.push(`<blockquote>${inlineMarkdown(line.replace(/^\s*>\s?/, ""))}</blockquote>`); continue; }
      if (line.includes("|") && tableDivider(lines[index + 1] || "")) {
        closeList();
        const header = tableCells(line); index += 2;
        const rows = [];
        while (index < lines.length && lines[index].includes("|") && lines[index].trim()) { rows.push(tableCells(lines[index])); index += 1; }
        index -= 1;
        out.push(`<table><thead><tr>${header.map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${header.map((_, cellIndex) => `<td>${inlineMarkdown(row[cellIndex] || "")}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
        continue;
      }
      closeList(); out.push(`<p>${inlineMarkdown(line)}</p>`);
    }
    closeList();
    if (inCode) out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
    return out.join("");
  }

  function currentTool() {
    return (state.catalog?.tools || []).find((tool) => tool.id === state.selectedId) || (state.catalog?.tools || [])[0] || fallbackTool;
  }

  function toolsArray() { return Array.isArray(state.catalog?.tools) ? state.catalog.tools : []; }
  function vaultEntries() { return Array.isArray(merge.vault?.entries) ? merge.vault.entries : []; }
  function vaultSources() { return Array.isArray(merge.vault?.sources) ? merge.vault.sources : []; }
  function combinedLibraryEntries() { return [...(Array.isArray(state.library?.entries) ? state.library.entries : []), ...vaultEntries()]; }
  function labelBucket(id) { return (state.catalog?.buckets || fallbackBuckets).find((bucket) => bucket.id === id)?.title || id; }
  function badgeFor(tool) {
    if (tool.mode === "calculator" || tool.mode === "filter") return `<span class="badge calc">Calculator</span>`;
    if (tool.layer === "wire") return `<span class="badge wire">Setup guide</span>`;
    return `<span class="badge">AI draft</span>`;
  }

  function renderBuckets() {
    const target = $("bucketFilters");
    target.innerHTML = "";
    const all = document.createElement("button");
    all.className = `filter-button${state.bucket ? "" : " active"}`;
    all.textContent = "All";
    all.type = "button";
    all.onclick = () => { state.bucket = ""; render(); };
    target.appendChild(all);
    (state.catalog?.buckets || fallbackBuckets).forEach((bucket) => {
      const button = document.createElement("button");
      button.className = `filter-button${state.bucket === bucket.id ? " active" : ""}`;
      button.textContent = bucket.title;
      button.type = "button";
      button.onclick = () => { state.bucket = bucket.id; render(); };
      target.appendChild(button);
    });
  }

  function visibleTools() {
    const query = state.toolSearch.trim().toLowerCase();
    return toolsArray().filter((tool) => (!state.bucket || tool.bucket === state.bucket) && (!query || `${tool.title} ${tool.summary} ${tool.bucket}`.toLowerCase().includes(query)));
  }

  function renderToolList() {
    const list = $("toolList");
    const tools = visibleTools();
    list.innerHTML = "";
    $("visibleCount").textContent = tools.length;
    tools.forEach((tool) => {
      const button = document.createElement("button");
      button.className = `tool-item${tool.id === state.selectedId ? " active" : ""}`;
      button.type = "button";
      button.innerHTML = `<strong>${escapeHtml(tool.title)}</strong><small>${escapeHtml(tool.summary || labelBucket(tool.bucket))}</small>`;
      button.onclick = () => { state.selectedId = tool.id; state.stageLegacyToolId = null; state.result = null; state.image = null; state.lastRun = null; state.runSequence += 1; state.imageSequence += 1; render(); };
      list.appendChild(button);
    });
    if (!tools.length) list.innerHTML = '<p class="empty">No resources match that search.</p>';
  }

  function controlFor(tool, field) {
    const wrapper = document.createElement("div");
    wrapper.className = `field${field.type === "textarea" || field.key === "csv" || field.key === "rows" ? " full" : ""}`;
    const label = document.createElement("label");
    label.htmlFor = `field-${field.key}`;
    label.innerHTML = `${escapeHtml(field.label || field.key)}${field.required ? ' <span class="required">*</span>' : ""}`;
    wrapper.appendChild(label);
    let control;
    if (field.type === "textarea") {
      control = document.createElement("textarea");
      control.rows = 5;
    } else if (field.type === "select") {
      control = document.createElement("select");
      const empty = document.createElement("option"); empty.value = ""; empty.textContent = field.placeholder || "Choose one"; control.appendChild(empty);
      (field.options || []).forEach((option) => { const item = document.createElement("option"); item.value = option; item.textContent = option; control.appendChild(item); });
    } else {
      control = document.createElement("input");
      control.type = ["number", "date"].includes(field.type) ? field.type : "text";
      if (field.type === "number") { control.step = "any"; control.min = "0"; }
    }
    control.id = `field-${field.key}`;
    control.name = field.key;
    control.value = state.fieldValues[tool.id]?.[field.key] || "";
    control.placeholder = field.placeholder || "";
    control.required = Boolean(field.required);
    if (field.type === "text" || field.type === "textarea") control.maxLength = 4000;
    wrapper.appendChild(control);
    return wrapper;
  }

  function uploadControl() {
    const wrapper = document.createElement("div");
    wrapper.className = "upload-field";
    wrapper.innerHTML = '<label for="photo-file">Photo of label or part <span class="required">*</span></label><small>One JPEG, PNG, or WebP. Resized in this browser. The toolkit does not save the photo.</small>';
    const input = document.createElement("input");
    input.id = "photo-file"; input.type = "file"; input.accept = "image/jpeg,image/png,image/webp"; input.required = !state.image;
    input.addEventListener("change", () => { const sequence = ++state.imageSequence; prepareImage(input.files?.[0], wrapper, sequence); });
    wrapper.appendChild(input);
    const preview = document.createElement("div"); preview.className = "preview"; preview.id = "imagePreview"; wrapper.appendChild(preview);
    if (state.image) preview.innerHTML = `<img src="${state.image.previewUrl}" alt="Selected label preview"><small>${escapeHtml(state.image.name)} · ${Math.round(state.image.bytes / 1024)} KB JPEG</small>`;
    return wrapper;
  }

  function prepareImage(file, wrapper, sequence) {
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) { showInlineError(wrapper, "Choose a JPEG, PNG, or WebP image."); return; }
    const reader = new FileReader();
    reader.onerror = () => showInlineError(wrapper, "The image could not be read.");
    reader.onload = () => {
      const image = new Image();
      image.onload = async () => {
        if (sequence !== state.imageSequence || currentTool().id !== "photo-part") return;
        const scale = Math.min(1, 1568 / Math.max(image.naturalWidth, image.naturalHeight));
        const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
        let quality = .86;
        let blob = await canvasBlob(canvas, quality);
        while (blob.size > 1024 * 1024 && quality > .35) { quality -= .1; blob = await canvasBlob(canvas, quality); }
        if (sequence !== state.imageSequence || currentTool().id !== "photo-part") return;
        if (blob.size > 1024 * 1024) { showInlineError(wrapper, "This image is still over 1 MiB after resizing. Choose a smaller image."); return; }
        const data = await blobToBase64(blob);
        if (sequence !== state.imageSequence || currentTool().id !== "photo-part") return;
        if (state.image?.previewUrl) URL.revokeObjectURL(state.image.previewUrl);
        state.image = { mediaType: "image/jpeg", data, previewUrl: URL.createObjectURL(blob), name: file.name, bytes: blob.size };
        const preview = wrapper.querySelector(".preview");
        preview.innerHTML = `<img src="${state.image.previewUrl}" alt="Selected label preview"><small>${escapeHtml(file.name)} · ${Math.round(blob.size / 1024)} KB JPEG</small>`;
      };
      image.onerror = () => showInlineError(wrapper, "The image could not be decoded.");
      image.src = reader.result;
    };
    try { reader.readAsDataURL(file); } catch { if (sequence === state.stageImageSequence && status) status.textContent = "The image could not be read."; }
  }

  function showInlineError(wrapper, message) {
    const preview = wrapper.querySelector(".preview");
    if (preview) preview.innerHTML = `<small class="result-status error">${escapeHtml(message)}</small>`;
    state.image = null;
  }
  function canvasBlob(canvas, quality) { return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality)); }
  function blobToBase64(blob) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",", 2)[1] || ""); reader.onerror = reject; reader.readAsDataURL(blob); }); }

  function renderMeta(tool, fullPrompt) {
    const playbook = tool.playbook || {};
    const sourceHtml = (tool.sources || []).filter((source) => source && source.url).map((source) => `<li><a href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.title || source.url)}</a>${source.evidence ? ` <span class="muted">${escapeHtml(source.evidence)}</span>` : ""}</li>`).join("");
    return `<div class="meta-sections">
      <section class="meta-section"><h3>What it delivers</h3><p>${escapeHtml(tool.deliveryNote || "Review the output before using it.")}</p></section>
      <section class="meta-section full-prompt"><h3>Full prompt</h3><pre><code id="fullPromptText">${escapeHtml(canonicalText(fullPrompt || tool.prompt || "No prompt was supplied for this resource."))}</code></pre><button class="button" type="button" data-copy-prompt="${escapeHtml(tool.id)}">Copy full prompt</button></section>
      <section class="meta-section"><h3>How to use it</h3><p><strong>When:</strong> ${escapeHtml(playbook.when || "When this problem appears in the shop.")}</p><p><strong>How:</strong> ${escapeHtml(playbook.how || "Enter the facts you know, review the result, and test it on one real case.")}</p><p><strong>Fixes:</strong> ${escapeHtml(playbook.fixes || "If a detail is missing, stop and supply the missing fact.")}</p><p><strong>Fallback:</strong> ${escapeHtml(playbook.fallback || "Use a simple human checklist while you learn the route.")}</p></section>
      ${sourceHtml ? `<section class="meta-section sources"><h3>Sources</h3><ul>${sourceHtml}</ul></section>` : ""}
    </div>`;
  }

  function renderDetail() {
    const tool = currentTool();
    const detail = $("toolDetail");
    if (!tool) { detail.innerHTML = '<p class="empty">Choose a resource to begin.</p>'; return; }
    const form = document.createElement("form"); form.id = "toolForm"; form.noValidate = false;
    const usageNote = state.offline ? "Portable reader. Calculators run on this device. Copy AI prompts into your own AI account." : tool.mode === "calculator" || tool.mode === "filter" ? "Runs on this Mac. No AI call." : "Your inputs and saved facts are sent to Claude to make this draft.";
    form.innerHTML = `<div class="detail-head"><div><p class="eyebrow">${escapeHtml(labelBucket(tool.bucket))}</p><h2>${escapeHtml(tool.title)}</h2><p class="summary">${escapeHtml(tool.summary || "")}</p></div><div class="badges">${badgeFor(tool)}</div></div><div class="form-grid" id="dynamicFields"></div><div class="detail-actions"><button class="button primary" id="runButton" type="submit">${tool.mode === "calculator" || tool.mode === "filter" ? "Run locally" : "Create draft"}</button><button class="button" id="promptButton" type="button">Copy prompt</button><span class="muted" id="formStatus">${state.offline ? "Offline reader mode" : "Ready"}</span></div><p class="usage-note">${escapeHtml(usageNote)}</p>`;
    const fields = form.querySelector("#dynamicFields");
    (tool.fields || []).forEach((field) => fields.appendChild(controlFor(tool, field)));
    if (tool.id === "photo-part") fields.appendChild(uploadControl());
    detail.innerHTML = ""; detail.appendChild(form);
    form.querySelector("#runButton").disabled = state.offline && !["calculator", "filter"].includes(tool.mode);
    form.querySelector("#runButton").hidden = state.offline && !["calculator", "filter"].includes(tool.mode);
    if (state.offline) form.querySelector("#promptButton").classList.add("primary");
    form.addEventListener("submit", (event) => { event.preventDefault(); runTool(form, false); });
    form.querySelector("#promptButton").addEventListener("click", () => runTool(form, true));
    form.querySelectorAll("[name]").forEach((control) => control.addEventListener("input", () => {
      state.fieldValues[tool.id] = readFields(form);
      const prompt = buildPromptOffline(tool, state.fieldValues[tool.id], state.stageLegacyToolId === tool.id ? volunteerProfile() : activeProfile());
      const promptTarget = detail.querySelector("#fullPromptText"); if (promptTarget) promptTarget.textContent = prompt;
    }));
    if (state.result && state.result.toolId === tool.id) { detail.insertAdjacentHTML("beforeend", renderResult(state.result)); populateCards(detail, state.result); }
    detail.insertAdjacentHTML("beforeend", renderMeta(tool, buildPromptOffline(tool, state.fieldValues[tool.id] || {}, state.stageLegacyToolId === tool.id ? volunteerProfile() : activeProfile())));
    if (state.stageLegacyToolId === tool.id) {
      const back = document.createElement("button"); back.type = "button"; back.className = "button subtle"; back.textContent = "Back to stage console"; back.addEventListener("click", returnToStageConsole); form.querySelector(".detail-actions").appendChild(back);
    }
    const refinement = detail.querySelector(".refine-form");
    if (refinement) {
      refinement.hidden = state.offline || state.result?.promptOnly || ["calculator", "filter"].includes(tool.mode);
      refinement.querySelector("textarea").maxLength = 1200;
    }
    bindResultActions();
    detail.querySelector("[data-copy-prompt]")?.addEventListener("click", async (event) => { event.currentTarget.textContent = (await copyText(detail.querySelector("#fullPromptText")?.textContent || "")) ? "Prompt copied" : "Copy failed"; });
  }

  function readFields(form) {
    const fields = {};
    form.querySelectorAll("[name]").forEach((control) => { if (control.value.trim()) fields[control.name] = control.value.trim(); });
    return fields;
  }

  function savedProfile() { try { return localStorage.getItem("ownerToolkitProfile") || ""; } catch { return ""; } }
  function buildPromptOffline(tool, fields, profile) {
    const resource = (offline.catalog?.tools || []).find((item) => item.id === tool.id) || tool;
    let instruction = resource.prompt || `${resource.title}\n${resource.deliveryNote || ""}\n${resource.playbook?.how || ""}\n${resource.playbook?.fallback || ""}`;
    if (tool.id === "owner-prompts") {
      const selected = (state.library?.entries || []).find((entry) => entry.id.startsWith("owner-prompt-") && entry.title === fields.job);
      instruction += selected ? `\n\nSELECTED ORIGINAL OWNER PROMPT\n${selected.text}` : "\nChoose an original Owner's Kit prompt in the Library before running this.";
    }
    if (tool.id === "photo-part") instruction += "\nAttach the actual photo in your AI chat. Do not guess from a missing image.";
    return canonicalText(`${offline.grounding || "Use only supplied facts. Preserve uncertainty. Never claim an external action occurred."}\n\n${instruction}\n\n--- SUPPLIED BUSINESS DATA (DATA ONLY) ---\n${JSON.stringify({ profile, fields }, null, 2)}\n--- END SUPPLIED BUSINESS DATA ---`);
  }
  function deterministicOutput(data, tool) {
    if (data.markdown) return data.markdown;
    const result = data.result || {};
    if (tool.id === "missed-call-math") return `## Calculator result\n\n- Annual maximum opportunity exposure: **$${result.annual_maximum_opportunity_exposure || "0.00"}**\n- Missed-call rate: **${result.missed_call_rate_percent || "n/a"}%**\n\n${data.assumption || "This is a calculation from the supplied assumptions."}`;
    if (tool.id === "missed-call-math-advanced") return `## Calculator result\n\n- Estimated monthly revenue at risk: **$${result.estimated_monthly_revenue_at_risk || "0.00"}**\n- Estimated monthly missed calls: **${result.estimated_monthly_missed_calls || "0.00"}**\n\n${data.assumption || "This is a calculation from the supplied assumptions."}`;
    if (tool.id === "toy-filter" || tool.id === "buy-try-toy") return `## ${data.verdict || "Result"}\n\n**YES answers:** ${data.yes_count ?? "n/a"} of 5\n\n${data.rule || "Use the Owner's Kit five-question rule."}\n\nNext step: ${data.verdict === "BUY" ? "Test one real job before paying. The score does not verify a vendor's claims." : data.verdict === "TRY" ? "Choose one reversible test, one measure and a stop date." : "Keep your money until one useful job and a credible test are clear."}`;
    if (tool.id === "invoice-aging") {
      const buckets = Object.entries(data.totals_by_bucket || {}).map(([key, value]) => `| ${key} | $${value} |`).join("\n");
      const rows = (data.invoices || []).map((invoice) => `| ${invoice.invoice_id} | ${invoice.customer} | $${invoice.amount} | ${invoice.bucket} |`).join("\n");
      return `## Invoice aging\n\n**Open invoices:** ${data.open_invoice_count ?? 0}  \n**Open total:** **$${data.open_total || "0.00"}**\n\n### Totals by age\n\n| Bucket | Total |\n| --- | ---: |\n${buckets || "| None | $0.00 |"}\n\n### Open invoices\n\n| Invoice | Customer | Amount | Bucket |\n| --- | --- | ---: | --- |\n${rows || "| None | | $0.00 | |"}\n\n${data.note || ""}\n\n### Excluded or malformed records\n\n${[...(data.duplicates || []), ...(data.malformed || [])].map((item) => `- ${item.invoice_id || `Row ${item.row || "unknown"}`}: ${item.reason}`).join("\n") || "None."}`;
    }
    if (tool.id === "follow-up-eligibility") {
      const names = (data.eligible || []).map((item) => `- ${item.name || item.contact_id}`).join("\n");
      const reasons = (data.decisions || []).filter((item) => !item.eligible).slice(0, 8).map((item) => `- ${item.name || item.contact_id}: ${item.reason}`).join("\n");
      return `## Follow-up review\n\n**Eligible:** ${data.eligible_count ?? 0}\n\n${names || "No contacts are eligible."}\n\n### Held back\n\n${reasons || "None listed."}\n\n### Malformed records\n\n${(data.malformed || []).map((item) => `- ${item.contact_id || `Row ${item.row || "unknown"}`}: ${item.reason}`).join("\n") || "None."}\n\n**No messages were sent:** ${data.no_send ? "yes" : "review"}.`;
    }
    return JSON.stringify(data, null, 2);
  }

  async function runTool(form, promptOnly) {
    const tool = currentTool();
    const toolId = tool.id;
    const runSequence = ++state.runSequence;
    if (promptOnly) {
      const fields = readFields(form);
      const prompt = buildPromptOffline(tool, fields, state.stageLegacyToolId === tool.id ? volunteerProfile() : activeProfile());
      const copied = await copyText(prompt);
      if (toolId !== state.selectedId || runSequence !== state.runSequence) return;
      state.fieldValues[toolId] = fields;
      state.result = {toolId, text: prompt, status: copied ? "Prompt copied" : "Prompt ready to copy", promptOnly: true};
      renderDetail();
      return;
    }
    if (tool.id === "photo-part" && !state.image) { setFormStatus("Choose one image first.", true); return; }
    if (!form.reportValidity()) return;
    const fields = readFields(form);
    const profile = state.stageLegacyToolId === tool.id ? volunteerProfile() : activeProfile();
    state.fieldValues[tool.id] = fields;
    state.lastRun = { toolId: tool.id, fields: { ...fields }, profile, image: state.image ? { mediaType: state.image.mediaType, data: state.image.data } : null };
    const payload = { toolId: tool.id, fields, profile };
    if (state.image && tool.id === "photo-part") payload.image = { mediaType: state.image.mediaType, data: state.image.data };
    state.running = true; setFormStatus(promptOnly ? "Preparing prompt..." : "Running...", false); toggleRun(form, true);
    try {
      if (state.offline) {
        if (["calculator", "filter"].includes(tool.mode) && window.OwnerToolkitUtilities?.run) {
          const data = await window.OwnerToolkitUtilities.run(tool.id, fields);
          state.result = { toolId: tool.id, text: deterministicOutput(data, tool), status: "Calculated on this device", raw: data };
        } else if (promptOnly) {
          const offlinePrompt = buildPromptOffline(tool, fields, state.stageLegacyToolId === tool.id ? volunteerProfile() : activeProfile());
          const copied = await copyText(offlinePrompt);
          state.result = { toolId: tool.id, text: offlinePrompt, status: copied ? "Prompt copied" : "Prompt ready to copy", promptOnly: true };
        } else throw new Error("AI runs are unavailable in this public reader. Copy the visible prompt into your own AI.");
      } else {
        const path = promptOnly ? "/api/prompt" : "/api/run";
        const data = await api(path, { method: "POST", body: JSON.stringify(payload) });
        const output = promptOnly ? (data.prompt || data.text || "") : data.text || deterministicOutput(data, tool);
        const copied = promptOnly ? await copyText(output) : false;
        if (toolId !== state.selectedId || runSequence !== state.runSequence) return;
        state.result = { toolId: tool.id, text: output, cards: Array.isArray(data.cards) ? data.cards : [], reviewWarnings: Array.isArray(data.reviewWarnings) ? data.reviewWarnings : [], status: promptOnly ? (copied ? "Prompt copied" : "Prompt ready to copy") : (data.truncated ? "Draft reached the output limit" : "Draft ready"), warning: Boolean(data.truncated), raw: data };
      }
      if (toolId !== state.selectedId || runSequence !== state.runSequence) return;
      renderDetail();
    } catch (error) {
      if (toolId !== state.selectedId || runSequence !== state.runSequence) return;
      state.result = { toolId: tool.id, error: error.message, status: "Error" };
      renderDetail();
    } finally { if (toolId === state.selectedId && runSequence === state.runSequence) state.running = false; }
  }

  function setFormStatus(message, error) { const target = $("formStatus"); if (target) { target.textContent = message; target.className = `result-status${error ? " error" : ""}`; } }
  function toggleRun(form, disabled) { form.querySelectorAll("button").forEach((button) => { button.disabled = disabled; }); }

  function renderResult(result) {
    if (result.error) return `<section class="result-panel"><div class="result-head"><h3>Could not complete</h3><span class="result-status error">${escapeHtml(result.status)}</span></div><p class="result-status error">${escapeHtml(result.error)}</p></section>`;
    const warning = result.warning ? '<span class="result-status warn">Review limit reached</span>' : `<span class="result-status">${escapeHtml(result.status || "Draft ready")}</span>`;
    const reviewWarnings = (result.reviewWarnings || []).map((item) => `<li>${escapeHtml(item)}</li>`).join("");
    return `<section class="result-panel"><div class="result-head"><h3>Reviewable result</h3>${warning}</div>${reviewWarnings ? `<div class="review-warnings"><strong>Review before use</strong><ul>${reviewWarnings}</ul></div>` : ""}${result.cards?.length ? '<div id="messageCards" class="message-cards"></div>' : ""}<div class="markdown">${renderMarkdown(result.text)}</div><div class="result-actions"><button class="button" type="button" data-action="copy-result">Copy whole result</button><button class="button" type="button" data-action="download-result">Download .txt</button>${currentTool().id === "business-brief-builder" ? '<button class="button" type="button" data-action="save-facts">Use as my business facts</button>' : ""}</div><div class="refine-form"><label for="changeRequest">Refine this result</label><textarea id="changeRequest" placeholder="Example: make it shorter while preserving every fact"></textarea><button class="button" type="button" data-action="refine">Refine this same tool</button></div></section>`;
  }

  function populateCards(detail, result) {
    const container = detail.querySelector("#messageCards");
    if (!container) return;
    result.cards.forEach((card) => {
      const article = document.createElement("article"); article.className = "message-card";
      const heading = document.createElement("h4"); heading.textContent = canonicalText(card.label || "Message");
      const text = document.createElement("p"); text.textContent = canonicalText(card.text || "");
      const copy = document.createElement("button"); copy.type = "button"; copy.className = "button"; copy.textContent = "Copy text";
      copy.addEventListener("click", async () => { copy.textContent = (await copyText(canonicalText(card.text || ""))) ? "Copied" : "Copy failed"; });
      article.append(heading, text, copy); container.appendChild(article);
    });
  }

  function resultText() { return state.result?.text || ""; }
  async function copyText(value) { try { await navigator.clipboard.writeText(value); return true; } catch { const area = document.createElement("textarea"); area.value = value; document.body.appendChild(area); area.select(); const ok = document.execCommand("copy"); area.remove(); return ok; } }
  function downloadText(filename, value) { const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([value], { type: "text/plain;charset=utf-8" })); link.download = filename; link.click(); URL.revokeObjectURL(link.href); }

  function bindResultActions() {
    const panel = document.querySelector(".result-panel"); if (!panel) return;
    panel.querySelector('[data-action="copy-result"]')?.addEventListener("click", async (event) => { event.currentTarget.textContent = (await copyText(resultText())) ? "Copied" : "Copy failed"; });
    panel.querySelector('[data-action="download-result"]')?.addEventListener("click", () => downloadText(`${currentTool().id}-draft.txt`, resultText()));
    panel.querySelector('[data-action="save-facts"]')?.addEventListener("click", (event) => { event.currentTarget.textContent = saveProfileValue(resultText()) ? "Saved as facts" : "Edit to 3000 first"; });
    panel.querySelector('[data-action="refine"]')?.addEventListener("click", () => refine(panel));
  }

  async function refine(panel) {
    const request = panel.querySelector("#changeRequest").value.trim();
    if (!request || !state.result?.text) return;
    const tool = currentTool();
    if (tool.mode === "calculator" || tool.mode === "filter") { panel.querySelector("#changeRequest").value = "Calculators and filters cannot be revised."; return; }
    const toolId = tool.id;
    const refineSequence = ++state.runSequence;
    const form = $("toolForm");
    const fields = readFields(form);
    state.running = true;
    const refineButton = panel.querySelector('[data-action="refine"]');
    refineButton.disabled = true;
    refineButton.textContent = "Revising...";
    try {
      const source = state.lastRun && state.lastRun.toolId === tool.id ? state.lastRun : { toolId: tool.id, fields: { ...fields }, profile: state.stageLegacyToolId === tool.id ? volunteerProfile() : activeProfile(), image: state.image ? { mediaType: state.image.mediaType, data: state.image.data } : null };
      const payload = { toolId: tool.id, fields: source.fields, profile: source.profile, previousDraft: state.result.text, changeRequest: request };
      if (source.image && tool.id === "photo-part") payload.image = source.image;
      const data = state.offline ? { text: buildPromptOffline(tool, source.fields, source.profile) + `\n\n--- DRAFT TO REFINE ---\n${state.result.text}\n--- CHANGE REQUEST ---\n${request}` } : await api("/api/run", { method: "POST", body: JSON.stringify(payload) });
      if (toolId !== state.selectedId || refineSequence !== state.runSequence) return;
      state.result = { toolId: tool.id, text: data.text || data.markdown || deterministicOutput(data, tool), cards: Array.isArray(data.cards) ? data.cards : [], reviewWarnings: Array.isArray(data.reviewWarnings) ? data.reviewWarnings : [], status: data.truncated ? "Draft reached the output limit" : "Refined draft ready", warning: Boolean(data.truncated), raw: data };
      renderDetail();
    } catch (error) { if (toolId !== state.selectedId || refineSequence !== state.runSequence) return; state.result = { toolId: tool.id, error: error.message, status: "Error" }; renderDetail(); }
    finally { if (toolId === state.selectedId && refineSequence === state.runSequence) state.running = false; }
  }

  function sourceForEntry(entry) {
    return vaultSources().find((source) => source.id === entry.sourceId || source.id === entry.sourceRecord || source.id === `src-${String(entry.sourceRecord || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}` || source.title === entry.sourceRecord || source.sourceFile === entry.sourceRecord) || null;
  }
  function syncLibraryControls() {
    $("librarySearch").value = state.librarySearch;
    $("libraryKind").value = state.libraryKind;
    $("libraryAll").classList.toggle("primary", state.libraryViewMode === "resources" && !state.librarySearch && !state.libraryKind && !state.libraryCategory);
    $("librarySources").classList.toggle("primary", state.libraryViewMode === "sources");
  }
  function renderLibrary() {
    syncLibraryControls();
    const target = $("libraryList");
    if (state.libraryViewMode === "sources") {
      const sources = vaultSources();
      $("libraryCount").textContent = `${sources.length} source records`;
      $("libraryScope").textContent = `${sources.length} original source records. Source claims are attributed to their authors, not verified results from this toolkit.`;
      target.innerHTML = "";
      if (!sources.length) { target.innerHTML = '<p class="empty">No source records were supplied.</p>'; return; }
      sources.forEach((source) => {
        const card = document.createElement("article"); card.className = "library-card source-card"; card.id = `source-${source.id}`;
        const text = canonicalText(source.text || "");
        const link = source.sourceUrl || source.url || "";
        card.innerHTML = `<div class="kind">Original source record</div><h3>${escapeHtml(source.title || source.id || "Untitled source")}</h3>${link ? `<p><a href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">Open original source</a></p>` : ""}<p>${escapeHtml(text)}</p><div class="result-actions"><button class="button" type="button">Copy</button><button class="button" type="button">Download</button></div>`;
        const buttons = card.querySelectorAll("button"); buttons[0].onclick = async () => { buttons[0].textContent = (await copyText(text)) ? "Copied" : "Copy failed"; }; buttons[1].onclick = () => downloadText(`${(source.id || source.title || "source").replace(/[^a-z0-9_-]/gi, "-")}.txt`, text);
        target.appendChild(card);
      });
      if (state.sourceFocusId) { const focusId = state.sourceFocusId; state.sourceFocusId = ""; requestAnimationFrame(() => document.getElementById(`source-${focusId}`)?.scrollIntoView({ behavior: "smooth", block: "start" })); }
      return;
    }
    const entries = combinedLibraryEntries();
    const query = state.librarySearch.trim().toLowerCase();
    const visible = entries.filter((entry) => (!state.libraryKind || entry.kind === state.libraryKind) && (!state.libraryCategory || entry.category === state.libraryCategory) && (!query || `${entry.title} ${entry.kind} ${canonicalText(entry.text)}`.toLowerCase().includes(query)));
    target.innerHTML = ""; $("libraryCount").textContent = state.libraryCategory ? `${visible.length} in ${(merge.vault?.categories || []).find((item) => item.id === state.libraryCategory)?.title || "category"}` : `${entries.length} resources`;
    $("libraryScope").textContent = state.libraryCategory ? `${visible.length} matching resources` : `${entries.length} resources, ${vaultSources().length} source records`;
    if (!visible.length) { target.innerHTML = '<p class="empty">No library entries match that search.</p>'; return; }
    visible.forEach((entry) => {
      const card = document.createElement("article"); card.className = "library-card";
      const libraryText = canonicalText(entry.text || "");
      const source = sourceForEntry(entry); const sourceRecord = entry.sourceRecord || source?.title || entry.sourceUrl || "";
      card.innerHTML = `<div class="kind">${escapeHtml(entry.kind || "resource")}</div><h3>${escapeHtml(entry.title || "Untitled resource")}</h3><p>${escapeHtml(libraryText)}</p>${sourceRecord ? `<p class="source-record">Source: ${source ? `<button class="source-jump" type="button" data-source-id="${escapeHtml(source.id)}">${escapeHtml(sourceRecord)}</button>` : escapeHtml(sourceRecord)}</p>` : ""}<div class="result-actions"><button class="button" type="button">Copy</button><button class="button" type="button">Download</button></div>`;
      const buttons = card.querySelectorAll(".result-actions button"); buttons[0].onclick = async () => { buttons[0].textContent = (await copyText(libraryText)) ? "Copied" : "Copy failed"; }; buttons[1].onclick = () => downloadText(`${(entry.id || "resource").replace(/[^a-z0-9_-]/gi, "-")}.txt`, libraryText);
      card.querySelector(".source-jump")?.addEventListener("click", () => { state.libraryViewMode = "sources"; state.sourceFocusId = source.id; state.librarySearch = ""; state.libraryKind = ""; state.libraryCategory = ""; renderLibrary(); });
      target.appendChild(card);
    });
  }

  function renderProfile() { const value = savedProfile(); $("profileText").value = value; $("profileStatus").textContent = value ? `Saved facts loaded from this device · ${value.length}/3000 characters` : "Not saved · 0/3000 characters"; }
  function saveProfileValue(value) {
    if (value.length > 3000) { $("profileStatus").textContent = `Edit this down to 3000 characters before saving (${value.length} now)`; return false; }
    try { localStorage.setItem("ownerToolkitProfile", value); $("profileStatus").textContent = `Saved on this device · ${value.length}/3000 characters`; return true; }
    catch { $("profileStatus").textContent = "This browser blocked local saving"; return false; }
  }

  const fallbackStage = [
    { id: "brief", title: "The Brief", prompt: "Turn the supplied evidence into a clear business brief. Separate facts, assumptions, and open questions. Do not invent proof." },
    { id: "reviews-to-words", title: "Reviews to Words That Sell", prompt: "Extract exact customer language from the supplied reviews. Group recurring outcomes, objections, and phrases. Use only supplied evidence." },
    { id: "voice-to-quote", title: "Voice Notes to Quote", prompt: "Turn the supplied voice-note transcript into a reviewable quote or scope. Mark anything missing instead of guessing." },
    { id: "one-star-three", title: "1-Star Reply x3", prompt: "Write three calm, factual possible replies to the supplied one-star review. Do not claim facts not in the evidence." },
    { id: "too-expensive", title: "Too Expensive", prompt: "Create a useful response to the supplied price objection. Preserve uncertainty and do not promise an outcome." },
    { id: "competitor-teardown", title: "Competitor Teardown", prompt: "Compare only the supplied competitor evidence. Identify positioning, proof, gaps, and testable choices without invented claims." },
    { id: "photo-to-part", title: "Photo to Part", prompt: "Use the supplied photo and notes to identify visible details, a cautious next check, and missing information. Never pretend a part is confirmed." }
  ];
  function stageItems() {
    const provided = Array.isArray(merge.featured?.stage) ? merge.featured.stage : [];
    return fallbackStage.map((fallback) => ({ ...fallback, ...(provided.find((item) => item.id === fallback.id) || {}) }));
  }
  function activeProfile(includeVolunteer = false) {
    const profile = savedProfile();
    return includeVolunteer && state.volunteerFacts.trim() ? `${profile ? `${profile}\n\n` : ""}VOLUNTEER FACTS (session only)\n${state.volunteerFacts.trim()}` : profile;
  }
  function volunteerProfile() {
    return state.volunteerFacts.trim() ? `VOLUNTEER FACTS (session only)\n${state.volunteerFacts.trim()}` : "";
  }
  function stagePrompt(item, variant = "structured") {
    const instruction = variant === "weak" ? (item.weakPrompt || "The less-guided comparison prompt is supplied by the local featured tool.") : (item.prompt || item.text || "Use only supplied evidence. Preserve uncertainty.");
    const evidence = state.stageEvidence[item.id] || "[Paste actual evidence here. Do not manufacture it.]";
    const photoInstruction = item.id === "photo-to-part" ? "\n\nPHOTO\nAttach the actual photo separately. Do not infer a part from missing or unreadable image details." : "";
    return canonicalText(`${instruction}\n\nVOLUNTEER FACTS (session only)\n${state.volunteerFacts.trim() || "[Add volunteer facts above if useful.]"}\n\nEVIDENCE\n${evidence}${photoInstruction}`);
  }
  function stageCopyText(item) {
    return item?.id === "brief" ? `LESS-GUIDED BRIEF\n\n${stagePrompt(item, "weak")}\n\nSTRUCTURED BRIEF\n\n${stagePrompt(item)}` : stagePrompt(item);
  }
  function stageSearchItems(query) {
    const needle = query.trim().toLowerCase();
    const tools = toolsArray().map((tool) => ({ type: "tool", id: tool.id, title: tool.title, text: `${tool.summary || ""}\n${tool.prompt || ""}`, item: tool }));
    const vault = combinedLibraryEntries().map((entry) => ({ type: "library", id: entry.id, title: entry.title, text: entry.text || "", item: entry }));
    return [...tools, ...vault].filter((item) => !needle || `${item.title} ${item.text}`.toLowerCase().includes(needle));
  }
  function stageOutput(data) {
    const text = data.text || data.markdown || "";
    return data.truncated ? `**Draft incomplete. It reached the output limit. Check and finish it before using.**\n\n${text}` : text;
  }
  function stageResultsMarkup() {
    if (!state.stageResult) return "";
    if (state.stageResult.error) return `<section class="stage-result"><h3>Could not complete</h3><p>${escapeHtml(state.stageResult.error)}</p></section>`;
    const blocks = state.stageResult.blocks || [{ title: "Reviewable result", text: state.stageResult.text || "" }];
    return `<section class="stage-result">${blocks.map((block) => `<article><h3>${escapeHtml(block.title)}</h3><div class="markdown">${renderMarkdown(block.text || "")}</div><button class="stage-copy" type="button" data-stage-copy="${escapeHtml(block.text || "")}">Copy result</button></article>`).join("")}</section>`;
  }
  function renderStage() {
    const shell = $("stageView");
    if (!shell) return;
    document.querySelector(".shell").hidden = true;
    shell.hidden = false;
    document.body.classList.add("stage-mode");
    const selected = stageItems().find((item) => item.id === state.stageSelected);
    const buttons = stageItems().map((item) => `<button class="stage-button${selected?.id === item.id ? " active" : ""}" type="button" data-stage-id="${escapeHtml(item.id)}">${escapeHtml(item.title)}</button>`).join("");
    shell.innerHTML = `<div class="stage-top"><a class="stage-exit" href="${escapeHtml(window.location.pathname)}">Owner Toolkit home</a><p>Live volunteer console</p><h1>Make the evidence useful.</h1><textarea id="volunteerFacts" rows="5" maxlength="2500" placeholder="VOLUNTEER FACTS. These stay for this session only and are added to each stage run.">${escapeHtml(state.volunteerFacts)}</textarea><div class="stage-actions"><button class="stage-clear" type="button" id="clearStage">Clear session facts and output</button><span>${localAiLabel()}</span></div></div><div class="stage-grid">${buttons}</div><label class="stage-search"><span>Search all tools and source material</span><input id="stageSearch" type="search" placeholder="Search the 38 tools and the vault" autocomplete="off"></label><div id="stageSearchResults" class="stage-search-results"></div>${selected ? renderStagePane(selected) : "<p class=\"stage-empty\">Choose a giant button. Every run waits for real evidence from the volunteer.</p>"}${stageResultsMarkup()}`;
    shell.querySelector("#volunteerFacts").addEventListener("input", (event) => { state.volunteerFacts = event.target.value; updateStagePrompt(selected); });
    shell.querySelector("#clearStage").addEventListener("click", clearStageConsole);
    shell.querySelectorAll("[data-stage-id]").forEach((button) => button.addEventListener("click", () => { state.stageSequence += 1; state.stageRunning = false; state.stageSelected = button.dataset.stageId; state.stageResult = null; state.stageImage = null; state.stageImageSequence += 1; renderStage(); requestAnimationFrame(() => $("stageEvidence")?.scrollIntoView({ behavior: "smooth", block: "center" })); }));
    shell.querySelector("#stageSearch").addEventListener("input", (event) => renderStageSearch(event.target.value));
    shell.querySelector("#stageEvidence")?.addEventListener("input", (event) => { state.stageEvidence[selected.id] = event.target.value; updateStagePrompt(selected); });
    shell.querySelector("#stageCopy")?.addEventListener("click", async (event) => { event.currentTarget.textContent = (await copyText(stageCopyText(selected))) ? "Prompt copied" : "Copy failed"; });
    shell.querySelector("#stageRun")?.addEventListener("click", () => runStage(selected));
    shell.querySelector("#stagePhoto")?.addEventListener("change", (event) => prepareStageImage(event.target.files?.[0], selected.id));
    shell.querySelectorAll("[data-stage-copy]").forEach((button) => button.addEventListener("click", async () => { button.textContent = (await copyText(button.dataset.stageCopy || "")) ? "Copied" : "Copy failed"; }));
  }
  function renderStagePane(selected) {
    const photo = selected.id === "photo-to-part" ? `<label class="stage-photo">Photo of the actual part <span class="required">required to run</span><input id="stagePhoto" type="file" accept="image/jpeg,image/png,image/webp" required><small id="stagePhotoStatus">${state.stageImage ? `${escapeHtml(state.stageImage.name)} ready` : "Add the actual photo. Context is optional, but the local run requires an image."}</small></label>` : "";
    const disabled = !localAiConfigured() || state.stageRunning;
    const promptContent = selected.id === "brief" ? `<div class="experiment-prompts"><section><h3>Less-guided brief</h3><pre><code id="stageWeakPromptCode">${escapeHtml(stagePrompt(selected, "weak"))}</code></pre></section><section><h3>Structured brief</h3><pre><code id="stagePromptCode">${escapeHtml(stagePrompt(selected))}</code></pre></section></div>` : `<pre><code id="stagePromptCode">${escapeHtml(stagePrompt(selected))}</code></pre>`;
    return `<section class="stage-pane"><p class="eyebrow">Prepared demo</p><h2>${escapeHtml(selected.title)}</h2><label for="stageEvidence">Actual evidence</label><textarea id="stageEvidence" rows="10" maxlength="4000" placeholder="Paste the actual review, transcript, objection, competitor copy, notes, or other evidence. Nothing is generated until you choose Run local AI.">${escapeHtml(state.stageEvidence[selected.id] || "")}</textarea>${photo}<section class="stage-full-prompt"><h3>Full prompt</h3>${promptContent}<div><button class="stage-copy" type="button" id="stageCopy">Copy</button><button class="stage-run" type="button" id="stageRun" ${disabled ? "disabled" : ""}>${state.stageRunning ? "Running locally..." : "Run local AI"}</button></div><p>${localAiConfigured() ? "This sends only the evidence and session facts you supplied to the local runtime." : "Copy this prompt into your own AI. This public reader makes no API calls."}</p></section></section>`;
  }
  function renderStageSearch(query) {
    const target = $("stageSearchResults"); if (!target) return;
    const items = stageSearchItems(query);
    target.innerHTML = query.trim() ? items.map((item) => `<button type="button" data-stage-search-type="${item.type}" data-stage-search-id="${escapeHtml(item.id)}"><strong>${escapeHtml(item.title || "Untitled")}</strong><small>${item.type === "tool" ? "Open original tool with session facts" : "Open full source text"}</small></button>`).join("") || "<p>No matching tools or source records.</p>" : "";
    target.querySelectorAll("[data-stage-search-type]").forEach((button) => button.addEventListener("click", () => openStageSearchItem(button.dataset.stageSearchType, button.dataset.stageSearchId)));
  }
  function openStageSearchItem(type, id) {
    if (type === "tool") {
      state.selectedId = id; state.stageLegacyToolId = id; state.result = null;
      $("stageView").hidden = true; document.querySelector(".shell").hidden = false; document.body.classList.remove("stage-mode");
      document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === "tools"));
      document.querySelectorAll(".view").forEach((view) => { const active = view.id === "toolsView"; view.hidden = !active; view.classList.toggle("active", active); });
      render();
      return;
    }
    const entry = combinedLibraryEntries().find((item) => item.id === id); if (!entry) return;
    const target = $("stageSearchResults");
    target.innerHTML = `<article class="stage-library-detail"><h3>${escapeHtml(entry.title || "Untitled")}</h3><p>${escapeHtml(entry.sourceRecord || entry.sourceUrl || "Source record unavailable")}</p><pre><code>${escapeHtml(canonicalText(entry.text || ""))}</code></pre><button class="stage-copy" type="button" id="copyStageLibrary">Copy full text</button></article>`;
    target.querySelector("#copyStageLibrary").addEventListener("click", async (event) => { event.currentTarget.textContent = (await copyText(canonicalText(entry.text || ""))) ? "Copied" : "Copy failed"; });
  }
  function returnToStageConsole() {
    state.result = null; state.runSequence += 1;
    $("stageView").hidden = false; document.querySelector(".shell").hidden = true; document.body.classList.add("stage-mode"); renderStage();
  }
  function clearStageConsole() {
    state.stageSequence += 1; state.runSequence += 1; state.imageSequence += 1; state.stageImageSequence += 1;
    if (state.image?.previewUrl) URL.revokeObjectURL(state.image.previewUrl);
    state.volunteerFacts = ""; state.stageEvidence = {}; state.stageResult = null; state.result = null; state.stageImage = null; state.image = null;
    state.stageLegacyToolId = null; state.fieldValues = {}; state.lastRun = null; state.stageRunning = false; renderStage();
  }
  function updateStagePrompt(selected) {
    if (!selected) return;
    const target = $("stagePromptCode"); if (target) target.textContent = stagePrompt(selected);
    const weak = $("stageWeakPromptCode"); if (weak) weak.textContent = stagePrompt(selected, "weak");
  }
  function prepareStageImage(file, selectedId) {
    const sequence = ++state.stageImageSequence;
    const status = $("stagePhotoStatus");
    state.stageImage = null;
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) { if (status) status.textContent = "Choose a JPEG, PNG, or WebP image."; return; }
    if (status) status.textContent = "Preparing image...";
    const reader = new FileReader();
    reader.onerror = () => { if (sequence === state.stageImageSequence && status) status.textContent = "The image could not be read."; };
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => { if (sequence === state.stageImageSequence && status) status.textContent = "The image could not be decoded."; };
      image.onload = async () => {
        if (sequence !== state.stageImageSequence || state.stageSelected !== selectedId) return;
        const scale = Math.min(1, 1568 / Math.max(image.naturalWidth, image.naturalHeight));
        let blob;
        try {
          const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
          const context = canvas.getContext("2d"); if (!context) throw new Error("Canvas is unavailable."); context.drawImage(image, 0, 0, canvas.width, canvas.height);
          let quality = .86; blob = await canvasBlob(canvas, quality);
          while (blob.size > 1024 * 1024 && quality > .35) { quality -= .1; blob = await canvasBlob(canvas, quality); }
        } catch { if (sequence === state.stageImageSequence && status) status.textContent = "The image could not be prepared."; return; }
        if (sequence !== state.stageImageSequence || state.stageSelected !== selectedId) return;
        if (blob.size > 1024 * 1024) { if (status) status.textContent = "Image is still over 1 MiB. Choose a smaller one."; return; }
        let data; try { data = await blobToBase64(blob); } catch { if (sequence === state.stageImageSequence && status) status.textContent = "The image could not be read."; return; }
        if (sequence !== state.stageImageSequence || state.stageSelected !== selectedId) return;
        state.stageImage = { mediaType: "image/jpeg", data, name: file.name, bytes: blob.size };
        if (status) status.textContent = `${file.name} ready (${Math.round(blob.size / 1024)} KB JPEG)`;
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  }
  async function runStage(selected) {
    const evidence = (state.stageEvidence[selected.id] || "").trim();
    const canRunPhoto = selected.id === "photo-to-part" && state.stageImage;
    if (selected.id === "photo-to-part" && !canRunPhoto) { state.stageResult = { error: "Add the actual photo before running Photo to Part. Context is optional." }; renderStage(); return; }
    if (!evidence && !canRunPhoto) { state.stageResult = { error: "Paste actual evidence before running this demo." }; renderStage(); return; }
    if (!localAiConfigured()) { state.stageResult = { error: "Public reader mode never calls AI. Copy the visible prompt into your own AI." }; renderStage(); return; }
    const sequence = ++state.stageSequence;
    state.stageRunning = true; state.stageResult = null; renderStage();
    const payload = (toolId) => ({ toolId, fields: { evidence }, profile: volunteerProfile(), maxOutputTokens: 1600, ...(selected.id === "photo-to-part" && state.stageImage ? { image: { mediaType: state.stageImage.mediaType, data: state.stageImage.data } } : {}) });
    try {
      if (selected.id === "brief") {
        const [weak, strong] = await Promise.all([api("/api/run", { method: "POST", body: JSON.stringify(payload("featured-stage-brief-weak")) }), api("/api/run", { method: "POST", body: JSON.stringify(payload("featured-stage-brief")) })]);
        if (sequence !== state.stageSequence) return;
        state.stageResult = { blocks: [{ title: "Less-guided brief", text: stageOutput(weak) }, { title: "Structured brief", text: stageOutput(strong) }] };
      } else {
        const data = await api("/api/run", { method: "POST", body: JSON.stringify(payload(`featured-stage-${selected.id}`)) });
        if (sequence !== state.stageSequence) return;
        state.stageResult = { text: stageOutput(data) };
      }
    } catch (error) { if (sequence === state.stageSequence) state.stageResult = { error: error.message || "The local runtime could not complete this run." }; }
    finally { if (sequence === state.stageSequence) { state.stageRunning = false; renderStage(); requestAnimationFrame(() => document.querySelector(".stage-result")?.scrollIntoView({ behavior: "smooth", block: "start" })); } }
  }
  function renderHome() {
    if (!$("homeView")) return;
    const doors = (state.catalog?.buckets || fallbackBuckets).slice(0, 9);
    $("nineDoors").innerHTML = doors.map((bucket) => `<button type="button" data-door="${escapeHtml(bucket.id)}">${escapeHtml(bucket.title)}</button>`).join("");
    $("nineDoors").querySelectorAll("[data-door]").forEach((button) => button.addEventListener("click", () => { state.featureSequence += 1; state.bucket = button.dataset.door; switchHomeToTools(); }));
    const gift = merge.featured?.gift || {}; $("giftCard").innerHTML = `<p class="eyebrow">Gift</p><h2>${escapeHtml(gift.title || "Take the offline reader")}</h2><div class="gift-body markdown">${renderMarkdown((gift.body || gift.lead || "Read, copy, and use the prompts in your own AI.").replace(/^# [^\n]+\n+/, ""))}</div><a class="button primary" href="ultimate-owner-toolkit.html" download>Download offline reader</a>`;
    renderFeatureCards("starterCards", merge.featured?.starter || [], "featured-starter-");
    renderFeatureCards("wowCards", merge.featured?.wow || [], "featured-wow-");
    renderFeatureCards("experimentCards", merge.featured?.experiments || [], "featured-experiment-");
    const categories = merge.vault?.categories || []; $("vaultCategories").innerHTML = categories.map((item) => `<button type="button" data-vault-category="${escapeHtml(item.id)}">${escapeHtml(item.title)}</button>`).join("");
    $("vaultCategories").querySelectorAll("[data-vault-category]").forEach((button) => button.addEventListener("click", () => { state.featureSequence += 1; state.libraryViewMode = "resources"; state.libraryKind = ""; state.librarySearch = ""; state.libraryCategory = button.dataset.vaultCategory; syncLibraryControls(); switchHomeToLibrary(); }));
    const suppliedLinks = Array.isArray(merge.links) ? merge.links : [];
    const roomLinks = suppliedLinks.length ? suppliedLinks : [{ title: "Phone room", description: "Turn a live call, review, or objection into a reviewable draft." }, { title: "Doodle room", description: "Make a hard idea visible before you ask anyone to act." }, { title: "Audit room", description: "Compare what happened with what the evidence can actually support.", url: "./assets/ai-audit-offer-sheet.pdf" }];
    $("roomCards").innerHTML = roomLinks.map((item) => `<article><h3>${escapeHtml(item.title || "Room")}</h3><p>${escapeHtml(item.description || "")}</p>${item.url ? `<a class="button" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">Open</a>` : ""}</article>`).join("");
  }
  function renderFeatureCards(targetId, items, prefix) {
    const target = $(targetId); if (!target) return;
    target.innerHTML = items.slice(0, targetId === "starterCards" ? 8 : targetId === "wowCards" ? 12 : 2).map((item) => `<article class="feature-card"><h3>${escapeHtml(item.title || "Untitled")}</h3><p>${escapeHtml(item.description || item.workProduct || item.inputsHint || "Open the prompt and supply real evidence.")}</p><button type="button" data-feature-id="${escapeHtml(item.id)}">${targetId === "experimentCards" ? "Open comparison" : "Open prompt"}</button></article>`).join("") || "<p class=\"muted\">Featured records load with the approved merge data.</p>";
    target.querySelectorAll("[data-feature-id]").forEach((button) => button.addEventListener("click", () => { const item = items.find((entry) => entry.id === button.dataset.featureId); if (item) targetId === "experimentCards" ? openExperiment(item) : openFeatured(item, prefix); }));
  }
  function featuredPrompt(item, evidence) {
    return canonicalText(`${item.prompt || item.text || "Use only supplied evidence. Preserve uncertainty. Do not invent proof."}\n\n--- SAVED OWNER PROFILE ---\n${activeProfile() || "[No saved owner profile.]"}\n--- ACTUAL EVIDENCE ---\n${evidence || "[Paste actual evidence before running.]"}`);
  }
  function openFeatured(item, prefix) {
    const sequence = ++state.featureSequence;
    const target = $("homeResults");
    const runControl = localAiConfigured() ? '<button class="button primary" type="button" id="runFeatured">Run local AI</button>' : "";
    const publicLabel = localAiConfigured() ? "Local AI is configured. Nothing runs automatically." : "Copy prompts into your AI. Calculators work here.";
    target.innerHTML = `<article class="feature-open"><h2>${escapeHtml(item.title || "Featured tool")}</h2><p>${escapeHtml(item.description || item.workProduct || item.inputsHint || "Supply actual evidence, then review the result.")}</p><label>Actual evidence<textarea id="featuredEvidence" rows="7" maxlength="4000" placeholder="Paste the actual evidence. No output is created until you choose Run local AI."></textarea></label><h3>Full prompt</h3><pre><code id="featuredPromptCode">${escapeHtml(featuredPrompt(item, ""))}</code></pre><div class="result-actions"><button class="button" type="button" id="copyFeatured">Copy prompt</button>${runControl}</div><p class="muted" id="featuredStatus">${publicLabel}</p></article>`;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    target.querySelector("#featuredEvidence").addEventListener("input", (event) => { target.querySelector("#featuredPromptCode").textContent = featuredPrompt(item, event.target.value); });
    target.querySelector("#copyFeatured").addEventListener("click", async (event) => { event.currentTarget.textContent = (await copyText(target.querySelector("#featuredPromptCode").textContent || "")) ? "Prompt copied" : "Copy failed"; });
    target.querySelector("#runFeatured")?.addEventListener("click", async () => {
      const evidence = target.querySelector("#featuredEvidence").value.trim(); const status = target.querySelector("#featuredStatus");
      if (!evidence) { status.textContent = "Paste actual evidence first."; return; }
      if (!localAiConfigured()) { status.textContent = localAiLabel(); return; }
      const runButton = target.querySelector("#runFeatured"); runButton.disabled = true;
      status.textContent = "Running locally...";
      try { const data = await api("/api/run", { method: "POST", body: JSON.stringify({ toolId: `${prefix}${item.id}`, fields: { evidence }, profile: activeProfile(), maxOutputTokens: 1600 }) }); if (sequence !== state.featureSequence) return; status.textContent = "Reviewable result"; target.insertAdjacentHTML("beforeend", `<div class="result-panel"><div class="markdown">${renderMarkdown(stageOutput(data))}</div></div>`); }
      catch (error) { if (sequence === state.featureSequence) status.textContent = error.message || "Could not complete the local run."; }
      finally { if (sequence === state.featureSequence) runButton.disabled = false; }
    });
  }
  function openExperiment(item) {
    state.featureSequence += 1;
    const target = $("homeResults");
    const steps = (item.steps || []).map((step) => `<li>${escapeHtml(step)}</li>`).join("");
    const compare = (item.compare || []).map((point) => `<li>${escapeHtml(point)}</li>`).join("");
    const promptA = canonicalText(item.promptA || "No Prompt A supplied."); const promptB = canonicalText(item.promptB || "No Prompt B supplied.");
    target.innerHTML = `<article class="feature-open experiment-open"><h2>${escapeHtml(item.title || "Experiment")}</h2><p>${escapeHtml(item.description || "Compare two prompts with the same real evidence.")}</p><h3>Steps</h3><ul>${steps || "<li>Use the same actual evidence in both prompts.</li>"}</ul><div class="experiment-prompts"><section><h3>Prompt A</h3><pre><code>${escapeHtml(promptA)}</code></pre><button class="button" type="button" id="copyExperimentA">Copy Prompt A</button></section><section><h3>Prompt B</h3><pre><code>${escapeHtml(promptB)}</code></pre><button class="button" type="button" id="copyExperimentB">Copy Prompt B</button></section></div><h3>Compare</h3><ul>${compare || "<li>Compare only what the evidence supports.</li>"}</ul><p class="muted">Copy each prompt into your AI with the same real evidence, then compare the results.</p></article>`;
    target.querySelector("#copyExperimentA").addEventListener("click", async (event) => { event.currentTarget.textContent = (await copyText(promptA)) ? "Copied" : "Copy failed"; });
    target.querySelector("#copyExperimentB").addEventListener("click", async (event) => { event.currentTarget.textContent = (await copyText(promptB)) ? "Copied" : "Copy failed"; });
    target.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  function switchHomeToTools() { state.featureSequence += 1; document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === "tools")); document.querySelectorAll(".view").forEach((view) => { const active = view.id === "toolsView"; view.hidden = !active; view.classList.toggle("active", active); }); render(); }
  function switchHomeToLibrary() { state.featureSequence += 1; document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === "library")); document.querySelectorAll(".view").forEach((view) => { const active = view.id === "libraryView"; view.hidden = !active; view.classList.toggle("active", active); }); renderLibrary(); }
  function bindTabs() {
    document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => { if (tab.dataset.tab !== "home") state.featureSequence += 1; document.querySelectorAll(".tab").forEach((item) => item.classList.toggle("active", item === tab)); document.querySelectorAll(".view").forEach((view) => { const active = view.id === `${tab.dataset.tab}View` || view.id === "toolsView" && tab.dataset.tab === "tools"; view.hidden = !active; view.classList.toggle("active", active); }); if (tab.dataset.tab === "profile") renderProfile(); }));
  }

  function render() {
    $("toolCount").textContent = toolsArray().length;
    $("resourceSummary").textContent = `${toolsArray().length} tools + ${vaultEntries().length} vault resources`;
    renderBuckets(); renderToolList(); renderDetail();
  }

  async function load() {
    const requests = localRuntime ? await Promise.allSettled([api("/api/catalog"), api("/api/library"), api("/api/status")]) : [{status: "rejected"}, {status: "rejected"}, {status: "rejected"}];
    const catalogResult = requests[0];
    if (catalogResult.status === "fulfilled") state.catalog = catalogResult.value;
    else if (offline.catalog) { state.catalog = offline.catalog; state.offline = true; }
    else { state.catalog = { version: 1, buckets: fallbackBuckets, tools: [fallbackTool] }; state.offline = true; }
    const libraryResult = requests[1];
    state.library = libraryResult.status === "fulfilled" ? libraryResult.value : (offline.library || { entries: [] });
    const statusResult = requests[2];
    state.status = statusResult.status === "fulfilled" ? statusResult.value : null;
    if (state.status?.ok) { $("apiState").classList.add("ready"); $("apiState").innerHTML = '<span class="state-dot"></span>' + (state.status.providerConfigured ? 'AI ready' : 'Calculators ready; AI not connected'); }
    else { state.offline = true; $("apiState").classList.add("offline"); $("apiState").innerHTML = '<span class="state-dot"></span>Copy prompts. Calculators ready.'; }
    const kinds = [...new Set(combinedLibraryEntries().map((entry) => entry.kind).filter(Boolean))].sort();
    kinds.forEach((kind) => { const option = document.createElement("option"); option.value = kind; option.textContent = kind; $("libraryKind").appendChild(option); });
    render(); renderHome(); if (isStageMode) renderStage();
    renderLibrary();
  }

  $("toolSearch").addEventListener("input", (event) => { state.toolSearch = event.target.value; render(); });
  $("homeSearch").addEventListener("input", (event) => {
    state.featureSequence += 1;
    state.homeSearch = event.target.value;
    const query = state.homeSearch.trim(); const target = $("homeResults");
    if (!query) { target.innerHTML = ""; return; }
    const results = stageSearchItems(query).slice(0, 12);
    target.innerHTML = results.map((item) => `<button type="button" data-home-type="${item.type}" data-home-id="${escapeHtml(item.id)}"><strong>${escapeHtml(item.title || "Untitled")}</strong><small>${item.type === "tool" ? "Tool" : "Source material"}</small></button>`).join("") || "<p class=\"muted\">No matching tools or source material.</p>";
    target.querySelectorAll("[data-home-type]").forEach((button) => button.addEventListener("click", () => {
      if (button.dataset.homeType === "tool") { state.selectedId = button.dataset.homeId; state.bucket = ""; switchHomeToTools(); }
      else { const entry = combinedLibraryEntries().find((item) => item.id === button.dataset.homeId); state.libraryViewMode = "resources"; state.librarySearch = entry?.title || ""; state.libraryCategory = ""; state.libraryKind = ""; syncLibraryControls(); switchHomeToLibrary(); }
    }));
  });
  $("librarySearch").addEventListener("input", (event) => { state.libraryViewMode = "resources"; state.librarySearch = event.target.value; state.libraryCategory = ""; renderLibrary(); });
  $("libraryKind").addEventListener("change", (event) => { state.libraryViewMode = "resources"; state.libraryKind = event.target.value; renderLibrary(); });
  $("libraryAll").addEventListener("click", () => { state.featureSequence += 1; state.libraryViewMode = "resources"; state.librarySearch = ""; state.libraryKind = ""; state.libraryCategory = ""; renderLibrary(); });
  $("librarySources").addEventListener("click", () => { state.featureSequence += 1; state.libraryViewMode = "sources"; state.librarySearch = ""; state.libraryKind = ""; state.libraryCategory = ""; renderLibrary(); });
  $("profileText").addEventListener("input", () => { $("profileStatus").textContent = `${$("profileText").value.length}/3000 characters · not saved`; });
  $("saveProfile").addEventListener("click", () => { saveProfileValue($("profileText").value); });
  $("clearProfile").addEventListener("click", () => { try { localStorage.removeItem("ownerToolkitProfile"); $("profileText").value = ""; $("profileStatus").textContent = "Cleared"; } catch { $("profileStatus").textContent = "This browser blocked local saving"; } });
  bindTabs();
  load();
})();
