// rut.js — Chilean RUT formatting, validation, and verifier-digit computation.

/** Remove dots and dash, uppercase the verifier. "12.345.678-5" -> "123456785". */
export function cleanRut(rut) {
  return String(rut ?? "").replace(/[.\-\s]/g, "").toUpperCase();
}

/** Compute the verifier digit (módulo 11) for a numeric RUT body string. */
export function computeDv(bodyDigits) {
  let sum = 0;
  let mul = 2;
  for (let i = bodyDigits.length - 1; i >= 0; i--) {
    sum += parseInt(bodyDigits[i], 10) * mul;
    mul = mul === 7 ? 2 : mul + 1;
  }
  const res = 11 - (sum % 11);
  if (res === 11) return "0";
  if (res === 10) return "K";
  return String(res);
}

/** True if the RUT (any format) is structurally valid and the DV checks out. */
export function isValidRut(rut) {
  const clean = cleanRut(rut);
  if (clean.length < 2) return false;
  const body = clean.slice(0, -1);
  const dv = clean.slice(-1);
  if (!/^\d+$/.test(body)) return false;
  if (!/^[0-9K]$/.test(dv)) return false;
  // Reasonable Chilean RUT body length (7–8 digits for people).
  if (body.length < 7 || body.length > 8) return false;
  return computeDv(body) === dv;
}

/** Pretty-format a RUT with dots and dash: "123456785" -> "12.345.678-5". */
export function formatRut(rut) {
  const clean = cleanRut(rut);
  if (clean.length < 2) return clean;
  const body = clean.slice(0, -1);
  const dv = clean.slice(-1);
  const withDots = body.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${withDots}-${dv}`;
}

/** Build a valid RUT string from a numeric body (for seeding mock data). */
export function rutFromBody(body) {
  const b = String(body);
  return formatRut(b + computeDv(b));
}
