/* 小さな SVG チャート部品（依存なし）。ホバーで十字線とツールチップを出す。 */
(function (root) {
  "use strict";
  const NS = "http://www.w3.org/2000/svg";
  const tip = () => document.getElementById("tooltip");

  function niceStep(span, n) {
    const raw = span / Math.max(1, n);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / mag;
    return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag;
  }
  function ticks(min, max, n) {
    if (max <= min) max = min + 1;
    const st = niceStep(max - min, n);
    const out = [];
    for (let v = Math.ceil(min / st) * st; v <= max + st * 1e-9; v += st) out.push(+v.toFixed(10));
    return out;
  }
  function logTicks(min, max) {
    const out = [];
    const lo = Math.floor(Math.log10(min)), hi = Math.ceil(Math.log10(max));
    const span = hi - lo;
    const mults = span <= 2 ? [1, 2, 5] : span <= 5 ? [1, 3] : [1];
    const every = span > 9 ? Math.ceil(span / 8) : 1;
    for (let e = lo; e <= hi; e++) {
      if ((e - lo) % every) continue;
      for (const m of mults) {
        const v = m * Math.pow(10, e);
        if (v >= min * 0.999 && v <= max * 1.001) out.push(v);
      }
    }
    return out;
  }

  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) if (attrs[k] !== undefined && attrs[k] !== null) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  function showTip(html, cx, cy) {
    const t = tip();
    t.innerHTML = html;
    t.classList.add("show");
    const w = t.offsetWidth, h = t.offsetHeight;
    let x = cx + 16, y = cy - h - 12;
    if (x + w > window.innerWidth - 8) x = cx - w - 16;
    if (y < 8) y = cy + 16;
    t.style.left = x + "px";
    t.style.top = y + "px";
  }
  function hideTip() { tip().classList.remove("show"); }

  // ---------- 汎用の器（軸・スケール） ----------
  function frame(host, o) {
    host.innerHTML = "";
    const W = Math.max(280, host.clientWidth || 600);
    const H = o.height || 340;
    const m = Object.assign({ t: 14, r: 18, b: 30, l: 58 }, o.margin || {});
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, height: H, role: "img", "aria-label": o.aria || "" }, host);
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const xs = (v) => m.l + ((v - o.x0) / (o.x1 - o.x0 || 1)) * iw;
    let ys;
    if (o.log) {
      const a = Math.log10(o.y0), b = Math.log10(o.y1);
      ys = (v) => m.t + ih - ((Math.log10(Math.max(v, o.y0)) - a) / (b - a || 1)) * ih;
    } else {
      ys = (v) => m.t + ih - ((v - o.y0) / (o.y1 - o.y0 || 1)) * ih;
    }
    const ax = el("g", { class: "ax" }, svg);
    const yt = o.yTicks || (o.log ? logTicks(o.y0, o.y1) : ticks(o.y0, o.y1, Math.max(3, Math.round(ih / 60))));
    for (const v of yt) {
      const y = ys(v);
      el("line", { x1: m.l, x2: W - m.r, y1: y, y2: y, class: v === 0 && !o.log ? "base" : "grid" }, ax);
      const t = el("text", { x: m.l - 8, y: y + 4, "text-anchor": "end" }, ax);
      t.textContent = o.fmtY ? o.fmtY(v) : v;
    }
    if (!o.log && o.y0 !== 0) el("line", { x1: m.l, x2: W - m.r, y1: m.t + ih, y2: m.t + ih, class: "base" }, ax);
    const xt = o.xTicks || ticks(o.x0, o.x1, Math.max(3, Math.round(iw / 80)));
    for (const v of xt) {
      const x = xs(v);
      if (x < m.l - 1 || x > W - m.r + 1) continue;
      const t = el("text", { x, y: H - m.b + 18, "text-anchor": "middle" }, ax);
      t.textContent = o.fmtX ? o.fmtX(v) : v;
    }
    const clipId = "c" + Math.random().toString(36).slice(2);
    const defs = el("defs", {}, svg);
    const cp = el("clipPath", { id: clipId }, defs);
    el("rect", { x: m.l, y: m.t - 2, width: iw, height: ih + 2 }, cp);
    const plot = el("g", { "clip-path": `url(#${clipId})` }, svg);
    return { svg, plot, W, H, m, iw, ih, xs, ys };
  }

  function pathOf(xs, ys, X, Y) {
    let d = "";
    for (let i = 0; i < X.length; i++) d += (i ? "L" : "M") + xs(X[i]).toFixed(1) + "," + ys(Y[i]).toFixed(1);
    return d;
  }
  function areaOf(xs, ys, X, lo, hi) {
    let d = "";
    for (let i = 0; i < X.length; i++) d += (i ? "L" : "M") + xs(X[i]).toFixed(1) + "," + ys(hi[i]).toFixed(1);
    for (let i = X.length - 1; i >= 0; i--) d += "L" + xs(X[i]).toFixed(1) + "," + ys(lo[i]).toFixed(1);
    return d + "Z";
  }

  // 十字線ホバー（x は配列の添字で最も近い点）
  function crosshair(f, X, onMove, dots) {
    const g = el("g", { style: "pointer-events:none" }, f.svg);
    const ln = el("line", { class: "crosshair", y1: f.m.t, y2: f.m.t + f.ih, visibility: "hidden" }, g);
    const dotEls = (dots || []).map((d) => el("circle", { r: 4.5, fill: d.color, class: "hover-dot", visibility: "hidden" }, g));
    const ov = el("rect", { x: f.m.l, y: f.m.t, width: f.iw, height: f.ih, fill: "transparent" }, f.svg);
    function at(evt) {
      const r = f.svg.getBoundingClientRect();
      const sx = ((evt.clientX - r.left) / r.width) * f.W;
      let best = 0, bd = Infinity;
      for (let i = 0; i < X.length; i++) {
        const d = Math.abs(f.xs(X[i]) - sx);
        if (d < bd) { bd = d; best = i; }
      }
      return best;
    }
    function move(evt) {
      const i = at(evt);
      const x = f.xs(X[i]);
      ln.setAttribute("x1", x); ln.setAttribute("x2", x); ln.setAttribute("visibility", "visible");
      (dots || []).forEach((d, k) => {
        const v = d.y[i];
        if (v === null || v === undefined || !isFinite(v)) { dotEls[k].setAttribute("visibility", "hidden"); return; }
        dotEls[k].setAttribute("cx", x); dotEls[k].setAttribute("cy", f.ys(v)); dotEls[k].setAttribute("visibility", "visible");
      });
      showTip(onMove(i), evt.clientX, evt.clientY);
    }
    function leave() {
      ln.setAttribute("visibility", "hidden");
      dotEls.forEach((d) => d.setAttribute("visibility", "hidden"));
      hideTip();
    }
    ov.addEventListener("pointermove", move);
    ov.addEventListener("pointerdown", move);
    ov.addEventListener("pointerleave", leave);
  }

  // ---------- 扇形（パーセンタイルの帯） ----------
  function fan(host, o) {
    const f = frame(host, o);
    for (const b of o.bands) el("path", { d: areaOf(f.xs, f.ys, o.x, b.lo, b.hi), fill: b.fill }, f.plot);
    for (const r of o.refs || []) {
      const y = f.ys(r.y);
      if (y < f.m.t || y > f.m.t + f.ih) continue;
      el("line", { x1: f.m.l, x2: f.m.l + f.iw, y1: y, y2: y, stroke: r.color, "stroke-width": 1.5, opacity: 0.9 }, f.plot);
      const t = el("text", { x: f.m.l + 6, y: y - 6, fill: "var(--ink-2)", "font-size": 11, "font-weight": 600 }, f.svg);
      t.textContent = r.label;
    }
    for (const v of o.vlines || []) {
      const x = f.xs(v.x);
      if (x < f.m.l || x > f.m.l + f.iw) continue;
      el("line", { x1: x, x2: x, y1: f.m.t, y2: f.m.t + f.ih, stroke: v.color || "var(--axis)", "stroke-width": 1 }, f.svg);
      const anchor = x > f.m.l + f.iw - 80 ? "end" : "start";
      const t = el("text", { x: x + (anchor === "end" ? -5 : 5), y: f.m.t + 12 + (v.row || 0) * 14, fill: "var(--ink-2)", "font-size": 11, "text-anchor": anchor }, f.svg);
      t.textContent = v.label;
    }
    for (const s of o.lines || []) {
      el("path", { d: pathOf(f.xs, f.ys, o.x, s.y), fill: "none", stroke: s.color, "stroke-width": s.width || 2, "stroke-linejoin": "round", "stroke-linecap": "round", opacity: s.opacity || 1 }, f.plot);
    }
    if (o.endLabel) {
      const i = o.x.length - 1, s = o.lines[0];
      const y = Math.max(f.m.t + 8, Math.min(f.m.t + f.ih - 4, f.ys(s.y[i])));
      el("circle", { cx: f.xs(o.x[i]), cy: y, r: 4, fill: s.color, class: "hover-dot" }, f.svg);
    }
    crosshair(f, o.x, o.tooltip, (o.lines || []).map((s) => ({ y: s.y, color: s.color })));
    return f;
  }

  // ---------- 縦棒 ----------
  function bars(host, o) {
    const f = frame(host, o);
    const n = o.x.length;
    const slot = f.iw / Math.max(1, (o.x1 - o.x0) / (o.unit || 1));
    // 狭い画面で棒が細くなりすぎるときは、すき間をなくして面として見せる
    const gap = slot < 4 ? 0 : o.gap === undefined ? 2 : o.gap;
    const bw = Math.max(slot < 4 ? slot + 0.3 : 1.5, Math.min(o.maxBar || 24, slot - gap));
    const zero = f.ys(Math.max(o.y0, 0));
    const rects = [];
    for (let i = 0; i < n; i++) {
      const v = o.y[i];
      if (v === null || v === undefined) { rects.push(null); continue; }
      const cx = f.xs(o.x[i]);
      const y = f.ys(v);
      const top = Math.min(y, zero), h = Math.max(Math.abs(zero - y), v === 0 ? 0 : 1.5);
      const r = Math.min(4, bw / 2, h);
      // 端だけ丸く、基線側は四角
      const up = v >= 0;
      const x0 = cx - bw / 2, x1 = cx + bw / 2;
      const d = up
        ? `M${x0},${zero}V${top + r}Q${x0},${top} ${x0 + r},${top}H${x1 - r}Q${x1},${top} ${x1},${top + r}V${zero}Z`
        : `M${x0},${zero}V${top + h - r}Q${x0},${top + h} ${x0 + r},${top + h}H${x1 - r}Q${x1},${top + h} ${x1},${top + h - r}V${zero}Z`;
      const p = el("path", { d, fill: o.color(i), opacity: o.selected !== undefined && o.selected !== null && o.selected !== i ? 0.45 : 1 }, f.plot);
      rects.push(p);
    }
    for (const r of o.refs || []) {
      const y = f.ys(r.y);
      el("line", { x1: f.m.l, x2: f.m.l + f.iw, y1: y, y2: y, stroke: r.color, "stroke-width": 1.5 }, f.svg);
      const t = el("text", { x: f.m.l + f.iw, y: y - 6, fill: "var(--ink-2)", "font-size": 11, "text-anchor": "end" }, f.svg);
      t.textContent = r.label;
    }
    // ホバー（棒より広い当たり判定）
    const ov = el("rect", { x: f.m.l, y: f.m.t, width: f.iw, height: f.ih, fill: "transparent", style: o.onClick ? "cursor:pointer" : "" }, f.svg);
    let last = -1;
    function idx(evt) {
      const r = f.svg.getBoundingClientRect();
      const sx = ((evt.clientX - r.left) / r.width) * f.W;
      let best = -1, bd = Infinity;
      for (let i = 0; i < n; i++) {
        if (o.y[i] === null || o.y[i] === undefined) continue;
        const d = Math.abs(f.xs(o.x[i]) - sx);
        if (d < bd) { bd = d; best = i; }
      }
      return bd <= Math.max(slot, 8) ? best : -1;
    }
    ov.addEventListener("pointermove", (evt) => {
      const i = idx(evt);
      if (last >= 0 && rects[last] && last !== i) rects[last].removeAttribute("stroke");
      if (i < 0) { hideTip(); last = -1; return; }
      if (rects[i]) { rects[i].setAttribute("stroke", "var(--ink)"); rects[i].setAttribute("stroke-width", "1.2"); }
      last = i;
      showTip(o.tooltip(i), evt.clientX, evt.clientY);
    });
    ov.addEventListener("pointerleave", () => { if (last >= 0 && rects[last]) rects[last].removeAttribute("stroke"); last = -1; hideTip(); });
    if (o.onClick) ov.addEventListener("click", (evt) => { const i = idx(evt); if (i >= 0) o.onClick(i); });
    return f;
  }

  // ---------- 折れ線（背景の区切り付き） ----------
  function lines(host, o) {
    const f = frame(host, o);
    for (const s of o.spans || []) {
      const x0 = Math.max(f.m.l, f.xs(s.x0)), x1 = Math.min(f.m.l + f.iw, f.xs(s.x1));
      if (x1 <= x0) continue;
      el("rect", { x: x0, y: f.m.t, width: x1 - x0, height: f.ih, fill: s.fill }, f.plot);
      if (x1 - x0 > 26) {
        const t = el("text", { x: (x0 + x1) / 2, y: f.m.t + 14, "text-anchor": "middle", fill: "var(--ink-2)", "font-size": 11, "font-weight": 600 }, f.svg);
        t.textContent = s.label;
      }
    }
    for (const b of o.areas || []) el("path", { d: areaOf(f.xs, f.ys, o.x, b.lo, b.hi), fill: b.fill }, f.plot);
    for (const v of o.vlines || []) {
      const x = f.xs(v.x);
      if (x < f.m.l || x > f.m.l + f.iw) continue;
      el("line", { x1: x, x2: x, y1: f.m.t, y2: f.m.t + f.ih, stroke: v.color || "var(--axis)", "stroke-width": 1 }, f.svg);
      const anchor = x > f.m.l + f.iw - 90 ? "end" : "start";
      const t = el("text", { x: x + (anchor === "end" ? -5 : 5), y: f.m.t + 12 + (v.row || 0) * 14, fill: "var(--ink-2)", "font-size": 11, "text-anchor": anchor }, f.svg);
      t.textContent = v.label;
    }
    for (const r of o.refs || []) {
      const y = f.ys(r.y);
      if (y < f.m.t || y > f.m.t + f.ih) continue;
      el("line", { x1: f.m.l, x2: f.m.l + f.iw, y1: y, y2: y, stroke: r.color, "stroke-width": 1.5 }, f.plot);
      const t = el("text", { x: f.m.l + 6, y: y - 6, fill: "var(--ink-2)", "font-size": 11, "font-weight": 600 }, f.svg);
      t.textContent = r.label;
    }
    for (const s of o.series) {
      el("path", { d: pathOf(f.xs, f.ys, o.x, s.y), fill: "none", stroke: s.color, "stroke-width": s.width || 2, "stroke-linejoin": "round", "stroke-linecap": "round" }, f.plot);
    }
    for (const mk of o.markers || []) {
      el("circle", { cx: f.xs(mk.x), cy: f.ys(mk.y), r: 5, fill: mk.color, class: "hover-dot" }, f.svg);
    }
    crosshair(f, o.x, o.tooltip, o.series.map((s) => ({ y: s.y, color: s.color })));
    return f;
  }

  // ResizeObserver で幅が変わったら描き直す
  const registry = new Map();
  const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver((entries) => {
    for (const e of entries) {
      const fn = registry.get(e.target);
      const w = Math.round(e.contentRect.width);
      if (fn && w > 0 && fn.w !== w) { fn.w = w; fn(); }
    }
  }) : null;
  function mount(host, draw) {
    const fn = () => draw();
    fn.w = host.clientWidth;
    registry.set(host, fn);
    if (ro) ro.observe(host);
    draw();
  }

  root.Charts = { fan, bars, lines, mount, ticks, logTicks, showTip, hideTip };
})(window);
