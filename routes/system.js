/**
 * /api/system — host system resource metrics for the header widgets.
 *
 * Pure Node core (os module + /proc/meminfo read on Linux), no dependencies,
 * no child processes. The CPU percentage is a DELTA measurement between two
 * consecutive samples of per-core tick counters (user/nice/sys/idle/irq) —
 * the same technique as top/htop. The first call has no baseline, so it
 * falls back to a loadavg-based estimate until the next sample arrives
 * (the frontend polls every 5s, so the estimate lasts one tick at most).
 *
 * RAM accounting (Linux): reads /proc/meminfo directly — the same kernel
 * counters `free` uses — and reports TWO distinct views so the numbers are
 * never ambiguous:
 *   percent            = used / total with used = total − MemFree − Buffers
 *                        − Cached − SReclaimable + Shmem (procps' classic
 *                        kb_main_used: page cache counts as used). This is
 *                        the naive "used vs total" ratio.
 *   percentAvail       = (total − MemAvailable) / total — what MODERN
 *                        `free` prints as its "used" column (MemAvailable
 *                        includes reclaimable cache). Older code computed
 *                        used = totalmem − os.freemem(), which on Linux
 *                        equals ~MemAvailable and thus UNDERSTATES the
 *                        naive ratio whenever page cache is large.
 * The header ring uses `percent` (cache counts). Non-Linux platforms fall
 * back to os.totalmem/freemem and report both views as equal.
 */
const os = require('os');
const fs = require('fs');
const express = require('express');
const router = express.Router();

// ---------------------------------------------------------------- RAM
/**
 * Parse /proc/meminfo (Linux) into a { key: kibibytes } map.
 * Returns null when the file is unavailable (non-Linux, containers…).
 */
function readMemInfo() {
  let raw = null;
  try { raw = fs.readFileSync('/proc/meminfo', 'utf8'); } catch { return null; }
  if (!raw) return null;
  const m = {};
  for (const line of raw.split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const k = line.slice(0, idx).trim();
    const v = parseInt(line.slice(idx + 1), 10);
    if (k && Number.isFinite(v)) m[k] = v;
  }
  return m;
}

/** 0–100 capped percentage (1 decimal), so counter noise never exceeds the bar. */
function pct(usedKiB, totalKiB) {
  if (!(totalKiB > 0)) return 0;
  return Math.max(0, Math.min(100, Math.round((usedKiB / totalKiB) * 1000) / 10));
}

/**
 * RAM snapshot with kernel-counter accounting:
 *   used      = MemTotal − MemFree − Buffers − Cached − SReclaimable + Shmem
 *               (procps' kb_main_used — buffers/cache count as used)
 *   available = MemAvailable (what modern free's "used" column is based on)
 */
function readRam() {
  const info = readMemInfo();
  const totalBytes = os.totalmem();
  if (info && Number.isFinite(info.MemTotal) && info.MemTotal > 0) {
    const totalKiB = info.MemTotal;
    const freeKiB = info.MemFree || 0;
    const buffersKiB = info.Buffers || 0;
    const cachedKiB = (info.Cached || 0) + (info.SReclaimable || 0) - (info.Shmem || 0);
    const usedKiB = Math.max(0, totalKiB - freeKiB - buffersKiB - cachedKiB);
    const availableKiB = Number.isFinite(info.MemAvailable)
      ? info.MemAvailable
      : freeKiB + buffersKiB + cachedKiB;
    return {
      totalBytes: totalKiB * 1024,
      usedBytes: usedKiB * 1024,
      freeBytes: freeKiB * 1024,
      buffCacheBytes: (buffersKiB + cachedKiB) * 1024,
      availableBytes: availableKiB * 1024,
      percent: pct(usedKiB, totalKiB),                       // cache counts as used
      percentAvail: pct(totalKiB - availableKiB, totalKiB),  // modern free's used column
      source: 'proc_meminfo',
    };
  }
  // Fallback (macOS/Windows/containers without /proc/meminfo): os module.
  const freeBytes = os.freemem();
  const usedBytes = Math.max(0, totalBytes - freeBytes);
  return {
    totalBytes,
    usedBytes,
    freeBytes,
    buffCacheBytes: 0,
    availableBytes: totalBytes - usedBytes,
    percent: pct(usedBytes, totalBytes),
    percentAvail: pct(usedBytes, totalBytes),
    source: 'os',
  };
}

// ---------------------------------------------------------------- CPU
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
//   freeBytes, buffCacheBytes, availableBytes, percent, percentAvail,
//   source }, cpu: { percent, cores, loadavg, estimate?, sampleMs? } }
router.get('/metrics', (_req, res) => {
  try {
    const ram = readRam();

    const delta = cpuPercentSinceLast();
    const cpu = delta ? { ...delta, loadavg: os.loadavg() } : cpuEstimate();

    res.json({
      ok: true,
      ts: Date.now(),
      hostname: os.hostname(),
      uptimeSec: Math.round(os.uptime()),
      ram,
      cpu,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'could not read system metrics' });
  }
});

module.exports = router;