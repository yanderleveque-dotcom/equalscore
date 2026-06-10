// customer.js — multi-step credit application + assessment result.

import { esc, clp, num } from "./utils.js";
import { isValidRut, formatRut, formatRutInput } from "./rut.js";
import { PLACES, REGIONS } from "./data.js";
import { computeScore, explain, bandFor, recommendOffer } from "./scoring.js";

const STEPS = ["Datos personales", "Situación laboral", "Datos alternativos", "Crédito solicitado"];

const PURPOSE_OPTIONS = [
  "Capital de trabajo",
  "Emergencia médica",
  "Educación",
  "Mejoras del hogar",
  "Compra de herramientas",
  "Consolidar deudas",
];
const CUSTOM_PURPOSE = "__custom__";
const MAX_AMOUNT = 10000000; // tope de solicitud: $10.000.000

/**
 * Invent a plausible existing-credit profile for an applicant. Generated anew
 * each time a score is requested (so it varies), and fed into the score:
 *   · openCredits / openDebt — current obligations, raise risk.
 *   · repaidOnTime — previous credits paid on time, a positive track record.
 */
function inventCreditProfile() {
  const r = Math.random();
  let openCredits = 0;
  if (r < 0.45) openCredits = 0;
  else if (r < 0.75) openCredits = 1;
  else if (r < 0.9) openCredits = 2;
  else openCredits = 3;

  let openDebt = 0;
  for (let i = 0; i < openCredits; i++) {
    openDebt += (3 + Math.floor(Math.random() * 28)) * 100000; // $300.000–$3.000.000 c/u
  }

  const maxRepaid = openCredits > 0 ? 3 : 2;
  const repaidOnTime = Math.floor(Math.random() * (maxRepaid + 1));
  return { openCredits, openDebt, repaidOnTime };
}

export function renderCustomer(onSubmitConsulta, getHistory) {
  const state = {
    step: 0,
    data: {
      name: "", rut: "", birth: "", region: "", comuna: "", phone: "", email: "",
      workType: "", income: "", tenureMonths: "",
      utilityMonths: 18, openBanking: false, appUsage: "media", phoneAuthorized: false,
      consentUtility: false, consentOB: false, consentApps: false, consentPhone: false,
      amount: "", termMonths: "12", purpose: "", purposeOther: "", consentFinal: false,
    },
    result: null,
  };

  const root = document.createElement("section");
  root.className = "customer-view";

  function setField(key, value) {
    state.data[key] = value;
  }

  function go(step) {
    state.step = step;
    render();
    root.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function render() {
    if (state.result) {
      root.innerHTML = resultHTML(state.data, state.result);
      wireResult();
      return;
    }
    root.innerHTML = `
      <div class="cust-head">
        <h1>Solicita tu crédito</h1>
        <p class="cust-sub">Te evaluamos con lo que el banco nunca mira. Sin historial bancario, sin problema.</p>
        ${progressHTML(state.step)}
      </div>
      <form class="cust-form" novalidate>
        ${[step1, step2, step3, step4][state.step](state.data)}
        <p class="form-error" id="step-error" role="alert"></p>
        <div class="cust-nav">
          ${state.step > 0 ? `<button type="button" class="btn btn-ghost" data-act="back">Atrás</button>` : `<span></span>`}
          ${state.step < 3
            ? `<button type="button" class="btn btn-primary" data-act="next">Continuar</button>`
            : `<button type="submit" class="btn btn-primary">Evaluar mi crédito</button>`}
        </div>
      </form>
      <p class="demo-label">Resultado de demostración · datos simulados</p>
    `;
    wireForm();
  }

  function wireForm() {
    const form = root.querySelector(".cust-form");
    // bind inputs
    form.querySelectorAll("[data-field]").forEach((inp) => {
      const key = inp.dataset.field;
      const evt = inp.type === "checkbox" || inp.tagName === "SELECT" || inp.type === "range" ? "input" : "input";
      inp.addEventListener(evt, () => {
        if (inp.type === "checkbox") setField(key, inp.checked);
        else if (key === "rut") {
          // Live-format into canonical RUT form, preserving caret at the end.
          const formatted = formatRutInput(inp.value);
          inp.value = formatted;
          inp.setSelectionRange(formatted.length, formatted.length);
          setField(key, formatted);
        } else setField(key, inp.value);
        if (inp.type === "range") {
          const out = form.querySelector(`#out-${key}`);
          if (out) out.textContent = inp.value;
        }
        if (key === "region") rebuildComunas(form);
        if (key === "purpose") render(); // reveal/hide the custom-purpose field
      });
    });
    // simulated connect toggles
    form.querySelectorAll("[data-toggle]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.dataset.toggle;
        const next = !state.data[key];
        setField(key, next);
        btn.classList.toggle("is-on", next);
        btn.querySelector(".toggle-label").textContent = next ? "Conectado ✓" : btn.dataset.idle;
      });
    });
    const back = form.querySelector('[data-act="back"]');
    const next = form.querySelector('[data-act="next"]');
    if (back) back.addEventListener("click", () => go(state.step - 1));
    if (next) next.addEventListener("click", () => { if (validateStep()) go(state.step + 1); });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (!validateStep()) return;
      // Look this applicant up by RUT. A returning client carries REAL credit
      // history (their previously-approved, on-time loans) into the new score;
      // a first-time applicant gets a plausible invented profile so the credit
      // feedback still has something to show.
      const history = getHistory ? getHistory(state.data.rut) : null;
      const returning = !!(history && history.visits > 0);
      const creditHistory = returning ? history.creditHistory : inventCreditProfile();
      const inputs = {
        utilityMonths: state.data.utilityMonths,
        income: state.data.income,
        tenureMonths: state.data.tenureMonths,
        workType: state.data.workType,
        appUsage: state.data.appUsage,
        openBanking: state.data.openBanking,
        phoneAuthorized: state.data.phoneAuthorized,
        creditHistory,
        name: state.data.name,
      };
      const res = computeScore(inputs);
      state.result = {
        ...res,
        explanation: explain(inputs, res),
        history,
        returning,
        visitNumber: (history ? history.visits : 0) + 1,
      };
      // Requesting the score IS the application: send it to the company
      // automatically (no separate "enviar" step).
      onSubmitConsulta?.(buildConsultaRecord(state.data, state.result));
      render();
    });
    if (state.step === 0) rebuildComunas(form);
  }

  function rebuildComunas(form) {
    const sel = form.querySelector('[data-field="comuna"]');
    if (!sel) return;
    const region = state.data.region;
    const opts = PLACES.filter((p) => !region || p.region === region);
    sel.innerHTML =
      `<option value="">Selecciona comuna</option>` +
      opts.map((p) => `<option value="${esc(p.comuna)}" ${state.data.comuna === p.comuna ? "selected" : ""}>${esc(p.comuna)}</option>`).join("");
  }

  function validateStep() {
    const errEl = root.querySelector("#step-error");
    const set = (msg) => { errEl.textContent = msg; return false; };
    errEl.textContent = "";
    const d = state.data;
    if (state.step === 0) {
      if (!d.name.trim()) return set("Ingresa tu nombre completo.");
      if (!isValidRut(d.rut)) return set("RUT inválido. Revisa el número y el dígito verificador (ej: 12.345.678-5).");
      if (!d.birth) return set("Ingresa tu fecha de nacimiento.");
      if (!d.region) return set("Selecciona tu región.");
      if (!d.comuna) return set("Selecciona tu comuna.");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email)) return set("Ingresa un email válido.");
      // normalise RUT display
      d.rut = formatRut(d.rut);
    } else if (state.step === 1) {
      if (!d.workType) return set("Selecciona tu tipo de trabajo.");
      if (d.income === "" || Number(d.income) < 0) return set("Ingresa tu ingreso mensual aproximado.");
      if (d.tenureMonths === "" || Number(d.tenureMonths) < 0) return set("Ingresa la antigüedad en tu actividad.");
    } else if (state.step === 2) {
      if (!d.consentUtility) return set("Debes autorizar el uso de tus pagos de servicios para continuar.");
      if (d.openBanking && !d.consentOB) return set("Marca el consentimiento de Open Banking.");
      if (!d.consentApps) return set("Marca el consentimiento de comportamiento en apps.");
      if (d.phoneAuthorized && !d.consentPhone) return set("Marca el consentimiento de uso de celular.");
    } else if (state.step === 3) {
      if (d.amount === "" || Number(d.amount) <= 0) return set("Ingresa el monto que necesitas.");
      if (Number(d.amount) > MAX_AMOUNT) return set("El monto máximo que puedes solicitar es $10.000.000.");
      if (!d.purpose) return set("Selecciona el propósito del crédito.");
      if (d.purpose === CUSTOM_PURPOSE && !d.purposeOther.trim()) return set("Especifica el propósito del crédito.");
      if (!d.consentFinal) return set("Debes autorizar la evaluación para continuar.");
    }
    return true;
  }

  function wireResult() {
    const restart = root.querySelector('[data-act="restart"]');
    if (restart) restart.addEventListener("click", () => {
      state.result = null; state.step = 0;
      state.data.consentFinal = false;
      render();
    });
    drawGauge(root, state.result.score);
  }

  render();
  return root;
}

// ---- Step templates -------------------------------------------------------
function progressHTML(step) {
  return `<ol class="progress" aria-label="Progreso">${STEPS.map(
    (s, i) =>
      `<li class="${i < step ? "done" : i === step ? "active" : ""}"><span class="progress-dot">${i < step ? "✓" : i + 1}</span><span class="progress-label">${s}</span></li>`
  ).join("")}</ol>`;
}

function field(label, inner, hint) {
  return `<div class="field"><label>${label}</label>${inner}${hint ? `<p class="hint">${hint}</p>` : ""}</div>`;
}

function step1(d) {
  return `<fieldset><legend>Datos personales</legend>
    ${field("Nombre completo", `<input type="text" data-field="name" value="${esc(d.name)}" autocomplete="name" required />`)}
    ${field("RUT", `<input type="text" data-field="rut" value="${esc(d.rut)}" placeholder="12.345.678-5" inputmode="text" required />`, "Validamos el dígito verificador.")}
    ${field("Fecha de nacimiento", `<input type="date" data-field="birth" value="${esc(d.birth)}" max="2008-12-31" required />`)}
    <div class="grid-2">
      ${field("Región", `<select data-field="region" required><option value="">Selecciona región</option>${REGIONS.map((r) => `<option ${d.region === r ? "selected" : ""}>${esc(r)}</option>`).join("")}</select>`)}
      ${field("Comuna", `<select data-field="comuna" required></select>`)}
    </div>
    <div class="grid-2">
      ${field("Teléfono", `<input type="tel" data-field="phone" value="${esc(d.phone)}" placeholder="+569 1234 5678" autocomplete="tel" />`)}
      ${field("Email", `<input type="email" data-field="email" value="${esc(d.email)}" autocomplete="email" required />`)}
    </div>
  </fieldset>`;
}

function step2(d) {
  return `<fieldset><legend>Situación laboral e ingresos</legend>
    ${field("Tipo de trabajo", `<select data-field="workType" required>
      <option value="">Selecciona</option>
      <option value="dependiente" ${d.workType === "dependiente" ? "selected" : ""}>Dependiente</option>
      <option value="independiente" ${d.workType === "independiente" ? "selected" : ""}>Independiente</option>
      <option value="informal" ${d.workType === "informal" ? "selected" : ""}>Informal</option>
      <option value="sin_actividad" ${d.workType === "sin_actividad" ? "selected" : ""}>Sin actividad</option>
    </select>`)}
    <div class="grid-2">
      ${field("Ingreso mensual aproximado (CLP)", `<input type="number" data-field="income" value="${esc(d.income)}" min="0" step="10000" placeholder="450000" />`)}
      ${field("Antigüedad en la actividad (meses)", `<input type="number" data-field="tenureMonths" value="${esc(d.tenureMonths)}" min="0" step="1" placeholder="18" />`)}
    </div>
  </fieldset>`;
}

function step3(d) {
  return `<fieldset><legend>Datos alternativos <span class="legend-tag">con tu consentimiento</span></legend>
    <p class="privacy-note" role="note">🔒 Solo usamos <strong>métricas agregadas</strong>. Tú controlas qué compartes y puedes revocarlo cuando quieras. Nunca pedimos contraseñas ni datos de tarjetas.</p>

    <div class="alt-item">
      ${field(`Pagos de servicios al día (luz, agua, internet): <output id="out-utilityMonths">${esc(d.utilityMonths)}</output> meses consecutivos`,
        `<input type="range" data-field="utilityMonths" min="0" max="36" step="1" value="${esc(d.utilityMonths)}" />`)}
      <label class="consent"><input type="checkbox" data-field="consentUtility" ${d.consentUtility ? "checked" : ""} /> Autorizo usar mi historial de pagos de servicios.</label>
    </div>

    <div class="alt-item">
      <label>Open Banking (Ley Fintech 21.521)</label>
      <button type="button" class="connect-toggle ${d.openBanking ? "is-on" : ""}" data-toggle="openBanking" data-idle="Conectar Open Banking">
        <span class="toggle-label">${d.openBanking ? "Conectado ✓" : "Conectar Open Banking"}</span>
      </button>
      <p class="hint">Conexión simulada — no se realiza ninguna integración real.</p>
      <label class="consent"><input type="checkbox" data-field="consentOB" ${d.consentOB ? "checked" : ""} /> Autorizo verificar mis cuentas vía Open Banking.</label>
    </div>

    <div class="alt-item">
      ${field("Comportamiento en apps de delivery / e-commerce",
        `<select data-field="appUsage">
          <option value="baja" ${d.appUsage === "baja" ? "selected" : ""}>Frecuencia baja</option>
          <option value="media" ${d.appUsage === "media" ? "selected" : ""}>Frecuencia media</option>
          <option value="alta" ${d.appUsage === "alta" ? "selected" : ""}>Frecuencia alta</option>
        </select>`)}
      <label class="consent"><input type="checkbox" data-field="consentApps" ${d.consentApps ? "checked" : ""} /> Autorizo usar mi frecuencia de uso de apps (agregada).</label>
    </div>

    <div class="alt-item">
      <label>Uso de celular (métricas agregadas)</label>
      <button type="button" class="connect-toggle ${d.phoneAuthorized ? "is-on" : ""}" data-toggle="phoneAuthorized" data-idle="Autorizar uso de celular">
        <span class="toggle-label">${d.phoneAuthorized ? "Conectado ✓" : "Autorizar uso de celular"}</span>
      </button>
      <p class="hint">Autorización simulada — solo métricas agregadas, sin leer tu contenido.</p>
      <label class="consent"><input type="checkbox" data-field="consentPhone" ${d.consentPhone ? "checked" : ""} /> Autorizo usar métricas agregadas de mi celular.</label>
    </div>
  </fieldset>`;
}

function step4(d) {
  return `<fieldset><legend>Crédito solicitado</legend>
    <div class="grid-2">
      ${field("Monto (CLP)", `<input type="number" data-field="amount" value="${esc(d.amount)}" min="0" max="${MAX_AMOUNT}" step="50000" placeholder="800000" />`, "Monto máximo: $10.000.000.")}
      ${field("Plazo (meses)", `<select data-field="termMonths">${[6, 9, 12, 18, 24, 36].map((m) => `<option value="${m}" ${String(d.termMonths) === String(m) ? "selected" : ""}>${m} meses</option>`).join("")}</select>`)}
    </div>
    ${field("Propósito", `<select data-field="purpose" required>
      <option value="">Selecciona</option>
      ${PURPOSE_OPTIONS.map((p) => `<option value="${esc(p)}" ${d.purpose === p ? "selected" : ""}>${esc(p)}</option>`).join("")}
      <option value="${CUSTOM_PURPOSE}" ${d.purpose === CUSTOM_PURPOSE ? "selected" : ""}>Otro (especificar)</option>
    </select>`)}
    ${d.purpose === CUSTOM_PURPOSE ? field("Especifica el propósito", `<input type="text" data-field="purposeOther" value="${esc(d.purposeOther)}" placeholder="Cuéntanos para qué lo necesitas" maxlength="80" />`) : ""}
    <label class="consent consent-final"><input type="checkbox" data-field="consentFinal" ${d.consentFinal ? "checked" : ""} /> Autorizo a EqualScore a evaluar mi solicitud con los datos entregados.</label>
  </fieldset>`;
}

// ---- Result ---------------------------------------------------------------
function resultHTML(d, res) {
  const earned = res.score - 300;
  const headroom = 850 - res.score;

  // Band-aware headline. The final decision now belongs to the company, so we
  // describe the strength of the score rather than claiming "pre-aprobado".
  const bandMsg =
    res.band === "bajo"
      ? "Excelente puntaje · alta probabilidad de aprobación"
      : res.band === "medio"
        ? "Buen puntaje · calificas para evaluación"
        : "Puntaje en desarrollo · la empresa revisará tu caso";
  const decisionCls = res.band === "alto" ? "no" : "ok";

  // Recommended starter credit: a smaller amount and shorter term than asked.
  const offer = recommendOffer(res.score, d.amount, d.termMonths);
  const askedAmount = Number(d.amount) || 0;
  const askedTerm = Number(d.termMonths) || 0;
  const offerHTML = `
    <div class="starter-offer">
      <h3 class="starter-offer-title">Tu crédito recomendado para empezar</h3>
      <div class="starter-offer-figures">
        <div><span class="so-label">Monto sugerido</span><span class="so-val">${clp(offer.offerAmount)}</span></div>
        <div><span class="so-label">Plazo sugerido</span><span class="so-val">${offer.offerTermMonths} meses</span></div>
      </div>
      <p class="starter-offer-note">${
        offer.reduced
          ? `Es un monto menor y un plazo más corto que lo que solicitaste (${clp(askedAmount)} a ${askedTerm} meses), pensado para partir con paso firme.`
          : `Un primer crédito acotado para empezar a construir tu historial.`
      }</p>
      <p class="starter-offer-grow">📈 Al tomar este crédito y <strong>pagar tus cuotas a tiempo</strong>, tu score sube y en tu próxima solicitud podrás acceder a un monto mayor —hasta <strong>${clp(offer.nextAmount)}</strong>— y mejores condiciones.</p>
    </div>`;

  // Existing-credit feedback: how many credits the client already has open and
  // for how much, plus the effect on the score and the message that a good
  // repayment record raises it.
  const credit = res.credit || { openCredits: 0, openDebt: 0, repaidOnTime: 0, onTimeCredits: 0, adjustment: 0 };
  const adj = Number(credit.adjustment) || 0;
  const adjText =
    adj === 0
      ? ""
      : `<span class="credit-adj ${adj > 0 ? "pos" : "neg"}">${adj > 0 ? "+" : ""}${adj} pts en tu puntaje</span>`;
  const openLine =
    credit.openCredits > 0
      ? `<p>Detectamos que ya tienes <strong>${credit.openCredits} crédito${credit.openCredits === 1 ? "" : "s"} abierto${credit.openCredits === 1 ? "" : "s"}</strong> por un total de <strong>${clp(credit.openDebt)}</strong>. Tener deuda vigente aumenta tu carga financiera y resta puntaje.</p>`
      : `<p>No detectamos <strong>créditos abiertos</strong> a tu nombre. No arrastrar deuda vigente juega a tu favor.</p>`;
  const onTimeLine =
    credit.onTimeCredits > 0
      ? `<p class="credit-good">✓ Estás <strong>pagando a tiempo</strong> ${credit.onTimeCredits === 1 ? "tu crédito vigente" : `tus ${credit.onTimeCredits} créditos vigentes`} con nosotros, lo que <strong>sube tu puntaje</strong>.</p>`
      : "";
  const historyLine =
    credit.repaidOnTime > 0
      ? `<p class="credit-good">✓ Registras <strong>${credit.repaidOnTime} crédito${credit.repaidOnTime === 1 ? "" : "s"} anterior${credit.repaidOnTime === 1 ? "" : "es"} pagado${credit.repaidOnTime === 1 ? "" : "s"} a tiempo</strong>, lo que <strong>sube tu puntaje</strong>.</p>`
      : credit.onTimeCredits > 0
        ? ""
        : `<p>Aún no registramos créditos anteriores pagados a tiempo. <strong>Un buen historial de pago de un crédito previo mejora tu puntaje</strong> en futuras solicitudes.</p>`;
  const creditHTML = `
    <div class="credit-status">
      <h3 class="credit-status-title">Tu situación de crédito ${adjText}</h3>
      ${openLine}
      ${onTimeLine}
      ${historyLine}
      <p class="credit-status-grow">Pagar tus créditos —los de hoy y los que vengan— <strong>a tiempo</strong> es la forma más rápida de subir tu puntaje y acceder a montos mayores.</p>
    </div>`;

  // Returning-client greeting: recognise the RUT and state which application
  // number this is, with the running approved/rejected tally and on-time note.
  const history = res.history;
  const visitNumber = res.visitNumber || 1;
  const ordinal = `${visitNumber}ª`;
  let returningHTML = "";
  if (res.returning && history) {
    const parts = [];
    if (history.approvals > 0) parts.push(`<strong>${history.approvals}</strong> ${history.approvals === 1 ? "crédito aprobado" : "créditos aprobados"}`);
    if (history.rejections > 0) parts.push(`<strong>${history.rejections}</strong> ${history.rejections === 1 ? "rechazo" : "rechazos"}`);
    if (history.pending > 0) parts.push(`<strong>${history.pending}</strong> en revisión`);
    const tally = parts.length ? ` Tu historial con nosotros: ${parts.join(", ")}.` : "";
    const onTime =
      history.onTimeCredits > 0
        ? ` Como vienes <strong>pagando a tiempo</strong> tu crédito vigente, sumamos puntos a tu favor en esta evaluación.`
        : history.repaidOnTime > 0
          ? ` Tu historial de pago a tiempo suma puntos a tu favor.`
          : "";
    returningHTML = `
      <div class="returning-banner">
        <span class="returning-badge">${ordinal} solicitud</span>
        <p>👋 ¡Hola de nuevo, ${esc(String(d.name).split(" ")[0])}! Reconocimos tu RUT: esta es tu <strong>${ordinal} solicitud</strong> con EqualScore.${tally}${onTime}</p>
      </div>`;
  }

  // Every factor is shown: positive contributors in green with an "of max"
  // sub-label, zero-contribution factors dimmed so it's obvious which data
  // sources weren't used yet.
  const factors = res.factors
    .map((f) => {
      const zero = f.points <= 0;
      const cls = zero ? "zero" : f.positive ? "pos" : "neu";
      const sub = zero
        ? `<span class="factor-zero-pts">Sin aporte todavía · hasta ${f.max} puntos posibles</span>`
        : `<span class="factor-of-max">${f.points} / ${f.max} posibles</span>`;
      return `<li class="${cls}">
        <span class="factor-pts">+${f.points}</span>
        <span class="factor-body"><span class="factor-label">${esc(f.label)}</span>${sub}</span>
      </li>`;
    })
    .join("");

  // Prioritised "how to improve" list — only factors with room to grow,
  // ordered by the biggest potential gain.
  const improvements = res.factors
    .filter((f) => f.tip)
    .map((f) => ({ gain: f.max - f.points, tip: f.tip }))
    .filter((x) => x.gain > 0)
    .sort((a, b) => b.gain - a.gain);

  const improvementsHTML = improvements.length
    ? `<div class="improvements">
        <h3 class="improvements-title">Cómo mejorar tu puntaje</h3>
        <ul>
          ${improvements
            .map(
              (i) => `<li class="improvement-item"><span class="improvement-gain">+${i.gain} pts</span><span class="improvement-tip">${esc(i.tip)}</span></li>`
            )
            .join("")}
        </ul>
      </div>`
    : `<p class="all-max-note">¡Excelente! Estás aprovechando al máximo todos los factores que medimos.</p>`;

  return `
    <div class="result-screen">
      <p class="demo-label demo-label-top">Resultado de demostración · datos simulados</p>
      <div class="result-grid">
        <div class="gauge-card">
          <div class="gauge-wrap">
            <svg class="gauge" viewBox="0 0 260 150" role="img" aria-label="Puntaje ${res.score} de 850">
              <path class="gauge-track" d="M20 140 A 110 110 0 0 1 240 140" fill="none" />
              <path class="gauge-value" id="gauge-value" d="M20 140 A 110 110 0 0 1 240 140" fill="none" stroke="${res.color}" />
            </svg>
            <div class="gauge-center">
              <span class="gauge-score" style="color:${res.color}">${res.score}</span>
              <span class="gauge-scale">de 300 a 850</span>
            </div>
          </div>
          <div class="band-badge" style="background:${res.color}1a;color:${res.color}">${esc(res.bandLabel)}</div>
          <p class="decision ${decisionCls}">${bandMsg}</p>
          <p class="decision-sub">La decisión final la toma la empresa que otorga el crédito.</p>
          <div class="score-breakdown">
            <div><span class="sb-label">Base</span><span class="sb-val">300</span></div>
            <div><span class="sb-label">Puntos obtenidos</span><span class="sb-val">+${earned}</span></div>
            <div><span class="sb-label">Puntos posibles adicionales</span><span class="sb-val">+${headroom}</span></div>
          </div>
        </div>

        <div class="result-detail">
          ${returningHTML}
          <p class="result-explain">${esc(res.explanation)}</p>

          <div class="bias-verified">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 4 6v6c0 5 3.5 8 8 10 4.5-2 8-5 8-10V6l-8-4Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M9 12l2 2 4-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            <div><strong>Sesgo verificado.</strong> Este resultado se calculó sin usar tu género, comuna ni edad, y se auditó contra paridad de género y territorial.</div>
          </div>

          ${creditHTML}

          ${offerHTML}

          <h3 class="factors-title">Qué influyó en tu score</h3>
          <ul class="factors">${factors}</ul>

          ${improvementsHTML}

          <p class="send-note" id="send-note">✓ Tu solicitud se <strong>envió automáticamente</strong> a la empresa y quedó <strong>pendiente</strong> de aprobación. La empresa la revisará y decidirá si otorga el crédito.</p>
          <div class="result-actions">
            <button type="button" class="btn btn-ghost" data-act="restart">Hacer otra solicitud</button>
          </div>
        </div>
      </div>
    </div>`;
}

function drawGauge(root, score) {
  const path = root.querySelector("#gauge-value");
  if (!path) return;
  const len = path.getTotalLength();
  const frac = (score - 300) / 550;
  path.style.strokeDasharray = String(len);
  path.style.strokeDashoffset = String(len * (1 - frac));
}

function buildConsultaRecord(d, res) {
  const id = "W" + Date.now().toString().slice(-7);
  const today = new Date().toISOString().slice(0, 10);
  const place = PLACES.find((p) => p.comuna === d.comuna) || {};
  const purpose = d.purpose === CUSTOM_PURPOSE ? d.purposeOther.trim() : d.purpose;
  // New walk-in applications start PENDIENTE: the company decides whether to
  // approve. We stash the requested terms so the loan can be built on approval.
  return {
    id,
    name: d.name,
    gender: "",
    age: d.birth ? Math.max(0, new Date().getFullYear() - new Date(d.birth).getFullYear()) : null,
    comuna: d.comuna,
    region: d.region,
    penalizedComuna: !!place.penalized,
    rut: formatRut(d.rut),
    phone: d.phone,
    email: d.email,
    scoreInputs: {
      utilityMonths: d.utilityMonths, income: Number(d.income), tenureMonths: Number(d.tenureMonths),
      workType: d.workType, appUsage: d.appUsage, openBanking: d.openBanking, phoneAuthorized: d.phoneAuthorized,
      creditHistory: res.credit
        ? {
            openCredits: res.credit.openCredits,
            openDebt: res.credit.openDebt,
            repaidOnTime: res.credit.repaidOnTime,
            onTimeCredits: res.credit.onTimeCredits,
          }
        : undefined,
    },
    score: res.score,
    band: bandFor(res.score).key,
    decision: "pendiente",
    estado: "pendiente",
    consultaDate: today,
    walkIn: true,
    requested: {
      amount: Number(d.amount),
      termMonths: Number(d.termMonths),
      purpose,
    },
    loan: null,
  };
}
