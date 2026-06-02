# EqualScore — App de demostración

Aplicación web (estática, sin backend) que demuestra el producto **EqualScore**: scoring
crediticio **explicable y auditado contra sesgo**, usando datos alternativos en lugar de
historial bancario tradicional.

La app tiene dos roles:

- **Cliente** — formulario de solicitud de crédito en 4 pasos (datos personales con
  validación de RUT chileno, situación laboral, datos alternativos con consentimiento
  por ítem, y crédito solicitado). Al enviar, calcula un **puntaje de demostración**
  (300–850) con medidor, banda de riesgo, explicación en lenguaje claro y los factores
  que influyeron.
- **Empresa** — panel de cartera con KPIs (semana/mes), búsqueda de clientes por nombre
  o RUT, ficha detallada con línea de pago, gráficos (Chart.js) y un **monitor de equidad**
  que compara aprobación y mora por género y por comuna, con indicador de *paridad OK / revisar*.

Puedes cambiar de rol en cualquier momento desde el encabezado.

> ⚠️ **Aviso importante (léelo).** EqualScore es un **proyecto en etapa conceptual
> (ronda semilla)**, **no** una entidad financiera regulada. **Todo el scoring y los
> datos mostrados son simulados.** La app **no** solicita ni almacena datos sensibles
> reales: no pide contraseñas, números de tarjeta ni credenciales bancarias. Las
> conexiones de *Open Banking* y *uso de celular* son **interruptores simulados** — no
> se realiza ninguna integración real. El mismo aviso aparece de forma permanente en el
> pie de página de la app.

---

## Stack

- HTML + CSS + **JavaScript vanilla (ES modules)** — sin framework, sin paso de build.
- [Chart.js 4](https://www.chartjs.org/) cargado desde CDN para los gráficos.
- Tipografía **Inter** (Google Fonts).
- Persistencia de sesión en `localStorage` (las consultas nuevas se guardan localmente).

No hay dependencias que instalar y no hay nada que compilar.

## Estructura

```
equalscore-app/
├── index.html            # punto de entrada
├── styles/
│   └── main.css          # tema índigo, responsive, accesible
└── scripts/
    ├── app.js            # router por hash + shell (header, role select, footer)
    ├── customer.js       # flujo de solicitud en 4 pasos + pantalla de resultado
    ├── dashboard.js      # panel de empresa: KPIs, gráficos, búsqueda, ficha, CSV
    ├── data.js           # dataset simulado (semilla fija) + estadísticas + localStorage
    ├── scoring.js        # fórmula de scoring transparente y determinista
    ├── rut.js            # validación de RUT chileno (dígito verificador, módulo 11)
    └── utils.js          # helpers (formato CLP, normalización, PRNG, etc.)
```

## Ejecutar localmente

Como la app usa **ES modules**, debe servirse por HTTP (abrir `index.html` con
`file://` no funciona). Cualquier servidor estático sirve. Por ejemplo, con Python
(incluido en macOS/Linux):

```bash
cd equalscore-app
python3 -m http.server 8767
```

Luego abre <http://localhost:8767> en el navegador.

Alternativas equivalentes:

```bash
npx serve .          # Node
php -S localhost:8767
```

> **Reiniciar los datos de demo:** la app guarda el dataset en `localStorage`. Para
> volver al estado inicial, usa el enlace *“Reiniciar datos de demostración”* en la
> pantalla de selección de rol, o borra el almacenamiento del sitio en las herramientas
> de desarrollo del navegador.

## Build

No hay build. Es un sitio estático: los archivos del repositorio **son** el artefacto
desplegable. Cualquier hosting de archivos estáticos funciona.

## Desplegar

### Opción A — GitHub Pages

1. Sube el repositorio a GitHub.
2. En el repo: **Settings → Pages**.
3. En **Build and deployment → Source**, elige **Deploy from a branch**.
4. Selecciona la rama (`main`) y la carpeta:
   - Si el contenido de la app está en la **raíz** del repo, elige `/ (root)`.
   - Si está dentro de `equalscore-app/`, mueve los archivos a la raíz del repo o
     publica esa carpeta (Pages solo permite `/` o `/docs`, así que lo más simple es
     que `index.html` quede en la raíz).
5. Guarda. En ~1 minuto la app estará en `https://<usuario>.github.io/<repo>/`.

No se requiere configuración extra: las rutas a `styles/` y `scripts/` son relativas y
funcionan bajo el subdirectorio del proyecto.

### Opción B — Netlify

**Desde la interfaz (drag & drop):**

1. Entra a <https://app.netlify.com/drop>.
2. Arrastra la carpeta `equalscore-app/` completa.
3. Listo: Netlify entrega una URL pública.

**Conectando el repositorio (deploy continuo):**

1. *Add new site → Import an existing project* y elige tu repo.
2. **Build command:** *(déjalo vacío)*.
3. **Publish directory:** `equalscore-app` (o `.` si los archivos están en la raíz).
4. *Deploy*.

### Opción C — Vercel

**Con la CLI:**

```bash
npm i -g vercel
cd equalscore-app
vercel        # sigue las indicaciones; framework: "Other"
```

**Desde la interfaz:**

1. *Add New… → Project* e importa el repo.
2. **Framework Preset:** *Other*.
3. **Build Command:** vacío · **Output Directory:** vacío (raíz) o `equalscore-app`.
4. *Deploy*.

---

## Cómo funciona el scoring (transparencia)

El puntaje es **determinista** y está documentado en
[`scripts/scoring.js`](scripts/scoring.js). Parte de una base de 300 y suma puntos por
factores **no protegidos** — historial de pagos de servicios, ingreso, antigüedad,
tipo de trabajo, comportamiento en apps, Open Banking y uso de celular (estos dos
últimos, simulados). **No** usa género, comuna ni edad. El máximo es 850.

El monitor de equidad del panel recalcula, sobre el dataset simulado, las tasas de
aprobación y mora por género y por comuna, y marca *“revisar”* si la brecha de
aprobación supera los 12 puntos porcentuales. El dataset está construido para ilustrar
el caso de uso: mujeres de 25–35 con buen historial de pagos **no** quedan
sub-aprobadas, y clientes con buen comportamiento en comunas históricamente penalizadas
**sí** son aprobados.

## Accesibilidad

HTML semántico, etiquetas asociadas a cada campo, navegación por teclado, `aria-*`
donde corresponde, enlace *“saltar al contenido”* y respeto por `prefers-reduced-motion`.

## Licencia

Material de demostración. Datos y scoring simulados. Sin garantías.
