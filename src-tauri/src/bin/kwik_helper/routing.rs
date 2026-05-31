//! Управление маршрутизацией Windows напрямую через Win32 IP Helper API.
//!
//! После перехода на mihomo built-in TUN внешний tun2socks-путь выпилен,
//! поэтому здесь осталась только подчистка наших маршрутов и orphan
//! WinTUN-адаптеров (9.E / cleanup на старте helper-сервиса):
//! - `GetIpForwardTable2` + `DeleteIpForwardEntry2` — удаление half-default
//!   routes, оставшихся после краша предыдущей сессии (по destination+nexthop);
//! - `ConvertInterfaceIndexToLuid` — резолв LUID интерфейса;
//! - PowerShell `Remove-NetAdapter` — снос orphan WinTUN-адаптера по имени.

use std::mem;
use std::net::Ipv4Addr;
use std::process::Stdio;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use tokio::process::Command as AsyncCommand;
use windows_sys::Win32::Foundation::{ERROR_NOT_FOUND, NO_ERROR};
use windows_sys::Win32::NetworkManagement::IpHelper::{
    DeleteIpForwardEntry2, FreeMibTable, GetIpForwardTable2, MIB_IPFORWARD_TABLE2,
};
use windows_sys::Win32::NetworkManagement::Ndis::NET_LUID_LH;
use windows_sys::Win32::Networking::WinSock::{AF_INET, SOCKADDR_IN, SOCKADDR_INET};

// ── Утилиты ────────────────────────────────────────────────────────────────

fn ipv4_from_addr(addr: &SOCKADDR_INET) -> Option<Ipv4Addr> {
    unsafe {
        if addr.si_family != AF_INET {
            return None;
        }
        let v4: &SOCKADDR_IN = mem::transmute(addr);
        let raw = v4.sin_addr.S_un.S_addr; // network byte order (BE)
        let octets = raw.to_ne_bytes();
        Some(Ipv4Addr::new(octets[0], octets[1], octets[2], octets[3]))
    }
}

pub fn luid_from_index(if_index: u32) -> Result<u64> {
    let mut luid: NET_LUID_LH = unsafe { mem::zeroed() };
    let ret = unsafe {
        windows_sys::Win32::NetworkManagement::IpHelper::ConvertInterfaceIndexToLuid(if_index, &mut luid)
    };
    if ret != NO_ERROR {
        bail!("ConvertInterfaceIndexToLuid({if_index}) → код {ret}");
    }
    Ok(unsafe { luid.Value })
}

fn mask_to_prefix_len(mask: Ipv4Addr) -> u8 {
    let bits = u32::from(mask);
    bits.count_ones() as u8
}

// ── Cleanup orphan-маршрутов ───────────────────────────────────────────────

/// Удаляет маршруты с указанной destination/mask **только если** их
/// NextHop совпадает с `nexthop`. Безопасно при cleanup orphan'ов: не
/// трогает легитимные маршруты других VPN с той же destination, но с
/// другим gateway.
///
/// Используется в 9.E на старте helper-сервиса для подчистки наших
/// half-default routes (`0.0.0.0/1` и `128.0.0.0/1`) с NextHop
/// `198.18.0.1`, оставшихся после краша предыдущей сессии.
pub async fn delete_route_with_nexthop(
    destination: &str,
    mask: &str,
    nexthop: &str,
) -> Result<()> {
    let dst: Ipv4Addr = match destination.parse() {
        Ok(d) => d,
        Err(_) => return Ok(()),
    };
    let mask: Ipv4Addr = match mask.parse() {
        Ok(m) => m,
        Err(_) => return Ok(()),
    };
    let nh: Ipv4Addr = match nexthop.parse() {
        Ok(n) => n,
        Err(_) => return Ok(()),
    };
    let prefix_len = mask_to_prefix_len(mask);

    tokio::task::spawn_blocking(move || -> Result<()> {
        let mut table_ptr: *mut MIB_IPFORWARD_TABLE2 = std::ptr::null_mut();
        let ret = unsafe { GetIpForwardTable2(AF_INET, &mut table_ptr) };
        if ret != NO_ERROR || table_ptr.is_null() {
            return Ok(());
        }
        let table = unsafe { &*table_ptr };
        let entries = unsafe {
            std::slice::from_raw_parts(table.Table.as_ptr(), table.NumEntries as usize)
        };

        let mut deleted = 0u32;
        for entry in entries {
            let entry_dst = ipv4_from_addr(&entry.DestinationPrefix.Prefix);
            let entry_nh = ipv4_from_addr(&entry.NextHop);
            if entry.DestinationPrefix.PrefixLength == prefix_len
                && entry_dst == Some(dst)
                && entry_nh == Some(nh)
            {
                let ret_del = unsafe { DeleteIpForwardEntry2(entry) };
                if ret_del != NO_ERROR && ret_del != ERROR_NOT_FOUND {
                    eprintln!(
                        "[routing] orphan-cleanup DeleteIpForwardEntry2({}/{} via {}) → код {}",
                        dst, prefix_len, nh, ret_del
                    );
                } else if ret_del == NO_ERROR {
                    deleted += 1;
                }
            }
        }

        unsafe { FreeMibTable(table_ptr as *mut _) };
        if deleted > 0 {
            eprintln!(
                "[routing] orphan-cleanup: удалено {deleted} маршрут(ов) {dst}/{prefix_len} via {nh}"
            );
        }
        Ok(())
    })
    .await??;
    Ok(())
}

// ── Cleanup orphan WinTUN-адаптера ─────────────────────────────────────────

/// Удалить orphaned WinTUN-адаптер с указанным именем, если он остался от
/// предыдущего запуска (например, после kill -9). Без cleanup-а новая
/// попытка `Creating adapter` зависает на 15 секунд: WinTUN видит
/// существующий адаптер с тем же именем и не может создать новый.
///
/// Реализация — через PowerShell: `Get-NetAdapter | Remove-NetAdapter`.
/// Не падает если адаптера нет (SilentlyContinue). Удаляет ТОЛЬКО адаптер
/// с указанным именем — чужие TUN-адаптеры (Happ, Outline, etc.) не трогаем.
pub async fn cleanup_orphan_tun(name: &str) -> Result<()> {
    // Защита от инъекции: имя адаптера должно быть только из ASCII-букв/цифр/
    // дефисов/подчёркиваний/звёздочки (для wildcard `kwik-*`).
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '*')
    {
        bail!("недопустимое имя TUN-адаптера: {name:?}");
    }
    let script = format!(
        "Get-NetAdapter -Name '{name}' -ErrorAction SilentlyContinue | Remove-NetAdapter -Confirm:$false -ErrorAction SilentlyContinue"
    );
    let mut child = AsyncCommand::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .context("powershell для cleanup_orphan_tun не запустился")?;

    // Жёсткий потолок: PowerShell cold-start ~2с + Remove-NetAdapter
    // обычно <1с. Если процесс «тонет» (драйвер залип, антивирус блокирует) —
    // убиваем чтобы не блокировать helper-startup на пол-минуты.
    match tokio::time::timeout(Duration::from_secs(5), child.wait()).await {
        Ok(_) => Ok(()),
        Err(_) => {
            let _ = child.start_kill();
            eprintln!(
                "[routing] cleanup_orphan_tun({name}) timeout 5с — kill, продолжаем"
            );
            Ok(())
        }
    }
}
