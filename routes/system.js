/**
 * /api/system — host system resource metrics for the header widgets.
 *
 * Pure Node core (os module + /proc and /sys reads on Linux), no
 * dependencies, no child processes. The CPU percentage is a DELTA
 * measurement between two consecutive samples of per-core tick counters
 * (user/nice/sys/idle/irq) — the same technique as top/htop. The first
 * call has no baseline, so it falls back to a loadavg-based estimate until
 * the next sample arrives (the frontend polls every 5s, so the estimate
 * lasts one tick at most).
 *
 * RAM accounting — CONTAINER-AWARE. When the process runs inside a Docker
 * container (/.dockerenv or cgroup markers), memory usage and limit are
 * read from the container's cgroup so the dashboard matches `docker stats`
 * instead of the host's /proc/meminfo:
 *   - cgroup v2: memory.current + memory.max ("max" = unlimited)
 *   - cgroup v1: memory.usage_in_bytes + memory.limit_in_bytes
 *                (2^63−4096 sentinel = unlimited)
 * An unlimited cgroup falls back to host MemTotal as the effective budget
 * (exactly what `docker stats` shows as LIMIT in that case). Bare metal
 * (no cgroup mount or files) uses host-level /proc/meminfo accounting:
 *   percent      = procps kb_main_used (buffers + page cache count as used)
 *   percentAvail = (MemTotal − MemAvailable) / MemTotal (modern free's
 *                  "used" column)
 */
const os = require('os');
const fs = require('fs');
const express = require('express');
const router = express.Router();

// ---------------------------------------------------------------- RAM
/** Values above 2^60 are cgroup "no limit" sentinels (v1: 2^63−4096, v2: "max"). */
const UNLIMITED_THRESHOLD = 2 ** 60;

const CGROUP_V2 = {
  usage: '/sys/fs/cgroup/memory.current',
  limit: '/sys/fs/cgroup/memory.max',
};
const CGROUP_V1 = {
  usage: '/sys/fs/cgroup/memory/memory.usage_in_bytes',
  limit: '/sys/fs/cgroup/memory/memory.limit_in_bytes',
};

/** Read a small text file, trimmed; null when missing/unreadable. */
function readTextFile(p) {
  try { return fs.readFileSync(p, 'utf8').trim(); } catch { return null; }
}

/** Is this process inside a container? (Docker marker + cgroup controller paths) */
function inContainer() {
  try {
    if (fs.existsSync('/.dockerenv')) return true;
    const c1 = readTextFile('/proc/1/cgroup');
    if (c1 && /docker|kubepods|containerd|libpod/i.test(c1)) return true;
  } catch { /* probe failures -> treated as bare metal */ }
  return false;
}

/**
 * Read usage + limit from a cgroup tree. `paths` overridable for tests.
 * Returns null when the tree is absent/unreadable. A sentinel/unset limit
 * resolves to { limitBytes: null } (caller decides the fallback budget).
 */
function readCgroupRam(paths) {
  const usageRaw = readTextFile(paths.usage);
  const limitRaw = readTextFile(paths.limit);
  if (usageRaw === null || limitRaw === null) return null;
  const usage = Number.parseInt(usageRaw, 10);
  if (!Number.isFinite(usage) || usage <= 0) return null;
  let limitBytes = null;
  const lv = String(limitRaw).toLowerCase();
  if (lv !== 'max') {
    const n = Number.parseInt(lv, 10);
    if (Number.isFinite(n) && n > 0 && n < UNLIMITED_THRESHOLD) limitBytes = n;
  }
  return { usageBytes: usage, limitBytes };
}

/**
 * Parse /proc/meminfo (Linux) into a { key: kibibytes } map.
 * Returns null when the file is unavailable.
 */
function readMemInfo() {
  const raw = readTextFile('/proc/meminfo');
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
function pct(usedBytes, totalBytes) {
  if (!(totalBytes > 0)) return 0;
  return Math.max(0, Math.min(100, Math.round((usedBytes / totalBytes) * 1000) / 10));
}

/** Host-level RAM snapshot (bare-metal or fallback): kernel-counter accounting. */
function readHostRam() {
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
      scope: 'host',
      cgroup: null,
      limitSet: true,
      source: 'proc_meminfo',
    };
  }
  // Last-resort fallback (non-Linux): os module.
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
    scope: 'host',
    cgroup: null,
    limitSet: true,
    source: 'os',
  };
}

/**
 * Container-aware RAM snapshot. Prefers the process cgroup (v2 then v1);
 * the effective budget is the cgroup limit, or host MemTotal when the
 * cgroup is unlimited (docker-stats behavior). Falls back to host-level
 * accounting when no cgroup is readable.
 */
function readRam() {
  const container = inContainer();
  const cgroupRam = readCgroupRam(CGROUP_V2) || readCgroupRam(CGROUP_V1);
  const v2 = readTextFile(CGROUP_V2.usage) !== null;

  if (container && cgroupRam) {
    const usedBytes = cgroupRam.usageBytes;
    // Effective budget: cgroup limit, else host total (matches `docker
    // stats` LIMIT for unlimited containers).
    const totalBytes = cgroupRam.limitBytes || os.totalmem();
    const limitSet = cgroupRam.limitBytes !== null;
    const usedPct = pct(usedBytes, totalBytes);
    return {
      totalBytes,
      usedBytes,
      freeBytes: limitSet ? Math.max(0, totalBytes - usedBytes) : null,
      buffCacheBytes: null,    // not exposed by cgroup controllers
      availableBytes: null,    // MemAvailable equivalents are cgroup-v1-absent
      percent: usedPct,
      percentAvail: null,
      scope: 'container',
      cgroup: v2 ? 'v2' : 'v1',
      limitSet,
      source: 'cgroup',
    };
  }
  return readHostRam();
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
// Test hooks (harness only): pure helpers with overridable paths.
module.exports._test = { readCgroupRam, readHostRam, readRam, inContainer, CGROUP_V1, CGROUP_V2, pct };