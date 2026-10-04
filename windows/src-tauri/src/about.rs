// What the settings window's About section reaches outside the app for: the
// owner's links, and the folders Nook keeps its files in.
//
// The page never says where to go. A link is named by an id, and the address
// it stands for is a constant here; the folder that is opened is the one Nook
// works out for itself. There is no command that opens an address or a path a
// page hands over.

use serde::{Deserialize, Serialize};

use crate::{platform, settings};

const PORTFOLIO_URL: &str = "https://zubyr.dev";
const GITHUB_URL: &str = "https://github.com/zubairbinshaukat";
const LINKEDIN_URL: &str = "https://www.linkedin.com/in/zubairbinshaukat";
const X_URL: &str = "https://x.com/zubyrdev";

/// The links of the About section. A name that is not one of these does not
/// reach the command: it fails to deserialize, and nothing is opened.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Link {
    Portfolio,
    Github,
    Linkedin,
    X,
}

impl Link {
    /// The address the link stands for.
    pub fn url(self) -> &'static str {
        match self {
            Link::Portfolio => PORTFOLIO_URL,
            Link::Github => GITHUB_URL,
            Link::Linkedin => LINKEDIN_URL,
            Link::X => X_URL,
        }
    }
}

/// Hands the link's address to the system, which opens it in the browser.
pub fn open_link(which: Link) {
    platform::open_url(which.url());
}

/// Where Nook keeps its files, for the About section to show.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataPaths {
    /// Preferences: settings.json.
    pub settings: String,
    /// The log and the relay.
    pub local: String,
    /// Why the relay pipe is not open, when it is not: Nook then gets no events.
    pub relay_error: Option<String>,
}

pub fn data_paths() -> DataPaths {
    DataPaths {
        settings: settings::config_dir().to_string_lossy().to_string(),
        local: settings::local_dir().to_string_lossy().to_string(),
        relay_error: crate::pipe::pipe_error(),
    }
}

/// Opens the folder the log is in, in the file manager.
pub fn open_log_folder() {
    let dir = settings::local_dir();
    // It is there as soon as a line was logged; made now if none was.
    if platform::ensure_private_dir(&dir).is_err() {
        return;
    }
    platform::reveal_folder(&dir.to_string_lossy());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn link(name: &str) -> Result<Link, serde_json::Error> {
        serde_json::from_value(serde_json::Value::String(name.to_string()))
    }

    #[test]
    fn each_link_id_opens_its_own_constant_address() {
        assert_eq!(link("portfolio").unwrap().url(), "https://zubyr.dev");
        assert_eq!(link("github").unwrap().url(), "https://github.com/zubairbinshaukat");
        assert_eq!(link("linkedin").unwrap().url(), "https://www.linkedin.com/in/zubairbinshaukat");
        assert_eq!(link("x").unwrap().url(), "https://x.com/zubyrdev");
        // Every one is a plain https address: nothing a shell or a handler would read as more.
        for which in [Link::Portfolio, Link::Github, Link::Linkedin, Link::X] {
            let url = which.url();
            assert!(url.starts_with("https://"), "{url}");
            assert!(url.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '/' | '.' | '-')), "{url}");
        }
    }

    #[test]
    fn a_page_cannot_name_an_address_of_its_own() {
        for said in ["https://example.com", "file:///C:/Windows", "Portfolio", "GITHUB", "", "portfolio "] {
            assert!(link(said).is_err(), "{said:?} must not be a link");
        }
    }

    #[test]
    fn the_data_paths_are_the_folders_nook_uses() {
        let paths = data_paths();
        assert_eq!(paths.settings, settings::config_dir().to_string_lossy());
        assert_eq!(paths.local, settings::local_dir().to_string_lossy());
        let json = serde_json::to_string(&paths).unwrap();
        assert!(json.contains(r#""settings":"#) && json.contains(r#""local":"#));
    }
}
