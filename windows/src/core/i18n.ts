/** Languages Nook can translate into, plus the optional system preference. */
export type Language = "en" | "uk" | "pl" | "ru";
export type LanguagePreference = Language | "system";

/** The keys are the small Settings pilot. English is the source of truth. */
export const ENGLISH = {
  "settings.look.title": "Look and colours",
  "settings.look.description": "Gullu's colour, the colours of this window, and how lively things are.",
  "settings.language.heading": "Interface language",
  "settings.language.label": "Language",
  "settings.language.description": "Choose the language used in Nook's interface.",
  "settings.language.tooltip": "Choose a language for Nook's interface.",
  "settings.language.system": "Same as system",
  "settings.language.en": "English",
  "settings.language.uk": "Українська",
  "settings.language.pl": "Polski",
  "settings.language.ru": "Русский",
  "settings.reset.idle": "Reset this section",
  "settings.reset.armed": "Click again to reset",
  "settings.reset.busy": "Resetting…",
  "settings.reset.look.note": "Puts Gullu's colour, this window's colours and motion back as they came.",
  "settings.reset.look.done": "Everything in Look and colours is as it came.",
  "settings.reset.look.armAnnouncement": "Click again to reset Look and colours.",
  "settings.reset.look.doneAnnouncement": "Look and colours is reset.",
} as const;

export type TranslationKey = keyof typeof ENGLISH;
export type Dictionary = Readonly<Record<TranslationKey, string>>;

export const DICTIONARIES: Readonly<Record<Language, Dictionary>> = {
  en: ENGLISH,
  uk: {
    "settings.look.title": "Вигляд і кольори",
    "settings.look.description": "Колір персонажа Gullu, кольори цього вікна та анімація інтерфейсу.",
    "settings.language.heading": "Мова інтерфейсу",
    "settings.language.label": "Мова",
    "settings.language.description": "Виберіть мову інтерфейсу Nook.",
    "settings.language.tooltip": "Виберіть мову інтерфейсу Nook.",
    "settings.language.system": "Мова системи",
    "settings.language.en": "English",
    "settings.language.uk": "Українська",
    "settings.language.pl": "Polski",
    "settings.language.ru": "Русский",
    "settings.reset.idle": "Скинути цей розділ",
    "settings.reset.armed": "Натисніть ще раз, щоб скинути",
    "settings.reset.busy": "Скидання…",
    "settings.reset.look.note": "Повертає колір Gullu, кольори вікна й анімацію до початкових значень.",
    "settings.reset.look.done": "У розділі «Вигляд і кольори» відновлено початкові значення.",
    "settings.reset.look.armAnnouncement": "Натисніть ще раз, щоб скинути вигляд і кольори.",
    "settings.reset.look.doneAnnouncement": "Вигляд і кольори скинуто.",
  },
  pl: {
    "settings.look.title": "Wygląd i kolory",
    "settings.look.description": "Kolor postaci Gullu, kolory tego okna i animacje interfejsu.",
    "settings.language.heading": "Język interfejsu",
    "settings.language.label": "Język",
    "settings.language.description": "Wybierz język interfejsu Nook.",
    "settings.language.tooltip": "Wybierz język interfejsu Nook.",
    "settings.language.system": "Język systemu",
    "settings.language.en": "English",
    "settings.language.uk": "Українська",
    "settings.language.pl": "Polski",
    "settings.language.ru": "Русский",
    "settings.reset.idle": "Przywróć ustawienia sekcji",
    "settings.reset.armed": "Kliknij ponownie, aby przywrócić domyślne",
    "settings.reset.busy": "Przywracanie…",
    "settings.reset.look.note": "Przywraca domyślne kolory Gullu i okna oraz animacje.",
    "settings.reset.look.done": "Wygląd i kolory są domyślne.",
    "settings.reset.look.armAnnouncement": "Kliknij ponownie, aby przywrócić domyślny wygląd i kolory.",
    "settings.reset.look.doneAnnouncement": "Przywrócono domyślny wygląd i kolory.",
  },
  ru: {
    "settings.look.title": "Вид и цвета",
    "settings.look.description": "Цвет персонажа Gullu, цвета этого окна и анимация интерфейса.",
    "settings.language.heading": "Язык интерфейса",
    "settings.language.label": "Язык",
    "settings.language.description": "Выберите язык интерфейса Nook.",
    "settings.language.tooltip": "Выберите язык интерфейса Nook.",
    "settings.language.system": "Язык системы",
    "settings.language.en": "English",
    "settings.language.uk": "Українська",
    "settings.language.pl": "Polski",
    "settings.language.ru": "Русский",
    "settings.reset.idle": "Сбросить настройки раздела",
    "settings.reset.armed": "Нажмите ещё раз, чтобы сбросить",
    "settings.reset.busy": "Сброс…",
    "settings.reset.look.note": "Возвращает исходные цвета Gullu и окна, а также анимацию.",
    "settings.reset.look.done": "В разделе «Вид и цвета» восстановлены исходные значения.",
    "settings.reset.look.armAnnouncement": "Нажмите ещё раз, чтобы сбросить вид и цвета.",
    "settings.reset.look.doneAnnouncement": "Вид и цвета сброшены.",
  },
};

const LANGUAGES: readonly Language[] = ["en", "uk", "pl", "ru"];

export function isLanguagePreference(value: unknown): value is LanguagePreference {
  return value === "system" || (typeof value === "string" && LANGUAGES.includes(value as Language));
}

/** Explicit choices win; system uses the authoritative code supplied by Rust at boot. */
export function effectiveLanguage(preference: LanguagePreference, systemLanguage: Language): Language {
  return preference === "system" ? systemLanguage : preference;
}

/** Missing entries always use English; unknown keys are excluded by the type. */
export function t(key: TranslationKey, language: Language = "en"): string {
  return translatedValue(key, DICTIONARIES[language]);
}

/** The fallback is separately testable so a future partial dictionary stays safe. */
export function translatedValue(key: TranslationKey, dictionary: Partial<Dictionary>): string {
  const value = dictionary[key];
  return value?.trim() ? value : ENGLISH[key];
}
