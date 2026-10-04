// The machine's memory and processor use, for the island — and only while
// there is an island to show them on.
//
// One thread, parked on the same gate as the cursor poll: while the island is
// hidden it takes no sample and never wakes. While the island is up it reads
// two counters every SAMPLE_PERIOD (two system calls on Windows, two small
// files of /proc on Linux) and emits `metrics`.
//
// Processor use is the share of the time between two samples that was not
// idle, so the first reading after each wake has none: it goes out as `null`,
// with the memory, and the next one has it. Nothing measured before a park is
// compared with anything measured after it.
//
// The graphics processor's use comes with them where the system counts it
// (Windows: the counters Task Manager reads, platform/windows.rs). It is asked
// for on the same tick, by the same thread; the counters are opened the first
// time the island is up and kept. A machine that has none — a virtual machine,
// Linux — says so once in the log, and `gpu` is `null` from then on.

use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::island::{PollGate, WINDOW_LABEL};
use crate::platform;

/// Time between two samples. Slow enough to cost nothing, fast enough to follow a build.
const SAMPLE_PERIOD: Duration = Duration::from_millis(2500);

/// What the processors have spent since the machine started, in the system's
/// own unit (100 ns on Windows, clock ticks on Linux): idle, and everything.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CpuTimes {
    pub idle: u64,
    pub total: u64,
}

/// The `metrics` event. `cpu` is the whole machine's, in percent; `gpu` the
/// busiest graphics adapter's, and None where it cannot be told.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Metrics {
    pub cpu: Option<f64>,
    pub gpu: Option<f64>,
    pub ram_used: u64,
    pub ram_total: u64,
}

/// Processor use between two samples, in percent with one decimal. None when
/// there is nothing to divide by — no time has passed — or when a counter
/// went backwards (it wrapped, or the machine came back from sleep with new
/// ones): a reading skipped is better than a made-up one.
pub fn cpu_percent(before: CpuTimes, now: CpuTimes) -> Option<f64> {
    let total = now.total.checked_sub(before.total).filter(|t| *t > 0)?;
    let idle = now.idle.checked_sub(before.idle)?;
    let busy = total.saturating_sub(idle);
    Some((busy as f64 * 1000.0 / total as f64).round() / 10.0)
}

/// The adapter and the kind of engine a `GPU Engine` counter instance is for:
/// `pid_1234_luid_0x00000000_0x0000D3A1_phys_0_eng_0_engtype_3D` is the
/// adapter `0x00000000_0x0000D3A1`, engine type `3D`. None for a name that is
/// not one of these.
#[cfg(any(windows, test))]
pub fn parse_gpu_instance(name: &str) -> Option<(&str, &str)> {
    let (_, rest) = name.split_once("_luid_")?;
    let (luid, rest) = rest.split_once("_phys_")?;
    let (_, engine_type) = rest.split_once("_engtype_")?;
    (!luid.is_empty() && !engine_type.is_empty()).then_some((luid, engine_type))
}

/// The graphics processor's use, in percent with one decimal, from every
/// engine instance and what it says — Task Manager's headline number: each
/// process's share of an engine type is added up per adapter, an adapter is as
/// busy as its busiest engine type (3D, VideoDecode, Copy…), and the machine
/// as its busiest adapter. None when no instance is one of an engine.
#[cfg(any(windows, test))]
pub fn gpu_percent<'a>(samples: impl IntoIterator<Item = (&'a str, f64)>) -> Option<f64> {
    let mut by_type: std::collections::HashMap<(&str, &str), f64> = std::collections::HashMap::new();
    for (name, value) in samples {
        let Some(key) = parse_gpu_instance(name) else { continue };
        // A reading that is no number, or under nothing, adds nothing.
        *by_type.entry(key).or_insert(0.0) += if value.is_finite() { value.max(0.0) } else { 0.0 };
    }
    let busiest = by_type.values().copied().reduce(f64::max)?;
    Some((busiest.clamp(0.0, 100.0) * 10.0).round() / 10.0)
}

/// Where the graphics processor's counters stand: not asked for yet, open, or
/// not to be had on this machine.
enum Gpu {
    Untried,
    On(platform::GpuCounters),
    Off,
}

/// Readings that could not be made out, in a row, before the counters are given up.
const GPU_MISSES: u32 = 3;

struct GpuSampler {
    state: Gpu,
    misses: u32,
}

impl GpuSampler {
    fn new() -> Self {
        Self { state: Gpu::Untried, misses: 0 }
    }

    /// Said once, and the counters are never asked for again: no retry, no second line.
    fn give_up(&mut self, why: String) {
        crate::log::line(format!("gpu: not measured — {why}"));
        self.state = Gpu::Off;
    }

    /// The use since the last tick. `fresh` — the first tick after a wake —
    /// only takes the reading the next one is compared with.
    fn sample(&mut self, fresh: bool) -> Option<f64> {
        if matches!(self.state, Gpu::Untried) {
            match platform::GpuCounters::open() {
                Ok(counters) => self.state = Gpu::On(counters),
                Err(why) => self.give_up(why),
            }
        }
        let Gpu::On(counters) = &mut self.state else { return None };
        if let Err(why) = counters.collect() {
            self.give_up(why);
            return None;
        }
        if fresh {
            return None;
        }
        match counters.read() {
            Ok(value) => {
                self.misses = 0;
                value
            }
            Err(why) => {
                self.misses += 1;
                if self.misses >= GPU_MISSES {
                    self.give_up(why);
                }
                None
            }
        }
    }
}

/// Memory in use and memory installed, in bytes, from /proc/meminfo:
/// MemTotal − MemAvailable. None when either line is missing.
#[cfg(any(target_os = "linux", test))]
pub fn parse_meminfo(text: &str) -> Option<(u64, u64)> {
    // "MemTotal:       32791420 kB"
    let kilobytes = |name: &str| {
        text.lines()
            .find_map(|line| line.strip_prefix(name)?.strip_prefix(':'))
            .and_then(|rest| rest.split_whitespace().next()?.parse::<u64>().ok())
    };
    let total = kilobytes("MemTotal")?;
    let available = kilobytes("MemAvailable")?;
    Some((total.saturating_sub(available).saturating_mul(1024), total.saturating_mul(1024)))
}

/// The processors' times from the first line of /proc/stat:
/// `cpu  user nice system idle iowait irq softirq steal guest guest_nice`.
/// Idle is idle + iowait; everything is the first eight (guest time is
/// already counted in user). None when the line is not there or is short.
#[cfg(any(target_os = "linux", test))]
pub fn parse_proc_stat(text: &str) -> Option<CpuTimes> {
    let mut fields = text.lines().find(|line| line.starts_with("cpu "))?.split_whitespace().skip(1);
    let mut times = [0u64; 8];
    for (i, slot) in times.iter_mut().enumerate() {
        // The first four are in every kernel; the rest came later, and are 0 without.
        match fields.next() {
            Some(field) => *slot = field.parse().ok()?,
            None if i >= 4 => break,
            None => return None,
        }
    }
    Some(CpuTimes { idle: times[3].saturating_add(times[4]), total: times.iter().fold(0u64, |sum, t| sum.saturating_add(*t)) })
}

/// One sample, as the island gets it. None when the memory cannot be read.
fn sample(before: Option<CpuTimes>, now: Option<CpuTimes>, gpu: Option<f64>) -> Option<Metrics> {
    let (ram_used, ram_total) = platform::memory()?;
    let cpu = before.zip(now).and_then(|(before, now)| cpu_percent(before, now));
    Some(Metrics { cpu, gpu, ram_used, ram_total })
}

/// Emits `metrics` every SAMPLE_PERIOD while the island is up. Parked on the
/// gate's condvar the rest of the time. Nothing here runs on the main thread.
pub fn spawn(app: AppHandle, gate: Arc<PollGate>) {
    std::thread::spawn(move || {
        // Opened on the first tick the island is up, and kept across parks.
        let mut gpu = GpuSampler::new();
        loop {
            gate.wait_until_active();
            crate::log::line("metrics: sampling resumed");
            let wake = gate.wakes();
            // Fresh on every wake: the first reading has no processor use.
            let mut before: Option<CpuTimes> = None;
            let mut fresh = true;
            loop {
                let now = platform::cpu_times();
                let gpu_now = gpu.sample(fresh);
                fresh = false;
                if let Some(metrics) = sample(before, now, gpu_now) {
                    let _ = app.emit_to(WINDOW_LABEL, "metrics", metrics);
                }
                before = now;
                // Hidden meanwhile — even hidden and shown again — and we start over.
                if !gate.wait_while_active(SAMPLE_PERIOD) || gate.wakes() != wake {
                    break;
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn times(idle: u64, total: u64) -> CpuTimes {
        CpuTimes { idle, total }
    }

    #[test]
    fn processor_use_is_what_was_not_idle_between_two_samples() {
        assert_eq!(cpu_percent(times(1000, 4000), times(1750, 5000)), Some(25.0));
        assert_eq!(cpu_percent(times(0, 0), times(1000, 1000)), Some(0.0));
        assert_eq!(cpu_percent(times(500, 1000), times(500, 2000)), Some(100.0));
        // One decimal.
        assert_eq!(cpu_percent(times(0, 0), times(2, 3)), Some(33.3));
        // Idle counted a hair past everything, as two reads a moment apart can: 0, never negative.
        assert_eq!(cpu_percent(times(0, 0), times(1001, 1000)), Some(0.0));
    }

    #[test]
    fn no_time_passed_or_a_counter_that_went_back_gives_no_reading() {
        let at = times(1000, 4000);
        assert_eq!(cpu_percent(at, at), None);
        // Wrapped, or reset: the total, or the idle time alone.
        assert_eq!(cpu_percent(times(10, u64::MAX - 5), times(20, 100)), None);
        assert_eq!(cpu_percent(at, times(900, 5000)), None);
        assert_eq!(cpu_percent(at, times(0, 0)), None);
    }

    const MEMINFO: &str = "MemTotal:       32791420 kB\nMemFree:         1203984 kB\nMemAvailable:   20412332 kB\nBuffers:          812340 kB\nCached:         17012344 kB\nSwapCached:            0 kB\n";

    #[test]
    fn memory_in_use_is_what_is_not_available() {
        assert_eq!(parse_meminfo(MEMINFO), Some(((32_791_420 - 20_412_332) * 1024, 32_791_420 * 1024)));
        // A kernel too old for MemAvailable, an empty file, a line that is no number: nothing.
        assert_eq!(parse_meminfo("MemTotal:       32791420 kB\nMemFree:         1203984 kB\n"), None);
        assert_eq!(parse_meminfo(""), None);
        assert_eq!(parse_meminfo("MemTotal: lots kB\nMemAvailable: 1 kB\n"), None);
        // A name that only starts the same is another line.
        assert_eq!(parse_meminfo("MemTotalHuge: 9 kB\nMemTotal: 8 kB\nMemAvailable: 3 kB\n"), Some((5 * 1024, 8 * 1024)));
        // More said to be available than there is: nothing in use, not a wrap.
        assert_eq!(parse_meminfo("MemTotal: 8 kB\nMemAvailable: 9 kB\n"), Some((0, 8 * 1024)));
    }

    const STAT: &str = "cpu  4705 356 584 3699 23 23 0 10 5 0\ncpu0 2000 100 300 1800 10 10 0 5 0 0\ncpu1 2705 256 284 1899 13 13 0 5 0 0\nintr 114930548 113199788\nctxt 1990473\n";

    #[test]
    fn processor_times_come_from_the_first_line_of_proc_stat() {
        // idle + iowait; and the first eight, guest time being in user already.
        assert_eq!(parse_proc_stat(STAT), Some(times(3699 + 23, 4705 + 356 + 584 + 3699 + 23 + 23 + 10)));
        // An old kernel's four fields.
        assert_eq!(parse_proc_stat("cpu  10 0 5 85\n"), Some(times(85, 100)));
        // Only a processor's own line, a short line, a field that is no number, nothing.
        assert_eq!(parse_proc_stat("cpu0 2000 100 300 1800 10 10 0 5 0 0\n"), None);
        assert_eq!(parse_proc_stat("cpu  10 0 5\n"), None);
        assert_eq!(parse_proc_stat("cpu  10 x 5 85\n"), None);
        assert_eq!(parse_proc_stat(""), None);
        // Two samples of it give a percentage like any other two.
        let later = parse_proc_stat("cpu  4805 356 684 3899 23 23 0 10 5 0\n").unwrap();
        assert_eq!(cpu_percent(parse_proc_stat(STAT).unwrap(), later), Some(50.0));
    }

    #[test]
    fn the_event_is_spelled_as_the_island_reads_it() {
        let first = Metrics { cpu: None, gpu: None, ram_used: 8 << 30, ram_total: 16 << 30 };
        assert_eq!(serde_json::to_string(&first).unwrap(), r#"{"cpu":null,"gpu":null,"ramUsed":8589934592,"ramTotal":17179869184}"#);
        let next = Metrics { cpu: Some(12.5), gpu: Some(40.0), ..first };
        assert!(serde_json::to_string(&next).unwrap().starts_with(r#"{"cpu":12.5,"gpu":40.0,"#));
    }

    #[test]
    fn an_engine_instance_names_its_adapter_and_its_engine_type() {
        assert_eq!(
            parse_gpu_instance("pid_1234_luid_0x00000000_0x0000D3A1_phys_0_eng_0_engtype_3D"),
            Some(("0x00000000_0x0000D3A1", "3D"))
        );
        assert_eq!(
            parse_gpu_instance("pid_18004_luid_0x00000000_0x00012F4B_phys_0_eng_5_engtype_VideoDecode"),
            Some(("0x00000000_0x00012F4B", "VideoDecode"))
        );
        // An engine type with more than one word keeps all of it.
        assert_eq!(parse_gpu_instance("pid_4_luid_0x0_0x1_phys_0_eng_9_engtype_Compute_0"), Some(("0x0_0x1", "Compute_0")));
        // Not an engine's name, or one with a part missing: nothing.
        for name in ["", "_Total", "pid_1234", "pid_1_luid_0x0_0x1_phys_0_eng_0", "pid_1_luid__phys_0_eng_0_engtype_3D", "pid_1_luid_0x0_0x1_phys_0_eng_0_engtype_"] {
            assert_eq!(parse_gpu_instance(name), None, "{name}");
        }
    }

    #[test]
    fn graphics_use_is_the_busiest_engine_type_of_the_busiest_adapter() {
        const A: &str = "luid_0x00000000_0x0000D3A1_phys_0";
        const B: &str = "luid_0x00000000_0x00012F4B_phys_0";
        let name = |pid: u32, adapter: &str, engine: u32, kind: &str| format!("pid_{pid}_{adapter}_eng_{engine}_engtype_{kind}");
        let samples = [
            // Adapter A: 3D is 12.5 + 30.25 + 1 = 43.75 across three processes; its video decoder is at 60.
            (name(100, A, 0, "3D"), 12.5),
            (name(200, A, 0, "3D"), 30.25),
            (name(300, A, 0, "3D"), 1.0),
            (name(200, A, 3, "VideoDecode"), 60.0),
            (name(100, A, 2, "Copy"), 4.0),
            // Adapter B: 3D at 71.04, in two processes.
            (name(100, B, 0, "3D"), 70.0),
            (name(400, B, 0, "3D"), 1.04),
            (name(400, B, 1, "Copy"), 2.0),
            ("_Total".to_string(), 500.0),
        ];
        let of = |rows: &[(String, f64)]| gpu_percent(rows.iter().map(|(n, v)| (n.as_str(), *v)));
        assert_eq!(of(&samples), Some(71.0));
        // Without adapter B, adapter A's busiest type: the decoder, not the sum of its types.
        assert_eq!(of(&samples[..5]), Some(60.0));
        assert_eq!(of(&samples[..3]), Some(43.8));
        // Shares that add up past everything: 100, never more. Idle: 0.
        assert_eq!(of(&[(name(1, A, 0, "3D"), 70.0), (name(2, A, 0, "3D"), 55.0)]), Some(100.0));
        assert_eq!(of(&[(name(1, A, 0, "3D"), 0.0)]), Some(0.0));
        // A reading that is no number or below nothing counts for nothing; no engine at all is no reading.
        assert_eq!(of(&[(name(1, A, 0, "3D"), f64::NAN), (name(2, A, 0, "3D"), -3.0), (name(3, A, 0, "3D"), 8.0)]), Some(8.0));
        assert_eq!(of(&[("_Total".to_string(), 9.0)]), None);
        assert_eq!(of(&[]), None);
    }
}
