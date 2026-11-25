//! Read-only platform battery status for the optional compact cell.

use serde::Serialize;

#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BatteryStatus {
    pub percent: Option<u8>,
    pub ac_connected: Option<bool>,
    pub charging: Option<bool>,
    pub battery_present: Option<bool>,
}

/// Convert the byte fields returned by GetSystemPowerStatus without treating
/// its sentinel values as real measurements.
#[cfg(any(windows, test))]
fn normalize_power_status(ac_line: u8, battery_flag: u8, life_percent: u8) -> BatteryStatus {
    let battery_present = if battery_flag == u8::MAX {
        None
    } else {
        Some(battery_flag & 128 == 0)
    };
    BatteryStatus {
        percent: if battery_present == Some(true) && life_percent != u8::MAX {
            Some(life_percent.min(100))
        } else {
            None
        },
        ac_connected: match ac_line {
            0 => Some(false),
            1 => Some(true),
            _ => None,
        },
        charging: if battery_present == Some(true) {
            Some(battery_flag & 8 != 0)
        } else {
            None
        },
        battery_present,
    }
}

fn read_status() -> BatteryStatus {
    #[cfg(windows)]
    {
        use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};

        let mut status = SYSTEM_POWER_STATUS::default();
        if unsafe { GetSystemPowerStatus(&mut status) }.is_ok() {
            return normalize_power_status(
                status.ACLineStatus,
                status.BatteryFlag,
                status.BatteryLifePercent,
            );
        }
    }
    // Linux battery support is intentionally unavailable in this contribution.
    // The command remains present so the cross-platform frontend can handle it.
    BatteryStatus::default()
}

#[tauri::command]
pub fn battery_status() -> BatteryStatus {
    read_status()
}

/// The settings picker only offers the cell when the platform reports a battery.
#[tauri::command]
pub fn battery_available() -> bool {
    read_status().battery_present == Some(true)
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "linux")]
    use super::read_status;
    use super::{normalize_power_status, BatteryStatus};

    #[test]
    fn windows_power_fields_normalize_charge_ac_and_presence() {
        assert_eq!(
            normalize_power_status(1, 8, 73),
            BatteryStatus {
                percent: Some(73),
                ac_connected: Some(true),
                charging: Some(true),
                battery_present: Some(true)
            },
        );
        assert_eq!(
            normalize_power_status(0, 1, 21),
            BatteryStatus {
                percent: Some(21),
                ac_connected: Some(false),
                charging: Some(false),
                battery_present: Some(true)
            },
        );
    }

    #[test]
    fn missing_and_unknown_battery_values_are_safe() {
        assert_eq!(
            normalize_power_status(2, 128, 20),
            BatteryStatus {
                percent: None,
                ac_connected: None,
                charging: None,
                battery_present: Some(false)
            },
        );
        assert_eq!(
            normalize_power_status(255, 255, 255),
            BatteryStatus::default(),
        );
        assert_eq!(normalize_power_status(1, 1, 255).percent, None);
        assert_eq!(normalize_power_status(1, 1, 120).percent, Some(100));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn battery_status_is_unavailable_on_linux() {
        assert_eq!(read_status(), BatteryStatus::default());
        assert!(!super::battery_available());
    }
}
