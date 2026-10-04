// What the Shelf's widgets keep, in one file: shelf.json, beside settings.json.
// It is one JSON object, a key per widget ("todo", "timer", ...), each with the
// widget's own shape. Everything is local; nothing leaves the machine.
//
// The page loads and saves a widget's part through `shelf_load` / `shelf_save`.
// What it sends is held to what Nook knows: only the widgets it may write, and
// within the sizes below (what is over is cut, never stored). The file is
// written whole each time, to a temporary file that then takes the place of the
// old one, so a power cut leaves the old file or the new one and never half.
//
// Widgets whose data Nook itself keeps (the project folders) are in the file
// too, but the page cannot write them: see `WRITABLE`.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{Map, Value};
use tauri::State;

/// The widgets the page may write. The others are Nook's own.
pub const WRITABLE: &[&str] = &["todo", "timer", "reminders"];

/// To-do: how many items, how long each, how long the notes.
pub const MAX_TODO_ITEMS: usize = 500;
pub const MAX_ITEM_CHARS: usize = 200;
pub const MAX_NOTES_CHARS: usize = 20_000;

/// Timer: the longest countdown (599 minutes, as the page offers), and the latest end it keeps (a Unix time in ms, far past any real one).
pub const MAX_TIMER_MS: f64 = 599.0 * 60_000.0;
const MAX_UNIX_MS: f64 = 100_000_000_000_000.0;

/// Reminders: how many are kept (the words are cut to MAX_ITEM_CHARS).
pub const MAX_REMINDERS: usize = 200;

/// A widget's whole part, once written: far above what the caps allow, so it only ever stops a page that sends junk.
pub const MAX_BYTES: usize = 600_000;

fn path() -> PathBuf {
    crate::platform::config_dir().join("shelf.json")
}

/// The file as it is, or nothing: a missing or damaged file is an empty shelf, not an error.
fn read(file: &Path) -> Map<String, Value> {
    match std::fs::read(file).ok().and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok()) {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

/// Writes the whole object to a temporary file next to the real one, then puts it in the real one's place.
fn write(file: &Path, map: &Map<String, Value>) -> std::io::Result<()> {
    if let Some(dir) = file.parent() {
        crate::platform::ensure_private_dir(dir)?;
    }
    let json = serde_json::to_vec_pretty(map).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let temp = file.with_extension("json.tmp");
    std::fs::write(&temp, json)?;
    std::fs::rename(&temp, file).inspect_err(|_| {
        let _ = std::fs::remove_file(&temp);
    })
}

/// `text` cut to `max` characters (not bytes: never in the middle of one).
fn cut(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

/// A widget's value as it is kept: its caps applied, or the reason it is refused.
pub fn capped(widget: &str, value: &Value) -> Result<Value, String> {
    if !WRITABLE.contains(&widget) {
        return Err(format!("the page may not write `{widget}`"));
    }
    let mut value = value.clone();
    match widget {
        "todo" => cap_todo(&mut value),
        "timer" => value = cap_timer(&value),
        "reminders" => value = cap_reminders(&value),
        _ => {}
    }
    let size = serde_json::to_vec(&value).map(|b| b.len()).unwrap_or(usize::MAX);
    if size > MAX_BYTES {
        return Err(format!("`{widget}` is too big to keep"));
    }
    Ok(value)
}

fn cap_todo(value: &mut Value) {
    let Some(object) = value.as_object_mut() else { return };
    if let Some(items) = object.get_mut("items").and_then(Value::as_array_mut) {
        items.truncate(MAX_TODO_ITEMS);
        for item in items.iter_mut() {
            if let Some(text) = item.get("text").and_then(Value::as_str).map(|t| cut(t, MAX_ITEM_CHARS)) {
                item["text"] = Value::String(text);
            }
        }
    }
    if let Some(notes) = object.get("notes").and_then(Value::as_str).map(|n| cut(n, MAX_NOTES_CHARS)) {
        object.insert("notes".into(), Value::String(notes));
    }
}

/// The timer as it is kept: its five fields and nothing else, the numbers whole and within range.
fn cap_timer(value: &Value) -> Value {
    let number = |key: &str, max: f64| {
        let n = value.get(key).and_then(Value::as_f64).filter(|n| n.is_finite()).unwrap_or(0.0);
        Value::from(n.clamp(0.0, max).round() as i64)
    };
    let flag = |key: &str| Value::Bool(value.get(key).and_then(Value::as_bool).unwrap_or(false));
    let mut kept = Map::new();
    kept.insert("durationMs".into(), number("durationMs", MAX_TIMER_MS));
    kept.insert("remainingMs".into(), number("remainingMs", MAX_TIMER_MS));
    kept.insert("endsAt".into(), number("endsAt", MAX_UNIX_MS));
    kept.insert("running".into(), flag("running"));
    kept.insert("done".into(), flag("done"));
    Value::Object(kept)
}

/// The reminders as they are kept: each with its six fields and nothing else, at most `MAX_REMINDERS`.
fn cap_reminders(value: &Value) -> Value {
    let items: Vec<Value> = value
        .get("items")
        .and_then(Value::as_array)
        .map(|all| all.iter().filter_map(cap_reminder).take(MAX_REMINDERS).collect())
        .unwrap_or_default();
    let next_id = value.get("nextId").and_then(Value::as_f64).filter(|n| n.is_finite()).unwrap_or(1.0);
    let mut kept = Map::new();
    kept.insert("items".into(), Value::Array(items));
    kept.insert("nextId".into(), Value::from(next_id.clamp(1.0, 1e9) as i64));
    Value::Object(kept)
}

fn cap_reminder(item: &Value) -> Option<Value> {
    let text = cut(item.get("text")?.as_str()?, MAX_ITEM_CHARS);
    if text.trim().is_empty() {
        return None;
    }
    let number = |key: &str, max: f64| item.get(key).and_then(Value::as_f64).filter(|n| n.is_finite()).unwrap_or(0.0).clamp(0.0, max).round() as i64;
    let flag = |key: &str| item.get(key).and_then(Value::as_bool).unwrap_or(false);
    let mut kept = Map::new();
    kept.insert("id".into(), Value::from(number("id", 1e9)));
    kept.insert("text".into(), Value::String(text));
    kept.insert("at".into(), Value::from(number("at", MAX_UNIX_MS)));
    kept.insert("done".into(), Value::Bool(flag("done")));
    kept.insert("fired".into(), Value::Bool(flag("fired")));
    kept.insert("missed".into(), Value::Bool(flag("missed")));
    Some(Value::Object(kept))
}
/// What is on the disk, read once and then kept: every save goes through here, so two saves never lose each other.
#[derive(Default)]
pub struct Store {
    map: Mutex<Option<Map<String, Value>>>,
}

impl Store {
    fn with<T>(&self, file: &Path, f: impl FnOnce(&mut Map<String, Value>) -> T) -> T {
        let mut held = self.map.lock().unwrap();
        f(held.get_or_insert_with(|| read(file)))
    }

    pub fn get(&self, widget: &str) -> Value {
        self.with(&path(), |map| map.get(widget).cloned().unwrap_or(Value::Null))
    }

    /// Nook's own write of a widget's part (the project folders): not held to `WRITABLE`.
    pub fn put(&self, widget: &str, value: Value) -> Result<(), String> {
        self.put_in(&path(), widget, value)
    }

    fn put_in(&self, file: &Path, widget: &str, value: Value) -> Result<(), String> {
        self.with(file, |map| {
            let before = map.insert(widget.to_string(), value);
            write(file, map).map_err(|err| {
                // Not kept in memory either: the page is told, and the next load says what is on the disk.
                match before {
                    Some(old) => map.insert(widget.to_string(), old),
                    None => map.remove(widget),
                };
                format!("could not save the shelf: {err}")
            })
        })
    }
}

/// The page asks for a widget's part: nothing yet is `null`.
#[tauri::command(async)]
pub fn shelf_load(store: State<Store>, widget: String) -> Value {
    store.get(&widget)
}

/// The page saves a widget's part. Refused, with the reason, when the widget is not the page's or the part is too big.
#[tauri::command(async)]
pub fn shelf_save(store: State<Store>, widget: String, value: Value) -> Result<(), String> {
    let value = capped(&widget, &value)?;
    store.put(&widget, value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nook-shelf-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir.join("shelf.json")
    }

    #[test]
    fn what_is_saved_is_read_back() {
        let file = scratch("round");
        let store = Store::default();
        let todo = json!({"items": [{"id": 1, "text": "Buy milk", "done": false}], "notes": "a\nb"});
        store.put_in(&file, "todo", todo.clone()).unwrap();
        // Another store, as after a restart: from the disk alone.
        let again = Store::default();
        assert_eq!(again.with(&file, |m| m.get("todo").cloned()), Some(todo));
        assert_eq!(again.with(&file, |m| m.get("timer").cloned()), None);
        let _ = std::fs::remove_dir_all(file.parent().unwrap());
    }

    #[test]
    fn a_save_leaves_no_temporary_file_and_keeps_the_other_widgets() {
        let file = scratch("temp");
        let store = Store::default();
        store.put_in(&file, "projects", json!({"recent": []})).unwrap();
        store.put_in(&file, "todo", json!({"items": []})).unwrap();
        assert!(!file.with_extension("json.tmp").exists());
        let on_disk = read(&file);
        assert!(on_disk.contains_key("projects") && on_disk.contains_key("todo"));
        let _ = std::fs::remove_dir_all(file.parent().unwrap());
    }

    #[test]
    fn a_damaged_file_is_an_empty_shelf() {
        let file = scratch("damaged");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, b"{ not json").unwrap();
        assert!(read(&file).is_empty());
        std::fs::write(&file, b"[1, 2]").unwrap();
        assert!(read(&file).is_empty());
        let _ = std::fs::remove_dir_all(file.parent().unwrap());
    }

    #[test]
    fn only_the_pages_own_widgets_are_written() {
        assert!(capped("todo", &json!({"items": []})).is_ok());
        assert!(capped("projects", &json!({"recent": []})).is_err());
        assert!(capped("nonsense", &json!(1)).is_err());
    }

    #[test]
    fn the_to_do_caps_cut_and_never_refuse() {
        let items: Vec<Value> = (0..MAX_TODO_ITEMS + 25)
            .map(|i| json!({"id": i, "text": "x".repeat(MAX_ITEM_CHARS + 50), "done": false}))
            .collect();
        let notes = "é".repeat(MAX_NOTES_CHARS + 10);
        let kept = capped("todo", &json!({"items": items, "notes": notes})).unwrap();
        let kept_items = kept["items"].as_array().unwrap();
        assert_eq!(kept_items.len(), MAX_TODO_ITEMS);
        assert_eq!(kept_items[0]["text"].as_str().unwrap().chars().count(), MAX_ITEM_CHARS);
        assert_eq!(kept["notes"].as_str().unwrap().chars().count(), MAX_NOTES_CHARS);
    }

    #[test]
    fn the_timer_keeps_its_five_fields_within_range() {
        let kept = capped("timer", &json!({
            "durationMs": 9_999_999_999.0, "remainingMs": -5, "endsAt": 1_700_000_000_000_i64,
            "running": true, "done": "yes", "extra": "x".repeat(1000),
        }))
        .unwrap();
        assert_eq!(kept["durationMs"], json!(MAX_TIMER_MS as i64));
        assert_eq!(kept["remainingMs"], json!(0));
        assert_eq!(kept["endsAt"], json!(1_700_000_000_000_i64));
        assert_eq!(kept["running"], json!(true));
        assert_eq!(kept["done"], json!(false));
        assert_eq!(kept.as_object().unwrap().len(), 5);
        // Not an object at all: all zeros and no flags, never an error.
        assert_eq!(capped("timer", &json!("junk")).unwrap()["running"], json!(false));
    }

    #[test]
    fn the_reminders_are_cut_to_their_caps_and_their_fields() {
        let mut items: Vec<Value> = (0..MAX_REMINDERS + 10)
            .map(|i| json!({"id": i, "text": "r".repeat(MAX_ITEM_CHARS + 20), "at": 1_700_000_000_000_i64, "done": false, "junk": 1}))
            .collect();
        items.insert(0, json!({"id": 9, "text": "   "}));
        items.insert(0, json!("not an object"));
        let kept = capped("reminders", &json!({"items": items, "nextId": 5})).unwrap();
        let kept_items = kept["items"].as_array().unwrap();
        assert_eq!(kept_items.len(), MAX_REMINDERS);
        assert_eq!(kept_items[0]["text"].as_str().unwrap().chars().count(), MAX_ITEM_CHARS);
        assert_eq!(kept_items[0].as_object().unwrap().len(), 6);
        assert_eq!(kept["nextId"], json!(5));
        assert_eq!(capped("reminders", &json!(null)).unwrap()["items"], json!([]));
    }

    #[test]
    fn a_part_that_is_far_too_big_is_refused() {
        let junk = json!({"items": [], "extra": "y".repeat(MAX_BYTES + 1)});
        assert!(capped("todo", &junk).is_err());
    }
}
