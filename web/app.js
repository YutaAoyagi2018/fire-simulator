/* 画面の配線：入力 → シミュレーション → 描画 */
(function () {
  "use strict";
  const D = window.FIRE_DATA;
  const E = window.FireEngine;
  const C = window.Charts;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  // ---------- 初期値 ----------
  const DEFAULTS = {
    age: 30, endAge: 95,
    nisa: 500, nisaBasis: 400, taxable: 0, taxableBasis: 0,
    monthly: 10, bonus: 30, contribGrowth: 0,
    fireMode: "target", swr: 4, targetManual: false, target: 7500, fireAge: 50, maxWorkAge: 60,
    expense: 25, sideIncome: 0, sideUntil: 60, pension: 12, pensionAge: 65,
    strategy: "fixed", pctRate: 4, floorPct: 80,
    events: [{ age: 60, amount: 500, label: "退職金" }],
    method: "hist", period: "all", mu: 5, sigma: 16, infl: 2,
    tax: true, useNisa: true, nisaAnnual: 360, nisaLife: 1800,
  };
  const STORE = "firesim-v1";
  let S = load();
  if (!["all", "1973", "1990"].includes(S.period)) S.period = "all";

  function load() {
    let s = null;
    try {
      if (location.hash.length > 3) s = JSON.parse(decodeURIComponent(escape(atob(location.hash.slice(1)))));
    } catch (e) { s = null; }
    if (!s) { try { s = JSON.parse(localStorage.getItem(STORE) || "null"); } catch (e) { s = null; } }
    return Object.assign({}, DEFAULTS, s || {}, { events: (s && Array.isArray(s.events)) ? s.events : DEFAULTS.events.map((e) => ({ ...e })) });
  }
  function save() { try { localStorage.setItem(STORE, JSON.stringify(S)); } catch (e) { /* 保存できない環境でも動く */ } }

  // ---------- 書式 ----------
  const nf = new Intl.NumberFormat("ja-JP");
  function man(v, digits) {
    if (v === null || v === undefined || !isFinite(v)) return "—";
    const a = Math.abs(v);
    if (a >= 10000) {
      const x = v / 10000;
      const d = digits !== undefined ? digits : a >= 100000 ? 1 : 2;
      return (+x.toFixed(d)).toLocaleString("ja-JP") + "億円";
    }
    return nf.format(Math.round(v)) + "万円";
  }
  function axisMan(v) {
    if (v >= 10000) return (+(v / 10000).toFixed(2)) + "億";
    if (v === 0) return "0";
    return nf.format(v) + "万";
  }
  const pct = (x, d = 0) => (isFinite(x) ? (x * 100).toFixed(d) + "%" : "—");
  const ageTxt = (a) => (a === null || a === undefined || !isFinite(a) ? "—" : Math.floor(a + 1e-9) + "歳");
  const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

  // ---------- 入力部品を組み立てる ----------
  function buildFields() {
    for (const f of $$(".field")) {
      const key = f.dataset.key;
      const label = f.textContent.trim();
      const min = +f.dataset.min, max = +f.dataset.max, step = +f.dataset.step;
      const smax = f.dataset.sliderMax ? +f.dataset.sliderMax : max;
      f.innerHTML = `
        <div class="f-top">
          <label class="f-label" for="in-${key}">${label}</label>
          <span class="f-val"><input id="in-${key}" type="number" inputmode="decimal" min="${min}" max="${max}" step="${step}"><span class="f-unit">${f.dataset.unit || ""}</span></span>
        </div>
        <input type="range" min="${min}" max="${smax}" step="${step}" aria-label="${label}">
        ${f.dataset.hint ? `<div class="f-hint">${f.dataset.hint}</div>` : ""}`;
      const num = $("input[type=number]", f), rng = $("input[type=range]", f);
      const setP = () => rng.style.setProperty("--p", ((Math.min(+rng.value, smax) - min) / (smax - min || 1)) * 100 + "%");
      f._sync = () => { num.value = S[key]; rng.value = Math.min(S[key], smax); setP(); };
      rng.addEventListener("input", () => { S[key] = +rng.value; num.value = rng.value; setP(); changed(key); });
      num.addEventListener("change", () => {
        let v = parseFloat(num.value);
        if (!isFinite(v)) v = S[key];
        v = Math.max(min, Math.min(max, v));
        S[key] = v; f._sync(); changed(key);
      });
    }
    for (const g of $$(".seg[data-key]")) {
      const key = g.dataset.key;
      g._sync = () => $$("button", g).forEach((b) => b.classList.toggle("on", b.dataset.v === S[key]));
      g.addEventListener("click", (e) => {
        const b = e.target.closest("button");
        if (!b) return;
        S[key] = b.dataset.v; g._sync(); changed(key);
      });
    }
    for (const c of $$("input[type=checkbox][data-key]")) {
      const key = c.dataset.key;
      c._sync = () => (c.checked = !!S[key]);
      c.addEventListener("change", () => { S[key] = c.checked; changed(key); });
    }
    for (const s of $$("select[data-key]")) {
      const key = s.dataset.key;
      s._sync = () => (s.value = S[key]);
      s.addEventListener("change", () => { S[key] = s.value; changed(key); });
    }
  }
  function syncAll() {
    for (const f of $$(".field")) f._sync && f._sync();
    for (const g of $$(".seg[data-key]")) g._sync && g._sync();
    for (const c of $$("input[type=checkbox][data-key]")) c._sync && c._sync();
    for (const s of $$("select[data-key]")) s._sync && s._sync();
    renderEvents();
    syncWhen();
  }
  function syncWhen() {
    for (const w of $$("[data-when]")) {
      const cond = w.dataset.when;
      const neg = cond.includes("!=");
      const [k, v] = cond.split(neg ? "!=" : "=");
      const cur = String(S[k]);
      w.classList.toggle("hidden", neg ? cur === v : cur !== v);
    }
  }

  // ---------- ライフイベント ----------
  function renderEvents() {
    const box = $("#events");
    box.innerHTML = S.events.length ? `<div class="ev ev-head"><span>年齢</span><span>金額(万円)</span><span>メモ</span><span></span></div>` : "";
    S.events.forEach((ev, i) => {
      const row = document.createElement("div");
      row.className = "ev";
      row.innerHTML = `<input type="number" class="age" value="${ev.age}" min="18" max="105" aria-label="年齢">
        <input type="number" class="amt" value="${ev.amount}" step="10" aria-label="金額（万円、出ていくお金はマイナス）">
        <input type="text" class="lab" value="${(ev.label || "").replace(/"/g, "&quot;")}" placeholder="例: 住宅の頭金" aria-label="メモ">
        <button class="x" title="削除" aria-label="削除">×</button>`;
      $(".age", row).addEventListener("change", (e) => { ev.age = +e.target.value; changed("events"); });
      $(".amt", row).addEventListener("change", (e) => { ev.amount = +e.target.value; changed("events"); });
      $(".lab", row).addEventListener("change", (e) => { ev.label = e.target.value; save(); });
      $(".x", row).addEventListener("click", () => { S.events.splice(i, 1); renderEvents(); changed("events"); });
      box.appendChild(row);
    });
  }
  $("#addEvent").addEventListener("click", () => {
    S.events.push({ age: Math.min(S.endAge - 1, S.age + 10), amount: -300, label: "" });
    renderEvents(); changed("events");
  });

  // ---------- 計算 ----------
  let R = null, H = null, sensCache = null, sensKey = "", timer = 0, selYear = null;
  function params(s = S) {
    return {
      ...s, targetAuto: !s.targetManual,
      maxWorkAge: Math.max(s.maxWorkAge, s.age),
      nPaths: 2000, block: 36,
    };
  }
  function changed() {
    syncWhen();
    save();
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
    clearTimeout(timer);
    timer = setTimeout(run, 60);
  }

  function run() {
    const p = params();
    const t0 = performance.now();
    R = E.simulate(D, p);
    if (R.error) { $("#verdict").textContent = R.error; return; }
    // 副収入があると、目標額は FIRE する年齢で変わる（副収入の残り年数が短いほど高い）
    const sideAff = p.targetAuto && p.sideIncome > 0 && p.sideUntil > p.age;
    $("#targetText").textContent = man(R.target);
    const tn = $("#targetNote");
    if (tn) tn.textContent = sideAff
      ? `${p.fireMode === "target" && R.fireAge ? ageTxt(R.fireAge.p50) : Math.min(p.fireAge, p.maxWorkAge) + "歳"}でFIREする場合。副収入が${p.sideUntil}歳で終わる分を見込んでいます（今すぐなら${man(R.targetNow)}、副収入なしなら${man(E.target({ ...p, sideIncome: 0 }))}）`
      : "";
    // 「歴史で試す」は常に全期間の歴史シナリオで
    H = p.method === "hist" && p.period === "all" && !R.note ? R : E.simulate(D, { ...p, method: "hist", period: "all" });
    sensCache = null;
    R.ms = performance.now() - t0;
    renderSummary();
    renderTab();
  }

  // ---------- 上部のまとめ ----------
  function renderSummary() {
    const p = R.p;
    const now = p.nisa + p.taxable;
    const fa = R.fireAge;
    const isTarget = p.fireMode === "target";
    const yearNow = new Date().getFullYear();

    // ヒーロー
    if (isTarget) {
      // fireAge には「目標に届かず遅くとも辞める年齢で辞めた」シナリオも含まれる
      const reach = R.earlyRate;
      const forced = reach < 0.5;
      $("#heroKicker").textContent = forced ? "仕事を辞める年齢（真ん中のシナリオ）" : "FIREに届く年齢（真ん中のシナリオ）";
      const a = fa ? fa.p50 : null;
      $("#heroAge").textContent = a !== null ? Math.floor(a + 1e-9) : "—";
      const left = a !== null ? Math.max(0, Math.round(a - p.age)) : null;
      $("#heroSub").innerHTML = forced
        ? `${reach > 0 ? "半分以上のシナリオで" : "どのシナリオでも"}目標に届かず、<b>${p.maxWorkAge}歳</b>で辞めます`
        : a <= p.age + 1e-9 ? `<b>もう目標に届いています</b>` : `あと<b>${left}年</b>・${yearNow + left}年ごろ`;
      const lo = p.age, hi = Math.max(p.maxWorkAge, lo + 1);
      const q = (v) => ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * 100;
      const prob = `${p.maxWorkAge}歳までに目標に届く確率 <b>${pct(reach)}</b>`;
      const spread = reach >= 0.9
        ? `。届く年齢は、早いケースで${ageTxt(fa.p10)}、遅いケースで${ageTxt(fa.p90)}です（10回のうち8回はこの間）`
        : reach > 0 ? `。残り${pct(1 - reach)}の人生は届かないまま${p.maxWorkAge}歳で辞めます` : "";
      const lab = (v) => (reach < 0.9 && v >= p.maxWorkAge - 1e-9 ? `${p.maxWorkAge}歳（未達）` : ageTxt(v));
      $("#heroRange").innerHTML = fa ? `
        <div>${prob}${spread}</div>` + (reach > 0 ? `
        <div class="rbar"><i style="left:${q(fa.p10)}%;width:${Math.max(1, q(fa.p90) - q(fa.p10))}%"></i><b style="left:${q(fa.p50)}%"></b></div>
        <div class="rlab"><span>${lab(fa.p10)}</span><span>${lab(fa.p90)}</span></div>` : "") : "";
    } else {
      $("#heroKicker").textContent = "FIREする年齢";
      $("#heroAge").textContent = Math.min(p.fireAge, p.maxWorkAge);
      const fr = R.paths.map((x) => x.fireReal).sort((a, b) => a - b);
      const med = E.quantile(fr, 0.5);
      $("#heroSub").innerHTML = `そのときの資産は<b>${man(med)}</b>（目標の${pct(med / R.target)}）`;
      $("#heroRange").innerHTML = `<div>下位10%で ${man(E.quantile(fr, 0.1))}・上位10%で ${man(E.quantile(fr, 0.9))}</div>`;
    }

    // ゲージ
    const sr = R.success;
    const circ = 2 * Math.PI * 50;
    const g = $("#gaugeFill");
    g.style.strokeDasharray = circ;
    g.style.strokeDashoffset = circ * (1 - sr);
    const st = sr >= 0.9 ? ["good", "安心", "M5 12.5l4.5 4.5L19 7.5"] : sr >= 0.75 ? ["warn", "注意", "M12 7v6M12 17v.5"] : ["crit", "危険", "M7 7l10 10M17 7L7 17"];
    g.style.stroke = cssVar("--" + st[0]);
    $("#gaugeVal").innerHTML = `${Math.round(sr * 100)}<small>%</small>`;
    const glbl = p.strategy === "percent" ? `生活費を${p.floorPct}%以上に保てる確率` : `${p.endAge}歳まで資産が持つ確率`;
    $("#gaugeLbl").textContent = glbl;
    $("#gaugeLbl2").textContent = glbl;
    $("#statusPill").innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="${cssVar("--" + st[0])}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="${st[2]}"/></svg>${st[1]}`;

    // タイル
    $("#tTarget").textContent = man(R.target);
    $("#tProgress").style.width = Math.min(100, (now / R.target) * 100) + "%";
    $("#tProgressText").textContent = `今 ${man(now)}（${pct(now / R.target, 1)}）`;
    $("#tFinalLabel").textContent = `${p.endAge}歳の資産（中央値）`;
    $("#tFinal").textContent = man(R.final.p50);
    $("#tFinalFoot").textContent = `下位10%: ${man(R.final.p10)}`;
    const wrs = R.paths.filter((x) => x.fireT >= 0 && x.fireReal > 0).map((x) => {
      const a = p.age + x.fireT / 12;
      const inc = (a < p.sideUntil ? p.sideIncome : 0) + (a >= p.pensionAge ? p.pension : 0);
      return Math.max(0, p.expense - inc) * 12 / x.fireReal;
    }).sort((a, b) => a - b);
    const wr = E.quantile(wrs, 0.5);
    $("#tWR").textContent = wrs.length ? pct(wr, 1) : "—";
    const after = Math.max(0, p.expense - p.pension);
    $("#tWRFoot").textContent = `年金開始後の取り崩し 月${(+after.toFixed(1)).toLocaleString()}万円`;
    const taxes = R.paths.map((x) => x.taxPaid).sort((a, b) => a - b);
    $("#tTax").textContent = p.tax ? man(E.quantile(taxes, 0.5)) : "計算しない";
    $("#tTaxFoot").textContent = p.useNisa ? "NISAで非課税になった分は含みません" : "NISAを使わない設定です";

    // ひとこと
    const methodTxt = R.usedMethod === "hist" ? `過去${nf.format(R.n)}通りの歴史` : R.usedMethod === "boot" ? `${nf.format(R.n)}通りの未来（過去の相場をつないだもの）` : `${nf.format(R.n)}通りの未来（想定利回り${p.mu}%）`;
    const contrib = `毎月${p.monthly}万円${p.bonus ? `とボーナス${p.bonus}万円` : ""}を全世界株式に積み立てると`;
    let v;
    if (isTarget && fa && R.earlyRate >= 0.5) {
      v = `${contrib}、真ん中のシナリオでは<b>${ageTxt(fa.p50)}</b>で目標の${man(R.target)}に届きます。`;
    } else if (isTarget && fa) {
      const fr = R.paths.map((x) => x.fireReal).sort((a, b) => a - b);
      v = `${contrib}、${R.earlyRate > 0 ? "真ん中のシナリオでは" : "どのシナリオでも"}<b>${p.maxWorkAge}歳までに目標の${man(R.target)}に届きません</b>（届く確率 ${pct(R.earlyRate)}）。${p.maxWorkAge}歳で辞めた時点の資産は真ん中のシナリオで${man(E.quantile(fr, 0.5))}です。`;
    } else {
      v = `${contrib}、${Math.min(p.fireAge, p.maxWorkAge)}歳で辞めた時点の資産は真ん中のシナリオで${man(E.quantile(R.paths.map((x) => x.fireReal).sort((a, b) => a - b), 0.5))}です。`;
    }
    v += ` その後、月${p.expense}万円（今の物価）で暮らすと、${methodTxt}のうち<b>${pct(sr)}</b>で${p.endAge}歳まで${p.strategy === "percent" ? `生活費を${p.floorPct}%以上に保てました` : "資産が持ちました"}。`;
    if (R.usedMethod === "hist") {
      const fails = R.paths.filter((x) => !x.success);
      if (fails.length) {
        const yrs = [...new Set(fails.map((x) => x.start.slice(0, 4)))];
        const show = yrs.length > 4 ? `${yrs[0]}年〜${yrs[yrs.length - 1]}年の一部など` : yrs.map((y) => y + "年").join("・");
        v += ` うまくいかなかったのは${show}に始めた場合です。`;
      }
    }
    $("#verdict").innerHTML = v;
    const nb = $("#noteBanner");
    const notes = [];
    if (R.note) notes.push(R.note);
    nb.innerHTML = notes.join("<br>");
    nb.classList.toggle("hidden", !notes.length);
  }

  // ---------- タブ ----------
  let tab = "fan";
  $("#tabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tab]");
    if (!b) return;
    tab = b.dataset.tab;
    $$("#tabs button").forEach((x) => x.classList.toggle("active", x === b));
    $$(".tabpane").forEach((x) => x.classList.toggle("hidden", x.dataset.pane !== tab));
    renderTab();
  });
  function renderTab() {
    if (!R || R.error) return;
    try {
      ({ fan: renderFan, dist: renderDist, history: renderHistory, sens: renderSens, table: renderTable, data: renderData })[tab]();
    } catch (err) {
      // 空白のままにせず、原因を画面に出す
      console.error(err);
      const pane = $(`.tabpane[data-pane="${tab}"]`);
      let box = $(".render-error", pane);
      if (!box) { box = document.createElement("p"); box.className = "note-banner render-error"; pane.appendChild(box); }
      box.textContent = `このタブを描けませんでした（${err.message}）。Ctrl+F5 で再読み込みしてください。`;
    }
  }

  // 資産の推移
  let scale = "lin";
  $("#scaleSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    scale = b.dataset.v;
    $$("#scaleSeg button").forEach((x) => x.classList.toggle("on", x === b));
    renderFan();
  });
  function renderFan() {
    const p = R.p, v = R.band.v, x = R.ages;
    const log = scale === "log";
    const depBy = x.map((a) => R.paths.filter((q) => q.depAge !== null && q.depAge <= a).length / R.n);
    $("#fanLegend").innerHTML = `
      <span><i class="line" style="background:${cssVar("--s1-strong")}"></i>真ん中（中央値）</span>
      <span><i style="background:${cssVar("--band-3")}"></i>25〜75%</span>
      <span><i style="background:${cssVar("--band-2")}"></i>10〜90%</span>
      <span><i style="background:${cssVar("--band-1")}"></i>5〜95%</span>
      <span><i class="line" style="background:${cssVar("--s2")}"></i>目標額</span>`;
    C.mount($("#fanChart"), () => {
      let y1 = 0;
      for (let i = 0; i < x.length; i++) y1 = Math.max(y1, v[4][i]);
      y1 = Math.max(y1 * 1.08, R.target * 1.25);
      const vlines = [];
      if (R.fireAge) vlines.push({ x: R.fireAge.p50, label: `FIRE ${ageTxt(R.fireAge.p50)}` });
      if (p.pensionAge > p.age && p.pensionAge < p.endAge) vlines.push({ x: p.pensionAge, label: `年金 ${p.pensionAge}歳`, row: 1 });
      C.fan($("#fanChart"), {
        x, x0: x[0], x1: x[x.length - 1],
        y0: log ? 100 : 0, y1: log ? Math.max(v[6].reduce((a, b) => Math.max(a, b), 0), R.target * 2) : y1, log,
        height: 360, fmtY: axisMan, fmtX: (a) => a + "歳",
        bands: [
          { lo: v[0], hi: v[6], fill: cssVar("--band-1") },
          { lo: v[1], hi: v[5], fill: cssVar("--band-2") },
          { lo: v[2], hi: v[4], fill: cssVar("--band-3") },
        ],
        lines: [{ y: v[3], color: cssVar("--s1-strong"), width: 2.5 }],
        refs: [{ y: R.target, color: cssVar("--s2"), label: `目標 ${man(R.target)}` }],
        vlines,
        aria: "年齢ごとの資産の分布",
        tooltip: (i) => `<div class="tt-h">${x[i]}歳（${new Date().getFullYear() + i}年）</div>
          <div class="tt-r"><span>上位10%</span><b>${man(v[5][i])}</b></div>
          <div class="tt-r"><span>上位25%</span><b>${man(v[4][i])}</b></div>
          <div class="tt-r"><span class="tt-k"><i style="background:${cssVar("--s1-strong")}"></i>真ん中</span><b>${man(v[3][i])}</b></div>
          <div class="tt-r"><span>下位25%</span><b>${man(v[2][i])}</b></div>
          <div class="tt-r"><span>下位10%</span><b>${man(v[1][i])}</b></div>
          ${depBy[i] > 0 ? `<div class="tt-r"><span>資産が尽きた</span><b>${pct(depBy[i], 1)}</b></div>` : ""}`,
      });
    });
  }

  // FIRE 年齢の分布
  function renderDist() {
    const p = R.p;
    const dt = $("#distTitle"), dc = $("#distCap");
    if (dt) dt.textContent = p.fireMode === "target" ? "何歳でFIREに届くか" : `${p.fireAge}歳で辞めたときの資産`;
    if (dc) dc.textContent = p.fireMode === "target"
      ? "シナリオごとの到達年齢の分布。「遅くとも辞める年齢」で辞めたシナリオも含みます。"
      : "辞めた時点の資産（今の価値）の分布。いちばん右の棒には、それより多いシナリオもまとめています。";
    if (p.fireMode === "target") {
      const lo = p.age, hi = Math.max(p.maxWorkAge, p.age);
      const xs = [], ys = [];
      for (let a = lo; a <= hi; a++) { xs.push(a); ys.push(0); }
      for (const fa of R.fireAges) {
        const k = Math.min(xs.length - 1, Math.max(0, Math.floor(fa + 1e-9) - lo));
        ys[k]++;
      }
      const share = ys.map((c) => c / R.n);
      const cum = []; share.reduce((s, c, i) => (cum[i] = s + c), 0);
      const forcedIdx = xs.length - 1;
      C.mount($("#distChart"), () => C.bars($("#distChart"), {
        x: xs, y: share, x0: lo - 0.6, x1: hi + 0.6, y0: 0, y1: Math.max(0.05, Math.max(...share) * 1.15),
        height: 300, fmtY: (v) => Math.round(v * 100) + "%", fmtX: (a) => a + "歳",
        color: (i) => (i === forcedIdx && R.earlyRate < 1 ? cssVar("--axis") : cssVar("--s1")),
        aria: "FIRE年齢の分布",
        tooltip: (i) => `<div class="tt-h">${xs[i]}歳${i === forcedIdx ? "（遅くとも辞める年齢）" : ""}</div>
          <div class="tt-r"><span>この年齢で届く</span><b>${pct(share[i], 1)}</b></div>
          <div class="tt-r"><span>この年齢までに</span><b>${pct(cum[i], 1)}</b></div>`,
      }));
      const marks = [35, 40, 45, 50, 55, 60, 65].filter((a) => a > p.age && a <= hi);
      $("#byAge").innerHTML = marks.map((a) => {
        const r = R.fireAges.filter((x) => x < a + 1 - 1e-9 && x < p.maxWorkAge - 1e-9).length / R.n;
        return `<div><small>${a}歳までに届く</small><strong>${pct(r)}</strong></div>`;
      }).join("");
    } else {
      // 年齢で決めた場合は、辞めた時点の資産の分布
      const fr = R.paths.map((x) => x.fireReal);
      const max = E.quantile(fr.slice().sort((a, b) => a - b), 0.97);
      const step = niceBin(max / 24);
      const xs = [], ys = [];
      for (let b = 0; b <= max; b += step) { xs.push(b + step / 2); ys.push(0); }
      for (const v of fr) { const k = Math.min(xs.length - 1, Math.floor(v / step)); ys[k]++; }
      const share = ys.map((c) => c / R.n);
      C.mount($("#distChart"), () => C.bars($("#distChart"), {
        x: xs, y: share, x0: 0, x1: xs.length * step, unit: step, y0: 0, y1: Math.max(...share) * 1.15,
        height: 300, fmtY: (v) => Math.round(v * 100) + "%", fmtX: axisMan,
        color: (i) => (xs[i] >= R.target ? cssVar("--s1") : cssVar("--s2")),
        refs: [],
        aria: "FIRE時点の資産の分布",
        tooltip: (i) => `<div class="tt-h">${man(xs[i] - step / 2)}〜${man(xs[i] + step / 2)}</div><div class="tt-r"><span>割合</span><b>${pct(share[i], 1)}</b></div>`,
      }));
      const reach = fr.filter((v) => v >= R.target).length / R.n;
      $("#byAge").innerHTML = `<div><small>${p.fireAge}歳で目標額に届いている</small><strong>${pct(reach)}</strong></div>
        <div><small>目標額</small><strong>${man(R.target)}</strong></div>`;
      $("#distChart").insertAdjacentHTML("afterbegin", `<div class="legend"><span><i style="background:${cssVar("--s1")}"></i>目標額以上</span><span><i style="background:${cssVar("--s2")}"></i>目標額未満</span></div>`);
    }
  }
  function niceBin(x) {
    const mag = Math.pow(10, Math.floor(Math.log10(Math.max(1, x))));
    const f = x / mag;
    return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag;
  }

  // 歴史で試す
  const EPISODES = [
    [1906, 1907, "1907年恐慌"], [1914, 1920, "第一次世界大戦と戦後インフレ"], [1928, 1932, "世界大恐慌（株価は約8割下落）"],
    [1937, 1942, "1937年の暴落と第二次世界大戦"], [1946, 1949, "戦後インフレ"], [1965, 1974, "スタグフレーションとオイルショック"],
    [1985, 1989, "プラザ合意後の円高とバブル"], [1999, 2003, "ITバブル崩壊"], [2007, 2009, "リーマン・ショック"],
  ];
  function renderHistory() {
    const p = R.p;
    const jan = H.paths.filter((x) => x.start && x.start.endsWith("-01"));
    if (!jan.length) {
      $("#histChart").innerHTML = `<p class="cap">この条件（${p.endAge - p.age}年間）を最後まで試せる年がありません。「何歳まで見るか」を短くしてください。</p>`;
      $("#story").innerHTML = ""; $("#pathChart").innerHTML = "";
      return;
    }
    const y0 = +D.start.slice(0, 4), y1 = +D.end.slice(0, 4);
    const years = [], vals = [], meta = [];
    const byYear = new Map(jan.map((x) => [+x.start.slice(0, 4), x]));
    for (let y = y0; y <= y1; y++) {
      const x = byYear.get(y);
      years.push(y);
      meta.push(x || null);
      vals.push(x ? (x.fireAge !== null ? x.fireAge - p.age : null) : null);
    }
    const okN = jan.filter((x) => x.success).length;
    $("#histLegend").innerHTML = `
      <span><i style="background:${cssVar("--good")}"></i>✓ 最後まで持った（${okN}年）</span>
      <span><i style="background:${cssVar("--crit")}"></i>✕ 途中で尽きた（${jan.length - okN}年）</span>
      <span style="color:var(--muted)">${jan[jan.length - 1].start.slice(0, 4)}年より後は、まだ${p.endAge - p.age}年たっていないため結果がありません</span>`;
    if (selYear === null || !byYear.has(selYear)) {
      const worst = jan.reduce((a, b) => (b.final < a.final ? b : a));
      selYear = +worst.start.slice(0, 4);
    }
    const draw = () => C.bars($("#histChart"), {
      x: years, y: vals, x0: y0 - 1, x1: y1 + 1, y0: 0, y1: Math.max(5, Math.max(...vals.filter((v) => v !== null)) * 1.1),
      height: 260, gap: 1, maxBar: 10, fmtY: (v) => v + "年", fmtX: (y) => y,
      color: (i) => (meta[i] && meta[i].success ? cssVar("--good") : cssVar("--crit")),
      selected: years.indexOf(selYear),
      aria: "開始年ごとのFIREまでの年数と成否",
      onClick: (i) => { selYear = years[i]; renderHistory(); },
      tooltip: (i) => {
        const x = meta[i];
        return `<div class="tt-h">${years[i]}年1月に始めたら</div>
          <div class="tt-r"><span>FIRE</span><b>${ageTxt(x.fireAge)}</b></div>
          <div class="tt-r"><span>${p.endAge}歳の資産</span><b>${x.success || x.depAge === null ? man(x.final) : ageTxt(x.depAge) + "で尽きる"}</b></div>
          <div class="tt-r"><span>結果</span><b>${x.success ? "✓ 持った" : "✕ 尽きた"}</b></div>`;
      },
    });
    C.mount($("#histChart"), draw);
    renderStory(byYear, selYear, jan);
  }
  function renderStory(byYear, y, jan) {
    const p = R.p;
    const x = byYear.get(y);
    const ys = jan.map((q) => +q.start.slice(0, 4));
    const i0 = E.monthIndex(D, `${y}-01`);
    const n10 = Math.min(120, D.r.length - i0);
    let g = 1;
    for (let k = 0; k < n10; k++) g *= (1 + D.r[i0 + k]) / (1 + D.inf[i0 + k]);
    const r10 = Math.pow(g, 12 / n10) - 1;
    const ep = EPISODES.filter(([a, b]) => b >= y && a <= y + 10).map((e) => e[2]);
    const seg = D.segments[D.src[i0]];
    $("#story").innerHTML = `
      <h4>${y}年1月、${p.age}歳で始めた人生 <span class="badge ${x.success ? "ok" : "ng"}">${x.success ? "✓ 最後まで持った" : "✕ 途中で尽きた"}</span></h4>
      <div>FIREは<b>${ageTxt(x.fireAge)}</b>（${y + Math.floor(x.fireAge - p.age)}年）、${x.depAge !== null ? `資産は<b>${ageTxt(x.depAge)}</b>で尽きました` : `${p.endAge}歳の資産は<b>${man(x.final)}</b>`}。
      始めてから10年間の実質リターンは<b>年${(r10 * 100).toFixed(1)}%</b>${ep.length ? `（${ep.join("、")}）` : ""}。データは「${seg.name}」です。</div>
      <div class="year-nav"><button id="prevY" aria-label="前の年">◀</button><input type="range" id="yearRange" min="${ys[0]}" max="${ys[ys.length - 1]}" value="${y}" aria-label="開始年"><button id="nextY" aria-label="次の年">▶</button></div>`;
    const go = (ny) => { if (byYear.has(ny)) { selYear = ny; renderHistory(); } };
    $("#prevY").onclick = () => go(selYear - 1);
    $("#nextY").onclick = () => go(selYear + 1);
    $("#yearRange").oninput = (e) => go(+e.target.value);

    const r = x.rec;
    const ages = Array.from(r, (_, k) => p.age + k);
    const yr = Array.from(r);
    const vl = [];
    if (x.fireAge !== null) vl.push({ x: x.fireAge, label: `FIRE ${ageTxt(x.fireAge)}` });
    if (x.depAge !== null) vl.push({ x: x.depAge, label: `尽きる ${ageTxt(x.depAge)}`, color: cssVar("--crit"), row: 1 });
    const med = R.band.v[3];
    C.mount($("#pathChart"), () => C.lines($("#pathChart"), {
      x: ages, x0: ages[0], x1: ages[ages.length - 1], y0: 0,
      y1: Math.max(R.target * 1.3, ...yr) * 1.05, height: 300, fmtY: axisMan, fmtX: (a) => a + "歳",
      series: [
        { y: med.length === yr.length ? Array.from(med) : yr.map(() => null), color: cssVar("--axis"), width: 2 },
        { y: yr, color: cssVar("--s1"), width: 2.5 },
      ],
      refs: [{ y: R.target, color: cssVar("--s2"), label: `目標 ${man(R.target)}` }],
      vlines: vl, aria: `${y}年に始めた場合の資産`,
      tooltip: (i) => `<div class="tt-h">${ages[i]}歳（${y + i}年）</div>
        <div class="tt-r"><span class="tt-k"><i style="background:${cssVar("--s1")}"></i>${y}年開始</span><b>${man(yr[i])}</b></div>
        <div class="tt-r"><span class="tt-k"><i style="background:${cssVar("--axis")}"></i>全体の中央値</span><b>${man(med[i])}</b></div>`,
    }));
    $("#pathChart").insertAdjacentHTML("afterbegin", `<div class="legend"><span><i class="line" style="background:${cssVar("--s1")}"></i>${y}年に始めた場合</span><span><i class="line" style="background:${cssVar("--axis")}"></i>全シナリオの中央値（${R.usedMethod === "hist" ? "歴史" : "選んだ前提"}）</span><span><i class="line" style="background:${cssVar("--s2")}"></i>目標額</span></div>`);
  }

  // 感度分析
  function renderSens() {
    const p = R.p;
    const key = JSON.stringify(p);
    const box = $("#sensGrid");
    const rows = [0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3];
    const isT = p.fireMode === "target";
    const cols = isT ? [3, 3.5, 4, 4.5, 5] : [-6, -4, -2, 0, 2, 4, 6].map((d) => p.fireAge + d).filter((a) => a > p.age && a < p.endAge);
    $("#sensCap").textContent = `生活費と${isT ? "取り崩し率（目標額の基準）" : "FIREする年齢"}を変えたときの、資産が持つ確率${isT ? "（大きい数字）とFIREの年齢の中央値（小さい数字）" : ""}。今の条件は枠で囲んでいます。`;
    if (sensCache && sensKey === key) return drawSens(sensCache, rows, cols, isT);
    sensKey = key;
    box.innerHTML = `<div class="loading">計算中…</div>`;
    const out = [];
    let r = 0;
    const step = () => {
      if (sensKey !== key) return;
      out.push(E.sensitivity(D, p, [rows[r]], cols, isT ? "swr" : "age")[0]);
      r++;
      drawSens(out, rows, cols, isT);
      if (r < rows.length) setTimeout(step, 0);
      else sensCache = out;
    };
    setTimeout(step, 30);
  }
  function rampColor(s) {
    const ramp = ["#cde2fb", "#b7d3f6", "#9ec5f4", "#86b6ef", "#6da7ec", "#5598e7", "#3987e5", "#2a78d6", "#256abf", "#1c5cab", "#184f95", "#104281", "#0d366b"];
    const t = Math.max(0, Math.min(1, (s - 0.5) / 0.5));
    const k = Math.round(t * (ramp.length - 1));
    return [ramp[k], k >= 6 ? "#ffffff" : "#0b0b0b"];
  }
  let sensSel = null;
  const shortMan = (v) => (v >= 10000 ? (+(v / 10000).toFixed(v >= 100000 ? 0 : 1)) + "億" : nf.format(Math.round(v / 100) * 100) + "万");
  function drawSens(out, rows, cols, isT) {
    const p = R.p;
    const curJ = cols.findIndex((cv) => (isT ? cv === p.swr : cv === p.fireAge));
    const curI = rows.indexOf(1);
    if (!sensSel || sensSel.key !== sensKey) sensSel = { key: sensKey, i: curI, j: curJ >= 0 ? curJ : Math.floor(cols.length / 2) };
    let h = `<table><thead><tr><th class="corner"><span class="c-long">生活費 ＼ ${isT ? "取り崩し率" : "FIRE年齢"}</span><span class="c-short">月の生活費</span></th>${cols.map((c) => `<th>${isT ? `${c}%<small>${shortMan(p.expense * 12 / (c / 100))}</small>` : c + "歳"}</th>`).join("")}</tr></thead><tbody>`;
    rows.forEach((rv, i) => {
      h += `<tr><th>${(+(p.expense * rv).toFixed(1)).toLocaleString()}万<small>${rv === 1 ? "今" : (rv > 1 ? "+" : "−") + Math.abs(Math.round((rv - 1) * 100)) + "%"}</small></th>`;
      cols.forEach((cv, j) => {
        const c = out[i] && out[i][j];
        const cls = [i === curI && j === curJ ? "cur" : "", i === sensSel.i && j === sensSel.j ? "sel" : ""].join(" ");
        if (!c) { h += `<td class="${cls}" style="background:var(--surface-2)"></td>`; return; }
        const [bg, fg] = rampColor(c.success);
        h += `<td class="${cls}" data-i="${i}" data-j="${j}" style="background:${bg};color:${fg}" tabindex="0" role="button" aria-label="生活費 月${(+(p.expense * rv).toFixed(1))}万円・${isT ? `取り崩し率${cv}%` : `${cv}歳でFIRE`}: ${pct(c.success)}">${Math.round(c.success * 100)}<span class="pc">%</span>${isT ? `<small>${c.fireAge ? Math.floor(c.fireAge + 1e-9) + "歳" : "—"}</small>` : ""}</td>`;
      });
      h += `</tr>`;
    });
    h += `</tbody></table><div class="scale"><span>50%以下</span><i style="background:linear-gradient(90deg,#cde2fb,#5598e7,#0d366b)"></i><span>100%</span></div>`;
    const g = $("#sensGrid");
    g.innerHTML = h;
    const pick = (td) => { sensSel.i = +td.dataset.i; sensSel.j = +td.dataset.j; drawSens(out, rows, cols, isT); };
    $$("td[data-i]", g).forEach((td) => {
      td.addEventListener("click", () => pick(td));
      td.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(td); } });
    });
    sensDetailFor(out, rows, cols, isT, curI, curJ);
  }
  function sensDetailFor(out, rows, cols, isT, curI, curJ) {
    const p = R.p, box = $("#sensDetail");
    const { i, j } = sensSel;
    const c = out[i] && out[i][j];
    if (!c) { box.innerHTML = ""; return; }
    const exp = +(p.expense * rows[i]).toFixed(1), cv = cols[j];
    const base = out[curI] && curJ >= 0 && out[curI][curJ];
    const isCur = i === curI && j === curJ;
    const diff = base && !isCur ? Math.round((c.success - base.success) * 100) : null;
    const tgt = isT ? E.target({ ...p, expense: exp, swr: cv, targetAuto: true }, c.fireAge || p.age) : null;
    const dAge = base && !isCur && c.fireAge && base.fireAge ? Math.round(c.fireAge - base.fireAge) : null;
    box.innerHTML = `
      <div class="sd-head">${isCur ? "今の条件" : "タップした条件"}</div>
      <div class="sd-cond">生活費 <b>月${exp.toLocaleString()}万円</b> × ${isT ? `取り崩し率 <b>${cv}%</b>（目標額 ${man(tgt)}）` : `<b>${cv}歳</b>でFIRE`}</div>
      <div class="sd-stats">
        <div><small>資産が持つ確率</small><strong>${pct(c.success)}</strong>${diff !== null ? `<em class="${diff >= 0 ? "up" : "down"}">今の条件より ${diff >= 0 ? "+" : "−"}${Math.abs(diff)}pt</em>` : ""}</div>
        ${isT ? `<div><small>FIREの年齢（中央値）</small><strong>${ageTxt(c.fireAge)}</strong>${dAge !== null ? `<em>今の条件より ${dAge >= 0 ? "+" : "−"}${Math.abs(dAge)}年</em>` : ""}</div>` : ""}
      </div>
      ${isCur ? "" : `<button class="apply-btn" id="sensApply">この条件にする</button>`}`;
    const ap = $("#sensApply");
    if (ap) ap.onclick = () => {
      S.expense = exp;
      if (isT) { S.swr = cv; S.targetManual = false; } else S.fireAge = cv;
      syncAll(); changed();
      toast("条件を変えました");
      window.scrollTo({ top: 0, behavior: "smooth" });
    };
  }

  // 年表
  let tableRows = [];
  function renderTable() {
    const p = R.p;
    // 最後の資産が中央値に最も近いシナリオを選び、明細つきで回し直す
    let best = 0, bd = Infinity;
    R.paths.forEach((x, i) => { const d = Math.abs(x.final - R.final.p50); if (d < bd) { bd = d; best = i; } });
    const months = R.months;
    const scs = E.scenarios(D, { ...p, method: R.usedMethod }, months);
    const one = E.runPath(scs[best], p, { detail: true });
    const v = R.band.v;
    const head = `<thead><tr><th>年齢</th><th>状態</th>
      <th class="c-r">下位10%</th><th class="c-r">中央値</th><th class="c-r">上位10%</th>
      <th class="c-f grp">積立</th><th class="c-f">取り崩し</th><th class="c-f">年金・<br class="sp">副収入</th><th class="c-f">税金</th>
      <th class="c-a grp">NISA</th><th class="c-a">特定口座</th><th class="c-a">合計</th></tr></thead>`;
    tableRows = [];
    let body = "";
    const every5 = $("#every5").checked;
    one.detail.forEach((d, k) => {
      const age = d.age;
      const fired = one.fireT >= 0 && Math.floor(one.fireT / 12) === k;
      const dep = one.depT >= 0 && Math.floor(one.depT / 12) <= k;
      const row = [age, dep ? "尽きた" : d.retired ? "FIRE" : "働く", v[1][k], v[3][k], v[5][k], d.contrib, d.withdraw, d.income, d.tax, d.nisa, d.taxable, d.end];
      tableRows.push(row);
      // 5年ごと表示でも、FIRE の年・年金開始の年・最後の年は残す
      if (every5 && (age - p.age) % 5 !== 0 && !fired && age !== p.pensionAge && k !== one.detail.length - 1) return;
      const st = dep ? `<span class="state d">尽きた</span>` : d.retired || fired ? `<span class="state f">FIRE</span>` : `<span class="state">働く</span>`;
      const f = (x) => nf.format(Math.round(x));
      body += `<tr class="${fired ? "fire" : ""} ${age === p.pensionAge ? "pen" : ""}"><td>${age}歳</td><td>${st}</td>
        <td class="c-r">${f(v[1][k])}</td><td class="c-r"><b>${f(v[3][k])}</b></td><td class="c-r">${f(v[5][k])}</td>
        <td class="c-f grp">${d.contrib ? f(d.contrib) : ""}</td><td class="c-f">${d.withdraw ? f(d.withdraw) : ""}</td><td class="c-f">${d.income ? f(d.income) : ""}</td><td class="c-f">${d.tax >= 0.5 ? f(d.tax) : ""}</td>
        <td class="c-a grp">${f(d.nisa)}</td><td class="c-a">${f(d.taxable)}</td><td class="c-a"><b>${f(d.end)}</b></td></tr>`;
    });
    $("#yTable").innerHTML = head + `<tbody>${body}</tbody>`;
    $("#yTable").dataset.view = tview;
  }
  let tview = "r";
  $("#tview").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    tview = b.dataset.v;
    $$("#tview button").forEach((x) => x.classList.toggle("on", x === b));
    $("#yTable").dataset.view = tview;
  });
  $("#every5").addEventListener("change", renderTable);
  $("#csvBtn").addEventListener("click", () => {
    const head = ["年齢", "状態", "下位10%", "中央値", "上位10%", "積立", "取り崩し", "年金・副収入", "税金", "NISA", "特定口座", "合計"];
    const csv = "﻿" + [head, ...tableRows.map((r) => r.map((x, i) => (i < 2 ? x : Math.round(x))))].map((r) => r.join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = "fire_simulation.csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  // データ
  let idxMode = "real";
  $("#idxSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    idxMode = b.dataset.v;
    $$("#idxSeg button").forEach((x) => x.classList.toggle("on", x === b));
    renderData();
  });
  let dataDrawn = false;
  function renderData() {
    const [y0, m0] = D.start.split("-").map(Number);
    const xs = [y0 + (m0 - 1) / 12 - 1 / 12];
    const real = [1], nom = [1];
    for (let i = 0; i < D.r.length; i++) {
      xs.push(y0 + (m0 - 1 + i) / 12);
      nom.push(nom[i] * (1 + D.r[i]));
      real.push(real[i] * (1 + D.r[i]) / (1 + D.inf[i]));
    }
    // 1年ごとに間引く（描画を軽く）
    const keep = xs.map((_, i) => i % 3 === 0 || i === xs.length - 1);
    const X = xs.filter((_, i) => keep[i]);
    const Y = (idxMode === "real" ? real : nom).filter((_, i) => keep[i]);
    const spans = D.segments.map((s, k) => {
      const [a, am] = s.from.split("-").map(Number), [b, bm] = s.to.split("-").map(Number);
      return { x0: a + (am - 1) / 12, x1: b + bm / 12, fill: k % 2 ? cssVar("--band-1") : "transparent", label: s.short };
    });
    const lastI = Y.length - 1;
    C.mount($("#idxChart"), () => C.lines($("#idxChart"), {
      x: X, x0: X[0], x1: X[lastI] + 0.5, y0: Math.min(...Y) * 0.8, y1: Math.max(...Y) * 1.4, log: true,
      height: 340, fmtX: (y) => Math.round(y), fmtY: (v) => (v >= 1000 ? nf.format(v) : v >= 1 ? v : v.toString()),
      spans, series: [{ y: Y, color: cssVar("--s1"), width: 1.8 }],
      aria: "指数をつないだ全世界株式の累積リターン",
      tooltip: (i) => {
        const yr = X[i];
        const mi = Math.round((yr - (y0 + (m0 - 1) / 12)) * 12);
        const seg = D.segments[D.src[Math.max(0, Math.min(D.src.length - 1, mi))]];
        const yy = Math.floor(yr + 1e-6), mm = Math.round((yr - yy) * 12) + 1;
        return `<div class="tt-h">${yy}年${mm}月</div><div class="tt-r"><span>${idxMode === "real" ? "実質" : "名目"}の値</span><b>${Y[i] >= 100 ? nf.format(Math.round(Y[i])) : Y[i].toFixed(2)}</b></div><div class="tt-r"><span>データ</span><b>${seg.name}</b></div>`;
      },
    }));
    if (dataDrawn) return;
    dataDrawn = true;
    const ann = D.annual.filter((a) => a[0] > y0 || m0 === 1);
    const ar = ann.map((a) => (1 + a[1]) / (1 + a[2]) - 1);
    C.mount($("#annChart"), () => C.bars($("#annChart"), {
      x: ann.map((a) => a[0]), y: ar, x0: ann[0][0] - 1, x1: ann[ann.length - 1][0] + 1, y0: Math.min(...ar) * 1.1, y1: Math.max(...ar) * 1.1,
      height: 240, gap: 1, maxBar: 8, fmtY: (v) => Math.round(v * 100) + "%", fmtX: (y) => y,
      color: (i) => (ar[i] >= 0 ? cssVar("--s1") : cssVar("--crit")),
      aria: "年ごとの実質リターン",
      tooltip: (i) => `<div class="tt-h">${ann[i][0]}年</div><div class="tt-r"><span>実質リターン</span><b>${(ar[i] * 100).toFixed(1)}%</b></div><div class="tt-r"><span>名目リターン</span><b>${(ann[i][1] * 100).toFixed(1)}%</b></div><div class="tt-r"><span>物価上昇</span><b>${(ann[i][2] * 100).toFixed(1)}%</b></div><div class="tt-r"><span>データ</span><b>${D.segments[ann[i][3]].name}</b></div>`,
    }));
    const segStats = D.segments.map((s) => {
      const a = E.monthIndex(D, s.from), b = E.monthIndex(D, s.to);
      let gn = 1, gr = 1;
      for (let i = a; i <= b; i++) { gn *= 1 + D.r[i]; gr *= (1 + D.r[i]) / (1 + D.inf[i]); }
      const n = b - a + 1;
      return [Math.pow(gn, 12 / n) - 1, Math.pow(gr, 12 / n) - 1];
    });
    $("#segTable").innerHTML = `<thead><tr><th class="l">期間</th><th class="l">使ったデータ</th><th>名目 年率</th><th>実質 年率</th><th class="l">メモ</th></tr></thead><tbody>` +
      D.segments.map((s, k) => `<tr><td class="l">${s.from.replace("-", "/")}〜${s.to.replace("-", "/")}</td><td class="l"><b>${s.name}</b></td><td>${(segStats[k][0] * 100).toFixed(1)}%</td><td>${(segStats[k][1] * 100).toFixed(1)}%</td><td class="l">${s.note}</td></tr>`).join("") + "</tbody>";
  }

  // ---------- ヘッダーの操作 ----------
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg; t.classList.add("show");
    setTimeout(() => t.classList.remove("show"), 1800);
  }
  $("#shareBtn").addEventListener("click", async () => {
    const hash = btoa(unescape(encodeURIComponent(JSON.stringify(S))));
    const url = location.origin + location.pathname + "#" + hash;
    try { await navigator.clipboard.writeText(url); toast("この条件のリンクをコピーしました"); }
    catch (e) { history.replaceState(null, "", "#" + hash); toast("アドレスバーのURLを共有してください"); }
  });
  $("#resetBtn").addEventListener("click", () => {
    S = Object.assign({}, DEFAULTS, { events: DEFAULTS.events.map((e) => ({ ...e })) });
    syncAll(); changed();
    toast("初期値に戻しました");
  });
  const THEME = "firesim-theme";
  function applyTheme(t) {
    if (t) document.documentElement.setAttribute("data-theme", t);
    else document.documentElement.removeAttribute("data-theme");
  }
  try { applyTheme(localStorage.getItem(THEME)); } catch (e) { /* なし */ }
  $("#themeBtn").addEventListener("click", () => {
    const dark = document.documentElement.getAttribute("data-theme") === "dark" ||
      (!document.documentElement.getAttribute("data-theme") && matchMedia("(prefers-color-scheme: dark)").matches);
    const t = dark ? "light" : "dark";
    applyTheme(t);
    try { localStorage.setItem(THEME, t); } catch (e) { /* なし */ }
    dataDrawn = false;
    renderSummary(); renderTab();
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { dataDrawn = false; renderSummary(); renderTab(); });

  const [ey, em] = D.end.split("-");
  $("#navText").textContent = `相場データ ${ey}年${+em}月まで`;

  // スマホ：結果と入力を行き来する浮きボタン
  const fab = $("#fab"), fabText = $("#fabText");
  let inputsInView = false;
  if ("IntersectionObserver" in window) {
    new IntersectionObserver((es) => {
      inputsInView = es[0].isIntersecting;
      fabText.textContent = inputsInView ? "結果を見る" : "条件を変える";
    }, { rootMargin: "-40% 0px -40% 0px" }).observe($("#inputs"));
  }
  fab.addEventListener("click", () => {
    if (inputsInView) window.scrollTo({ top: 0, behavior: "smooth" });
    else $("#inputs").scrollIntoView({ behavior: "smooth", block: "start" });
  });

  buildFields();
  syncAll();
  run();
})();
