// scoring.js — EqualScore demo scoring engine.
//
// TRANSPARENT & DETERMINISTIC: the same inputs always yield the same score.
// The score is the base (300) plus weighted contributions that sum to a
// maximum of 550, giving a 300–850 range. By design it uses ONLY behavioural
// and financial signals — NEVER gender, comuna, age or any protected
// attribute — which is what lets us stamp the result "sesgo verificado".
//
// Contribution budget (max points):
//   Pagos de servicios al día (0–36 meses) ............ 220  (weighted heavily)
//   Estabilidad de ingresos ........................... 160
//        · monto del ingreso (cap $1.000.000) .......... 60
//        · antigüedad en la actividad (cap 60 meses) ... 60
//        · tipo de trabajo ............................. 40
//   Comportamiento en apps (baja/media/alta) ..........  70
//   Open Banking conectado ............................  60
//   Uso de celular autorizado .........................  40
//   ----------------------------------------------------------
//   Total máximo sobre la base 300 .................... 550  -> 850

import { clamp } from "./utils.js";

const WORK_POINTS = {
  dependiente: 40,
  independiente: 30,
  informal: 16,
  sin_actividad: 0,
};

const APP_POINTS = { baja: 0, media: 35, alta: 70 };

export function computeScore(input) {
  const utilityMonths = clamp(Number(input.utilityMonths) || 0, 0, 36);
  const income = Math.max(0, Number(input.income) || 0);
  const tenureMonths = Math.max(0, Number(input.tenureMonths) || 0);
  const workType = input.workType || "sin_actividad";
  const appUsage = input.appUsage || "baja";
  const openBanking = !!input.openBanking;
  const phoneAuthorized = !!input.phoneAuthorized;

  const utilityPts = (utilityMonths / 36) * 220;
  const incomePts = clamp(income / 1_000_000, 0, 1) * 60;
  const tenurePts = clamp(tenureMonths / 60, 0, 1) * 60;
  const workPts = WORK_POINTS[workType] ?? 0;
  const appPts = APP_POINTS[appUsage] ?? 0;
  const obPts = openBanking ? 60 : 0;
  const phonePts = phoneAuthorized ? 40 : 0;

  const raw = 300 + utilityPts + incomePts + tenurePts + workPts + obPts + appPts + phonePts;
  const score = Math.round(clamp(raw, 300, 850));

  const band = bandFor(score);

  // ---- per-factor improvement tips ----------------------------------------
  // Each tip quantifies exactly how many points the user could still gain and
  // names a concrete action. Tips are null when the factor is already maxed.
  const utilityGap = 220 - Math.round(utilityPts);
  let utilityTip = null;
  if (utilityMonths < 36 && utilityGap > 0) {
    const monthsToMax = 36 - utilityMonths;
    utilityTip = `Mantén tus servicios al día: ${monthsToMax} ${monthsToMax === 1 ? "mes más" : "meses más"} consecutivos suman hasta +${utilityGap} puntos.`;
  }

  // Income stability: surface the single binding sub-factor (work/income/tenure).
  const workGap = 40 - workPts;
  const incomeGap = Math.round(60 - incomePts);
  const tenureGap = Math.round(60 - tenurePts);
  const stabCandidates = [
    { gap: workGap, msg: (g) => `Formaliza tu actividad laboral (dependiente o independiente): suma hasta +${g} puntos.` },
    { gap: incomeGap, msg: (g) => `Acreditar un ingreso mayor (hasta $1.000.000) suma hasta +${g} puntos.` },
    { gap: tenureGap, msg: (g) => `Sumar antigüedad en tu actividad (hasta 60 meses) aporta hasta +${g} puntos.` },
  ].filter((c) => c.gap > 0).sort((a, b) => b.gap - a.gap);
  const stabilityTip = stabCandidates.length ? stabCandidates[0].msg(stabCandidates[0].gap) : null;

  let appTip = null;
  if (appUsage !== "alta") {
    const appGap = 70 - appPts;
    appTip = `Registrar más actividad en apps (nivel ${appUsage === "baja" ? "medio o alto" : "alto"}) suma hasta +${appGap} puntos.`;
  }

  const obTip = openBanking ? null : "Conecta Open Banking (Ley Fintech 21.521) para verificar tus cuentas: suma 60 puntos.";
  const phoneTip = phoneAuthorized ? null : "Autoriza las métricas agregadas de tu celular: suma 40 puntos.";

  // Factors that drove the score, with their ceiling (max) and a tip. Biggest
  // contribution first.
  const factors = [
    {
      key: "utility",
      label: `Pagos de servicios al día: ${utilityMonths} ${utilityMonths === 1 ? "mes" : "meses"} consecutivos`,
      points: Math.round(utilityPts),
      max: 220,
      positive: utilityMonths >= 12,
      tip: utilityTip,
    },
    {
      key: "income",
      label: `Estabilidad de ingresos (${workLabel(workType)}, ${tenureMonths} meses de antigüedad)`,
      points: Math.round(incomePts + tenurePts + workPts),
      max: 160,
      positive: incomePts + tenurePts + workPts >= 70,
      tip: stabilityTip,
    },
    {
      key: "apps",
      label: `Comportamiento en apps: actividad ${appUsage}`,
      points: Math.round(appPts),
      max: 70,
      positive: appUsage !== "baja",
      tip: appTip,
    },
    {
      key: "ob",
      label: openBanking ? "Open Banking conectado (datos verificados)" : "Open Banking no conectado",
      points: Math.round(obPts),
      max: 60,
      positive: openBanking,
      tip: obTip,
    },
    {
      key: "phone",
      label: phoneAuthorized ? "Uso de celular autorizado (métricas agregadas)" : "Uso de celular no autorizado",
      points: Math.round(phonePts),
      max: 40,
      positive: phoneAuthorized,
      tip: phoneTip,
    },
  ];

  return { score, band: band.key, bandLabel: band.label, color: band.color, factors };
}

export function bandFor(score) {
  if (score >= 720) return { key: "bajo", label: "Riesgo bajo", color: "#059669" };
  if (score >= 600) return { key: "medio", label: "Riesgo medio", color: "#D97706" };
  return { key: "alto", label: "Riesgo alto", color: "#DC2626" };
}

/** Approval rule for the demo: medio o bajo se aprueba. */
export function isApproved(score) {
  return score >= 600;
}

const STD_TERMS = [6, 9, 12, 18, 24, 36];

/**
 * Recommended "starter" credit for the applicant: deterministically a SMALLER
 * amount and a SHORTER term than what they requested, sized by score band. The
 * idea we surface to the client is that taking a conservative first credit and
 * paying it on time raises their score, unlocking a larger amount next time.
 *
 * Returns { offerAmount, offerTermMonths, nextAmount, reduced } where
 * `reduced` is true when the offer is actually smaller/shorter than requested.
 */
export function recommendOffer(score, requestedAmount, requestedTermMonths) {
  const amount = Math.max(0, Number(requestedAmount) || 0);
  const term = Math.max(1, Number(requestedTermMonths) || 12);

  // Lower band => more conservative starter offer.
  let amountFactor, termFactor;
  if (score >= 720) { amountFactor = 0.8; termFactor = 0.75; }
  else if (score >= 600) { amountFactor = 0.6; termFactor = 0.6; }
  else { amountFactor = 0.4; termFactor = 0.5; }

  // Amount: round DOWN to nearest 50.000 CLP, floor 100.000, never above asked.
  let offerAmount = Math.floor((amount * amountFactor) / 50000) * 50000;
  offerAmount = Math.max(100000, offerAmount);
  if (amount > 0 && offerAmount > amount) offerAmount = amount;

  // Term: nearest standard term not exceeding our shortened cap, min 6 meses.
  const cap = Math.max(6, Math.round(term * termFactor));
  let offerTermMonths = STD_TERMS.filter((t) => t <= cap).pop() || 6;
  if (offerTermMonths > term) offerTermMonths = term;

  // Motivating "next level" amount (≈1.6×), rounded to 50.000.
  const nextAmount = Math.round((offerAmount * 1.6) / 50000) * 50000;

  const reduced = offerAmount < amount || offerTermMonths < term;
  return { offerAmount, offerTermMonths, nextAmount, reduced };
}

function workLabel(w) {
  return (
    {
      dependiente: "trabajo dependiente",
      independiente: "trabajo independiente",
      informal: "trabajo informal",
      sin_actividad: "sin actividad",
    }[w] || "actividad"
  );
}

const DRIVER_PHRASES = {
  utility: "tu historial de pagos de servicios al día",
  income: "la estabilidad de tus ingresos y tu trabajo",
  apps: "tu actividad constante en apps",
  ob: "tus cuentas verificadas por Open Banking",
  phone: "el uso responsable de tu celular",
};

/**
 * Brand-voice, plain-language explanation. Band-aware: tells the user what
 * their score *means* for credit access and highlights the single factor that
 * helped them most. Works with any result that carries `factors` (computeScore
 * output); degrades gracefully if factors are absent.
 */
export function explain(input, result, firstName) {
  const name = firstName || (input.name ? String(input.name).split(" ")[0] : "Hola");
  const score = result.score;
  const band = result.band || bandFor(score).key;
  const factors = result.factors || [];

  let bandSentence;
  if (band === "bajo") {
    bandSentence = `tu puntaje de ${score} te ubica en riesgo bajo: calificas para nuestras mejores condiciones de crédito`;
  } else if (band === "medio") {
    bandSentence = `tu puntaje de ${score} te ubica en riesgo medio: ya calificas para un crédito, y llegar a 720 o más te abriría condiciones aún mejores`;
  } else {
    bandSentence = `tu puntaje de ${score} está en riesgo alto: hoy necesitamos más antecedentes para aprobarte, pero puedes mejorarlo con los pasos de abajo`;
  }

  const driver = factors.filter((f) => f.points > 0).sort((a, b) => b.points - a.points)[0];
  const driverSentence = driver
    ? ` Lo que más sumó a tu favor fue ${DRIVER_PHRASES[driver.key] || "los datos que compartiste"}.`
    : "";

  return `${name}, ${bandSentence}.${driverSentence} Esto es lo que el banco tradicional nunca miró.`;
}
