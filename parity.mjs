#!/usr/bin/env node
/**
 * Fetch the same Binance USD-M 1m klines used by the dashboard, then compare
 * adx.js (browser/Node) against a faithful port of /workspace/adx/scan.py.
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const require = createRequire(import.meta.url);
const AdxAlert = require("./adx.js");
const __dirname = dirname(fileURLToPath(import.meta.url));

const COINS = AdxAlert.COINS;
const LIMIT = 500;
const N = 14;
const cachePath = process.argv[2] || join(__dirname, ".parity-klines.json");

async function fetchKlines(symbol) {
  let err;
  for (let i = 0; i < 8; i++) {
    try {
      const res = await fetch(
        `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1m&limit=${LIMIT}`
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      err = e;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw err;
}

/* Exact scan.py wilder / adx, in JS, closed candles only (drop a still-open last bar). */
function pythonAdx(raw) {
  let k = raw;
  const lastClose = Number(k[k.length - 1][6]);
  if (lastClose >= Date.now()) k = k.slice(0, -1);
  const h = k.map((c) => +c[2]);
  const l = k.map((c) => +c[3]);
  const c_ = k.map((c) => +c[4]);
  const tr = [0];
  const pdm = [0];
  const mdm = [0];
  for (let i = 1; i < k.length; i++) {
    tr.push(Math.max(h[i] - l[i], Math.abs(h[i] - c_[i - 1]), Math.abs(l[i] - c_[i - 1])));
    const up = h[i] - h[i - 1];
    const dn = l[i - 1] - l[i];
    pdm.push(up > dn && up > 0 ? up : 0);
    mdm.push(dn > up && dn > 0 ? dn : 0);
  }
  function wilder(x, n) {
    const out = Array(x.length).fill(null);
    let s = 0;
    for (let i = 1; i <= n; i++) s += x[i];
    out[n] = s;
    for (let i = n + 1; i < x.length; i++) {
      s = s - s / n + x[i];
      out[i] = s;
    }
    return out;
  }
  const a = wilder(tr, N);
  const p = wilder(pdm, N);
  const m = wilder(mdm, N);
  const pdi = Array(k.length).fill(null);
  const mdi = Array(k.length).fill(null);
  const dx = Array(k.length).fill(null);
  for (let i = N; i < k.length; i++) {
    pdi[i] = (100 * p[i]) / a[i];
    mdi[i] = (100 * m[i]) / a[i];
    dx[i] = pdi[i] + mdi[i] ? (100 * Math.abs(pdi[i] - mdi[i])) / (pdi[i] + mdi[i]) : 0;
  }
  const ad = Array(k.length).fill(null);
  ad[2 * N - 1] = dx.slice(N, 2 * N).reduce((s, x) => s + x, 0) / N;
  for (let i = 2 * N; i < k.length; i++) ad[i] = (ad[i - 1] * (N - 1) + dx[i]) / N;
  const sigs = [];
  for (let j = 1; j < ad.length; j++) {
    if (ad[j] == null || ad[j - 1] == null) continue;
    if (ad[j] >= 25 && ad[j] > ad[j - 1]) {
      if (pdi[j] > mdi[j] && (pdi[j - 1] <= mdi[j - 1] || ad[j - 1] < 25)) {
        sigs.push({ index: j, signal: "LONG", close: c_[j], adx: ad[j], pdi: pdi[j], mdi: mdi[j], closeTime: Number(k[j][6]) });
      }
      if (mdi[j] > pdi[j] && (mdi[j - 1] <= pdi[j - 1] || ad[j - 1] < 25)) {
        sigs.push({ index: j, signal: "SHORT", close: c_[j], adx: ad[j], pdi: pdi[j], mdi: mdi[j], closeTime: Number(k[j][6]) });
      }
    }
  }
  return { k, pdi, mdi, ad, sigs };
}

function fmtWib(closeTime) {
  return AdxAlert.formatWib(closeTime).full;
}

async function main() {
  let store;
  if (existsSync(cachePath) && process.argv[2]) {
    store = JSON.parse(readFileSync(cachePath, "utf8"));
  } else {
    store = {};
    for (const s of COINS) {
      store[s] = await fetchKlines(s);
      process.stderr.write(`fetched ${s} ${store[s].length} klines\n`);
    }
    writeFileSync(cachePath, JSON.stringify(store));
  }

  let failed = 0;
  const nearShorts = [];

  for (const s of COINS) {
    const raw = store[s];
    const py = pythonAdx(raw);
    const js = AdxAlert.compute(raw, true);
    const jsSigs = AdxAlert.findSignals(js);

    if (js.klines.length !== py.k.length) {
      console.error(`${s}: closed-candle count mismatch js=${js.klines.length} py=${py.k.length}`);
      failed++;
    }
    const n = Math.min(js.adx.length, py.ad.length);
    let maxDiff = 0;
    for (let i = 0; i < n; i++) {
      if (js.adx[i] == null && py.ad[i] == null) continue;
      maxDiff = Math.max(maxDiff, Math.abs((js.adx[i] ?? NaN) - (py.ad[i] ?? NaN)));
      maxDiff = Math.max(maxDiff, Math.abs((js.pdi[i] ?? NaN) - (py.pdi[i] ?? NaN)));
      maxDiff = Math.max(maxDiff, Math.abs((js.mdi[i] ?? NaN) - (py.mdi[i] ?? NaN)));
    }

    const jsKey = jsSigs.map((x) => `${x.index}:${x.signal}`).join(",");
    const pyKey = py.sigs.map((x) => `${x.index}:${x.signal}`).join(",");
    const match = jsKey === pyKey && maxDiff < 1e-10;
    console.log(
      `${s}: ${match ? "PASS" : "FAIL"}  signals=${jsSigs.length}  maxDiff=${maxDiff}` +
        (jsSigs.length
          ? "\n  " +
            jsSigs
              .map((x) => `${x.signal} ${fmtWib(x.closeTime)} WIB close=${x.close} ADX=${x.adx.toFixed(1)} +DI=${x.pdi.toFixed(1)} -DI=${x.mdi.toFixed(1)}`)
              .join("\n  ")
          : "")
    );
    if (!match) {
      console.error("  js:", jsKey);
      console.error("  py:", pyKey);
      failed++;
    }
    if (s === "NEARUSDT") {
      for (const x of jsSigs) {
        const w = fmtWib(x.closeTime);
        if (x.signal === "SHORT" && w.includes("2026-11-17 13:03")) nearShorts.push(x);
      }
    }

    const latestJs = AdxAlert.latestScanSignal(js);
    // last-5 window, same as scan.py
    let sig = null;
    let i = py.ad.length - 1;
    for (let j = py.ad.length - 5; j < py.ad.length; j++) {
      if (py.ad[j] >= 25 && py.ad[j] > py.ad[j - 1]) {
        if (py.pdi[j] > py.mdi[j] && (py.pdi[j - 1] <= py.mdi[j - 1] || py.ad[j - 1] < 25)) {
          sig = "LONG";
          i = j;
        }
        if (py.mdi[j] > py.pdi[j] && (py.mdi[j - 1] <= py.pdi[j - 1] || py.ad[j - 1] < 25)) {
          sig = "SHORT";
          i = j;
        }
      }
    }
    const latestPy = sig ? { signal: sig, index: i } : null;
    const latestOk =
      (!latestJs && !latestPy) ||
      (latestJs && latestPy && latestJs.signal === latestPy.signal && latestJs.index === latestPy.index);
    if (!latestOk) {
      console.error(`${s}: latest-scan mismatch js=${JSON.stringify(latestJs)} py=${JSON.stringify(latestPy)}`);
      failed++;
    } else {
      console.log(`  scan.py last-5 window: ${latestJs ? latestJs.signal + " @ " + fmtWib(latestJs.closeTime) + " WIB" : "none"}`);
    }
  }

  if (nearShorts.length) {
    console.log("NEAR SHORT around 13:03 WIB on 17 Nov 2026: FOUND");
  } else {
    console.log("NEAR SHORT around 13:03 WIB on 17 Nov 2026: NOT IN RANGE (klines may have rolled off)");
  }

  if (failed) {
    console.error(`PARITY FAILED (${failed})`);
    process.exit(1);
  }
  console.log("PARITY PASSED");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
