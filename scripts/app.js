// app.js — role-based router and application shell.

import { loadDataset, saveDataset, resetDataset, addCustomer, updateCustomer, deleteCustomer, approveCustomer, rejectCustomer } from "./data.js";
import { renderCustomer } from "./customer.js";
import { renderDashboard } from "./dashboard.js";

let customers = loadDataset();
const getCustomers = () => customers;
function setCustomers(next) {
  customers = next;
  saveDataset(customers);
}

let dashboardApi = null;

const app = document.getElementById("app");

const ROUTES = {
  "#/cliente": "customer",
  "#/empresa": "dashboard",
};
function currentView() {
  return ROUTES[location.hash] || "select";
}

function navigate(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

window.addEventListener("hashchange", render);

function render() {
  const view = currentView();
  app.innerHTML = "";
  app.appendChild(header(view));

  const main = document.createElement("main");
  main.id = "view";
  main.className = "view view-" + view;
  app.appendChild(main);

  if (view === "customer") {
    dashboardApi = null;
    main.appendChild(
      renderCustomer((rec) => {
        setCustomers(addCustomer(customers, rec));
      })
    );
  } else if (view === "dashboard") {
    const api = renderDashboard({
      getCustomers,
      onNuevaConsulta: openNuevaConsulta,
      onUpdateCustomer: (cid, patch) => {
        setCustomers(updateCustomer(customers, cid, patch));
        dashboardApi && dashboardApi.refresh();
      },
      onDeleteCustomer: (cid) => {
        setCustomers(deleteCustomer(customers, cid));
        dashboardApi && dashboardApi.refresh();
      },
      onApprove: (cid) => {
        setCustomers(approveCustomer(customers, cid));
        dashboardApi && dashboardApi.refresh();
      },
      onReject: (cid) => {
        setCustomers(rejectCustomer(customers, cid));
        dashboardApi && dashboardApi.refresh();
      },
    });
    dashboardApi = api;
    main.appendChild(api.root);
  } else {
    dashboardApi = null;
    main.appendChild(roleSelect());
  }

  app.appendChild(footer());
  window.scrollTo(0, 0);
}

function header(view) {
  const h = document.createElement("header");
  h.className = "app-header";
  h.innerHTML = `
    <div class="app-header-inner">
      <button class="brand" data-go="#/" aria-label="Inicio EqualScore">
        <svg width="30" height="30" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="url(#g)"/><path d="M9 12h14M9 16h14M9 20h9" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/><defs><linearGradient id="g" x1="0" y1="0" x2="32" y2="32"><stop offset="0" stop-color="#7C3AED"/><stop offset="1" stop-color="#4C1D95"/></linearGradient></defs></svg>
        <span class="brand-name">EqualScore</span>
      </button>
      <div class="role-switch" role="group" aria-label="Cambiar rol">
        <button data-go="#/cliente" class="${view === "customer" ? "is-active" : ""}">Cliente</button>
        <button data-go="#/empresa" class="${view === "dashboard" ? "is-active" : ""}">Empresa</button>
      </div>
    </div>`;
  h.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => navigate(b.dataset.go === "#/" ? "#/inicio" : b.dataset.go)));
  return h;
}

function roleSelect() {
  const s = document.createElement("section");
  s.className = "role-select";
  s.innerHTML = `
    <div class="role-hero">
      <span class="pill">Demostración · datos simulados</span>
      <h1>¿Cómo quieres usar EqualScore?</h1>
      <p>Scoring crediticio con IA explicable y datos alternativos. Elige tu rol para comenzar.</p>
    </div>
    <div class="role-cards">
      <button class="role-card" data-go="#/cliente">
        <span class="role-icon">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4" stroke="currentColor" stroke-width="2"/><path d="M4 21c0-4 3.5-7 8-7s8 3 8 7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        </span>
        <span class="role-title">Soy cliente y quiero solicitar un crédito</span>
        <span class="role-desc">Completa una solicitud y recibe tu score explicable en segundos, aunque no tengas historial bancario.</span>
        <span class="role-cta">Solicitar crédito →</span>
      </button>
      <button class="role-card" data-go="#/empresa">
        <span class="role-icon">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 21V10l9-6 9 6v11" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M9 21v-6h6v6" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>
        </span>
        <span class="role-title">Soy la empresa que otorga el préstamo</span>
        <span class="role-desc">Opera tu cartera, busca clientes y revisa el monitor de equidad por género y comuna.</span>
        <span class="role-cta">Abrir panel →</span>
      </button>
    </div>
    <button class="reset-link" id="reset-data">Reiniciar datos de demostración</button>`;
  s.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => navigate(b.dataset.go)));
  s.querySelector("#reset-data").addEventListener("click", () => {
    setCustomers(resetDataset());
    alert("Datos de demostración reiniciados.");
  });
  return s;
}

function openNuevaConsulta() {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  const box = document.createElement("div");
  box.className = "modal modal-wide";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-label", "Nueva consulta de score");
  const closeBtn = document.createElement("button");
  closeBtn.className = "modal-close";
  closeBtn.setAttribute("aria-label", "Cerrar");
  closeBtn.textContent = "×";
  const close = () => overlay.remove();
  closeBtn.addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

  box.appendChild(closeBtn);
  box.appendChild(
    renderCustomer((rec) => {
      setCustomers(addCustomer(customers, rec));
      dashboardApi && dashboardApi.refresh();
    })
  );
  overlay.appendChild(box);
  document.getElementById("view").appendChild(overlay);
}

function footer() {
  const f = document.createElement("footer");
  f.className = "app-footer";
  f.innerHTML = `
    <p class="disclaimer"><strong>Proyecto en etapa conceptual (ronda semilla).</strong> EqualScore no es aún una entidad financiera regulada. Todo el scoring y los datos mostrados son <strong>simulados</strong>; no se solicitan ni almacenan contraseñas, números de tarjeta ni accesos bancarios reales. Las conexiones de Open Banking y uso de celular son interruptores simulados.</p>
    <p class="copy">EqualScore · 2026</p>`;
  return f;
}

render();
