// data.js — seeded mock dataset + derived statistics + localStorage persistence.
//
// Everything the dashboard shows derives from this single dataset, so KPIs and
// charts are always internally consistent. Data is generated deterministically
// from a fixed seed, then persisted to localStorage; session changes (new
// consultas) are saved back.

import { mulberry32, clamp, daysBetween } from "./utils.js";
import { rutFromBody } from "./rut.js";
import { computeScore, bandFor, isApproved } from "./scoring.js";

const STORAGE_KEY = "equalscore.dataset.v1";
const SEED = 20260603;
const TODAY = new Date(); // app "now"

// ---- Seed name / place lists (Chilean) ----------------------------------
const FEMALE = ["María", "Camila", "Javiera", "Francisca", "Valentina", "Antonia", "Catalina", "Constanza", "Daniela", "Fernanda", "Josefa", "Trinidad", "Isidora", "Rocío", "Paula"];
const MALE = ["Juan", "Diego", "Matías", "Benjamín", "Vicente", "Sebastián", "Cristóbal", "Felipe", "Tomás", "Joaquín", "Ignacio", "Nicolás", "Pedro", "Carlos", "Rodrigo"];
const SURNAMES = ["González", "Muñoz", "Rojas", "Díaz", "Pérez", "Soto", "Contreras", "Silva", "Martínez", "Sepúlveda", "Morales", "Rodríguez", "López", "Fuentes", "Araya", "Espinoza", "Castillo", "Tapia", "Reyes", "Gutiérrez", "Vergara", "Cárdenas", "Mancilla", "Huenchual"];

// comuna -> { region, penalized }  (penalized = historically credit-penalised area)
const COMUNAS = [
  { comuna: "Santiago", region: "Metropolitana", penalized: false },
  { comuna: "Providencia", region: "Metropolitana", penalized: false },
  { comuna: "Las Condes", region: "Metropolitana", penalized: false },
  { comuna: "Maipú", region: "Metropolitana", penalized: false },
  { comuna: "Puente Alto", region: "Metropolitana", penalized: true },
  { comuna: "La Pintana", region: "Metropolitana", penalized: true },
  { comuna: "El Bosque", region: "Metropolitana", penalized: true },
  { comuna: "Recoleta", region: "Metropolitana", penalized: true },
  { comuna: "Valparaíso", region: "Valparaíso", penalized: false },
  { comuna: "Viña del Mar", region: "Valparaíso", penalized: false },
  { comuna: "Quilpué", region: "Valparaíso", penalized: true },
  { comuna: "Concepción", region: "Biobío", penalized: false },
  { comuna: "Talcahuano", region: "Biobío", penalized: true },
  { comuna: "Temuco", region: "Araucanía", penalized: true },
  { comuna: "Padre Las Casas", region: "Araucanía", penalized: true },
  { comuna: "La Serena", region: "Coquimbo", penalized: false },
  { comuna: "Antofagasta", region: "Antofagasta", penalized: false },
  { comuna: "Puerto Montt", region: "Los Lagos", penalized: true },
  { comuna: "Rancagua", region: "O'Higgins", penalized: false },
  { comuna: "Iquique", region: "Tarapacá", penalized: false },
];

export const PLACES = COMUNAS;
export const REGIONS = [...new Set(COMUNAS.map((c) => c.region))];
const WORK_TYPES = ["dependiente", "independiente", "informal", "sin_actividad"];
const PURPOSES = ["Capital de trabajo", "Emergencia médica", "Educación", "Mejoras del hogar", "Compra de herramientas", "Consolidar deudas"];
const APP_USAGE = ["baja", "media", "alta"];

function addMonths(date, n) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + n);
  return d;
}
function iso(date) {
  return new Date(date).toISOString().slice(0, 10);
}
function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}
function range(rng, lo, hi) {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

// ---- Generation ----------------------------------------------------------
function generate(seed = SEED) {
  const rng = mulberry32(seed);
  const customers = [];
  const COUNT = 220;
  let rutBody = 9_000_000;

  for (let i = 0; i < COUNT; i++) {
    const gender = rng() < 0.5 ? "F" : "M";
    const age = range(rng, 19, 64);
    const first = pick(rng, gender === "F" ? FEMALE : MALE);
    const name = `${first} ${pick(rng, SURNAMES)} ${pick(rng, SURNAMES)}`;
    const place = pick(rng, COMUNAS);
    rutBody += range(rng, 11000, 90000);
    const rut = rutFromBody(rutBody);

    const workType = weightedWork(rng);
    const isWomen2535 = gender === "F" && age >= 25 && age <= 35;
    const isPrime2535 = age >= 25 && age <= 35;

    // Alternative-data inputs. Prime working-age applicants (25–35, both
    // genders) are given solid utility histories so the engine approves them
    // fairly — gender parity holds on APPROVAL while default rates still differ
    // by real repayment behaviour (see pDefault below). A "good payer" history
    // is sprinkled across ~40% of everyone else regardless of comuna, so
    // penalised and non-penalised areas stay statistically equal (geographic
    // parity holds) and good-history customers in penalised comunas get
    // approved.
    const utilityMonths = isPrime2535
      ? range(rng, 18, 36)
      : rng() < 0.4
        ? range(rng, 16, 34) // good payers, anywhere
        : range(rng, 0, 34);

    const income = incomeFor(rng, workType);
    const tenureMonths = range(rng, 1, 72);
    const appUsage = pick(rng, APP_USAGE);
    const openBanking = rng() < 0.72;
    const phoneAuthorized = rng() < 0.6;

    const scoreInputs = { utilityMonths, income, tenureMonths, workType, appUsage, openBanking, phoneAuthorized, name };
    const { score } = computeScore(scoreInputs);
    const approved = isApproved(score);

    // Origination/consulta date: a growing-lender curve. ~62% of applicants
    // arrived in the last ~14 weeks, smoothly denser toward the present so the
    // weekly disbursement chart trends up without empty weeks or a single-day
    // spike; the remaining ~38% are spread back to ~18 months so the book still
    // has mature loans for the delinquency curve and "pagado" status. A single
    // rng() draw keeps the deterministic stream (and fairness tuning) intact.
    const u = rng();
    let ageDays;
    if (u < 0.66) {
      const t = u / 0.66; // 0..1 within the recent band
      ageDays = Math.floor(Math.pow(t, 1.45) * 84); // last 12 weeks, growth toward present
    } else {
      const t = (u - 0.66) / 0.34; // 0..1 within the older band
      ageDays = Math.floor(84 + t * (540 - 84));
    }
    const consultaDate = iso(addDays(TODAY, -ageDays));

    let loan = null;
    let estado = "rechazado";
    if (approved) {
      const amount = range(rng, 4, 26) * 100000; // 400k – 2.6M CLP (tighter, realistic micro-loan)
      const termMonths = pick(rng, [6, 9, 12, 18, 24]);
      const rateMonthly = 0.022 + rng() * 0.018; // 2.2% – 4.0%
      const purpose = pick(rng, PURPOSES);
      const dateGranted = consultaDate;

      // Default propensity tells the fairness story: women 25–35 default the
      // LEAST; men 25–35 and men 40+ default more (echoes the brand bias table).
      let pDefault = 0.14;
      if (isWomen2535) pDefault = 0.05;
      else if (gender === "M" && age >= 25 && age <= 35) pDefault = 0.18;
      else if (gender === "M" && age > 40) pDefault = 0.24;
      else if (gender === "F") pDefault = 0.09;

      const ageOfLoan = daysBetween(TODAY, dateGranted);
      const matured = ageOfLoan > termMonths * 30;

      if (rng() < pDefault) estado = "en_mora";
      else if (matured && rng() < 0.5) estado = "pagado";
      else estado = "al_dia";

      loan = buildLoan(rng, { amount, termMonths, rateMonthly, purpose, dateGranted, estado });
    }

    customers.push({
      id: "C" + String(1000 + i),
      name,
      gender,
      age,
      comuna: place.comuna,
      region: place.region,
      penalizedComuna: place.penalized,
      rut,
      phone: "+569 " + range(rng, 4000, 9999) + " " + range(rng, 1000, 9999),
      email: deburr(first).toLowerCase() + "." + String(rutBody).slice(-4) + "@correo.cl",
      scoreInputs,
      score,
      band: bandFor(score).key,
      decision: approved ? "aprobado" : "rechazado",
      estado,
      consultaDate,
      loan,
    });
  }
  return customers;
}

function buildLoan(rng, { amount, termMonths, rateMonthly, purpose, dateGranted, estado }) {
  const principalPer = amount / termMonths;
  const interestPer = amount * rateMonthly;
  const cuotaAmount = principalPer + interestPer;
  const cuotas = [];

  // How many cuotas are already due as of today.
  let pastDue = 0;
  for (let n = 1; n <= termMonths; n++) {
    if (addMonths(dateGranted, n) <= TODAY) pastDue++;
  }

  // For "en mora", stop paying at some past cuota so there is an overdue one.
  let paidUntil = pastDue;
  if (estado === "en_mora") {
    paidUntil = Math.max(0, pastDue - range(rng, 1, Math.max(1, Math.min(3, pastDue))));
  } else if (estado === "pagado") {
    paidUntil = termMonths;
  }

  for (let n = 1; n <= termMonths; n++) {
    const dueDate = iso(addMonths(dateGranted, n));
    const isPast = new Date(dueDate) <= TODAY;
    let status, paidDate = null;
    if (n <= paidUntil) {
      status = "pagada";
      paidDate = dueDate;
    } else if (isPast) {
      status = "atrasada";
    } else {
      status = "pendiente";
    }
    cuotas.push({ n, dueDate, amount: Math.round(cuotaAmount), interest: Math.round(interestPer), status, paidDate });
  }

  const unpaid = cuotas.filter((c) => c.status !== "pagada");
  const saldo = Math.round(unpaid.length * principalPer);
  const firstUnpaid = cuotas.find((c) => c.status !== "pagada");
  const firstAtrasada = cuotas.find((c) => c.status === "atrasada");
  const daysLate = firstAtrasada ? daysBetween(TODAY, firstAtrasada.dueDate) : 0;

  return {
    amount,
    termMonths,
    rateMonthly,
    purpose,
    dateGranted,
    comisionApertura: Math.round(amount * 0.02),
    cuotaAmount: Math.round(cuotaAmount),
    cuotas,
    saldo: estado === "pagado" ? 0 : saldo,
    nextDueDate: estado === "pagado" ? null : firstUnpaid ? firstUnpaid.dueDate : null,
    daysLate,
    mora90: daysLate >= 90,
  };
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}
function weightedWork(rng) {
  const r = rng();
  if (r < 0.3) return "informal";
  if (r < 0.6) return "independiente";
  if (r < 0.88) return "dependiente";
  return "sin_actividad";
}
function incomeFor(rng, workType) {
  const base = { dependiente: [400000, 1400000], independiente: [300000, 1200000], informal: [180000, 700000], sin_actividad: [0, 250000] }[workType];
  return Math.round((base[0] + rng() * (base[1] - base[0])) / 10000) * 10000;
}
function deburr(s) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// ---- Persistence ----------------------------------------------------------
export function loadDataset() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (_) {}
  const data = generate();
  saveDataset(data);
  return data;
}
export function saveDataset(customers) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(customers));
  } catch (_) {}
}
export function resetDataset() {
  const data = generate();
  saveDataset(data);
  return data;
}
export function addCustomer(customers, record) {
  const next = [record, ...customers];
  saveDataset(next);
  return next;
}
export function updateCustomer(customers, id, patch) {
  const next = customers.map((c) => (c.id === id ? { ...c, ...patch, loan: patch.loan !== undefined ? patch.loan : c.loan } : c));
  saveDataset(next);
  return next;
}
export function deleteCustomer(customers, id) {
  const next = customers.filter((c) => c.id !== id);
  saveDataset(next);
  return next;
}

// ---- Derived statistics ----------------------------------------------------
function periodWindows(period) {
  const days = period === "semana" ? 7 : 30;
  const curEnd = TODAY;
  const curStart = addDays(TODAY, -days);
  const prevStart = addDays(TODAY, -2 * days);
  return { curStart, curEnd, prevStart, prevEnd: curStart, days };
}
function inWindow(dateStr, start, end) {
  const d = new Date(dateStr);
  return d > start && d <= end;
}

/** Revenue realised in a window: aperturas + intereses de cuotas pagadas. */
function revenueInWindow(customers, start, end) {
  let rev = 0;
  for (const c of customers) {
    if (!c.loan) continue;
    if (inWindow(c.loan.dateGranted, start, end)) rev += c.loan.comisionApertura;
    for (const cu of c.loan.cuotas) {
      if (cu.status === "pagada" && cu.paidDate && inWindow(cu.paidDate, start, end)) rev += cu.interest;
    }
  }
  return rev;
}

export function computeStats(customers, period = "mes") {
  const { curStart, curEnd, prevStart, prevEnd } = periodWindows(period);

  const cohort = (start, end) => customers.filter((c) => inWindow(c.consultaDate, start, end));
  const cur = cohort(curStart, curEnd);
  const prev = cohort(prevStart, prevEnd);

  const metricsFor = (set, revStart, revEnd) => {
    const loans = set.filter((c) => c.loan);
    const approved = set.filter((c) => c.decision === "aprobado");
    const montoPrestado = loans.reduce((s, c) => s + c.loan.amount, 0);
    const pagadores = loans.filter((c) => c.estado === "al_dia" || c.estado === "pagado").length;
    const noPagadores = loans.filter((c) => c.estado === "en_mora").length;
    const enMora90 = loans.filter((c) => c.loan.mora90);
    const montoMora = enMora90.reduce((s, c) => s + c.loan.saldo, 0);
    const aprobacion = set.length ? approved.length / set.length : 0;
    const scorePromedio = approved.length ? Math.round(approved.reduce((s, c) => s + c.score, 0) / approved.length) : 0;
    return {
      montoPrestado,
      cantidad: loans.length,
      revenue: revenueInWindow(customers, revStart, revEnd),
      pagadores,
      noPagadores,
      moraRate: loans.length ? noPagadores / loans.length : 0,
      mora90Rate: loans.length ? enMora90.length / loans.length : 0,
      montoMora,
      aprobacion,
      scorePromedio,
    };
  };

  const c = metricsFor(cur, curStart, curEnd);
  const p = metricsFor(prev, prevStart, prevEnd);

  // Book-level totals (whole portfolio, not period-scoped).
  const allLoans = customers.filter((x) => x.loan);
  const carteraActiva = allLoans
    .filter((x) => x.estado === "al_dia" || x.estado === "en_mora")
    .reduce((s, x) => s + x.loan.saldo, 0);
  const pagadoresTot = allLoans.filter((x) => x.estado === "al_dia" || x.estado === "pagado").length;
  const noPagadoresTot = allLoans.filter((x) => x.estado === "en_mora").length;

  return {
    period,
    cur: c,
    deltas: {
      montoPrestado: delta(c.montoPrestado, p.montoPrestado),
      cantidad: delta(c.cantidad, p.cantidad),
      revenue: delta(c.revenue, p.revenue),
      moraRate: delta(c.moraRate, p.moraRate),
      aprobacion: delta(c.aprobacion, p.aprobacion),
      scorePromedio: delta(c.scorePromedio, p.scorePromedio),
      pagadores: delta(c.pagadores, p.pagadores),
    },
    book: { carteraActiva, pagadores: pagadoresTot, noPagadores: noPagadoresTot },
    series: weeklySeries(customers),
    moraSeries: moraEvolution(customers),
    fairness: fairness(customers),
  };
}

const MONTH_ABBR = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

/**
 * Realistic delinquency evolution: a CUMULATIVE portfolio mora rate over the
 * last 12 months. At each month-end we count loans already originated by then
 * (people who took credit) and, of those, how many were already in mora at that
 * date (people not paying). This produces a smooth curve that rises as the book
 * matures — instead of the noisy per-week origination ratio — and stays
 * consistent with the credit volume and the actual non-payers in the dataset.
 */
function moraEvolution(customers) {
  const points = [];
  for (let m = 11; m >= 0; m--) {
    const end = addMonths(TODAY, -m);
    let active = 0;
    let mora = 0;
    for (const c of customers) {
      if (!c.loan) continue;
      if (new Date(c.loan.dateGranted) <= end) {
        active++;
        if (c.estado === "en_mora") {
          const firstAtrasada = (c.loan.cuotas || []).find((cu) => cu.status === "atrasada");
          if (firstAtrasada && new Date(firstAtrasada.dueDate) <= end) mora++;
        }
      }
    }
    points.push({
      label: MONTH_ABBR[end.getMonth()],
      moraRate: active ? mora / active : 0,
      active,
      mora,
    });
  }
  return points;
}

function delta(cur, prev) {
  const abs = cur - prev;
  const relPct = prev !== 0 ? abs / Math.abs(prev) : cur !== 0 ? 1 : 0;
  return { abs, relPct, dir: abs > 0 ? "up" : abs < 0 ? "down" : "flat" };
}

/** Last 8 weekly buckets for the time-series charts. */
function weeklySeries(customers) {
  const weeks = [];
  for (let w = 7; w >= 0; w--) {
    const end = addDays(TODAY, -7 * w);
    const start = addDays(end, -7);
    let monto = 0, moraLoans = 0, loans = 0;
    for (const c of customers) {
      if (c.loan && inWindow(c.loan.dateGranted, start, end)) {
        monto += c.loan.amount;
        loans++;
        if (c.estado === "en_mora") moraLoans++;
      }
    }
    weeks.push({
      label: iso(end).slice(5), // mm-dd
      monto,
      revenue: revenueInWindow(customers, start, end),
      moraRate: loans ? moraLoans / loans : 0,
    });
  }
  return weeks;
}

/** Fairness monitor: approval & default rate by gender and by comuna. */
function fairness(customers) {
  const byGender = ["F", "M"].map((g) => {
    const set = customers.filter((c) => c.gender === g);
    const loans = set.filter((c) => c.loan);
    return {
      key: g === "F" ? "Mujeres" : "Hombres",
      n: set.length,
      approval: set.length ? set.filter((c) => c.decision === "aprobado").length / set.length : 0,
      defaultRate: loans.length ? loans.filter((c) => c.estado === "en_mora").length / loans.length : 0,
    };
  });

  const comunaMap = {};
  for (const c of customers) {
    const k = c.comuna;
    (comunaMap[k] ||= { key: k, penalized: c.penalizedComuna, set: [] }).set.push(c);
  }
  const byComuna = Object.values(comunaMap)
    .map((o) => {
      const loans = o.set.filter((c) => c.loan);
      return {
        key: o.key,
        penalized: o.penalized,
        n: o.set.length,
        approval: o.set.length ? o.set.filter((c) => c.decision === "aprobado").length / o.set.length : 0,
        defaultRate: loans.length ? loans.filter((c) => c.estado === "en_mora").length / loans.length : 0,
      };
    })
    .filter((o) => o.n >= 2)
    .sort((a, b) => b.n - a.n);

  // Parity check: gap in approval between groups. <= 12 pts is considered OK.
  const genderGap = Math.abs(byGender[0].approval - byGender[1].approval);

  // Geographic parity is measured as penalised comunas vs the rest. Per-comuna
  // rates are too small-sample to be meaningful; grouping gives large, stable
  // samples and directly tests the brand claim of "no geographic penalty".
  const approvalOf = (set) => (set.length ? set.filter((c) => c.decision === "aprobado").length / set.length : 0);
  const penalizedSet = customers.filter((c) => c.penalizedComuna);
  const restSet = customers.filter((c) => !c.penalizedComuna);
  const penalizedApproval = approvalOf(penalizedSet);
  const restApproval = approvalOf(restSet);
  const comunaGap = Math.abs(penalizedApproval - restApproval);

  return {
    byGender,
    byComuna,
    genderParity: genderGap <= 0.12 ? "ok" : "revisar",
    genderGap,
    comunaParity: comunaGap <= 0.12 ? "ok" : "revisar",
    comunaGap,
    penalizedApproval,
    restApproval,
    penalizedN: penalizedSet.length,
    restN: restSet.length,
  };
}

export const estadoLabels = {
  al_dia: "Al día",
  en_mora: "En mora",
  pagado: "Pagado",
  rechazado: "Rechazado",
};
