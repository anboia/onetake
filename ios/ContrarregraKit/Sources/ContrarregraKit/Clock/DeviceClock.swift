import Foundation

/// Os relógios do aparelho (glossário de spec.md): **D** = `CLOCK_MONOTONIC_RAW` em ns (não para no sono,
/// sem ajuste de NTP); `uptime` = `CLOCK_UPTIME_RAW` em ns (a base do `mach_absolute_time` e do
/// `CACurrentMediaTime`, que para no sono).
public enum DeviceClock {
    /// D agora, em ns.
    public static func rawNs() -> UInt64 {
        clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW)
    }

    /// Tempo de atividade agora, em ns.
    public static func uptimeNs() -> UInt64 {
        clock_gettime_nsec_np(CLOCK_UPTIME_RAW)
    }
}
