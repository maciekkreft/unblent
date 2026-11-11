import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import * as echarts from "echarts";
import { machine, FEATURES, pictureOf, lineOf, cellTip, formatMs, dayName, whoOf, mayAllOf, onMacOf } from "./machine.js";
import settingsEdited from "./events/settings.edited.json" with { type: "json" };

// Section 10: a reactive controller is the home for attaching an actor to a view.
class ActorController {
  constructor(host) {
    this.host = host;
    host.addController(this);
  }

  hostConnected() {
    this.actor = mount(machine, {
      input: { ask: (target, name, payload) => ask(machine, target, name, payload) },
      events: { "settings.edited": settingsEdited },
    });
    this.subscription = this.actor.subscribe(() => this.host.requestUpdate());
  }

  hostDisconnected() {
    this.subscription?.unsubscribe();
    unmount(this.actor);
  }

  get snapshot() {
    return this.actor?.getSnapshot();
  }

  send(event) {
    this.actor?.send(event);
  }
}

// Each feature's colour token (7.4), named in full so the tokens' users can be found.
const COLOURS = {
  journal: "--color-feature-journal",
  reading: "--color-feature-reading",
  highlights: "--color-feature-highlights",
  notes: "--color-feature-notes",
  chats: "--color-feature-chats",
  evaluators: "--color-feature-evaluators",
  choice: "--color-feature-choice",
  values: "--color-feature-values",
  other: "--color-feature-other",
};

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

class UsageTab extends LitElement {
  // The same type and spacing as the other tabs of the sheet; the charts take their
  // colours from the tokens at draw time, through the probe below, since ECharts draws
  // with resolved colours, not custom properties.
  static styles = css`
    :host {
      display: block;
      container: usage / inline-size;
    }
    .usage {
      padding: var(--space-md);
      max-width: calc(var(--width-form) * 1.5);
    }
    h3 {
      margin: 0;
      font-size: var(--text-subtitle);
      font-weight: var(--weight-semibold);
      line-height: var(--leading-tight);
      color: var(--color-ink);
    }
    .bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-sm) var(--space-md);
      margin-bottom: var(--space-md);
    }
    .bar h3 {
      margin-right: auto;
    }
    .seg {
      display: inline-flex;
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: var(--space-2xs);
      gap: var(--space-2xs);
      background: var(--color-canvas);
    }
    .seg.admin {
      background: var(--color-admin-subtle);
      border-color: transparent;
    }
    .seg button {
      font: inherit;
      font-size: var(--text-sm);
      color: var(--color-body);
      background: none;
      border: 0;
      border-radius: calc(var(--radius-sm) - var(--space-2xs));
      padding: var(--space-2xs) var(--space-sm);
      cursor: pointer;
    }
    .seg button:hover {
      background: var(--color-surface-hover);
    }
    .seg button[aria-pressed="true"] {
      background: var(--color-surface-active);
      color: var(--color-ink);
      font-weight: var(--weight-semibold);
    }
    button:focus-visible,
    input[type="checkbox"]:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    .switch-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: var(--space-md);
      margin-top: var(--space-md);
      padding: var(--space-sm) 0;
      border-top: var(--border-width) solid var(--color-border);
    }
    .switch-row label {
      color: var(--color-ink);
    }
    .help,
    .empty,
    .error {
      margin: 0;
      color: var(--color-body-mid);
      font-size: var(--text-sm);
    }
    .empty,
    .error {
      margin-top: var(--space-sm);
    }
    input[type="checkbox"] {
      margin: 0;
      flex: none;
      accent-color: var(--color-accent);
      width: var(--space-md);
      height: var(--space-md);
    }
    .ghost {
      margin-top: var(--space-md);
      display: grid;
      grid-template-columns: 2fr 1fr 1fr;
      grid-template-rows: calc(var(--space-2xl) - var(--space-xs)) var(--space-xl);
      gap: calc(var(--space-2xs) + var(--border-width));
    }
    .ghost i {
      border-radius: var(--radius-sm);
      background: var(--color-canvas-soft);
      border: var(--border-width) dashed var(--color-border);
    }
    .ghost i:first-child {
      grid-row: span 2;
    }
    .summary {
      margin: var(--space-md) 0;
      color: var(--color-body);
      font-size: var(--text-sm);
    }
    .summary strong {
      color: var(--color-ink);
      font-weight: var(--weight-semibold);
    }
    .big {
      display: block;
      font-size: var(--text-heading);
      color: var(--color-ink);
      font-weight: var(--weight-semibold);
      line-height: var(--leading-tight);
      font-variant-numeric: tabular-nums;
    }
    .section-h {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: baseline;
      gap: var(--space-sm);
      margin: var(--space-lg) 0 var(--space-sm);
      font-size: var(--text-sm);
      font-weight: var(--weight-semibold);
      color: var(--color-ink);
    }
    .section-h span {
      font-weight: var(--weight-normal);
      color: var(--color-body-mid);
      font-size: var(--text-caption);
    }
    .chart {
      width: 100%;
      position: relative;
    }
    .tree {
      height: calc(var(--space-2xl) * 3.6);
    }
    .stream {
      height: calc(var(--space-2xl) * 2.97);
    }
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-xs);
      margin-top: var(--space-sm);
    }
    .chip {
      font: inherit;
      font-size: var(--text-caption);
      display: inline-flex;
      align-items: center;
      gap: var(--space-xs);
      padding: var(--space-2xs) var(--space-sm);
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-full);
      background: var(--color-canvas);
      color: var(--color-body);
      cursor: pointer;
      transition: opacity var(--duration-fast) var(--ease);
    }
    .chip:hover {
      background: var(--color-surface-hover);
    }
    .chip[aria-pressed="true"] {
      border-color: var(--color-ink);
      color: var(--color-ink);
    }
    .chip.dim {
      opacity: 0.45;
    }
    .dot {
      width: var(--space-sm);
      height: var(--space-sm);
      border-radius: var(--radius-full);
      flex: none;
    }
    .chip .t {
      color: var(--color-body-mid);
      font-variant-numeric: tabular-nums;
    }
    /* The calendar: one square per day, newest bottom right. --tint is the accent, or
       the colour of the feature followed; each level mixes more of it into the soft
       canvas, so the shades follow the scheme without a redraw. */
    .cal-wrap {
      position: relative;
      --tint: var(--color-accent);
    }
    .cal {
      display: grid;
      grid-auto-flow: column;
      grid-template-rows: repeat(7, auto);
      grid-template-columns: repeat(26, minmax(0, 1fr));
      gap: calc(var(--space-2xs) + var(--border-width));
    }
    .cal i,
    .scale i {
      display: block;
      border-radius: calc(var(--radius-sm) / 2);
      background: var(--color-canvas-soft);
      transition: background-color var(--duration-slide) var(--ease), opacity var(--duration-slide) var(--ease);
    }
    .cal i {
      aspect-ratio: 1;
      outline: var(--border-width) solid transparent;
    }
    .cal i.out {
      opacity: 0.35;
    }
    .cal i.today {
      outline-color: var(--color-ink);
      outline-offset: var(--border-width);
    }
    :is(.cal, .scale) i.l1 {
      background: color-mix(in srgb, var(--tint) 25%, var(--color-canvas-soft));
    }
    :is(.cal, .scale) i.l2 {
      background: color-mix(in srgb, var(--tint) 45%, var(--color-canvas-soft));
    }
    :is(.cal, .scale) i.l3 {
      background: color-mix(in srgb, var(--tint) 70%, var(--color-canvas-soft));
    }
    :is(.cal, .scale) i.l4 {
      background: var(--tint);
    }
    .cal-foot {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: var(--space-xs);
      font-size: var(--text-caption);
      color: var(--color-body-mid);
    }
    .scale {
      display: inline-flex;
      align-items: center;
      gap: calc(var(--space-2xs) + var(--border-width));
    }
    .scale i {
      width: calc(var(--space-sm) + var(--space-2xs));
      height: calc(var(--space-sm) + var(--space-2xs));
    }
    .tip {
      position: absolute;
      z-index: 1;
      pointer-events: none;
      background: var(--color-canvas);
      color: var(--color-ink);
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-sm);
      box-shadow: var(--shadow-card);
      padding: var(--space-xs) var(--space-sm);
      font-size: var(--text-caption);
      white-space: nowrap;
      opacity: 0;
      transition: opacity var(--duration-fast) var(--ease);
    }
    .tip.on {
      opacity: 1;
    }
    .probe {
      display: none;
    }
    @container usage (width < 32.5rem) {
      .tree {
        height: calc(var(--space-2xl) * 3.28);
      }
      .stream {
        height: calc(var(--space-2xl) * 2.66);
      }
      .big {
        font-size: var(--text-subtitle);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .chip,
      .cal i,
      .scale i,
      .tip {
        transition: none;
      }
    }
  `;

  #actor = new ActorController(this);
  #charts = { tree: null, stream: null };
  #shown = false;
  #resize = null;
  #scheme = null;
  #media = null;
  #redraw = () => this.#draw();

  connectedCallback() {
    super.connectedCallback();
    // The sheet keeps every tab connected (settings-tabs): a tab shown has a box, one
    // hidden has none, so the summary is asked again each time the box appears.
    // Next frame: a summary answered from this device lands at once, and a tab redrawn
    // inside the observer resizes the box it watches, which the browser reports.
    this.#resize = new ResizeObserver(() =>
      requestAnimationFrame(() => {
        const shown = this.offsetWidth > 0;
        if (shown && !this.#shown) this.#actor.send({ type: "_show" });
        this.#shown = shown;
        if (shown) {
          this.#mountCharts();
          this.#charts.tree?.resize();
          this.#charts.stream?.resize();
        }
      }),
    );
    this.#resize.observe(this);
    // The colour scheme is a document fact (7.5): read, never written.
    this.#scheme = new MutationObserver(this.#redraw);
    this.#scheme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-color-scheme"] });
    this.#media = matchMedia("(prefers-color-scheme: dark)");
    this.#media.addEventListener("change", this.#redraw);
  }

  disconnectedCallback() {
    this.#resize?.disconnect();
    this.#scheme?.disconnect();
    this.#media?.removeEventListener("change", this.#redraw);
    for (const key of Object.keys(this.#charts)) {
      this.#charts[key]?.dispose();
      this.#charts[key] = null;
    }
    super.disconnectedCallback();
  }

  // dock-desk's Ctrl+h/j/k/l (12) focuses a panel by its host: land on its first control.
  focus(options) {
    const target = this.renderRoot?.querySelector("button, input");
    if (target) target.focus(options);
    else super.focus(options);
  }

  // A token's resolved value: custom properties hold light-dark() pairs, which only a
  // property that uses them resolves.
  #token(name, property = "color") {
    const probe = this.renderRoot.querySelector(".probe");
    if (!probe) return "";
    probe.style.setProperty(property, `var(${name})`);
    return getComputedStyle(probe).getPropertyValue(property).trim();
  }

  // ← and → (and h and l with Vim keys on) move between the buttons of one row; at an
  // end the key does nothing, so the opposite key is always the way back.
  #move(e, vim) {
    const step = { ArrowLeft: -1, ArrowRight: 1, ...(vim ? { h: -1, l: 1 } : {}) }[e.key];
    if (!step || e.altKey || e.ctrlKey || e.metaKey) return;
    const buttons = [...e.currentTarget.querySelectorAll("button")];
    const next = buttons[buttons.indexOf(e.target) + step];
    e.preventDefault();
    next?.focus();
  }

  #key(e) {
    if (e.key !== "Escape" || !this.#actor.snapshot?.context.focus) return;
    e.preventDefault();
    e.stopPropagation();
    this.#actor.send({ type: "_clear" });
  }

  #tip(e, picture, focus) {
    const tip = this.renderRoot.querySelector(".tip");
    const i = Number(e.target?.dataset?.i);
    if (!tip || !Number.isInteger(i)) return;
    tip.textContent = cellTip(picture.cells[i], focus);
    tip.classList.add("on");
    const wrap = tip.parentElement.getBoundingClientRect();
    const cell = e.target.getBoundingClientRect();
    const left = Math.min(wrap.width - tip.offsetWidth, Math.max(0, cell.left - wrap.left + cell.width / 2 - tip.offsetWidth / 2));
    tip.style.left = `${left}px`;
    tip.style.top = `${cell.top - wrap.top - tip.offsetHeight - 4}px`;
  }

  #untip() {
    this.renderRoot.querySelector(".tip")?.classList.remove("on");
  }

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot) return nothing;
    const { context } = snapshot;
    const settings = context.settings;
    const on = settings?.usageCounting === true;
    const vim = settings?.vimKeys === true;
    const who = whoOf(context);
    const summary = context.summary;
    const ready = summary && !summary.error;
    const picture = ready ? pictureOf(summary, context.range, context.now(), context.focus) : null;
    return html`
      <div class="usage" @keydown=${(e) => this.#key(e)}>
        <span class="probe" aria-hidden="true"></span>
        <div class="bar">
          <h3>Usage</h3>
          ${on && mayAllOf(context.session)
            ? html`<div class="seg admin" role="group" aria-label="Whose usage" @keydown=${(e) => this.#move(e, vim)}>
                ${[
                  ["you", "You"],
                  ["all", "All accounts"],
                ].map(
                  ([id, name]) =>
                    html`<button aria-pressed=${who === id ? "true" : "false"} @click=${() => this.#actor.send({ type: "_who", who: id })}>${name}</button>`,
                )}
              </div>`
            : nothing}
          ${settings
            ? html`<div class="seg" role="group" aria-label="Range" @keydown=${(e) => this.#move(e, vim)}>
                ${[
                  ["week", "Week"],
                  ["month", "Month"],
                  ["all", "All"],
                ].map(
                  ([id, name]) =>
                    html`<button aria-pressed=${context.range === id ? "true" : "false"} @click=${() => this.#actor.send({ type: "_range", range: id })}>
                      ${name}
                    </button>`,
                )}
              </div>`
            : nothing}
        </div>
        ${settings ? this.#body(context, picture, who) : nothing}
        ${settings ? this.#switchRow(on, context.session) : nothing}
      </div>
    `;
  }

  #switchRow(on, session) {
    return html`<div class="switch-row">
      <div>
        <label for="share">Share usage statistics from this device</label>
        <p class="help">
          Your time is counted on this device either way. When on, this device also sends which features you use and for how long — never what you write or read — to guide future
          development. You can leave it off for good.${onMacOf(session) ? " The counts stay on this Mac." : ""}
        </p>
      </div>
      <input
        id="share"
        type="checkbox"
        role="switch"
        .checked=${on}
        aria-checked=${on ? "true" : "false"}
        @change=${(e) => {
          // settings.changed is the only assignment: the box shows the setting, not the click.
          e.target.checked = on;
          this.#actor.send({ type: "_toggle" });
        }}
      />
    </div>`;
  }

  #ghost(text) {
    return html`<div class="ghost" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>
      <p class="empty">${text}</p>`;
  }

  #body(context, picture, who) {
    const summary = context.summary;
    if (!summary) return nothing;
    if (summary.error === "signed-out") return this.#ghost("Sign in to see where your time goes.");
    if (summary.error) return html`<p class="error" role="status">Your usage could not be read. Check the connection and open Usage again.</p>`;
    if (!picture.any) return this.#ghost("Counting from now. What you do next shows here the next time you open Usage.");
    const line = lineOf(picture, context.range, who, summary.accounts);
    const focus = context.focus;
    return html`
      <p class="summary">
        <span class="big">${formatMs(picture.total)}</span><span>${line.lead}${line.top ? html`<strong>${line.top}</strong>` : nothing}${line.tail}</span>
      </p>
      <div class="section-h">Where your time went <span>click a feature to follow it</span></div>
      <div class="chart tree"></div>
      <div class="chips" @keydown=${(e) => this.#move(e, context.settings.vimKeys)}>
        ${picture.totals.map(
          (f) => html`<button
            class="chip ${focus && focus !== f.id ? "dim" : ""}"
            data-feature=${f.id}
            aria-pressed=${focus === f.id ? "true" : "false"}
            @click=${() => this.#actor.send({ type: "_focus", feature: f.id })}
          >
            <span class="dot" style="background: var(${COLOURS[f.id]})"></span>${f.name} <span class="t">${formatMs(f.ms)}</span>
          </button>`,
        )}
      </div>
      <div class="section-h">Day by day <span>${picture.step === 7 ? "minutes per week" : "minutes per day"}</span></div>
      <div class="chart stream"></div>
      <div class="section-h">
        Every day since ${picture.first.long}
        <span>${picture.active} of ${picture.span} days ${context.range === "all" ? "" : "in range "}active</span>
      </div>
      <div class="cal-wrap" style=${focus ? `--tint: var(${COLOURS[focus]})` : ""}>
        <div
          class="cal"
          role="img"
          aria-label=${`${picture.active} of ${picture.span} days active`}
          @mousemove=${(e) => this.#tip(e, picture, focus)}
          @mouseleave=${() => this.#untip()}
        >
          ${picture.cells.map(
            (c, i) => html`<i data-i=${i} class="l${c.level} ${c.out ? "out" : ""} ${c.today ? "today" : ""}"></i>`,
          )}
        </div>
        <div class="cal-foot">
          <span>${picture.first.short}</span>
          <span class="scale">Less <i></i><i class="l1"></i><i class="l2"></i><i class="l3"></i><i class="l4"></i> More</span>
          <span>Today</span>
        </div>
        <div class="tip" role="tooltip"></div>
      </div>
    `;
  }

  updated() {
    this.#mountCharts();
    this.#draw();
  }

  // ECharts owns the inside of each chart's box; a box Lit replaced gets a new chart.
  #mountCharts() {
    if (!this.#shown) return;
    for (const key of ["tree", "stream"]) {
      const el = this.renderRoot.querySelector(`.chart.${key}`);
      const chart = this.#charts[key];
      if (chart && chart.getDom() === el) continue;
      chart?.dispose();
      this.#charts[key] = el && el.clientWidth > 0 ? this.#init(el, key) : null;
    }
  }

  #init(el, key) {
    const chart = echarts.init(el, null, { renderer: "svg" });
    const follow = (id) => id && this.#actor.send({ type: "_focus", feature: id });
    if (key === "tree") chart.on("click", (p) => follow(p.data?.fid));
    else chart.on("click", (p) => follow(FEATURES.find((f) => f.name === p.data?.[2])?.id));
    return chart;
  }

  #draw() {
    const snapshot = this.#actor.snapshot;
    const { tree, stream } = this.#charts;
    if (!snapshot || (!tree && !stream)) return;
    const { context } = snapshot;
    if (!context.summary || context.summary.error) return;
    const focus = context.focus;
    const picture = pictureOf(context.summary, context.range, context.now(), focus);
    const t = (name) => this.#token(name);
    const ink = t("--color-ink");
    const mid = t("--color-body-mid");
    const canvas = t("--color-canvas");
    const border = t("--color-border");
    const grey = t("--color-surface-active");
    const colour = (id) => (!focus || focus === id ? t(COLOURS[id]) : grey);
    const font = getComputedStyle(this).fontFamily;
    const shadow = this.#token("--shadow-card", "box-shadow");
    const tooltip = {
      backgroundColor: canvas,
      borderColor: border,
      borderWidth: 1,
      padding: [4, 8],
      textStyle: { color: ink, fontFamily: font, fontSize: 13 },
      extraCssText: `box-shadow: ${shadow}; border-radius: 6px;`,
    };
    const anim = { animation: !reduced(), animationDurationUpdate: 600, animationEasingUpdate: "cubicInOut" };
    const sum = picture.total || 1;

    tree?.setOption({
      ...anim,
      tooltip: { ...tooltip, confine: true, formatter: (p) => `${p.name} · ${formatMs(p.value)} (${Math.round((p.value / sum) * 100)}%)` },
      series: [
        {
          type: "treemap",
          roam: false,
          nodeClick: false,
          breadcrumb: { show: false },
          left: 0,
          right: 0,
          top: 0,
          bottom: 0,
          squareRatio: 1.2,
          itemStyle: { borderColor: canvas, borderWidth: 3, gapWidth: 3, borderRadius: 6 },
          label: {
            show: true,
            fontFamily: font,
            color: canvas,
            fontSize: 13,
            fontWeight: 600,
            formatter: (p) => (p.value / sum < 0.05 ? "" : `${p.name}\n{t|${formatMs(p.value)}}`),
            rich: { t: { fontSize: 12, fontWeight: 400, color: canvas, opacity: 0.85, padding: [3, 0, 0, 0] } },
          },
          data: picture.totals.map((f) => ({
            name: f.name,
            value: f.ms,
            fid: f.id,
            itemStyle: { color: colour(f.id) },
            label: { color: !focus || focus === f.id ? canvas : mid, rich: { t: { color: !focus || focus === f.id ? canvas : mid } } },
          })),
        },
      ],
    });

    stream?.setOption(
      {
        ...anim,
        tooltip: {
          ...tooltip,
          confine: true,
          trigger: "axis",
          axisPointer: { type: "line", lineStyle: { color: t("--color-border-strong") } },
          formatter: (ps) => {
            const head = `${picture.step === 7 ? "Week to " : ""}${dayName(ps[0].value[0])}`;
            const lines = ps
              .filter((p) => p.value[1] > 0 && (!focus || FEATURES.find((f) => f.name === p.value[2])?.id === focus))
              .sort((a, b) => b.value[1] - a.value[1])
              .map((p) => `${p.marker}${p.value[2]} · ${formatMs(p.value[1] * 60000)}`);
            return `<b>${head}</b><br>${lines.join("<br>") || "nothing"}`;
          },
        },
        singleAxis: {
          type: "time",
          top: 4,
          bottom: 22,
          left: 16,
          right: 16,
          axisLine: { lineStyle: { color: border } },
          axisTick: { show: false },
          splitLine: { show: false },
          axisLabel: {
            color: mid,
            fontSize: 11,
            fontFamily: font,
            hideOverlap: true,
            showMinLabel: false,
            showMaxLabel: false,
            formatter: context.range === "week" ? "{ee}" : "{d} {MMM}",
          },
          axisPointer: { label: { show: false } },
        },
        series: [
          {
            type: "themeRiver",
            boundaryGap: ["8%", "8%"],
            label: { show: false },
            emphasis: { disabled: true },
            color: FEATURES.map((f) => colour(f.id)),
            data: picture.river,
          },
        ],
      },
      true,
    );
  }
}

customElements.define("usage-tab", UsageTab);
