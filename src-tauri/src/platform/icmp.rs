//! ICMP echo (ping) через Windows `IcmpSendEcho`.
//!
//! `IcmpSendEcho` НЕ требует прав администратора (в отличие от raw-socket'ов) —
//! Windows предоставляет user-mode ICMP через iphlpapi. Используется для
//! pre-connect пинга нод mihomo-профиля, когда TCP-connect не годится:
//! UDP-протоколы (hysteria2 / tuic / wireguard) не слушают TCP, а ICMP к
//! хосту даёт честный network-RTT независимо от протокола.

use std::net::Ipv4Addr;
#[cfg(windows)]
use std::time::Instant;

/// ICMP-echo к IPv4-адресу. Возвращает RTT в мс или `None`
/// (timeout / ICMP заблокирован / ошибка). Блокирующая — вызывать через
/// `spawn_blocking`.
#[cfg(windows)]
pub fn icmp_echo_ipv4(ip: Ipv4Addr, timeout_ms: u32) -> Option<u32> {
    use std::ffi::c_void;
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        IcmpCloseHandle, IcmpCreateFile, IcmpSendEcho, ICMP_ECHO_REPLY,
    };

    // SAFETY: документированный Win32 ICMP API. Хендл закрываем сразу после
    // вызова; буфер ответа достаточного размера (reply-struct + payload + 8
    // байт запаса под ICMP-заголовок, как требует MSDN).
    unsafe {
        let handle = IcmpCreateFile();
        if handle == INVALID_HANDLE_VALUE {
            return None;
        }
        // IPAddr (u32) в network byte order: на little-endian Windows
        // младший байт = первый октет (как inet_addr).
        let dest = u32::from_ne_bytes(ip.octets());
        let payload: [u8; 32] = [0x61; 32];
        let reply_size = std::mem::size_of::<ICMP_ECHO_REPLY>() + payload.len() + 8;
        let mut reply_buf = vec![0u8; reply_size];

        // Меряем RTT по wall-clock: IcmpSendEcho блокирует до ответа/таймаута,
        // так что elapsed ≈ network-RTT. Поле `RoundTripTime` для части хостов
        // возвращает 0 (округление/квирк) — поэтому ему не доверяем, берём
        // максимум из измеренного и RoundTripTime, но не меньше 1мс.
        let start = Instant::now();
        let n = IcmpSendEcho(
            handle,
            dest,
            payload.as_ptr() as *const c_void,
            payload.len() as u16,
            std::ptr::null(),
            reply_buf.as_mut_ptr() as *mut c_void,
            reply_size as u32,
            timeout_ms,
        );
        let elapsed = start.elapsed().as_millis() as u32;
        IcmpCloseHandle(handle);

        if n == 0 {
            return None;
        }
        let reply = &*(reply_buf.as_ptr() as *const ICMP_ECHO_REPLY);
        // Status == 0 → IP_SUCCESS.
        if reply.Status == 0 {
            Some(reply.RoundTripTime.max(elapsed).max(1))
        } else {
            None
        }
    }
}

/// Стаб для не-Windows платформ (готовимся к портированию). На macOS/Linux
/// ICMP без admin делается иначе (`SOCK_DGRAM` ICMP) — реализуем при порте.
#[cfg(not(windows))]
pub fn icmp_echo_ipv4(_ip: Ipv4Addr, _timeout_ms: u32) -> Option<u32> {
    None
}
