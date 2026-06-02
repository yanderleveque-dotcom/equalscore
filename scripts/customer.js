// customer.js — multi-step credit application + assessment result.

import { esc, clp, num } from "./utils.js";
import { isValidRut, formatRut } from "./rut.js";
import { PLACES, REGIONS } from "./data.js";
import { computeScore, explain, bandFor, isApproved } from "./scoring.js";

const STEPS = ["Datos personales", "Situación laboral", "Datos alternativos", "Crédito solicitado"];

export function renderCustomer(onSubmitConsulta) {
  const state = {
    step: 0,
    data: {
      name: "", rut: "", birth: "", region: "", comuna: "", phone: "", email: "",
      workType: "", income: "", tenureMonths: "",
      utilityMonths: 18, openBanking: false, appUsage: "media", phoneAuthorized: false,
      consentUtility: false, consentOB: false, consentApps: false, consentPhone: false,
      amount: "", termMonths: "12", purpose: "", consentFinal: false,
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
        else setField(key, inp.value);
        if (inp.type === "range") {
          const out = form.querySelector(`#out-${key}`);
          if (out) out.textContent = inp.value;
        }
        if (key === "region") rebuildComunas(form);
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
      const inputs = {
        utilityMonths: state.data.utilityMonths,
        income: state.data.income,
        tenureMonths: state.data.tenureMonths,
        workType: state.data.workType,
        appUsage: state.data.appUsage,
        openBanking: state.data.openBanking,
        phoneAuthorized: state.data.phoneAuthorized,
        name: state.data.name,
      };
      const res = computeScore(inputs);
      state.result = { ...res, explanation: explain(inputs, res) };
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
      if (!d.purpose) return set("Selecciona el propósito del crédito.");
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
    const send = root.querySelector('[data-act="send"]');
    if (send) send.addEventListener("click", () => {
      const rec = buildConsultaRecord(state.data, state.result);
      onSubmitConsulta?.(rec);
      send.textContent = "Enviado a la empresa ✓";
      send.disabled = true;
      send.classList.add("is-sent");
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
      ${field("Monto (CLP)", `<input type="number" data-field="amount" value="${esc(d.amount)}" min="0" step="50000" placeholder="800000" />`)}
      ${field("Plazo (meses)", `<select data-field="termMonths">${[6, 9, 12, 18, 24, 36].map((m) => `<option value="${m}" ${String(d.termMonths) === String(m) ? "selected" : ""}>${m} meses</option>`).join("")}</select>`)}
    </div>
    ${field("Propósito", `<select data-field="purpose" required>
      <option value="">Selecciona</option>
      ${["Capital de trabajo", "Emergencia médica", "Educación", "Mejoras del hogar", "Compra de herramientas", "Consolidar deudas"].map((p) => `<option ${d.purpose === p ? "selected" : ""}>${esc(p)}</option>`).join("")}
    </select>`)}
    <label class="consent consent-final"><input type="checkbox" data-field="consentFinal" ${d.consentFinal ? "checked" : ""} /> Autorizo a EqualScore a evaluar mi solicitud con los datos entregados.</label>
  </fieldset>`;
}

// ---- Result ---------------------------------------------------------------
function resultHTML(d, res) {
  const approved = isApproved(res.score);
  const factors = res.factors
    .filter((f) => f.points > 0)
    .sort((a, b) => b.points - a.points)
    .map((f) => `<li class="${f.positive ? "pos" : "neu"}"><span class="factor-pts">+${f.points}</span> ${esc(f.label)}</li>`)
    .join("");

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
          <p class="decision ${approved ? "ok" : "no"}">${approved ? "Crédito pre-aprobado" : "Necesitamos más datos para aprobar"}</p>
        </div>

        <div class="result-detail">
          <p class="result-explain">${esc(res.explanation)}</p>

          <div class="bias-verified">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 4 6v6c0 5 3.5 8 8 10 4.5-2 8-5 8-10V6l-8-4Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M9 12l2 2 4-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            <div><strong>Sesgo verificado.</strong> Este resultado se calculó sin usar tu género, comuna ni edad, y se auditó contra paridad de género y territorial.</div>
          </div>

          <h3 class="factors-title">Qué influyó en tu score</h3>
          <ul class="factors">${factors}</ul>

          <div class="result-actions">
            <button type="button" class="btn btn-primary" data-act="send">Enviar a la empresa</button>
            <button type="button" class="btn btn-ghost" data-act="restart">Hacer otra simulación</button>
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
  const approved = isApproved(res.score);
  const today = new Date().toISOString().slice(0, 10);
  const place = PLACES.find((p) => p.comuna === d.comuna) || {};
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
    },
    score: res.score,
    band: bandFor(res.score).key,
    decision: approved ? "aprobado" : "rechazado",
    estado: approved ? "al_dia" : "rechazado",
    consultaDate: today,
    walkIn: true,
    loan: approved
      ? {
          amount: Number(d.amount), termMonths: Number(d.termMonths), rateMonthly: 0.03,
          purpose: d.purpose, dateGranted: today, comisionApertura: Math.round(Number(d.amount) * 0.02),
          cuotaAmount: Math.round((Number(d.amount) / Number(d.termMonths)) * 1.03),
          cuotas: [], saldo: Number(d.amount), nextDueDate: today, daysLate: 0, mora90: false,
        }
      : null,
  };
}
