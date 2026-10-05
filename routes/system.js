/**
 * /api/system — host system resource metrics for the header widgets.
 *
 * Pure Node core (os module), no dependencies, no child processes, no
 * filesystem. The CPU percentage is a DELTA measurement between two
 * consecutive samples of per-core tick counters (user/nice/sys/idle/irq)
 * — the same technique as top/htop. The first call has no baseline, so it
 * falls back to a loadavg-based estimate until the next sample arrives
 * (the frontend polls every 5s, so the estimate lasts one tick at most).
 */
const os = require('os');
const express = require('express');
const router = express.Router();

/** Snapshot of summed per-core CPU tick counters + wall-clock time. */
function cpuSnapshot() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const c of cpus) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total, cores: cpus.length, at: Date.now() };
}

let lastCpu = null; // previous snapshot ({ idle, total, at })

/**
 * CPU usage % since the previous sample (delta of busy/idle tick counters).
 * Returns null when there is no baseline yet (first call after boot).
 */
function cpuPercentSinceLast() {
  const now = cpuSnapshot();
  if (lastCpu && now.total > lastCpu.total) {
    const dIdle = now.idle - lastCpu.idle;
    const dTotal = now.total - lastCpu.total;
    const sampleMs = now.at - lastCpu.at;
    lastCpu = now;
    const busy = dTotal - dIdle;
    return {
      percent: dTotal > 0 ? Math.round((busy / dTotal) * 1000) / 10 : 0,
      cores: now.cores,
      sampleMs,
    };
  }
  lastCpu = now;
  return null;
}

/** Coarse one-shot fallback: 1-min load average relative to core count. */
function cpuEstimate() {
  const cores = os.cpus().length;
  const load = os.loadavg()[0];
  return {
    percent: cores > 0 ? Math.min(999.9, Math.round((load / cores) * 1000) / 10) : null,
    cores,
    loadavg: os.loadavg(),
    estimate: true,
    sampleMs: null,
  };
}

// GET /api/system/metrics -> { ok, ts, ram: { totalBytes, usedBytes,
//   freeBytes, percent }, cpu: { percent, cores, loadavg, estimate?, sampleMs? } }
router.get('/metrics', (_req, res) => {
  try {
    const totalBytes = os.totalmem();
    const freeBytes = os.freemem();
    const usedBytes = totalBytes - freeBytes;
    const ramPercent = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0;

    const delta = cpuPercentSinceLast();
    const cpu = delta ? { ...delta, loadavg: os.loadavg() } : cpuEstimate();

    res.json({
      ok: true,
      ts: Date.now(),
      hostname: os.hostname(),
      uptimeSec: Math.round(os.uptime()),
      ram: {
        totalBytes,
        usedBytes,
        freeBytes,
        percent: ramPercent,
      },
      cpu,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'could not read system metrics' });
  }
});

module.exports = router;