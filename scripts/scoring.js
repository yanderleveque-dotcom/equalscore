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

  const raw = 300 + utilityPts + incomePts + tenurePts + workPts + appPts + obPts + phonePts;
  const score = Math.round(clamp(raw, 300, 850));

  const band = bandFor(score);

  // Factors that drove the score, biggest contribution first.
  const factors = [
    {
      label: `Pagos de servicios al día: ${utilityMonths} ${utilityMonths === 1 ? "mes" : "meses"} consecutivos`,
      points: Math.round(utilityPts),
      positive: utilityMonths >= 12,
    },
    {
      label: `Estabilidad de ingresos (${workLabel(workType)}, ${tenureMonths} meses de antigüedad)`,
      points: Math.round(incomePts + tenurePts + workPts),
      positive: incomePts + tenurePts + workPts >= 70,
    },
    {
      label: `Comportamiento en apps: actividad ${appUsage}`,
      points: Math.round(appPts),
      positive: appUsage !== "baja",
    },
    {
      label: openBanking ? "Open Banking conectado (datos verificados)" : "Open Banking no conectado",
      points: Math.round(obPts),
      positive: openBanking,
    },
    {
      label: phoneAuthorized ? "Uso de celular autorizado (métricas agregadas)" : "Uso de celular no autorizado",
      points: Math.round(phonePts),
      positive: phoneAuthorized,
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

/** Brand-voice, plain-language explanation. */
export function explain(input, result, firstName) {
  const name = firstName || (input.name ? String(input.name).split(" ")[0] : "Hola");
  const m = clamp(Number(input.utilityMonths) || 0, 0, 36);
  const lead =
    m >= 12
      ? `${name}, pagaste tus servicios ${m} meses seguidos`
      : `${name}, registras ${m} ${m === 1 ? "mes" : "meses"} de pagos de servicios`;

  const incomeBit =
    Number(input.income) >= 400000 ? " y mantienes ingresos estables" : " y estamos evaluando tus ingresos";

  return (
    `${lead}${incomeBit}. Score: ${result.score}. ${result.bandLabel}. ` +
    `Esto es lo que el banco nunca miró.`
  );
}
