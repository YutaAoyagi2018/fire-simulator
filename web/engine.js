/* FIRE シミュレーションのエンジン（画面に依存しない。Node でも動く）
 *
 * 金額の単位は「万円」。入力はすべて「今の価値（実質）」で受け取り、
 * 内部では物価を掛けた名目額で動かす（NISA の枠と税金は名目で効くため）。
 * 結果は再び今の価値に直して返す。
 */
(function (root) {
  "use strict";

  const TAX = 0.20315; // 譲渡益課税（所得税＋復興税＋住民税）

  // ---------- 乱数 ----------
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function gauss(rand) {
    let u = 0, v = 0;
    while (u === 0) u = rand();
    while (v === 0) v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  // ---------- データ ----------
  function monthIndex(data, ym) {
    const [y0, m0] = data.start.split("-").map(Number);
    const [y, m] = ym.split("-").map(Number);
    return (y - y0) * 12 + (m - m0);
  }
  function labelOf(data, i) {
    const [y0, m0] = data.start.split("-").map(Number);
    const k = y0 * 12 + (m0 - 1) + i;
    return `${Math.floor(k / 12)}-${String((k % 12) + 1).padStart(2, "0")}`;
  }

  const PERIODS = {
    all: { from: null, label: "1871年〜（約155年）" },
    "1973": { from: "1973-02", label: "1973年〜（変動相場制・円建て）" },
    "1990": { from: "1990-07", label: "1990年〜（先進国株）" },
  };

  function slice(data, period) {
    const from = PERIODS[period] && PERIODS[period].from ? monthIndex(data, PERIODS[period].from) : 0;
    return { r: data.r.slice(from), inf: data.inf.slice(from), offset: from };
  }

  // ---------- シナリオ（リターンの並び）を作る ----------
  // 返り値: [{ r: Float64Array, inf: Float64Array, start: "YYYY-MM" | null }]
  function scenarios(data, p, months) {
    const out = [];
    if (p.method === "hist") {
      const s = slice(data, p.period);
      const step = p.histStep || 1;
      for (let i = 0; i + months <= s.r.length; i += step) {
        out.push({
          r: Float64Array.from(s.r.slice(i, i + months)),
          inf: Float64Array.from(s.inf.slice(i, i + months)),
          start: labelOf(data, s.offset + i),
        });
      }
      return out;
    }
    const rand = mulberry32(p.seed || 20261110);
    const n = p.nPaths || 2000;
    if (p.method === "boot") {
      const s = slice(data, p.period);
      const L = s.r.length;
      const block = Math.min(p.block || 36, L);
      for (let k = 0; k < n; k++) {
        const r = new Float64Array(months), inf = new Float64Array(months);
        let t = 0;
        while (t < months) {
          const st = Math.floor(rand() * (L - block + 1));
          for (let j = 0; j < block && t < months; j++, t++) {
            r[t] = s.r[st + j];
            inf[t] = s.inf[st + j];
          }
        }
        out.push({ r, inf, start: null });
      }
      return out;
    }
    // param: 対数正規（実質の幾何平均 mu, 年率ボラ sigma, 物価は一定）
    const mu = Math.log(1 + p.mu / 100) / 12;
    const sd = p.sigma / 100 / Math.sqrt(12);
    const im = Math.pow(1 + p.infl / 100, 1 / 12) - 1;
    for (let k = 0; k < n; k++) {
      const r = new Float64Array(months), inf = new Float64Array(months);
      for (let t = 0; t < months; t++) {
        // mu を幾何平均として扱うため、ドリフトの補正（−σ²/2）は加えない
        const real = Math.exp(mu + sd * gauss(rand)) - 1;
        r[t] = (1 + real) * (1 + im) - 1;
        inf[t] = im;
      }
      out.push({ r, inf, start: null });
    }
    return out;
  }

  // ---------- 1本の人生 ----------
  function target(p) {
    if (!p.targetAuto) return p.target;
    const need = Math.max(0, p.expense - p.sideIncome) * 12; // 年金は含めない（保守的）
    return need / (p.swr / 100);
  }

  function runPath(sc, p, opt) {
    const months = sc.r.length;
    const years = Math.floor(months / 12);
    const rec = new Float32Array(years + 1); // 各年齢の期首（今の価値）
    const spend = opt.detail ? new Float32Array(years + 1) : null;
    const detail = opt.detail ? [] : null;
    const tgt = target(p);
    const useTax = p.tax;
    const lifeCap = p.nisaLife, yearCap = p.nisaAnnual;

    let nisaV = p.nisa, nisaB = Math.min(p.nisaBasis, p.nisa > 0 ? p.nisaBasis : 0);
    let taxV = p.taxable, taxB = Math.min(p.taxableBasis, p.taxable);
    let nisaYear = 0, cpi = 1;
    let retired = false, fireT = -1, depT = -1, fireReal = 0;
    let spendFactor = 1, initWR = 0, minSpend = 1, pctMonthly = 0;
    let taxPaid = 0, contribTotal = 0, withdrawTotal = 0;
    let yrContrib = 0, yrWithdraw = 0, yrTax = 0, yrIncome = 0;

    const evAt = new Map();
    for (const e of p.events || []) {
      if (!e || !isFinite(e.age) || !isFinite(e.amount) || e.amount === 0) continue;
      const t = Math.round((e.age - p.age) * 12);
      if (t >= 0 && t < months) evAt.set(t, (evAt.get(t) || 0) + e.amount);
    }

    // 名目額 amt を引き出す。足りなければ false
    function withdraw(amt) {
      if (amt <= 0) return true;
      // 1) 課税口座から（NISA を長く非課税で育てるため）
      if (taxV > 1e-9) {
        const gainRatio = useTax ? Math.max(0, 1 - taxB / taxV) : 0;
        const net = taxV * (1 - TAX * gainRatio);
        if (net >= amt) {
          const gross = amt / (1 - TAX * gainRatio);
          const tax = gross - amt;
          taxB *= 1 - gross / taxV;
          taxV -= gross;
          taxPaid += tax / cpi; yrTax += tax / cpi;
          return true;
        }
        const tax = taxV - net;
        taxPaid += tax / cpi; yrTax += tax / cpi;
        amt -= net;
        taxV = 0; taxB = 0;
      }
      // 2) NISA から（非課税）。売った簿価分の生涯枠は戻る
      if (nisaV >= amt) {
        nisaB *= 1 - amt / nisaV;
        nisaV -= amt;
        return true;
      }
      nisaV = 0; nisaB = 0;
      return false;
    }
    function deposit(amt) {
      if (amt <= 0) return;
      const room = Math.max(0, Math.min(yearCap - nisaYear, lifeCap - nisaB));
      const toN = p.useNisa ? Math.min(room, amt) : 0;
      nisaV += toN; nisaB += toN; nisaYear += toN;
      taxV += amt - toN; taxB += amt - toN;
    }

    for (let t = 0; t <= months; t++) {
      const age = p.age + t / 12;
      const total = nisaV + taxV;
      const real = total / cpi;
      if (t % 12 === 0) {
        const y = t / 12;
        rec[y] = real;
        if (detail && y > 0) {
          detail.push({ age: p.age + y - 1, contrib: yrContrib, withdraw: yrWithdraw, tax: yrTax, income: yrIncome, end: real, nisa: nisaV / cpi, taxable: taxV / cpi, retired });
        }
        yrContrib = yrWithdraw = yrTax = yrIncome = 0;
        nisaYear = 0;
      }
      if (t === months) break;

      // --- FIRE の判定（月初）
      if (!retired) {
        const hit = p.fireMode === "target" ? real >= tgt : age >= p.fireAge - 1e-9;
        if (hit || age >= p.maxWorkAge - 1e-9) {
          retired = true;
          fireT = t;
          fireReal = real;
          const inc = (age < p.sideUntil ? p.sideIncome : 0) + (age >= p.pensionAge ? p.pension : 0);
          initWR = real > 0 ? Math.max(0, p.expense - inc) * 12 / real : Infinity;
          if (p.strategy === "percent") pctMonthly = (real * p.pctRate) / 100 / 12;
        }
      }

      // --- 毎年の見直し（FIRE 後の記念月）
      if (retired && t > fireT && (t - fireT) % 12 === 0 && depT < 0) {
        const inc = (age < p.sideUntil ? p.sideIncome : 0) + (age >= p.pensionAge ? p.pension : 0);
        if (p.strategy === "percent") {
          pctMonthly = (real * p.pctRate) / 100 / 12;
        } else if (p.strategy === "guardrail" && real > 0) {
          const wr = Math.max(0, p.expense * spendFactor - inc) * 12 / real;
          if (wr > initWR * 1.2) spendFactor = Math.max(p.floorPct / 100, spendFactor * 0.9);
          else if (wr < initWR * 0.8) spendFactor = Math.min(1, spendFactor * 1.1);
        }
      }

      // --- お金の出入り（今の価値で計算し、名目にして動かす）
      if (!retired) {
        const g = Math.pow(1 + (p.contribGrowth || 0) / 100, Math.floor(t / 12));
        let c = p.monthly * g + (t % 12 === 11 ? p.bonus * g : 0);
        if (c > 0) { deposit(c * cpi); contribTotal += c; yrContrib += c; }
        else if (c < 0) { if (!withdraw(-c * cpi) && depT < 0) depT = t; }
      } else if (depT < 0) {
        const inc = (age < p.sideUntil ? p.sideIncome : 0) + (age >= p.pensionAge ? p.pension : 0);
        yrIncome += inc;
        let out, s;
        if (p.strategy === "percent") {
          out = pctMonthly;
          s = (pctMonthly + inc) / p.expense;
        } else {
          s = spendFactor;
          out = p.expense * spendFactor - inc;
        }
        if (s < minSpend) minSpend = s;
        if (out > 0) {
          if (withdraw(out * cpi)) { withdrawTotal += out; yrWithdraw += out; }
          else depT = t;
        } else if (out < 0) {
          deposit(-out * cpi); yrContrib += -out;
        }
      }

      // --- 一度きりの出入り
      const ev = evAt.get(t);
      if (ev) {
        if (ev > 0) deposit(ev * cpi);
        else if (!withdraw(-ev * cpi) && depT < 0) depT = t;
      }
      if (depT >= 0 && depT === t) { nisaV = 0; taxV = 0; nisaB = 0; taxB = 0; }

      // --- 相場と物価
      nisaV *= 1 + sc.r[t];
      taxV *= 1 + sc.r[t];
      cpi *= 1 + sc.inf[t];
    }

    return {
      rec, fireT, depT, fireReal, minSpend, final: rec[years], start: sc.start,
      taxPaid, contribTotal, withdrawTotal, detail, spend,
    };
  }

  // ---------- まとめ ----------
  function quantile(sorted, q) {
    if (!sorted.length) return NaN;
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  function simulate(data, p, opt = {}) {
    const months = Math.round((p.endAge - p.age) * 12);
    if (months < 12) return { error: "終わりの年齢は今の年齢より1年以上あとにしてください" };
    let usedMethod = p.method;
    let scs = scenarios(data, p, months);
    let note = null;
    if (!scs.length) {
      note = "選んだ期間が短く、歴史シナリオを1本も作れないため、同じ期間のブロック・ブートストラップに切り替えました";
      usedMethod = "boot";
      scs = scenarios(data, { ...p, method: "boot" }, months);
    }
    const paths = scs.map((sc) => runPath(sc, p, opt));
    const years = Math.floor(months / 12);
    const n = paths.length;

    const qs = [0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95];
    const band = qs.map(() => new Float64Array(years + 1));
    const col = new Float64Array(n);
    for (let y = 0; y <= years; y++) {
      for (let i = 0; i < n; i++) col[i] = paths[i].rec[y];
      const s = Array.from(col).sort((a, b) => a - b);
      qs.forEach((q, k) => (band[k][y] = quantile(s, q)));
    }

    const floor = p.strategy === "percent" ? p.floorPct / 100 - 1e-9 : 0;
    let ok = 0, fired = 0;
    const fireAges = [];
    const earlyMax = p.maxWorkAge;
    let reachedEarly = 0;
    for (const x of paths) {
      x.success = x.depT < 0 && x.minSpend >= floor;
      if (x.success) ok++;
      if (x.fireT >= 0) {
        fired++;
        const a = p.age + x.fireT / 12;
        x.fireAge = a;
        fireAges.push(a);
        if (a < earlyMax - 1e-9) reachedEarly++;
      } else x.fireAge = null;
      x.depAge = x.depT >= 0 ? p.age + x.depT / 12 : null;
    }
    fireAges.sort((a, b) => a - b);
    const finals = paths.map((x) => x.final).sort((a, b) => a - b);
    const minSp = paths.map((x) => x.minSpend).sort((a, b) => a - b);

    return {
      p, usedMethod, note, n, years, months,
      ages: Array.from({ length: years + 1 }, (_, y) => p.age + y),
      band: { q: qs, v: band },
      success: ok / n,
      fireRate: fired / n,
      earlyRate: reachedEarly / n,
      fireAge: fired ? { p10: quantile(fireAges, 0.1), p50: quantile(fireAges, 0.5), p90: quantile(fireAges, 0.9) } : null,
      fireAges,
      final: { p10: quantile(finals, 0.1), p50: quantile(finals, 0.5), p90: quantile(finals, 0.9) },
      minSpend: { p10: quantile(minSp, 0.1), p50: quantile(minSp, 0.5) },
      target: target(p),
      paths,
    };
  }

  // 生活費 × FIRE条件 の格子で成功率と FIRE 年齢の中央値を出す（重いので軽量版で回す）
  function sensitivity(data, p, rows, cols, colKey) {
    const out = [];
    for (const rv of rows) {
      const line = [];
      for (const cv of cols) {
        const q = { ...p, expense: p.expense * rv, nPaths: Math.min(p.nPaths || 2000, 600), histStep: p.method === "hist" ? 3 : 1 };
        if (colKey === "swr") { q.targetAuto = true; q.swr = cv; }
        else q.fireAge = cv;
        const res = simulate(data, q);
        line.push({ success: res.success, fireAge: res.fireAge ? res.fireAge.p50 : null });
      }
      out.push(line);
    }
    return out;
  }

  // 一定の年率で増えたときの到達年齢（目安の直線）
  function deterministic(p, realRate) {
    const tgt = target(p);
    let v = p.nisa + p.taxable;
    const m = Math.pow(1 + realRate, 1 / 12) - 1;
    for (let t = 0; t < (p.maxWorkAge - p.age) * 12; t++) {
      if (v >= tgt) return p.age + t / 12;
      const g = Math.pow(1 + (p.contribGrowth || 0) / 100, Math.floor(t / 12));
      v = v * (1 + m) + p.monthly * g + (t % 12 === 11 ? p.bonus * g : 0);
    }
    return null;
  }

  const api = { simulate, sensitivity, runPath, scenarios, target, deterministic, PERIODS, monthIndex, labelOf, quantile, TAX };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.FireEngine = api;
})(typeof window !== "undefined" ? window : globalThis);
