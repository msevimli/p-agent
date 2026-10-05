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
// Container-aware: when the process has a readable CPU cgroup, usage comes
// from the cgroup's own counters (cpuacct.usage / cpu.stat usage_usec), so
// the percentage reflects the CONTAINER's CPU burn vs its quota — not the
// whole host's. This container (v1) splits the controllers: cpuacct.usage
// lives under the cpuacct tree while cpu.stat + cfs quota live under cpu.

const CPU_V2_STAT = '/sys/fs/cgroup/cpu.stat'; // usage_usec (µs) — unified hierarchy
const CPU_V2_MAX = '/sys/fs/cgroup/cpu.max';   // "<quota> <period>" | "max <period>"
const CPU_V1_BASES = [
  '/sys/fs/cgroup/cpu,cpuacct',
  '/sys/fs/cgroup/cpu',
  '/sys/fs/cgroup/cpuacct',
];

/** First existing file across the cgroup v1 controller bases. */
function findV1CpuFile(name) {
  for (const base of CPU_V1_BASES) {
    const p = `${base}/${name}`;
    if (readTextFile(p) !== null) return p;
  }
  return null;
}

/**
 * Resolve the container's CPU cgroup sources.
 * Returns { version:'v2', usagePath, maxPath } or
 *         { version:'v1', usagePath, quotaPath, periodPath, statPath } or null.
 */
function detectCpuCgroup() {
  if (readTextFile(CPU_V2_STAT) !== null && readTextFile(CPU_V2_MAX) !== null) {
    return { version: 'v2', usagePath: CPU_V2_STAT, maxPath: CPU_V2_MAX };
  }
  const usagePath = findV1CpuFile('cpuacct.usage');
  if (usagePath) {
    return {
      version: 'v1',
      usagePath,
      quotaPath: findV1CpuFile('cpu.cfs_quota_us'),
      periodPath: findV1CpuFile('cpu.cfs_period_us'),
      statPath: findV1CpuFile('cpu.stat'),
    };
  }
  return null;
}

/**
 * Read the cgroup's current CPU usage in NANOSECONDS + allocated quota cores.
 * quotaCores = cpu.max quota/period (v2) or cfs_quota_us/period_us (v1);
 * null means unlimited (quota -1 / "max").
 */
function readCgroupCpu(cg) {
  if (!cg) return null;
  let usageNanos = null;
  let quotaCores = null;
  if (cg.version === 'v2') {
    const stat = readTextFile(cg.usagePath);
    if (stat === null) return null;
    const m = stat.match(/^usage_usec\s+(\d+)/m);
    if (!m) return null;
    usageNanos = Number.parseInt(m[1], 10) * 1000;
    const maxRaw = readTextFile(cg.maxPath);
    if (maxRaw !== null) {
      const [quota, period] = maxRaw.split(/\s+/);
      if (quota && quota !== 'max') {
        const q = Number.parseInt(quota, 10);
        const p = Number.parseInt(period, 10);
        if (Number.isFinite(q) && Number.isFinite(p) && p > 0) quotaCores = q / p;
      }
    }
  } else {
    const usageRaw = readTextFile(cg.usagePath);
    if (usageRaw === null) return null;
    const usage = Number.parseInt(usageRaw, 10);
    if (!Number.isFinite(usage)) return null;
    usageNanos = usage;
    const quotaRaw = readTextFile(cg.quotaPath);
    const periodRaw = readTextFile(cg.periodPath);
    if (quotaRaw !== null && periodRaw !== null) {
      const q = Number.parseInt(quotaRaw, 10);
      const p = Number.parseInt(periodRaw, 10);
      if (Number.isFinite(q) && Number.isFinite(p) && p > 0 && q > 0) quotaCores = q / p;
    }
  }
  return { usageNanos, quotaCores };
}

/** Snapshot of summed per-core CPU tick counters + wall-clock time (host fallback). */
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

let lastCpu = null;        // previous host tick snapshot ({ idle, total, at })
let lastCgroupCpu = null;  // previous cgroup snapshot ({ at, usageNanos, version })

/**
 * Host-level CPU usage % since the previous sample (delta of busy/idle tick
 * counters). Returns null when there is no baseline yet (first call after
 * boot).
 */
function cpuPercentSinceLastHost() {
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
      quotaCores: null,
      sampleMs,
    };
  }
  lastCpu = now;
  return null;
}

/**
 * Container CPU usage % since the previous sample. usageNanos delta over
 * wall time gives the cores the container actually burned; the percentage
 * is expressed against the container's allocated quota cores (or host core
 * count when the quota is unlimited). Returns null on the first sample
 * (no baseline yet). `nowMs` injectable for tests.
 */
function cpuPercentSinceLastCgroup(cg, nowMs) {
  const at = Number.isFinite(nowMs) ? nowMs : Date.now();
  const cur = readCgroupCpu(cg);
  if (!cur) return null;
  if (!lastCgroupCpu || lastCgroupCpu.version !== cg.version) {
    lastCgroupCpu = { at, usageNanos: cur.usageNanos, version: cg.version };
    return null;
  }
  const wallNs = (at - lastCgroupCpu.at) * 1e6;
  const dUsage = cur.usageNanos - lastCgroupCpu.usageNanos;
  lastCgroupCpu = { at, usageNanos: cur.usageNanos, version: cg.version };
  if (wallNs <= 0) return null;
  const hostCores = os.cpus().length || 1;
  const quotaCores = cur.quotaCores;
  const normCores = quotaCores || hostCores; // relative to quota, else host capacity
  const burnedCores = Math.max(0, dUsage / wallNs);
  return {
    percent: normCores > 0 ? Math.min(999.9, Math.round((burnedCores / normCores) * 1000) / 10) : 0,
    cores: normCores,
    quotaCores,
    burnedCores: Math.round(burnedCores * 1000) / 1000,
    sampleMs: Math.round(wallNs / 1e6),
  };
}

/** Coarse one-shot fallback: 1-min load average relative to core count. */
function cpuEstimate() {
  const cores = os.cpus().length;
  const load = os.loadavg()[0];
  return {
    percent: cores > 0 ? Math.min(999.9, Math.round((load / cores) * 1000) / 10) : null,
    cores,
    quotaCores: null,
    loadavg: os.loadavg(),
    estimate: true,
    sampleMs: null,
  };
}

/**
 * Method-aware CPU collection: cgroup (v1/v2) when running in a container
 * with a readable CPU cgroup, host tick deltas otherwise. The first sample
 * of any method has no baseline and falls back to a loadavg estimate.
 */
function computeCpu(nowMs) {
  const container = inContainer();
  const cg = container ? detectCpuCgroup() : null;
  let delta = null;
  let scope = 'host';
  if (cg) {
    scope = 'container';
    delta = cpuPercentSinceLastCgroup(cg, nowMs);
  } else {
    delta = cpuPercentSinceLastHost();
  }
  const base = delta || cpuEstimate();
  return { ...base, scope, cgroup: cg ? cg.version : null, loadavg: os.loadavg() };
}

// GET /api/system/metrics -> { ok, ts, ram: {...}, cpu: { percent, cores,
//   quotaCores, burnedCores?, scope, cgroup, loadavg, estimate?, sampleMs? } }
router.get('/metrics', (_req, res) => {
  try {
    const ram = readRam();
    const cpu = computeCpu();

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
// Test hooks (harness only): pure helpers with overridable paths/state.
module.exports._test = {
  readCgroupRam, readHostRam, readRam, inContainer, CGROUP_V1, CGROUP_V2, pct,
  detectCpuCgroup, readCgroupCpu, cpuPercentSinceLastCgroup, computeCpu,
  CPU_V1_BASES, CPU_V2_STAT, CPU_V2_MAX,
  resetCpu: () => { lastCpu = null; lastCgroupCpu = null; },
};