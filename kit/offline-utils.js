(function (root) {
  "use strict";

  // Small decimal helper. BigInt keeps money arithmetic exact and lets the
  // browser match Python Decimal's non-negative ROUND_HALF_UP behavior.
  class DecimalValue {
    constructor(coefficient, scale) {
      this.n = coefficient;
      this.scale = scale;
    }
    static parse(value, field) {
      const text = String(value).trim().replace(/,/g, "");
      const match = text.match(/^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/);
      if (!match) throw new Error(field + " must be a number");
      const sign = match[1] === "-" ? -1n : 1n;
      const whole = match[2] || "0";
      const fraction = match[3] !== undefined ? match[3] : (match[4] || "");
      const exponent = match[5] ? Number(match[5]) : 0;
      if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100000) {
        throw new Error(field + " must be a number");
      }
      let coefficient = sign * BigInt((whole + fraction) || "0");
      let scale = fraction.length - exponent;
      if (scale < 0) {
        coefficient *= 10n ** BigInt(-scale);
        scale = 0;
      }
      const result = new DecimalValue(coefficient, scale);
      if (result.n < 0n) throw new Error(field + " must be a finite non-negative number");
      return result;
    }
    compare(other) {
      const scale = Math.max(this.scale, other.scale);
      const left = this.n * 10n ** BigInt(scale - this.scale);
      const right = other.n * 10n ** BigInt(scale - other.scale);
      return left < right ? -1 : left > right ? 1 : 0;
    }
    add(other) {
      const scale = Math.max(this.scale, other.scale);
      return new DecimalValue(
        this.n * 10n ** BigInt(scale - this.scale) + other.n * 10n ** BigInt(scale - other.scale),
        scale,
      );
    }
    multiply(other) {
      return new DecimalValue(this.n * other.n, this.scale + other.scale);
    }
    quantize(targetScale) {
      if (this.scale <= targetScale) {
        return new DecimalValue(this.n * 10n ** BigInt(targetScale - this.scale), targetScale);
      }
      const divisor = 10n ** BigInt(this.scale - targetScale);
      let quotient = this.n / divisor;
      const remainder = this.n % divisor;
      if (remainder * 2n >= divisor) quotient += 1n;
      return new DecimalValue(quotient, targetScale);
    }
    toString() {
      let digits = this.n.toString();
      if (this.scale === 0) return digits;
      if (digits.length <= this.scale) digits = "0".repeat(this.scale + 1 - digits.length) + digits;
      const point = digits.length - this.scale;
      return digits.slice(0, point) + "." + digits.slice(point);
    }
  }

  function decimal(value, field) { return DecimalValue.parse(value, field); }
  function money(value) { return value.quantize(2).toString(); }
  function percent(value, field) {
    const result = decimal(value, field);
    if (result.compare(decimal("100", "100")) > 0) throw new Error(field + " must be between 0 and 100");
    return new DecimalValue(result.n, result.scale + 2);
  }
  function isoDate(value, field) {
    const text = String(value).trim();
    const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) throw new Error(field + " must be YYYY-MM-DD");
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
      throw new Error(field + " must be YYYY-MM-DD");
    }
    return text;
  }
  function dateOrdinal(iso) {
    const parts = iso.split("-").map(Number);
    return Date.UTC(parts[0], parts[1] - 1, parts[2]) / 86400000;
  }
  function bool(value, field) {
    const normalized = String(value).trim().toLowerCase();
    if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "n", "off", ""].includes(normalized)) return false;
    throw new Error(field + " must be yes/no");
  }

  function missedCallExposure(callsPerWeek, missedPerWeek, averageJobValue) {
    const calls = decimal(callsPerWeek, "calls_per_week");
    const missed = decimal(missedPerWeek, "missed_per_week");
    const value = decimal(averageJobValue, "average_job_value");
    if (missed.compare(calls) > 0) throw new Error("missed_per_week cannot exceed calls_per_week");
    const annual = missed.multiply(decimal("52", "52")).multiply(value);
    let rate = "0.00";
    if (calls.n !== 0n) {
      // (missed / calls) * 100, rounded to two decimal places, half up.
      const numerator = missed.n * 100n * 10n ** BigInt(calls.scale);
      const denominator = calls.n * 10n ** BigInt(missed.scale);
      const scaled = numerator * 100n;
      let quotient = scaled / denominator;
      if ((scaled % denominator) * 2n >= denominator) quotient += 1n;
      rate = new DecimalValue(quotient, 2).toString();
    }
    return {
      tool: "missed-call-exposure",
      result: {
        annual_maximum_opportunity_exposure: money(annual),
        missed_call_rate_percent: rate,
      },
      assumption: "Annual maximum opportunity exposure = missed calls per week × 52 × average job value. This upper bound treats every missed call as one potential job; it is not actual revenue.",
      inputs: {
        calls_per_week: calls.toString(),
        missed_per_week: missed.toString(),
        average_job_value: money(value),
      },
    };
  }

  function missedCallMath(weeklyMissed, averageTicket, closeRate, weeksPerMonth) {
    const calls = decimal(weeklyMissed, "weekly_missed");
    const ticket = decimal(averageTicket, "average_ticket");
    const rate = percent(closeRate, "close_rate");
    const monthFactor = decimal(weeksPerMonth, "weeks_per_month");
    const monthlyCalls = calls.multiply(monthFactor);
    const revenue = monthlyCalls.multiply(rate).multiply(ticket);
    return {
      tool: "missed-call-math-advanced",
      result: {
        estimated_monthly_missed_calls: monthlyCalls.quantize(2).toString(),
        estimated_monthly_revenue_at_risk: money(revenue),
      },
      assumption: "Possible monthly revenue at risk = weekly missed calls × close rate × average job value × 4.33. This is an estimate based on supplied inputs, not money proven lost or a promise.",
      inputs: {
        weekly_missed_calls: calls.toString(),
        average_ticket: money(ticket),
        close_rate_percent: rate.multiply(decimal("100", "100")).toString(),
        weeks_per_month: monthFactor.toString(),
      },
    };
  }

  function buyTryToy(answerText) {
    const answers = String(answerText).split(",").map((part) => part.trim().toLowerCase());
    if (answers.length !== 5) throw new Error("answers must contain exactly five comma-separated yes/no values");
    const normalized = answers.map((value, index) => bool(value, "answer " + (index + 1)));
    const yes = normalized.filter(Boolean).length;
    return {
      tool: "buy-try-toy",
      yes_count: yes,
      verdict: yes >= 4 ? "BUY" : yes >= 2 ? "TRY" : "TOY",
      answers: normalized,
      rule: "4-5 YES = BUY; 2-3 YES = TRY; 0-1 YES = TOY.",
      questions: [
        "Can I name whether it makes money, saves time, or makes customers happier?",
        "Can I see it work on my business before I pay?",
        "If I cancel tomorrow, do I lose only the subscription?",
        "Can someone on my team run it in a week without a consultant?",
        "Would I bet fifty of my own dollars that it pays for itself this month?",
      ],
    };
  }

  // CSV parser equivalent to the Python csv module for ordinary RFC 4180
  // records, including quoted commas, escaped quotes, BOM, and CRLF.
  function readCsv(raw) {
    let text = String(raw).replace(/^\uFEFF/, "");
    const records = [];
    let row = [];
    let field = "";
    let quoted = false;
    let justClosedQuote = false;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 1; }
          else { quoted = false; justClosedQuote = true; }
        } else field += ch;
      } else if (ch === '"' && field === "") {
        quoted = true;
        justClosedQuote = false;
      } else if (ch === ",") {
        row.push(field); field = ""; justClosedQuote = false;
      } else if (ch === "\r" || ch === "\n") {
        if (ch === "\r" && text[i + 1] === "\n") i += 1;
        row.push(field); field = "";
        // csv.reader does not emit the phantom record after a terminal newline.
        if (row.length > 1 || row[0] !== "" || i < text.length - 1) records.push(row);
        row = []; justClosedQuote = false;
      } else {
        field += ch; justClosedQuote = false;
      }
    }
    if (quoted) throw new Error("malformed CSV: unterminated quoted field");
    if (row.length || field) { row.push(field); records.push(row); }
    if (!records.length || !records[0].length) return { rows: [], errors: [{ row: 1, reason: "missing header" }], header: [] };
    const header = records[0];
    const rows = [];
    const errors = [];
    for (let index = 1; index < records.length; index += 1) {
      const values = records[index];
      if (values.length > header.length) errors.push({ row: index + 1, reason: "extra columns" });
      const mapped = {};
      for (let j = 0; j < header.length; j += 1) mapped[String(header[j])] = values[j] === undefined ? "" : values[j];
      rows.push(mapped);
    }
    return { rows, errors, header };
  }

  function requiredColumns(csv, required, message) {
    if (csv.rows.length) {
      const missing = required.filter((key) => !Object.prototype.hasOwnProperty.call(csv.rows[0], key)).sort();
      if (missing.length) throw new Error(message + missing.join(", "));
    }
  }
  function rowValue(row, key) { return row[key] === undefined || row[key] === null ? "" : String(row[key]); }

  function invoiceAging(raw, asOf) {
    const cutoff = isoDate(asOf, "as_of");
    const csv = readCsv(raw);
    requiredColumns(csv, ["invoice_id", "customer", "amount", "due_date", "status"], "invoice CSV missing columns: ");
    const grouped = new Map();
    const allRowsById = new Map();
    const invalidIds = new Set();
    const valid = [];
    const malformed = csv.errors.slice();
    const csvErrorRows = new Set(csv.errors.map((error) => error.row));
    csv.rows.forEach((row, offset) => {
      const rowNumber = offset + 2;
      const invoiceId = rowValue(row, "invoice_id").trim();
      if (invoiceId) {
        if (!allRowsById.has(invoiceId)) allRowsById.set(invoiceId, []);
        allRowsById.get(invoiceId).push(rowNumber);
        if (csvErrorRows.has(rowNumber)) invalidIds.add(invoiceId);
      }
      try {
        if (!invoiceId) throw new Error("invoice_id is required");
        const amount = decimal(rowValue(row, "amount"), "amount");
        const due = isoDate(rowValue(row, "due_date"), "due_date");
        const status = rowValue(row, "status").trim().toLowerCase();
        if (!["open", "paid", "void"].includes(status)) throw new Error("status must be open, paid, or void");
        if (!grouped.has(invoiceId)) grouped.set(invoiceId, []);
        grouped.get(invoiceId).push({ row: rowNumber, invoice_id: invoiceId, customer: rowValue(row, "customer").trim(), amount, due_date: due, status });
      } catch (error) {
        malformed.push({ row: rowNumber, invoice_id: invoiceId, reason: error.message });
        if (invoiceId) invalidIds.add(invoiceId);
      }
    });
    const duplicates = [];
    for (const [invoiceId, items] of grouped.entries()) {
      if (invalidIds.has(invoiceId)) duplicates.push({ invoice_id: invoiceId, rows: allRowsById.get(invoiceId), reason: "invoice_id group excluded because at least one row is malformed" });
      else if (items.length > 1) duplicates.push({ invoice_id: invoiceId, rows: items.map((item) => item.row), reason: "duplicate invoice_id group excluded to fail closed, including conflicting statuses" });
      else valid.push(items[0]);
    }
    const buckets = { current: decimal("0", "0"), "1-30": decimal("0", "0"), "31-60": decimal("0", "0"), "61-90": decimal("0", "0"), "91+": decimal("0", "0") };
    const openRows = [];
    valid.forEach((item) => {
      if (item.status !== "open") return;
      const days = Math.max(dateOrdinal(cutoff) - dateOrdinal(item.due_date), 0);
      const bucket = days === 0 ? "current" : days <= 30 ? "1-30" : days <= 60 ? "31-60" : days <= 90 ? "61-90" : "91+";
      buckets[bucket] = buckets[bucket].add(item.amount);
      openRows.push({ invoice_id: item.invoice_id, customer: item.customer, amount: money(item.amount), due_date: item.due_date, days_overdue: days, bucket });
    });
    let total = decimal("0", "0");
    Object.values(buckets).forEach((value) => { total = total.add(value); });
    const invalidGroups = Array.from(invalidIds).filter((id) => !grouped.has(id)).sort();
    const totals = {};
    Object.keys(buckets).forEach((key) => { totals[key] = money(buckets[key]); });
    return { tool: "invoice-aging", as_of: cutoff, open_invoice_count: openRows.length, open_total: money(total), totals_by_bucket: totals, invoices: openRows, duplicates, malformed, invalid_groups: invalidGroups, note: "Duplicate and malformed invoice groups are excluded from totals. Paid and void invoices are excluded." };
  }

  function phone(value) {
    let digits = String(value || "").replace(/\D/g, "");
    if (digits.length === 11 && digits[0] === "1") digits = digits.slice(1);
    return digits.length === 10 ? digits : "";
  }
  function integer(value, field) {
    const text = String(value).trim();
    if (!/^[+-]?\d+$/.test(text)) throw new Error(field + " must be an integer");
    const number = Number(text);
    if (!Number.isSafeInteger(number)) throw new Error(field + " must be an integer");
    return number;
  }

  function followUpEligibility(raw, asOf, minDays, dedupeDays) {
    if (minDays < 0 || dedupeDays < 0) throw new Error("min_days and dedupe_days must be non-negative");
    const cutoff = isoDate(asOf, "as_of");
    const csv = readCsv(raw);
    requiredColumns(csv, ["contact_id", "name", "phone", "last_contacted", "consent", "opted_out", "booked"], "follow-up CSV missing columns: ");
    const decisions = [];
    const eligible = [];
    const malformed = csv.errors.slice();
    const parsed = [];
    const contactRows = new Map();
    const csvErrorRows = new Set(csv.errors.map((error) => error.row));
    csv.rows.forEach((row, offset) => {
      const rowNumber = offset + 2;
      const contactId = rowValue(row, "contact_id").trim();
      if (contactId) {
        if (!contactRows.has(contactId)) contactRows.set(contactId, []);
        contactRows.get(contactId).push(rowNumber);
      }
      const normalizedPhone = phone(rowValue(row, "phone"));
      const item = { row: rowNumber, contact_id: contactId, name: rowValue(row, "name").trim(), phone: normalizedPhone, last: null, consent: null, opted_out: null, booked: null, errors: [] };
      if (csvErrorRows.has(rowNumber)) item.errors.push("extra columns");
      if (!contactId) item.errors.push("duplicate or missing contact_id");
      if (!normalizedPhone) item.errors.push("phone is missing or not a US 10 or 11 digit number");
      [["last", "last_contacted"], ["consent", "consent"], ["opted_out", "opted_out"], ["booked", "booked"]].forEach(([key, field]) => {
        try { item[key] = key === "last" ? isoDate(rowValue(row, field), field) : bool(rowValue(row, field), field); }
        catch (error) { item.errors.push(error.message); }
      });
      item.errors.forEach((reason) => malformed.push({ row: rowNumber, contact_id: contactId, reason }));
      if (normalizedPhone) parsed.push(item);
    });
    const duplicateContactIds = new Set(Array.from(contactRows.entries()).filter(([, rows]) => rows.length > 1).map(([id]) => id));
    const groups = new Map();
    parsed.forEach((item) => { if (!groups.has(item.phone)) groups.set(item.phone, []); groups.get(item.phone).push(item); });
    const requiredDays = Math.max(minDays, dedupeDays);
    for (const [normalizedPhone, items] of groups.entries()) {
      const groupOptedOut = items.some((item) => item.opted_out === true);
      const groupConsent = items.every((item) => item.consent === true);
      const groupBooked = items.some((item) => item.booked === true);
      const groupAmbiguous = items.some((item) => item.errors.length || duplicateContactIds.has(item.contact_id));
      const validDates = items.filter((item) => item.last !== null).map((item) => item.last);
      const latest = validDates.length ? validDates.reduce((a, b) => dateOrdinal(a) >= dateOrdinal(b) ? a : b) : null;
      const age = latest ? dateOrdinal(cutoff) - dateOrdinal(latest) : null;
      const candidates = items.filter((item) => item.last !== null).slice().sort((a, b) => dateOrdinal(b.last) - dateOrdinal(a.last) || b.row - a.row);
      const representative = candidates[0] || null;
      items.forEach((item) => {
        let reason;
        if (groupOptedOut) reason = "opted out at phone level";
        else if (groupAmbiguous) reason = "ambiguous or malformed phone group blocked";
        else if (!groupConsent) reason = "no consent at phone level";
        else if (groupBooked) reason = "already booked at phone level";
        else if (latest === null) reason = "no valid last_contacted date";
        else if (age < requiredDays) reason = "latest contact " + age + " days ago; minimum is " + requiredDays;
        else if (item === representative) reason = "eligible";
        else reason = "duplicate phone; latest contact is the representative";
        const decision = { row: item.row, contact_id: item.contact_id, name: item.name, phone: normalizedPhone, eligible: reason === "eligible", reason };
        decisions.push(decision);
        if (decision.eligible) eligible.push(decision);
      });
    }
    decisions.sort((a, b) => a.row - b.row);
    return { tool: "follow-up-eligibility", as_of: cutoff, min_days: minDays, dedupe_days: dedupeDays, required_days: requiredDays, eligible_count: eligible.length, eligible, decisions, malformed, no_send: true, note: "This report only identifies records for human review. It never sends a message." };
  }

  const BRIEF_FIELDS = [
    ["business_name", "Business name"], ["location", "Where you work"], ["ideal_customer", "Best customer"], ["core_offer", "What you do"],
    ["customer_problem", "Problem you solve"], ["process", "How the work happens"], ["proof", "Proof you can use"], ["voice_and_boundaries", "Voice and boundaries"],
  ];
  function businessBrief(data) {
    const missing = BRIEF_FIELDS.filter(([key]) => !String(data[key] === undefined ? "" : data[key]).trim()).map(([key]) => key);
    if (missing.length) throw new Error("missing brief fields: " + missing.join(", "));
    const lines = ["# " + String(data.business_name) + " business brief", "", "Use this brief as context. Treat it as supplied business information, not permission to send, publish, or promise anything.", ""];
    BRIEF_FIELDS.forEach(([key, label]) => lines.push("## " + label, String(data[key]).trim(), ""));
    return lines.join("\n").replace(/\n+$/, "\n");
  }

  function firstNonEmpty(fields, keys) {
    for (const key of keys) if (fields[key] !== undefined && String(fields[key]).trim()) return String(fields[key]);
    return "";
  }
  function run(toolId, fields) {
    const data = fields && typeof fields === "object" ? fields : {};
    if (toolId === "missed-call-math") {
      const required = (name) => { if (data[name] !== undefined && String(data[name]).trim()) return data[name]; throw new Error("Missing required calculator input: " + name); };
      return missedCallExposure(required("calls_per_week"), required("missed_per_week"), required("average_job_value"));
    }
    if (toolId === "missed-call-math-advanced") {
      const required = (name) => { if (data[name] !== undefined && String(data[name]).trim()) return data[name]; throw new Error("Missing required calculator input: " + name); };
      return missedCallMath(required("weekly_missed_calls"), required("average_ticket"), required("close_percent"), data.weeks_per_month === undefined ? "4.33" : data.weeks_per_month);
    }
    if (toolId === "toy-filter") {
      return buyTryToy(["outcome", "proof", "exit", "team", "payback"].map((key) => data[key] === undefined ? "" : data[key]).join(","));
    }
    if (toolId === "invoice-aging") {
      const raw = firstNonEmpty(data, ["csv", "invoices"]);
      if (!raw) throw new Error("Provide sample CSV text.");
      if (data.as_of === undefined || !String(data.as_of).trim()) throw new Error("as_of is required.");
      return invoiceAging(raw, data.as_of);
    }
    if (toolId === "follow-up-eligibility") {
      const raw = firstNonEmpty(data, ["csv", "rows"]);
      if (!raw) throw new Error("Provide sample CSV text.");
      if (data.as_of === undefined || !String(data.as_of).trim()) throw new Error("as_of is required.");
      const min = integer(data.min_days === undefined ? 7 : data.min_days, "min_days");
      const dedupe = integer(data.dedupe_days === undefined ? 20 : data.dedupe_days, "dedupe_days");
      return followUpEligibility(raw, data.as_of, min, dedupe);
    }
    if (toolId === "business-brief-builder") return { tool: toolId, markdown: businessBrief(data) };
    throw new Error("This deterministic utility is not implemented yet.");
  }

  root.OwnerToolkitUtilities = { run };
  if (typeof module !== "undefined" && module.exports) module.exports = root.OwnerToolkitUtilities;
})(typeof window !== "undefined" ? window : globalThis);
