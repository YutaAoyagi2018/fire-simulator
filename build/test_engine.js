// node build/test_engine.js : エンジンの動作確認
const fs = require("fs"); const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "../web/data.js"), "utf8");
globalThis.window = {}; eval(src); const data = window.FIRE_DATA;
const E = require("../web/engine.js");
const base = { age: 30, endAge: 95, nisa: 500, nisaBasis: 400, taxable: 0, taxableBasis: 0, monthly: 15, bonus: 30, contribGrowth: 0,
  expense: 25, fireMode: "target", fireAge: 50, targetAuto: true, target: 7500, swr: 4, maxWorkAge: 65,
  sideIncome: 0, sideUntil: 60, pensionAge: 65, pension: 12, strategy: "fixed", pctRate: 4, floorPct: 80,
  tax: true, useNisa: true, nisaAnnual: 360, nisaLife: 1800, method: "hist", period: "all", mu: 5, sigma: 16, infl: 2, nPaths: 2000, block: 36, events: [] };
function show(label, q) {
  const t0 = Date.now(); const r = E.simulate(data, { ...base, ...q }); const ms = Date.now() - t0;
  if (r.error) return console.log(label, r.error);
  const f = r.fireAge;
  console.log(`${label.padEnd(26)} n=${r.n} 成功${(r.success*100).toFixed(1)}% FIRE中央${f?f.p50.toFixed(1):"-"} (${f?f.p10.toFixed(1):"-"}〜${f?f.p90.toFixed(1):"-"}) 早期${(r.earlyRate*100).toFixed(0)}% 終了中央${r.final.p50.toFixed(0)}万 目標${r.target.toFixed(0)} ${ms}ms ${r.note||""}`);
  return r;
}
show("歴史・全期間", {});
show("歴史・1973〜", { period: "1973" });
show("歴史・1990〜", { period: "1990" });
show("ブートストラップ・全期間", { method: "boot" });
show("想定利回り 5%/16%", { method: "param" });
show("45歳で辞める", { fireMode: "age", fireAge: 45 });
show("45歳・定率4%", { fireMode: "age", fireAge: 45, strategy: "percent" });
show("45歳・ガードレール", { fireMode: "age", fireAge: 45, strategy: "guardrail" });
show("税なし", { tax: false });
show("NISAなし", { useNisa: false });
const r = show("詳細", { detail: true });
const worst = r.paths.reduce((a, b) => (b.final < a.final ? b : a));
console.log("最悪の開始", worst.start, worst.final.toFixed(0), worst.fireAge, worst.depAge);
const one = E.runPath(E.scenarios(data, { ...base, period: "all" }, 65 * 12)[0], base, { detail: true });
console.log(one.detail.slice(0, 3), one.detail.length);
// 決定論的な確認: 0%リターンで積立のみ
const flat = { r: new Float64Array(120), inf: new Float64Array(120), start: null };
const z = E.runPath(flat, { ...base, nisa: 0, nisaBasis: 0, monthly: 10, bonus: 0, expense: 1000, maxWorkAge: 99, endAge: 40 }, {});
console.log("0%で10年×月10万 =", z.final, "(期待 1200)");
const t0 = Date.now(); E.sensitivity(data, base, [0.8, 1, 1.2], [3, 4, 5], "swr"); console.log("感度3x3", Date.now() - t0, "ms");
// 副収入つきの目標額：副収入が終わる年数で割り引く
{
  const q = { ...base, expense: 25, sideIncome: 10, sideUntil: 60, swr: 4 };
  console.log("目標 副収入なし", E.target({ ...q, sideIncome: 0 }, 45).toFixed(0), "(期待 7500)");
  console.log("目標 45歳・60歳まで副収入10万", E.target(q, 45).toFixed(0), "(期待 約6166)");
  console.log("目標 60歳以降", E.target(q, 60).toFixed(0), "(期待 7500)");
  console.log("目標 一生続く副収入", E.target({ ...q, sideUntil: 200, endAge: 200 }, 45).toFixed(0), "(期待 4500に近い)");
  // 年4%（実質）で増え続ける相場・物価0%で、45歳に目標ちょうどで辞めると、60歳でほぼ 7500 になるはず
  const m = Math.pow(1.04, 1 / 12) - 1, months = 30 * 12;
  const flat4 = { r: new Float64Array(months).fill(m), inf: new Float64Array(months), start: null };
  const t45 = E.target(q, 45);
  const run = E.runPath(flat4, { ...q, age: 45, endAge: 75, nisa: 0, nisaBasis: 0, taxable: t45, taxableBasis: t45, tax: false, useNisa: false, monthly: 0, bonus: 0, pension: 0, fireMode: "target", maxWorkAge: 99 }, {});
  console.log("45歳で目標→60歳の資産", run.rec[15].toFixed(0), "(期待 7500前後。月ごとの取り崩しのぶん少し下振れ) FIRE", run.fireT === 0 ? "即時" : run.fireT);
}
