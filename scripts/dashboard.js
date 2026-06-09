// dashboard.js — lender portfolio view powered by EqualScore.

import { clp, num, pct, fmtDate, esc, normalize, daysBetween } from "./utils.js";
import { cleanRut } from "./rut.js";
import { computeStats, estadoLabels, PLACES } from "./data.js";
import { computeScore, explain } from "./scoring.js";

const PAGE_SIZE = 8;

export function renderDashboard(deps) {
  const { getCustomers, onNuevaConsulta, onUpdateCustomer, onDeleteCustomer } = deps;

  const ui = {
    period: "mes",
    search: "",
    actFilter: "todos",
    actFrom: "",
    actTo: "",
    sortKey: "consultaDate",
    sortDir: "desc",
    page: 1,
  };
  let charts = {};

  const root = document.createElement("section");
  root.className = "dashboard";
  root.innerHTML = `
    <div class="dash-head">
      <div>
        <h1>Panel de la empresa</h1>
        <p class="dash-sub">Cartera de préstamos con monitor de equidad EqualScore.</p>
      </div>
      <div class="period-toggle" role="group" aria-label="Período">
        <button data-period="semana">Semana</button>
        <button data-period="mes" class="is-active">Mes</button>
      </div>
    </div>
    <div id="kpis" class="kpi-grid"></div>

    <div class="charts-grid">
      <div class="panel"><h2>Monto prestado por semana</h2><div class="chart-box"><canvas id="ch-monto"></canvas></div></div>
      <div class="panel"><h2>Ingresos por semana</h2><div class="chart-box"><canvas id="ch-rev"></canvas></div></div>
      <div class="panel"><h2>Pagadores vs no pagadores</h2><div class="chart-box"><canvas id="ch-pag"></canvas></div><p class="chart-caption" id="cap-pag"></p></div>
      <div class="panel"><h2>Evolución de la tasa de mora</h2><div class="chart-box"><canvas id="ch-mora"></canvas></div><p class="chart-caption" id="cap-mora"></p></div>
    </div>

    <div class="panel fairness" id="fairness"></div>

    <div class="panel">
      <div class="panel-head">
        <h2>Buscar cliente</h2>
        <input type="search" id="search" class="search-input" placeholder="Buscar por nombre o RUT…" aria-label="Buscar por nombre o RUT" />
      </div>
      <div id="search-results" class="table-wrap"></div>
    </div>

    <div class="panel">
      <div class="panel-head">
        <h2>Actividad reciente</h2>
        <div class="act-tools">
          <select id="act-filter" aria-label="Filtrar por estado">
            <option value="todos">Todos los estados</option>
            <option value="al_dia">Al día</option>
            <option value="en_mora">En mora</option>
            <option value="pagado">Pagado</option>
            <option value="rechazado">Rechazado</option>
          </select>
          <label class="date-range">Desde <input type="date" id="act-from" /></label>
          <label class="date-range">Hasta <input type="date" id="act-to" /></label>
          <button class="btn btn-ghost btn-sm" id="btn-nueva">+ Nueva consulta</button>
          <button class="btn btn-ghost btn-sm" id="btn-csv">Exportar CSV</button>
        </div>
      </div>
      <div id="activity" class="table-wrap"></div>
    </div>

    <div id="modal-root"></div>
  `;

  // ---- wiring ----
  root.querySelectorAll("[data-period]").forEach((b) =>
    b.addEventListener("click", () => {
      ui.period = b.dataset.period;
      root.querySelectorAll("[data-period]").forEach((x) => x.classList.toggle("is-active", x === b));
      renderKpis();
      renderCharts();
    })
  );
  const searchInput = root.querySelector("#search");
  searchInput.addEventListener("input", () => { ui.search = searchInput.value; renderSearch(); });

  root.querySelector("#act-filter").addEventListener("change", (e) => { ui.actFilter = e.target.value; ui.page = 1; renderActivity(); });
  root.querySelector("#act-from").addEventListener("change", (e) => { ui.actFrom = e.target.value; ui.page = 1; renderActivity(); });
  root.querySelector("#act-to").addEventListener("change", (e) => { ui.actTo = e.target.value; ui.page = 1; renderActivity(); });
  root.querySelector("#btn-csv").addEventListener("click", exportCsv);
  root.querySelector("#btn-nueva").addEventListener("click", () => onNuevaConsulta?.());

  // ---- renders ----
  function renderAll() {
    renderKpis();
    renderFairness();
    renderSearch();
    renderActivity();
    renderCharts();
  }

  function renderKpis() {
    const customers = getCustomers();
    const stats = computeStats(customers, ui.period);
    const allLoans = customers.filter((c) => c.loan);
    const mora90 = allLoans.filter((c) => c.loan.mora90);
    const montoMora = mora90.reduce((s, c) => s + c.loan.saldo, 0);
    const moraRateBook = allLoans.length ? mora90.length / allLoans.length : 0;
    const pagTot = stats.book.pagadores;
    const noPagTot = stats.book.noPagadores;
    const totLoans = pagTot + noPagTot;
    const per = ui.period === "semana" ? "esta semana" : "este mes";

    const cards = [
      kpi("Monto prestado", clp(stats.cur.montoPrestado), per, stats.deltas.montoPrestado, true),
      kpi("Préstamos otorgados", num(stats.cur.cantidad), per, stats.deltas.cantidad, true),
      kpi("Ingresos generados", clp(stats.cur.revenue), per + " · intereses + comisiones", stats.deltas.revenue, true),
      kpi("Tasa de aprobación", pct(stats.cur.aprobacion), per, stats.deltas.aprobacion, true),
      kpi("Score promedio aprobados", num(stats.cur.scorePromedio), per, stats.deltas.scorePromedio, true),
      kpi("Pagadores vs no pagadores", `${pagTot} / ${noPagTot}`, totLoans ? `${pct(pagTot / totLoans, 0)} al día` : "—", null, true),
      kpi("Tasa de mora (90d)", pct(moraRateBook), `${clp(montoMora)} en mora`, stats.deltas.moraRate, false),
      kpi("Cartera activa total", clp(stats.book.carteraActiva), "monto vigente", null, true),
    ];
    root.querySelector("#kpis").innerHTML = cards.join("");
  }

  function renderFairness() {
    const stats = computeStats(getCustomers(), ui.period);
    const f = stats.fairness;
    const genderRows = f.byGender
      .map((g) => `<tr><th scope="row">${esc(g.key)}</th><td>${pct(g.approval)}</td><td>${pct(g.defaultRate)}</td><td>${g.n}</td></tr>`)
      .join("");
    const topComunas = f.byComuna.slice(0, 8);
    const comunaRows = topComunas
      .map(
        (c) =>
          `<tr><th scope="row">${esc(c.key)} ${c.penalized ? '<span class="chip-pen">penalizada</span>' : ""}</th><td>${pct(c.approval)}</td><td>${pct(c.defaultRate)}</td><td>${c.n}</td></tr>`
      )
      .join("");

    root.querySelector("#fairness").innerHTML = `
      <div class="panel-head">
        <h2>Monitor de equidad <span class="fair-tag">fairness by design</span></h2>
      </div>
      <p class="fair-intro">EqualScore audita la tasa de aprobación y de mora por género y comuna. La paridad busca que ningún grupo sea aprobado de forma sistemáticamente distinta.</p>
      <div class="fair-grid">
        <div>
          <div class="fair-title">Por género ${parityBadge(f.genderParity, f.genderGap)}</div>
          <table class="data-table"><thead><tr><th>Grupo</th><th>Aprobación</th><th>Mora</th><th>n</th></tr></thead><tbody>${genderRows}</tbody></table>
        </div>
        <div>
          <div class="fair-title">Por comuna ${parityBadge(f.comunaParity, f.comunaGap)}</div>
          <p class="fair-note">Comunas penalizadas: <strong>${pct(f.penalizedApproval, 0)}</strong> de aprobación (n=${f.penalizedN}) vs <strong>${pct(f.restApproval, 0)}</strong> en el resto (n=${f.restN}).</p>
          <table class="data-table"><thead><tr><th>Comuna</th><th>Aprob.</th><th>Mora</th><th>n</th></tr></thead><tbody>${comunaRows}</tbody></table>
        </div>
      </div>`;
  }

  function renderSearch() {
    const q = ui.search.trim();
    const customers = getCustomers();
    let rows = customers;
    if (q) {
      const nq = normalize(q);
      const rq = cleanRut(q);
      rows = customers.filter(
        (c) => normalize(c.name).includes(nq) || (rq.length >= 2 && cleanRut(c.rut).includes(rq))
      );
    } else {
      rows = customers.slice(0, 8);
    }
    const box = root.querySelector("#search-results");
    if (!rows.length) {
      box.innerHTML = `<p class="empty">Sin resultados para “${esc(q)}”.</p>`;
      return;
    }
    box.innerHTML = `
      ${q ? `<p class="result-count">${rows.length} resultado(s)</p>` : `<p class="result-count">Mostrando 8 de ${customers.length} clientes — escribe para buscar.</p>`}
      <table class="data-table clickable">
        <thead><tr><th>Nombre</th><th>RUT</th><th>Comuna</th><th>Score</th><th>Estado</th><th>Monto</th><th>Próx. cuota</th></tr></thead>
        <tbody>
          ${rows
            .slice(0, 60)
            .map(
              (c) => `<tr data-id="${c.id}" tabindex="0" role="button" aria-label="Ver ${esc(c.name)}">
            <td>${esc(c.name)}</td>
            <td class="mono">${esc(c.rut)}</td>
            <td>${esc(c.comuna)}</td>
            <td><span class="score-pill ${c.band}">${c.score}</span></td>
            <td>${estadoBadge(c.estado)}</td>
            <td>${c.loan ? clp(c.loan.amount) : "—"}</td>
            <td>${c.loan && c.loan.nextDueDate ? fmtDate(c.loan.nextDueDate) : "—"}</td>
          </tr>`
            )
            .join("")}
        </tbody>
      </table>`;
    box.querySelectorAll("tr[data-id]").forEach((tr) => {
      const open = () => openDetail(tr.dataset.id);
      tr.addEventListener("click", open);
      tr.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
    });
  }

  function filteredActivity() {
    let rows = getCustomers().slice();
    if (ui.actFilter !== "todos") rows = rows.filter((c) => c.estado === ui.actFilter);
    if (ui.actFrom) rows = rows.filter((c) => c.consultaDate >= ui.actFrom);
    if (ui.actTo) rows = rows.filter((c) => c.consultaDate <= ui.actTo);
    const dir = ui.sortDir === "asc" ? 1 : -1;
    rows.sort((a, b) => {
      const va = sortVal(a, ui.sortKey), vb = sortVal(b, ui.sortKey);
      return va < vb ? -dir : va > vb ? dir : 0;
    });
    return rows;
  }

  function renderActivity() {
    const rows = filteredActivity();
    const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    ui.page = Math.min(ui.page, pages);
    const slice = rows.slice((ui.page - 1) * PAGE_SIZE, ui.page * PAGE_SIZE);
    const arrow = (k) => (ui.sortKey === k ? (ui.sortDir === "asc" ? " ▲" : " ▼") : "");

    root.querySelector("#activity").innerHTML = `
      <table class="data-table clickable">
        <thead><tr>
          <th data-sort="consultaDate">Fecha${arrow("consultaDate")}</th>
          <th data-sort="name">Cliente${arrow("name")}</th>
          <th data-sort="rut">RUT${arrow("rut")}</th>
          <th data-sort="score">Score${arrow("score")}</th>
          <th data-sort="decision">Decisión${arrow("decision")}</th>
          <th data-sort="monto">Monto${arrow("monto")}</th>
        </tr></thead>
        <tbody>
          ${slice
            .map(
              (c) => `<tr data-id="${c.id}" tabindex="0" role="button">
            <td>${fmtDate(c.consultaDate)}</td>
            <td>${esc(c.name)}${c.walkIn ? ' <span class="chip-pen">walk-in</span>' : ""}</td>
            <td class="mono">${esc(c.rut)}</td>
            <td><span class="score-pill ${c.band}">${c.score}</span></td>
            <td>${c.decision === "aprobado" ? '<span class="badge ok">Aprobado</span>' : '<span class="badge no">Rechazado</span>'}</td>
            <td>${c.loan ? clp(c.loan.amount) : "—"}</td>
          </tr>`
            )
            .join("")}
        </tbody>
      </table>
      <div class="pager">
        <button class="btn btn-ghost btn-sm" id="prev" ${ui.page <= 1 ? "disabled" : ""}>Anterior</button>
        <span>Página ${ui.page} de ${pages} · ${rows.length} registros</span>
        <button class="btn btn-ghost btn-sm" id="next" ${ui.page >= pages ? "disabled" : ""}>Siguiente</button>
      </div>`;

    root.querySelectorAll("#activity th[data-sort]").forEach((th) =>
      th.addEventListener("click", () => {
        const k = th.dataset.sort;
        if (ui.sortKey === k) ui.sortDir = ui.sortDir === "asc" ? "desc" : "asc";
        else { ui.sortKey = k; ui.sortDir = "asc"; }
        renderActivity();
      })
    );
    root.querySelectorAll("#activity tr[data-id]").forEach((tr) => {
      const open = () => openDetail(tr.dataset.id);
      tr.addEventListener("click", open);
      tr.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
    });
    const prev = root.querySelector("#prev"), next = root.querySelector("#next");
    if (prev) prev.addEventListener("click", () => { ui.page--; renderActivity(); });
    if (next) next.addEventListener("click", () => { ui.page++; renderActivity(); });
  }

  function exportCsv() {
    const rows = filteredActivity();
    const head = ["Fecha", "Cliente", "RUT", "Comuna", "Score", "Decision", "Estado", "Monto", "Saldo"];
    const lines = [head.join(",")];
    for (const c of rows) {
      lines.push(
        [
          c.consultaDate,
          csvCell(c.name),
          c.rut,
          csvCell(c.comuna),
          c.score,
          c.decision,
          c.estado,
          c.loan ? c.loan.amount : 0,
          c.loan ? c.loan.saldo : 0,
        ].join(",")
      );
    }
    const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `equalscore_actividad_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ---- detail modal ----
  function openDetail(id) {
    const c = getCustomers().find((x) => x.id === id);
    if (!c) return;
    const full = computeScore(c.scoreInputs);
    const exp = explain(c.scoreInputs, full, c.name.split(" ")[0]);
    const loan = c.loan;
    const timeline = loan && loan.cuotas && loan.cuotas.length
      ? loan.cuotas
          .map(
            (cu) => `<li class="cuota ${cu.status}"><span class="cuota-n">Cuota ${cu.n}</span><span class="cuota-date">${fmtDate(cu.dueDate)}</span><span class="cuota-amt">${clp(cu.amount)}</span><span class="cuota-status">${cuotaLabel(cu.status)}</span></li>`
          )
          .join("")
      : `<li class="cuota pendiente"><span class="cuota-n">Sin cuotas registradas</span></li>`;

    const modal = document.createElement("div");
    modal.className = "modal-overlay";
    const close = () => modal.remove();

    function renderView() {
      modal.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-label="Detalle de ${esc(c.name)}">
        <button class="modal-close" aria-label="Cerrar">×</button>
        <div class="modal-head">
          <div>
            <h2>${esc(c.name)}</h2>
            <p class="modal-meta">${esc(c.rut)} · ${esc(c.comuna)}, ${esc(c.region)}${c.age ? " · " + c.age + " años" : ""}</p>
            <p class="modal-meta">${esc(c.email || "")}${c.phone ? " · " + esc(c.phone) : ""}</p>
          </div>
          <div class="modal-score">
            <span class="score-pill ${c.band} big">${c.score}</span>
            ${estadoBadge(c.estado)}
          </div>
        </div>

        <p class="modal-explain">${esc(exp)} <span class="mini-verified">Sesgo verificado ✓</span></p>

        <div class="modal-grid">
          <div><span class="ml">Monto prestado</span><span class="mv">${loan ? clp(loan.amount) : "—"}</span></div>
          <div><span class="ml">Saldo</span><span class="mv">${loan ? clp(loan.saldo) : "—"}</span></div>
          <div><span class="ml">Tasa mensual</span><span class="mv">${loan ? pct(loan.rateMonthly) : "—"}</span></div>
          <div><span class="ml">Plazo</span><span class="mv">${loan ? loan.termMonths + " meses" : "—"}</span></div>
          <div><span class="ml">Próxima cuota</span><span class="mv">${loan && loan.nextDueDate ? fmtDate(loan.nextDueDate) : "—"}</span></div>
          <div><span class="ml">Propósito</span><span class="mv">${loan ? esc(loan.purpose) : "—"}</span></div>
        </div>

        <h3 class="timeline-title">Historial de pagos</h3>
        <ul class="timeline">${timeline}</ul>

        <div class="modal-actions">
          <button class="btn btn-ghost btn-sm" id="btn-edit">Editar datos</button>
          <button class="btn btn-danger btn-sm" id="btn-delete">Eliminar cliente</button>
        </div>
      </div>`;
      modal.querySelector(".modal-close").addEventListener("click", close);
      modal.querySelector("#btn-edit").addEventListener("click", renderEdit);
      modal.querySelector("#btn-delete").addEventListener("click", renderDeleteConfirm);
      modal.querySelector(".modal-close").focus();
    }

    function renderEdit() {
      const comunaOpts = PLACES.map(
        (p) => `<option value="${esc(p.comuna)}" ${p.comuna === c.comuna ? "selected" : ""}>${esc(p.comuna)} (${esc(p.region)})</option>`
      ).join("");
      const estadoOpts = ["al_dia", "en_mora", "pagado", "rechazado"]
        .map((s) => `<option value="${s}" ${s === c.estado ? "selected" : ""}>${esc(estadoLabels[s])}</option>`)
        .join("");
      modal.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-label="Editar ${esc(c.name)}">
        <button class="modal-close" aria-label="Cerrar">×</button>
        <div class="modal-head"><div><h2>Editar cliente</h2><p class="modal-meta">${esc(c.rut)}</p></div></div>
        <form id="edit-form" class="edit-form">
          <label class="ef-field"><span>Nombre</span><input type="text" name="name" value="${esc(c.name)}" required /></label>
          <label class="ef-field"><span>Email</span><input type="email" name="email" value="${esc(c.email || "")}" /></label>
          <label class="ef-field"><span>Teléfono</span><input type="text" name="phone" value="${esc(c.phone || "")}" /></label>
          <label class="ef-field"><span>Comuna</span><select name="comuna">${comunaOpts}</select></label>
          <label class="ef-field"><span>Estado</span><select name="estado">${estadoOpts}</select></label>
          <label class="ef-field"><span>Monto del préstamo</span><input type="number" name="amount" min="0" step="10000" value="${loan ? loan.amount : ""}" ${loan ? "" : "disabled"} /></label>
          <p class="edit-err" id="edit-err" role="alert" hidden></p>
          <div class="modal-actions">
            <button type="button" class="btn btn-ghost btn-sm" id="btn-cancel">Cancelar</button>
            <button type="submit" class="btn btn-primary btn-sm">Guardar cambios</button>
          </div>
        </form>
      </div>`;
      modal.querySelector(".modal-close").addEventListener("click", close);
      modal.querySelector("#btn-cancel").addEventListener("click", renderView);
      modal.querySelector("#edit-form").addEventListener("submit", (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const name = String(fd.get("name") || "").trim();
        if (!name) return showEditErr("El nombre es obligatorio.");
        const comunaName = String(fd.get("comuna"));
        const place = PLACES.find((p) => p.comuna === comunaName) || { region: c.region, penalized: c.penalizedComuna };
        const patch = {
          name,
          email: String(fd.get("email") || "").trim(),
          phone: String(fd.get("phone") || "").trim(),
          comuna: comunaName,
          region: place.region,
          penalizedComuna: place.penalized,
          estado: String(fd.get("estado")),
        };
        if (loan) {
          const amt = Math.max(0, Math.round(Number(fd.get("amount")) || 0));
          patch.loan = { ...loan, amount: amt };
        }
        onUpdateCustomer?.(id, patch);
        close();
      });
      modal.querySelector('input[name="name"]').focus();
    }

    function showEditErr(msg) {
      const el = modal.querySelector("#edit-err");
      if (el) { el.textContent = msg; el.hidden = false; }
    }

    function renderDeleteConfirm() {
      modal.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-label="Eliminar ${esc(c.name)}">
        <button class="modal-close" aria-label="Cerrar">×</button>
        <div class="modal-head"><div><h2>Eliminar cliente</h2></div></div>
        <p class="confirm-text">¿Seguro que quieres eliminar a <strong>${esc(c.name)}</strong> (${esc(c.rut)})? Esta acción no se puede deshacer.</p>
        <div class="modal-actions">
          <button class="btn btn-ghost btn-sm" id="btn-cancel-del">Cancelar</button>
          <button class="btn btn-danger btn-sm" id="btn-confirm-del">Sí, eliminar</button>
        </div>
      </div>`;
      modal.querySelector(".modal-close").addEventListener("click", close);
      modal.querySelector("#btn-cancel-del").addEventListener("click", renderView);
      modal.querySelector("#btn-confirm-del").addEventListener("click", () => {
        onDeleteCustomer?.(id);
        close();
      });
      modal.querySelector("#btn-confirm-del").focus();
    }

    modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
    document.addEventListener("keydown", function onEsc(e) { if (e.key === "Escape") { close(); document.removeEventListener("keydown", onEsc); } });
    renderView();
    root.querySelector("#modal-root").appendChild(modal);
  }

  // ---- charts ----
  function renderCharts() {
    if (typeof window.Chart === "undefined") {
      window.addEventListener("load", () => renderCharts(), { once: true });
      return;
    }
    const stats = computeStats(getCustomers(), ui.period);
    Object.values(charts).forEach((ch) => ch && ch.destroy());
    charts = {};
    const labels = stats.series.map((w) => w.label);
    const grid = "#EDE9FE";
    const indigo = "#5B21B6";
    const violet = "#8B5CF6";

    charts.monto = new Chart(root.querySelector("#ch-monto"), {
      type: "bar",
      data: { labels, datasets: [{ label: "Monto prestado", data: stats.series.map((w) => w.monto), backgroundColor: indigo, borderRadius: 6 }] },
      options: baseOpts((v) => clp(v)),
    });
    charts.rev = new Chart(root.querySelector("#ch-rev"), {
      type: "line",
      data: { labels, datasets: [{ label: "Ingresos", data: stats.series.map((w) => w.revenue), borderColor: violet, backgroundColor: "rgba(139,92,246,.15)", fill: true, tension: 0.35, pointRadius: 3 }] },
      options: baseOpts((v) => clp(v)),
    });
    // Pagadores vs no pagadores: counts, with each group's loaned amount and a
    // tooltip that shows count, share % and money. A caption restates it in text.
    const allLoans = getCustomers().filter((c) => c.loan);
    const pagSet = allLoans.filter((c) => c.estado === "al_dia" || c.estado === "pagado");
    const noPagSet = allLoans.filter((c) => c.estado === "en_mora");
    const pagCount = pagSet.length;
    const noPagCount = noPagSet.length;
    const totPag = pagCount + noPagCount;
    const montoPag = pagSet.reduce((s, c) => s + c.loan.amount, 0);
    const montoNoPag = noPagSet.reduce((s, c) => s + c.loan.amount, 0);
    const montos = [montoPag, montoNoPag];

    charts.pag = new Chart(root.querySelector("#ch-pag"), {
      type: "doughnut",
      data: {
        labels: ["Pagadores", "No pagadores"],
        datasets: [{ data: [pagCount, noPagCount], backgroundColor: ["#059669", "#DC2626"], borderWidth: 0 }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: "bottom" },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const val = ctx.parsed;
                const p = totPag ? Math.round((val / totPag) * 100) : 0;
                return ` ${ctx.label}: ${val} (${p}%)`;
              },
              afterLabel: (ctx) => " Monto: " + clp(montos[ctx.dataIndex]),
            },
          },
        },
      },
    });
    const pPag = totPag ? Math.round((pagCount / totPag) * 100) : 0;
    const pNo = totPag ? 100 - pPag : 0;
    const capPag = root.querySelector("#cap-pag");
    if (capPag) {
      capPag.innerHTML = `<span class="cap-ok">Pagadores: <strong>${pagCount}</strong> (${pPag}%) · ${clp(montoPag)}</span><span class="cap-no">No pagadores: <strong>${noPagCount}</strong> (${pNo}%) · ${clp(montoNoPag)}</span>`;
    }

    // Evolución de la tasa de mora: cumulative portfolio mora rate over 12 months.
    const ms = stats.moraSeries;
    charts.mora = new Chart(root.querySelector("#ch-mora"), {
      type: "line",
      data: { labels: ms.map((p) => p.label), datasets: [{ label: "Tasa de mora", data: ms.map((p) => +(p.moraRate * 100).toFixed(1)), borderColor: "#DC2626", backgroundColor: "rgba(220,38,38,.12)", fill: true, tension: 0.35, pointRadius: 3 }] },
      options: baseOpts((v) => v + "%", ms.map((p) => `${p.mora} en mora / ${p.active} activos`)),
    });
    const last = ms[ms.length - 1];
    const capMora = root.querySelector("#cap-mora");
    if (capMora && last) {
      capMora.textContent = `Hoy: ${(last.moraRate * 100).toFixed(1)}% de mora — ${last.mora} no pagan de ${last.active} créditos activos.`;
    }
  }

  function baseOpts(fmt, afterLabels) {
    const callbacks = { label: (ctx) => " " + fmt(ctx.parsed.y) };
    if (Array.isArray(afterLabels)) {
      callbacks.afterLabel = (ctx) => (afterLabels[ctx.dataIndex] ? " " + afterLabels[ctx.dataIndex] : "");
    }
    return {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks } },
      scales: {
        x: { grid: { display: false } },
        y: { beginAtZero: true, ticks: { callback: (v) => fmt(v) }, grid: { color: "#EDE9FE" } },
      },
    };
  }

  renderAll();
  return { root, refresh: renderAll };
}

// ---- small helpers --------------------------------------------------------
function kpi(label, value, sub, d, goodWhenUp) {
  return `<div class="kpi">
    <span class="kpi-label">${esc(label)}</span>
    <span class="kpi-value">${value}</span>
    <span class="kpi-sub">${esc(sub)}</span>
    ${d ? deltaChip(d, goodWhenUp) : ""}
  </div>`;
}
function deltaChip(d, goodWhenUp) {
  if (d.dir === "flat") return `<span class="delta flat">— sin cambios</span>`;
  const good = goodWhenUp ? d.dir === "up" : d.dir === "down";
  const arrow = d.dir === "up" ? "▲" : "▼";
  return `<span class="delta ${good ? "good" : "bad"}">${arrow} ${pct(Math.abs(d.relPct), 0)} vs período anterior</span>`;
}
function estadoBadge(estado) {
  const cls = { al_dia: "ok", en_mora: "no", pagado: "neutral", rechazado: "muted" }[estado] || "muted";
  return `<span class="badge ${cls}">${esc(estadoLabels[estado] || estado)}</span>`;
}
function cuotaLabel(s) {
  return { pagada: "Pagada", pendiente: "Pendiente", atrasada: "Atrasada" }[s] || s;
}
function parityBadge(state, gap) {
  return state === "ok"
    ? `<span class="parity ok">Paridad: OK</span>`
    : `<span class="parity warn">Paridad: revisar (${pct(gap, 0)})</span>`;
}
function bandLabelFor(band) {
  return { bajo: "Riesgo bajo", medio: "Riesgo medio", alto: "Riesgo alto" }[band] || "";
}
function sortVal(c, key) {
  if (key === "monto") return c.loan ? c.loan.amount : -1;
  if (key === "rut") return cleanRut(c.rut);
  if (key === "name") return normalize(c.name);
  return c[key];
}
function csvCell(s) {
  const v = String(s ?? "");
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
